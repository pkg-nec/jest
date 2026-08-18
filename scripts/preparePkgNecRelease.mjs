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
import {createPackageInventory} from './pkgNecPackageIdentity.mjs';

const dependencyFields = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'peerDependenciesMeta',
];
const releaseDirectoryName = '.pkg-nec-release';
const defaultRepoRoot = path.resolve(
  fileURLToPath(new URL('..', import.meta.url)),
);
const defaultPolicy = JSON.parse(
  fs.readFileSync(
    new URL('pkgNec/packageIdentityPolicy.json', import.meta.url),
    'utf8',
  ),
);

function containsLocalLink(value) {
  if (typeof value === 'string') {
    return ['file:', 'link:', 'workspace:'].some(protocol =>
      value.startsWith(protocol),
    );
  }
  if (value === null || typeof value !== 'object') return false;
  return Object.values(value).some(containsLocalLink);
}

function isSha512Integrity(integrity) {
  return typeof integrity === 'string' && /^sha512-\S+$/u.test(integrity);
}

function expectSameKeys({actual, expected, field, workspace}) {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (!isDeepStrictEqual(actualKeys, expectedKeys)) {
    throw new Error(`${workspace.newName} changed ${field} dependency keys`);
  }
}

export function inspectPackedManifest({
  inventory,
  manifest,
  workspace,
  workspaceManifest,
}) {
  if (!manifest || typeof manifest !== 'object') {
    throw new TypeError(`Packed manifest missing for ${workspace?.newName}`);
  }
  if (manifest.name !== workspace.newName) {
    throw new Error(
      `Packed manifest name changed for ${workspace.newName}: ${manifest.name}`,
    );
  }
  if (manifest.version !== workspaceManifest.version) {
    throw new Error(
      `Packed manifest version changed for ${workspace.newName}: ${manifest.version}`,
    );
  }
  if (manifest.private === true) {
    throw new Error(`Packed manifest is private: ${workspace.newName}`);
  }
  for (const field of dependencyFields) {
    const source = workspaceManifest[field] ?? {};
    const packed = manifest[field] ?? {};
    expectSameKeys({actual: packed, expected: source, field, workspace});

    for (const [name, sourceValue] of Object.entries(source)) {
      if (
        typeof sourceValue !== 'string' ||
        !sourceValue.startsWith('workspace:')
      ) {
        if (!isDeepStrictEqual(packed[name], sourceValue)) {
          throw new Error(`${workspace.newName} changed ${field}.${name}`);
        }
        continue;
      }

      const target = inventory.byNewName.get(name);
      if (!target) {
        throw new Error(
          `${workspace.newName} has an unknown workspace dependency: ${name}`,
        );
      }
      const protocol = sourceValue.slice('workspace:'.length);
      const allowed =
        protocol === '*'
          ? new Set([target.version, `=${target.version}`])
          : protocol === '^'
            ? new Set([`^${target.version}`])
            : protocol === '~'
              ? new Set([`~${target.version}`])
              : new Set([protocol]);
      if (!allowed.has(packed[name])) {
        throw new Error(`${workspace.newName} changed ${field}.${name}`);
      }
    }

    for (const [name, value] of Object.entries(packed)) {
      if (containsLocalLink(value)) {
        throw new Error(
          `${workspace.newName} contains a local dependency link in ${field}.${name}`,
        );
      }
    }
  }
}

export function createReleaseLedger({
  artifacts,
  generatedAt,
  nodeVersion,
  order,
  packageManager,
  sourceCommit,
}) {
  const artifactNames = new Set();
  for (const artifact of artifacts) {
    if (artifactNames.has(artifact.name)) {
      throw new Error(`Duplicate prepared artifact: ${artifact.name}`);
    }
    artifactNames.add(artifact.name);
    if (!isSha512Integrity(artifact.integrity)) {
      throw new TypeError(
        `Invalid prepared artifact integrity for ${artifact.name}`,
      );
    }
  }

  const artifactsByName = new Map(artifacts.map(item => [item.name, item]));
  const packages = order.map((name, index) => {
    const artifact = artifactsByName.get(name);
    if (!artifact) {
      throw new Error(`Missing prepared artifact for ${name}`);
    }
    return {...artifact, order: index + 1};
  });
  if (artifactsByName.size !== packages.length) {
    throw new Error('Prepared artifacts do not match the release order');
  }

  return {
    generatedAt,
    nodeVersion,
    packageManager,
    packages,
    schemaVersion: 1,
    sourceCommit,
  };
}

function releaseMarkdown(ledger) {
  const lines = [
    '# pkg-nec Release Ledger',
    '',
    `Schema version: ${ledger.schemaVersion}`,
    `Generated at: ${ledger.generatedAt}`,
    `Source commit: ${ledger.sourceCommit}`,
    `Node: ${ledger.nodeVersion}`,
    `Package manager: ${ledger.packageManager}`,
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

async function defaultReadSourceCommit(root) {
  const {stdout} = await execa('git', ['rev-parse', 'HEAD'], {cwd: root});
  return stdout.trim();
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
      try {
        await fs.promises.rename(previousDirectory, releaseDirectory);
      } catch (rollbackError) {
        error.backupPath = previousDirectory;
        error.rollbackError = rollbackError;
      }
    }
    throw error;
  }

  if (movedPrevious) {
    await fs.promises.rm(previousDirectory, {force: true, recursive: true});
  }
}

export async function runPrepareReleaseCommand({
  audit = auditRepository,
  buildGraph = buildRuntimeReleaseGraph,
  inspectTarball = defaultInspectTarball,
  inventory,
  makeStagingDirectory = defaultMakeStagingDirectory,
  orderGraph = topologicalReleaseOrder,
  outputDirectory,
  policy = defaultPolicy,
  readSourceCommit = defaultReadSourceCommit,
  repackTarball = repackReleaseArtifact,
  repoRoot = defaultRepoRoot,
  runCommand = defaultRunCommand,
  write = console.log,
  writeFile = fs.promises.writeFile,
} = {}) {
  const root = path.resolve(repoRoot);
  const releaseDirectory = resolveReleaseDirectory(root, outputDirectory);
  const packageInventory =
    inventory ?? createPackageInventory({policy, repoRoot: root});
  const findings = audit({
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
        const workspaceManifest = JSON.parse(
          fs.readFileSync(workspace.manifestPath, 'utf8'),
        );
        await runCommand(
          'yarn',
          ['workspace', name, 'pack', '--out', rawTarballPath],
          {cwd: root},
        );

        const rawPacked = await inspectTarball(rawTarballPath);
        inspectPackedManifest({
          inventory: packageInventory,
          manifest: rawPacked.manifest,
          workspace,
          workspaceManifest,
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

    const rootManifest = JSON.parse(
      fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
    );
    ledger = createReleaseLedger({
      artifacts,
      generatedAt: new Date().toISOString(),
      nodeVersion: process.version,
      order,
      packageManager: rootManifest.packageManager,
      sourceCommit: await readSourceCommit(root),
    });
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
    await runPrepareReleaseCommand();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
