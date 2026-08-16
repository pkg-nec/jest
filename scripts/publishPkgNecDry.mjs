/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {createHash, randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import execa from 'execa';
import fs from 'graceful-fs';
import {auditRepository} from './pkgNec/audit.mjs';
import {
  comparePackageFiles,
  isHelperReleasePackageName,
  validateReleaseFiles,
} from './pkgNec/releaseArtifactPolicy.mjs';
import {
  buildRuntimeReleaseGraph,
  topologicalReleaseOrder,
} from './pkgNec/releaseGraph.mjs';
import {
  localTarArguments,
  repackReleaseArtifact,
} from './pkgNec/repackReleaseArtifact.mjs';
import {canonicalName} from './pkgNecPackageIdentity.mjs';

const dependencyFields = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'peerDependenciesMeta',
  'resolutions',
];
const publishablePrivatePackages = new Set([
  '@jest/test-globals',
  '@jest/test-utils',
]);
const releaseDirectoryName = '.pkg-nec-release';
const defaultRepoRoot = path.resolve(
  fileURLToPath(new URL('..', import.meta.url)),
);
const defaultBaseline = JSON.parse(
  fs.readFileSync(
    new URL('pkgNec/upstreamManifestBaseline.json', import.meta.url),
    'utf8',
  ),
);

function identityFromBaseline(
  repoRoot,
  filePath,
  record,
  {isRoot = false} = {},
) {
  const manifestPath = path.join(repoRoot, filePath);
  return {
    directory: path.dirname(manifestPath),
    manifestPath,
    newName: canonicalName(record.name, {isRoot}),
    oldName: record.name,
    publishable:
      record.private !== true || publishablePrivatePackages.has(record.name),
    version: record.version,
  };
}

function inventoryFromBaseline({baseline, repoRoot}) {
  const root = identityFromBaseline(
    repoRoot,
    'package.json',
    baseline['package.json'],
    {isRoot: true},
  );
  const packages = Object.entries(baseline)
    .filter(([filePath]) => filePath !== 'package.json')
    .map(([filePath, record]) =>
      identityFromBaseline(repoRoot, filePath, record),
    );
  const identities = [root, ...packages];

  return {
    byNewName: new Map(identities.map(item => [item.newName, item])),
    byOldName: new Map(identities.map(item => [item.oldName, item])),
    packages,
    root,
  };
}

function baselineIdentityMaps(baseline) {
  const oldToNew = new Map();
  const recordsByNewName = new Map();
  const recordsByOldName = new Map();

  for (const [filePath, record] of Object.entries(baseline)) {
    const newName = canonicalName(record.name, {
      isRoot: filePath === 'package.json',
    });
    oldToNew.set(record.name, newName);
    recordsByNewName.set(newName, record);
    recordsByOldName.set(record.name, record);
  }

  return {oldToNew, recordsByNewName, recordsByOldName};
}

function containsLinkValue(value) {
  if (typeof value === 'string') return value.startsWith('link:');
  if (value === null || typeof value !== 'object') return false;
  return Object.values(value).some(containsLinkValue);
}

function containsOldInternalName(value, oldNames) {
  if (typeof value === 'string') {
    return oldNames.find(oldName => value.includes(oldName)) ?? null;
  }
  if (value === null || typeof value !== 'object') return null;
  for (const nestedValue of Object.values(value)) {
    const oldName = containsOldInternalName(nestedValue, oldNames);
    if (oldName) return oldName;
  }
  return null;
}

export function inspectPackedManifest({baseline, manifest, workspace}) {
  if (!manifest || typeof manifest !== 'object') {
    throw new TypeError(`Packed manifest missing for ${workspace?.newName}`);
  }

  const {oldToNew, recordsByNewName, recordsByOldName} =
    baselineIdentityMaps(baseline);
  const baselineRecord = recordsByOldName.get(workspace.oldName);
  if (!baselineRecord) {
    throw new Error(`Manifest baseline missing for ${workspace.newName}`);
  }

  if (manifest.name === workspace.oldName) {
    throw new Error(`Packed manifest contains old name ${workspace.oldName}`);
  }
  if (manifest.name !== workspace.newName) {
    throw new Error(
      `Packed manifest name changed for ${workspace.newName}: ${manifest.name}`,
    );
  }
  if (
    manifest.version !== workspace.version ||
    manifest.version !== baselineRecord.version
  ) {
    throw new Error(
      `Packed manifest version changed for ${workspace.newName}: ${manifest.version}`,
    );
  }
  if (manifest.private === true) {
    throw new Error(`Packed manifest is private: ${workspace.newName}`);
  }
  if (manifest.publishConfig?.access !== 'public') {
    throw new Error(
      `Packed manifest is missing public access: ${workspace.newName}`,
    );
  }

  const oldNames = [...oldToNew.keys()].sort(
    (left, right) => right.length - left.length,
  );
  for (const field of dependencyFields) {
    const actualDependencies = manifest[field] ?? {};
    const baselineDependencies = baselineRecord[field] ?? {};
    const expectedDependencies = new Map(
      Object.entries(baselineDependencies).map(([oldName, value]) => [
        oldToNew.get(oldName) ?? oldName,
        {internal: oldToNew.has(oldName), oldName, value},
      ]),
    );

    for (const [dependencyName, range] of Object.entries(actualDependencies)) {
      if (oldToNew.has(dependencyName)) {
        throw new Error(
          `Packed manifest contains old name ${dependencyName} in ${field}`,
        );
      }
      if (containsLinkValue(range)) {
        throw new Error(
          `Packed manifest contains link: value for ${field}.${dependencyName}`,
        );
      }
      const oldValueName = containsOldInternalName(range, oldNames);
      if (oldValueName) {
        throw new Error(
          `Packed manifest contains old name alias ${oldValueName} in ${field}.${dependencyName}`,
        );
      }
      if (
        dependencyName.startsWith('@pkg-nec/') &&
        !recordsByNewName.has(dependencyName)
      ) {
        throw new Error(
          `Unresolved internal dependency ${dependencyName} in ${workspace.newName}`,
        );
      }
      if (!expectedDependencies.has(dependencyName)) {
        throw new Error(
          `Unexpected dependency ${field}.${dependencyName} in ${workspace.newName}`,
        );
      }
    }

    for (const [dependencyName, expected] of expectedDependencies) {
      if (!Object.hasOwn(actualDependencies, dependencyName)) {
        if (expected.internal) {
          throw new Error(
            `Unresolved internal dependency ${dependencyName} in ${workspace.newName}`,
          );
        }
        throw new Error(
          `Third-party range changed for ${field}.${dependencyName} in ${workspace.newName}`,
        );
      }

      const actualRange = actualDependencies[dependencyName];
      if (
        expected.internal &&
        field !== 'peerDependenciesMeta' &&
        expected.value === 'workspace:*'
      ) {
        const dependencyVersion = recordsByNewName.get(dependencyName).version;
        if (
          actualRange !== dependencyVersion &&
          actualRange !== `=${dependencyVersion}`
        ) {
          throw new Error(
            `Packed internal dependency version changed for ${dependencyName} in ${workspace.newName}: ${actualRange}`,
          );
        }
      } else if (!isDeepStrictEqual(actualRange, expected.value)) {
        throw new Error(
          `${expected.internal ? 'Internal dependency value' : 'Third-party range'} changed for ${field}.${dependencyName} in ${workspace.newName}`,
        );
      }
    }
  }
}

export function createReleaseLedger({artifacts, order}) {
  const artifactsByName = new Map();
  for (const artifact of artifacts) {
    if (artifactsByName.has(artifact.name)) {
      throw new Error(`Duplicate release artifact: ${artifact.name}`);
    }
    if (!String(artifact.integrity).startsWith('sha512-')) {
      throw new Error(`Release artifact lacks SHA-512 SRI: ${artifact.name}`);
    }
    artifactsByName.set(artifact.name, artifact);
  }

  const orderIndex = new Map(order.map((name, index) => [name, index]));
  const packages = order.map((name, index) => {
    const artifact = artifactsByName.get(name);
    if (!artifact) throw new Error(`Release artifact missing for ${name}`);

    return {
      files: [...artifact.files].sort((left, right) =>
        left.localeCompare(right),
      ),
      integrity: artifact.integrity,
      name: artifact.name,
      order: index,
      prerequisites: [...artifact.prerequisites].sort(
        (left, right) =>
          (orderIndex.get(left) ?? Number.MAX_SAFE_INTEGER) -
            (orderIndex.get(right) ?? Number.MAX_SAFE_INTEGER) ||
          left.localeCompare(right),
      ),
      tarball: artifact.tarball,
      version: artifact.version,
    };
  });

  if (artifactsByName.size !== packages.length) {
    const unexpected = [...artifactsByName.keys()].filter(
      name => !orderIndex.has(name),
    );
    throw new Error(`Unexpected release artifact: ${unexpected.join(', ')}`);
  }

  return {generatedAt: new Date().toISOString(), packages};
}

function releaseMarkdown(ledger) {
  const lines = [
    '# pkg-nec Release Ledger',
    '',
    `Generated at: ${ledger.generatedAt}`,
    '',
    '| Order | Package | Version | Prerequisites | Tarball | Integrity | Files |',
    '| ---: | --- | --- | --- | --- | --- | ---: |',
  ];

  for (const item of ledger.packages) {
    lines.push(
      `| ${item.order} | ${item.name} | ${item.version} | ${
        item.prerequisites.join(', ') || 'none'
      } | ${item.tarball} | ${item.integrity} | ${item.files.length} |`,
    );
  }

  for (const item of ledger.packages) {
    lines.push('', `## ${item.order}. ${item.name}`, '');
    for (const file of item.files) lines.push(`- ${file}`);
  }

  return `${lines.join('\n')}\n`;
}

function isFileSystemRoot(filePath) {
  return path.dirname(filePath) === filePath;
}

function isWithinDirectory(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return (
    relative !== '' &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== '..' &&
    !path.isAbsolute(relative)
  );
}

function resolveReleaseDirectory(repoRoot, outputDirectory) {
  const root = path.resolve(repoRoot);
  if (isFileSystemRoot(root)) {
    throw new Error(`Repository root must not be a filesystem root: ${root}`);
  }
  const realRoot = fs.realpathSync(root);
  if (isFileSystemRoot(realRoot)) {
    throw new Error(
      `Real repository root must not be a filesystem root: ${realRoot}`,
    );
  }
  const expected = path.join(root, releaseDirectoryName);
  const resolved = path.resolve(outputDirectory ?? expected);

  if (resolved !== expected || resolved === root) {
    throw new Error(
      `Invalid release output directory; expected exact repository child ${expected}`,
    );
  }

  try {
    const outputStatus = fs.lstatSync(resolved);
    if (!outputStatus.isDirectory() && !outputStatus.isSymbolicLink()) {
      throw new Error(`Release output path is not a directory: ${resolved}`);
    }
    const realOutput = fs.realpathSync(resolved);
    if (!isWithinDirectory(realRoot, realOutput)) {
      throw new Error(
        `Release output resolves outside the real repository: ${realOutput}`,
      );
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  return resolved;
}

function resolveStagingDirectory(repoRoot, stagingDirectory) {
  const root = path.resolve(repoRoot);
  const resolved = path.resolve(stagingDirectory);
  const stagingPrefix = `${releaseDirectoryName}-stage-`;
  if (
    path.dirname(resolved) !== root ||
    !path.basename(resolved).startsWith(stagingPrefix) ||
    path.basename(resolved) === stagingPrefix
  ) {
    throw new Error(
      `Invalid staging directory outside the real repository staging namespace: ${resolved}`,
    );
  }

  const stagingStatus = fs.lstatSync(resolved);
  if (!stagingStatus.isDirectory() && !stagingStatus.isSymbolicLink()) {
    throw new Error(`Release staging path is not a directory: ${resolved}`);
  }
  const realRoot = fs.realpathSync(root);
  const realStaging = fs.realpathSync(resolved);
  if (!isWithinDirectory(realRoot, realStaging)) {
    throw new Error(
      `Release staging resolves outside the real repository: ${realStaging}`,
    );
  }
  return resolved;
}

async function defaultRunCommand(command, args, options) {
  await execa(command, args, {...options, stdio: 'inherit'});
}

async function defaultInspectTarball(tarballPath) {
  const {stdout: listing} = await execa(
    'tar',
    localTarArguments(['-tzf', tarballPath], [1]),
  );
  const files = listing
    .split(/\r?\n/u)
    .map(file => file.replace(/^\.\//u, ''))
    .filter(Boolean);
  if (!files.includes('package/package.json')) {
    throw new Error(
      `Packed tarball is missing package/package.json: ${tarballPath}`,
    );
  }

  const {stdout: manifestText} = await execa(
    'tar',
    localTarArguments(['-xOzf', tarballPath, 'package/package.json'], [1]),
  );
  return {files, manifest: JSON.parse(manifestText)};
}

async function defaultMakeStagingDirectory(repoRoot) {
  return fs.promises.mkdtemp(
    path.join(repoRoot, `${releaseDirectoryName}-stage-`),
  );
}

async function promoteReleaseDirectory({
  releaseDirectory,
  repoRoot,
  stagingDirectory,
}) {
  resolveReleaseDirectory(repoRoot, releaseDirectory);
  const previousDirectory = `${releaseDirectory}.previous-${randomUUID()}`;
  let movedPrevious = false;

  try {
    try {
      await fs.promises.rename(releaseDirectory, previousDirectory);
      movedPrevious = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    await fs.promises.rename(stagingDirectory, releaseDirectory);
  } catch (error) {
    if (movedPrevious) {
      await fs.promises.rename(previousDirectory, releaseDirectory);
    }
    throw error;
  }

  if (movedPrevious) {
    await fs.promises.rm(previousDirectory, {force: true, recursive: true});
  }
}

export async function runPublishDryCommand({
  audit = auditRepository,
  baseline = defaultBaseline,
  buildGraph = buildRuntimeReleaseGraph,
  inspectTarball = defaultInspectTarball,
  inventory,
  makeStagingDirectory = defaultMakeStagingDirectory,
  orderGraph = topologicalReleaseOrder,
  outputDirectory,
  repackTarball = repackReleaseArtifact,
  repoRoot = defaultRepoRoot,
  runCommand = defaultRunCommand,
  write = console.log,
  writeFile = fs.promises.writeFile,
} = {}) {
  const root = path.resolve(repoRoot);
  const releaseDirectory = resolveReleaseDirectory(root, outputDirectory);
  const packageInventory =
    inventory ?? inventoryFromBaseline({baseline, repoRoot: root});
  const findings = audit({
    baseline,
    inventory: packageInventory,
    repoRoot: root,
  });
  if (findings.length > 0) {
    throw new Error(
      `Package identity audit failed with ${findings.length} finding(s)`,
    );
  }

  const graph = buildGraph(packageInventory);
  const order = orderGraph(graph);

  const stagingDirectory = resolveStagingDirectory(
    root,
    await makeStagingDirectory(root),
  );
  let ledger;
  let primaryError;
  try {
    const artifacts = [];
    for (const name of order) {
      const workspace = packageInventory.byNewName.get(name);
      if (!workspace || workspace.publishable === false) {
        throw new Error(`Release workspace missing or private: ${name}`);
      }

      const tarballName = `${name.slice(1).replace('/', '-')}-${
        workspace.version
      }.tgz`;
      const finalTarballPath = path.posix.join(
        releaseDirectoryName,
        tarballName,
      );
      const rawTarballPath = path.join(
        stagingDirectory,
        tarballName.replace(/\.tgz$/u, '.raw-packed.tgz'),
      );
      const stagedFinalTarballPath = path.join(stagingDirectory, tarballName);
      let rawFailure;
      try {
        await runCommand(
          'yarn',
          ['workspace', name, 'pack', '--out', rawTarballPath],
          {cwd: root},
        );

        const rawPacked = await inspectTarball(rawTarballPath);
        inspectPackedManifest({
          baseline,
          manifest: rawPacked.manifest,
          workspace,
        });
        await repackTarball({
          finalTarballPath: stagedFinalTarballPath,
          licensePath: path.join(root, 'LICENSE'),
          packageName: name,
          rawTarballPath,
          stagingDirectory,
        });
        const finalPacked = await inspectTarball(stagedFinalTarballPath);
        if (!isDeepStrictEqual(rawPacked.manifest, finalPacked.manifest)) {
          throw new Error(`Packed manifest changed after repacking: ${name}`);
        }
        const fileComparison = comparePackageFiles({
          actualFiles: finalPacked.files,
          expectedFiles: rawPacked.files,
        });
        if (
          fileComparison.added.some(file => file !== 'LICENSE') ||
          fileComparison.missing.length > 0
        ) {
          throw new Error(
            `Packed file inventory changed after repacking: ${name}`,
          );
        }
        const releaseFiles = validateReleaseFiles({
          files: finalPacked.files,
          helper: isHelperReleasePackageName(name),
          manifest: finalPacked.manifest,
          packageName: name,
        });
        const bytes = await fs.promises.readFile(stagedFinalTarballPath);
        artifacts.push({
          files: releaseFiles,
          integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
          name,
          prerequisites: [...(graph.get(name) ?? [])],
          tarball: finalTarballPath,
          version: workspace.version,
        });
      } catch (error) {
        rawFailure = error;
      }
      let rawCleanupError;
      try {
        await fs.promises.rm(rawTarballPath, {force: true});
      } catch (error) {
        rawCleanupError = error;
      }
      if (rawFailure) throw rawFailure;
      if (rawCleanupError) throw rawCleanupError;
    }

    ledger = createReleaseLedger({artifacts, order});
    await writeFile(
      path.join(stagingDirectory, 'release-ledger.json'),
      `${JSON.stringify(ledger, null, 2)}\n`,
    );
    await writeFile(
      path.join(stagingDirectory, 'release-ledger.md'),
      releaseMarkdown(ledger),
    );
    await promoteReleaseDirectory({
      releaseDirectory,
      repoRoot: root,
      stagingDirectory,
    });
  } catch (error) {
    primaryError = error;
  }
  let cleanupError;
  try {
    await fs.promises.rm(stagingDirectory, {force: true, recursive: true});
  } catch (error) {
    cleanupError = error;
  }
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
  write(`Packed ${ledger.packages.length} pkg-nec release artifact(s).`);
  write(
    `Release ledger: ${path.join(releaseDirectory, 'release-ledger.json')}`,
  );
  return ledger;
}

const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  try {
    await runPublishDryCommand();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
