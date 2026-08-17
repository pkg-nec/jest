/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import fs from 'graceful-fs';
import {rewritePackageSpecifier} from '../pkgNecPackageIdentity.mjs';
import {applyTextEdits, collectModuleCandidates} from './moduleCandidates.mjs';
import {enumerateRepositoryFiles} from './repositoryFiles.mjs';
import {collectStructuredCandidates} from './structuredCandidates.mjs';

const dependencyFields = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
  'peerDependenciesMeta',
  'resolutions',
];
const helperManifestPaths = new Set([
  'packages/test-globals/package.json',
  'packages/test-utils/package.json',
]);
const helperMetadataFields = new Set([
  'homepage',
  'license',
  'private',
  'publishConfig',
  'repository',
]);
const doublePrefix = ['@pkg-nec/jest-', 'jest-'].join('');
const planMetadata = new WeakMap();

function normalizedPath(filePath) {
  return filePath.split(path.sep).join('/');
}

function relativeManifestPath(repoRoot, manifestPath) {
  return normalizedPath(path.relative(repoRoot, manifestPath));
}

function dependencyField(field) {
  return dependencyFields.find(
    candidate =>
      field === candidate ||
      field.startsWith(`${candidate}.`) ||
      field.startsWith(`${candidate}[`),
  );
}

function assertNoDoublePrefix(value, filePath) {
  if (typeof value === 'string' && value.includes(doublePrefix)) {
    throw new Error(`Found double-prefix package identity in ${filePath}`);
  }
}

function assertInventory(inventory, repoRoot) {
  if (!inventory?.root || !Array.isArray(inventory.packages)) {
    throw new TypeError('Invalid package identity inventory');
  }

  const oldNames = new Set();
  const newNames = new Set();
  const manifestPaths = new Set();
  for (const identity of [inventory.root, ...inventory.packages]) {
    if (oldNames.has(identity.oldName)) {
      throw new Error(`Package identity collision: ${identity.oldName}`);
    }
    if (newNames.has(identity.newName)) {
      throw new Error(`Canonical package name collision: ${identity.newName}`);
    }

    const manifestPath = relativeManifestPath(repoRoot, identity.manifestPath);
    if (manifestPaths.has(manifestPath)) {
      throw new Error(`Package manifest collision: ${manifestPath}`);
    }

    oldNames.add(identity.oldName);
    newNames.add(identity.newName);
    manifestPaths.add(manifestPath);
  }
}

function snapshotInventory(inventory) {
  const root = {...inventory.root};
  const packages = inventory.packages.map(identity => ({...identity}));
  const identities = [root, ...packages];
  return {
    byNewName: new Map(
      identities.map(identity => [identity.newName, identity]),
    ),
    byOldName: new Map(
      identities.map(identity => [identity.oldName, identity]),
    ),
    packages,
    root,
  };
}

function validateTrustedPlan(plan) {
  const metadata = planMetadata.get(plan);
  if (
    metadata !== undefined &&
    !isDeepStrictEqual(plan, metadata.trustedPlan)
  ) {
    throw new Error(
      'Trusted plan changed after planning; preservation seal invalid',
    );
  }
}

function expectedDependencyMap(dependencies, inventory, manifestPath, field) {
  if (
    dependencies == null ||
    typeof dependencies !== 'object' ||
    Array.isArray(dependencies)
  ) {
    return dependencies;
  }

  const result = {};
  for (const [dependencyName, dependencyRange] of Object.entries(
    dependencies,
  )) {
    const expectedName =
      rewritePackageSpecifier(dependencyName, inventory) ?? dependencyName;
    if (Object.hasOwn(result, expectedName)) {
      throw new Error(
        `Dependency key collision in ${manifestPath}: ${field}.${expectedName}`,
      );
    }
    result[expectedName] = dependencyRange;
  }
  return result;
}

function validateManifestMetadataPolicy(files, {inventory, repoRoot}) {
  for (const file of files) {
    if (path.basename(file.path).toLowerCase() !== 'package.json') continue;

    const before = JSON.parse(file.before);
    const after = JSON.parse(file.after);
    const relativePath = relativeManifestPath(repoRoot, file.path);
    const isHelperManifest = helperManifestPaths.has(relativePath);
    const expectedName =
      typeof before.name === 'string'
        ? (rewritePackageSpecifier(before.name, inventory) ?? before.name)
        : before.name;

    if (!isDeepStrictEqual(after.name, expectedName)) {
      throw new Error(`Package name policy violation in ${file.path}`);
    }

    for (const field of dependencyFields) {
      const expectedDependencies = expectedDependencyMap(
        before[field],
        inventory,
        file.path,
        field,
      );
      if (!isDeepStrictEqual(after[field], expectedDependencies)) {
        throw new Error(
          `Dependency metadata policy violation in ${file.path}: ${field}`,
        );
      }
    }

    const fields = new Set([...Object.keys(before), ...Object.keys(after)]);
    fields.delete('name');
    for (const field of dependencyFields) fields.delete(field);
    for (const field of fields) {
      if (isDeepStrictEqual(before[field], after[field])) continue;
      if (isHelperManifest && helperMetadataFields.has(field)) continue;
      throw new Error(
        `Manifest metadata policy violation in ${file.path}: ${field}`,
      );
    }
  }
}

function sortEdits(edits) {
  return [...edits].sort(
    (left, right) => right.start - left.start || right.end - left.end,
  );
}

function parserCompatibleModuleSource(code) {
  return code.replaceAll(
    /^(\s*(?:import|export)\b[^\r\n;]*?(?:\bfrom\s+)?['"][^'"\r\n]+['"]\s+)assert(?=\s*\{)/gm,
    '$1with  ',
  );
}

function moduleMayContainIdentity(code, inventory) {
  if (code.includes('\\')) return true;

  for (const identity of inventory.byOldName.values()) {
    for (const quote of ["'", '"']) {
      const prefix = `${quote}${identity.oldName}`;
      let index = code.indexOf(prefix);
      while (index !== -1) {
        const suffix = code[index + prefix.length];
        if (suffix === quote || suffix === '/') return true;
        index = code.indexOf(prefix, index + prefix.length);
      }
    }
  }
  return false;
}

function withRawOldValues(code, edits) {
  return edits.map(edit => ({
    ...edit,
    oldValue: code.slice(edit.start, edit.end),
  }));
}

function collectMigrationModuleCandidates({code, filePath, inventory}) {
  if (!moduleMayContainIdentity(code, inventory)) return [];
  if (/^(?:\.\.\/)+[A-Za-z0-9_./@-]+\r?\n?$/.test(code)) return [];

  const compatibleCode = parserCompatibleModuleSource(code);
  try {
    return withRawOldValues(
      code,
      collectModuleCandidates({
        code: compatibleCode,
        filePath,
        inventory,
      }),
    );
  } catch (error) {
    if (
      path.extname(filePath) !== '.js' ||
      error?.code !== 'BABEL_PARSE_ERROR'
    ) {
      throw error;
    }
    return withRawOldValues(
      code,
      collectModuleCandidates({
        code: compatibleCode,
        filePath: `${filePath}x`,
        inventory,
      }),
    );
  }
}

function plannedText(filesByPath, manifestPath) {
  return (
    filesByPath.get(path.resolve(manifestPath))?.after ??
    fs.readFileSync(manifestPath, 'utf8')
  );
}

function addDependencyComparisons({
  afterManifest,
  baselineRecord,
  inventory,
  manifestComparisons,
  manifestPath,
}) {
  for (const field of dependencyFields) {
    const beforeDependencies = baselineRecord[field] ?? {};
    const afterDependencies = afterManifest[field] ?? {};
    const expectedAfterKeys = new Set();

    for (const [beforeName, beforeValue] of Object.entries(
      beforeDependencies,
    )) {
      const afterName =
        rewritePackageSpecifier(beforeName, inventory) ?? beforeName;
      if (expectedAfterKeys.has(afterName)) {
        throw new Error(
          `Dependency key collision in ${manifestPath}: ${afterName}`,
        );
      }
      expectedAfterKeys.add(afterName);
      manifestComparisons.push({
        after: afterDependencies[afterName],
        before: beforeValue,
        field: `${field}.${beforeName}`,
        path: manifestPath,
      });
    }

    for (const [afterName, afterValue] of Object.entries(afterDependencies)) {
      if (!expectedAfterKeys.has(afterName)) {
        manifestComparisons.push({
          after: afterValue,
          before: undefined,
          field: `${field}.${afterName}`,
          path: manifestPath,
        });
      }
    }
  }
}

function createManifestComparisons({baseline, files, inventory, repoRoot}) {
  const identities = [inventory.root, ...inventory.packages];
  const identityPaths = new Set(
    identities.map(identity =>
      relativeManifestPath(repoRoot, identity.manifestPath),
    ),
  );
  const baselinePaths = Object.keys(baseline);
  if (
    baselinePaths.length !== identityPaths.size ||
    baselinePaths.some(manifestPath => !identityPaths.has(manifestPath))
  ) {
    throw new Error('Manifest baseline does not match workspace paths');
  }

  const filesByPath = new Map(
    files.map(file => [path.resolve(file.path), file]),
  );
  const manifestComparisons = [];
  for (const identity of identities) {
    const manifestPath = relativeManifestPath(repoRoot, identity.manifestPath);
    const baselineRecord = baseline[manifestPath];
    const afterManifest = JSON.parse(
      plannedText(filesByPath, identity.manifestPath),
    );

    if (baselineRecord.name !== identity.oldName) {
      throw new Error(`Manifest baseline name changed at ${manifestPath}`);
    }
    if (afterManifest.name !== identity.newName) {
      throw new Error(`Unexpected migrated package name at ${manifestPath}`);
    }

    manifestComparisons.push(
      {
        after: afterManifest.name,
        before: baselineRecord.name,
        field: 'name',
        path: manifestPath,
      },
      {
        after: afterManifest.version,
        before: baselineRecord.version,
        field: 'version',
        path: manifestPath,
      },
      {
        after: afterManifest.private === true,
        before: baselineRecord.private,
        field: 'private',
        path: manifestPath,
      },
    );
    addDependencyComparisons({
      afterManifest,
      baselineRecord,
      inventory,
      manifestComparisons,
      manifestPath,
    });
  }
  return manifestComparisons;
}

function validateFile(file, seenPaths) {
  if (seenPaths.has(file.path)) {
    throw new Error(`Migration file collision: ${file.path}`);
  }
  seenPaths.add(file.path);

  const edits = [...file.edits].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  let previous = null;
  for (const edit of edits) {
    if (
      !Number.isInteger(edit.start) ||
      !Number.isInteger(edit.end) ||
      edit.start < 0 ||
      edit.end < edit.start ||
      edit.end > file.before.length
    ) {
      throw new RangeError(`Invalid edit range in ${file.path}`);
    }
    if (previous !== null && edit.start < previous.end) {
      throw new Error(`Found overlapping edits in ${file.path}`);
    }
    if (file.before.slice(edit.start, edit.end) !== edit.oldValue) {
      throw new Error(`Edit oldValue mismatch in ${file.path}`);
    }
    if (typeof edit.replacement !== 'string') {
      throw new TypeError(`Edit replacement must be a string in ${file.path}`);
    }
    previous = edit;
  }

  if (applyTextEdits(file.before, edits) !== file.after) {
    throw new Error(`Migration output mismatch in ${file.path}`);
  }
  assertNoDoublePrefix(file.after, file.path);
}

function validateManifestComparison(comparison) {
  const {after, before, field, path: manifestPath} = comparison;
  if (isDeepStrictEqual(before, after)) return;

  if (dependencyField(field)) {
    throw new Error(
      `Manifest dependency value changed at ${manifestPath}: ${field}`,
    );
  }
  if (field === 'version') {
    throw new Error(`Manifest version changed at ${manifestPath}`);
  }
  if (field === 'name') {
    if (typeof after !== 'string' || !after.startsWith('@pkg-nec/')) {
      throw new Error(`Manifest name changed unexpectedly at ${manifestPath}`);
    }
    assertNoDoublePrefix(after, manifestPath);
    return;
  }

  const normalizedManifestPath = normalizedPath(manifestPath);
  if (
    helperManifestPaths.has(normalizedManifestPath) &&
    helperMetadataFields.has(field)
  ) {
    return;
  }
  throw new Error(`Manifest metadata changed at ${manifestPath}: ${field}`);
}

function validateTrustedManifestPreservation(plan) {
  if (
    !plan.files.some(
      file => path.basename(file.path).toLowerCase() === 'package.json',
    )
  ) {
    return;
  }

  const metadata = planMetadata.get(plan);
  if (metadata === undefined) {
    throw new Error('Manifest preservation requires a trusted migration plan');
  }

  validateManifestMetadataPolicy(plan.files, metadata);

  const comparisons = createManifestComparisons({
    baseline: metadata.baseline,
    files: plan.files,
    inventory: metadata.inventory,
    repoRoot: metadata.repoRoot,
  });
  for (const comparison of comparisons) {
    validateManifestComparison(comparison);
  }
  if (!isDeepStrictEqual(comparisons, plan.manifestComparisons)) {
    throw new Error('Manifest preservation comparisons are incomplete');
  }
}

function transactionPath(filePath, label, index, fileSystem) {
  const directory = path.dirname(filePath);
  const basename = path.basename(filePath);
  const prefix = `.${basename}.pkg-nec-${process.pid}-${Date.now()}-${index}`;
  let attempt = 0;
  let candidate;
  do {
    candidate = path.join(directory, `${prefix}-${attempt}.${label}`);
    attempt += 1;
  } while (fileSystem.existsSync(candidate));
  return candidate;
}

function removeIfPresent(filePath, fileSystem) {
  try {
    fileSystem.unlinkSync(filePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function throwWithCleanupErrors(error, cleanupErrors) {
  if (cleanupErrors.length === 0) throw error;
  throw new AggregateError(
    [error, ...cleanupErrors],
    `Migration failed and rollback encountered ${cleanupErrors.length} error(s)`,
  );
}

function stageChangedFiles(changedFiles, fileSystem) {
  const entries = changedFiles.map((file, index) => ({
    backupPath: transactionPath(file.path, 'backup', index, fileSystem),
    file,
    originalMoved: false,
    stageCommitted: false,
    stagePath: transactionPath(file.path, 'stage', index, fileSystem),
  }));

  try {
    for (const entry of entries) {
      const mode = fileSystem.statSync(entry.file.path).mode;
      const descriptor = fileSystem.openSync(entry.stagePath, 'wx', mode);
      try {
        fileSystem.writeFileSync(descriptor, entry.file.after, 'utf8');
        fileSystem.fsyncSync(descriptor);
      } finally {
        fileSystem.closeSync(descriptor);
      }
    }
  } catch (error) {
    const cleanupErrors = [];
    for (const entry of entries) {
      try {
        removeIfPresent(entry.stagePath, fileSystem);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    throwWithCleanupErrors(error, cleanupErrors);
  }
  return entries;
}

function rollbackEntries(entries, fileSystem, error) {
  const cleanupErrors = [];
  for (const entry of [...entries].reverse()) {
    try {
      if (entry.stageCommitted) {
        removeIfPresent(entry.file.path, fileSystem);
      }
      if (entry.originalMoved) {
        fileSystem.renameSync(entry.backupPath, entry.file.path);
      }
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
  }
  for (const entry of entries) {
    try {
      removeIfPresent(entry.stagePath, fileSystem);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
  }
  throwWithCleanupErrors(error, cleanupErrors);
}

function commitStagedFiles(entries, fileSystem) {
  try {
    for (const entry of entries) {
      fileSystem.renameSync(entry.file.path, entry.backupPath);
      entry.originalMoved = true;
      if (
        fileSystem.readFileSync(entry.backupPath, 'utf8') !== entry.file.before
      ) {
        throw new Error(
          `File changed while committing migration: ${entry.file.path}`,
        );
      }
      fileSystem.renameSync(entry.stagePath, entry.file.path);
      entry.stageCommitted = true;
    }
  } catch (error) {
    rollbackEntries(entries, fileSystem, error);
  }

  const cleanupWarnings = [];
  for (const entry of entries) {
    try {
      removeIfPresent(entry.backupPath, fileSystem);
    } catch (error) {
      cleanupWarnings.push({
        backupPath: entry.backupPath,
        message: error.message,
        path: entry.file.path,
      });
    }
  }
  return cleanupWarnings;
}

export function validateMigrationPlan(plan) {
  if (!plan || !Array.isArray(plan.files)) {
    throw new TypeError('Migration plan must contain files');
  }
  if (!Array.isArray(plan.manifestComparisons)) {
    throw new TypeError('Migration plan must contain manifest comparisons');
  }

  const seenPaths = new Set();
  for (const file of plan.files) validateFile(file, seenPaths);
  for (const comparison of plan.manifestComparisons) {
    validateManifestComparison(comparison);
  }
}

export function buildMigrationPlan({baseline, inventory, repoRoot}) {
  const rootDirectory = path.resolve(repoRoot);
  assertInventory(inventory, rootDirectory);

  const rootManifest = JSON.parse(
    fs.readFileSync(path.join(rootDirectory, 'package.json'), 'utf8'),
  );
  if (
    rootManifest.name === inventory.root.newName ||
    rootManifest.name?.startsWith('@pkg-nec/')
  ) {
    throw new Error('Repository already appears to be rebranded');
  }

  const files = [];
  for (const entry of enumerateRepositoryFiles({repoRoot: rootDirectory})) {
    const before = fs.readFileSync(entry.path, 'utf8');
    const edits =
      entry.category === 'module'
        ? collectMigrationModuleCandidates({
            code: before,
            filePath: entry.path,
            inventory,
          })
        : collectStructuredCandidates({
            category: entry.category,
            filePath: entry.path,
            inventory,
            text: before,
          });
    const sortedEdits = sortEdits(edits);
    const after = applyTextEdits(before, sortedEdits);
    assertNoDoublePrefix(after, entry.path);
    if (after !== before) {
      files.push({after, before, edits: sortedEdits, path: entry.path});
    }
  }

  const plan = {
    files,
    manifestComparisons: createManifestComparisons({
      baseline,
      files,
      inventory,
      repoRoot: rootDirectory,
    }),
  };
  validateManifestMetadataPolicy(plan.files, {
    inventory,
    repoRoot: rootDirectory,
  });
  validateMigrationPlan(plan);
  planMetadata.set(plan, {
    baseline: structuredClone(baseline),
    inventory: snapshotInventory(inventory),
    repoRoot: rootDirectory,
    trustedPlan: structuredClone(plan),
  });
  return plan;
}

export function applyMigrationPlan(plan, {fileSystem = fs} = {}) {
  validateTrustedPlan(plan);
  validateMigrationPlan(plan);
  validateTrustedManifestPreservation(plan);

  for (const file of plan.files) {
    const current = fileSystem.readFileSync(file.path, 'utf8');
    if (current !== file.before) {
      throw new Error(`File changed after migration planning: ${file.path}`);
    }
  }

  const changedFiles = plan.files.filter(file => file.after !== file.before);
  const stagedEntries = stageChangedFiles(changedFiles, fileSystem);
  const cleanupWarnings = commitStagedFiles(stagedEntries, fileSystem);

  const countsByCategory = {};
  for (const file of changedFiles) {
    for (const edit of file.edits) {
      const category = edit.category ?? 'uncategorized';
      countsByCategory[category] = (countsByCategory[category] ?? 0) + 1;
    }
  }

  const report = {
    changedPaths: changedFiles.map(file => file.path).sort(),
    countsByCategory: Object.fromEntries(
      Object.entries(countsByCategory).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  };
  if (cleanupWarnings.length > 0) {
    report.cleanupWarnings = cleanupWarnings;
  }
  return report;
}
