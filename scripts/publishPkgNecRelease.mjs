/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {gunzipSync} from 'node:zlib';
import execa from 'execa';
import fs from 'graceful-fs';
import {publicationProgressLine} from './pkgNec/publicationProgress.mjs';
import {
  exactRegistryResult,
  isRegistryNotFound,
  redactRegistryFailure,
  waitForExactVersion,
} from './pkgNec/registryVisibility.mjs';
import {
  buildRuntimeReleaseGraph,
  topologicalReleaseOrder,
} from './pkgNec/releaseGraph.mjs';
import {
  publishRelease,
  validateReleaseLedger,
} from './pkgNec/releasePublisher.mjs';
import {createPackageInventory} from './pkgNecPackageIdentity.mjs';
import {inspectPackedManifest} from './preparePkgNecRelease.mjs';

const releaseDirectoryName = '.pkg-nec-release';
const usage =
  'Usage: yarn publish:pkg-nec-release <ledger-path> <journal-path> <release-tag>';
const defaultRepoRoot = path.resolve(
  fileURLToPath(new URL('..', import.meta.url)),
);
const defaultPolicy = JSON.parse(
  fs.readFileSync(
    new URL('pkgNec/packageIdentityPolicy.json', import.meta.url),
    'utf8',
  ),
);

function classifiedError({classification, message}) {
  const error = new Error(message);
  error.classification = classification;
  return error;
}

function validExactRegistryResult(result) {
  return (
    typeof result.integrity === 'string' &&
    result.integrity.length > 0 &&
    typeof result.name === 'string' &&
    result.name.length > 0 &&
    typeof result.version === 'string' &&
    result.version.length > 0
  );
}

export async function inspectRegistryEntry(entry, runNpm = execa) {
  let result;
  try {
    result = await runNpm('npm', [
      'view',
      `${entry.name}@${entry.version}`,
      '--json',
      '--registry=https://registry.npmjs.org/',
    ]);
  } catch (error) {
    if (isRegistryNotFound(error)) return {kind: 'absent'};
    throw classifiedError({
      classification: 'fatal',
      message: `Fatal npm view for ${entry.name}@${entry.version}: ${redactRegistryFailure(error)}`,
    });
  }

  try {
    const exact = exactRegistryResult(result);
    if (!validExactRegistryResult(exact)) {
      throw new TypeError('Registry response omitted exact package metadata');
    }
    return {kind: 'present', ...exact};
  } catch (error) {
    throw classifiedError({
      classification: 'fatal',
      message: `Fatal npm view for ${entry.name}@${entry.version}: ${redactRegistryFailure(error)}`,
    });
  }
}

function isExplicitVersionConflict(error) {
  if (String(error?.code ?? '').toUpperCase() === 'EPUBLISHCONFLICT') {
    return true;
  }
  return /\b(?:cannot|can't) publish over (?:the )?previously published versions?\b/iu.test(
    redactRegistryFailure(error),
  );
}

export async function publishRegistryEntry(entry, runNpm = execa) {
  try {
    await runNpm('npm', [
      'publish',
      entry.tarball,
      '--access',
      'public',
      '--provenance',
      '--registry=https://registry.npmjs.org/',
    ]);
  } catch (error) {
    const classification = isExplicitVersionConflict(error)
      ? 'version-conflict'
      : 'fatal';
    throw classifiedError({
      classification,
      message: `Fatal npm publish for ${entry.name}@${entry.version}: ${redactRegistryFailure(error)}`,
    });
  }
}

export async function verifyRegistryConflict(entry) {
  return waitForExactVersion({
    expectedIntegrity: entry.integrity,
    name: entry.name,
    query: (args, options) => execa('npm', args, options),
    version: entry.version,
  });
}

function isWithinDirectory(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function resolveReleasePath({label, releaseDirectory, repoRoot, value}) {
  const resolved = path.resolve(repoRoot, value);
  if (!isWithinDirectory(releaseDirectory, resolved)) {
    throw new Error(`Invalid ${label} path: ${value}`);
  }
  return resolved;
}

async function realPathWithin({
  candidate,
  label,
  missingMessage,
  realReleaseDirectory,
  realpath,
}) {
  let realCandidate;
  try {
    realCandidate = await realpath(candidate);
  } catch (error) {
    if (error?.code === 'ENOENT' && missingMessage) {
      throw new Error(missingMessage);
    }
    throw error;
  }
  if (!isWithinDirectory(realReleaseDirectory, realCandidate)) {
    throw new Error(`Invalid ${label} path: ${candidate}`);
  }
  return realCandidate;
}

async function canonicalOutputPath({
  candidate,
  label,
  realReleaseDirectory,
  realpath,
}) {
  const realParent = await realpath(path.dirname(candidate));
  const expectedPath = path.join(realParent, path.basename(candidate));
  if (!isWithinDirectory(realReleaseDirectory, expectedPath)) {
    throw new Error(`Invalid ${label} path: ${candidate}`);
  }

  let existingPath;
  try {
    existingPath = await realpath(candidate);
  } catch (error) {
    if (error?.code === 'ENOENT') return expectedPath;
    throw error;
  }
  if (
    !isWithinDirectory(realReleaseDirectory, existingPath) ||
    existingPath !== expectedPath
  ) {
    throw new Error(`Invalid ${label} path: ${candidate}`);
  }
  return expectedPath;
}

function tarString(buffer, start, length) {
  const end = buffer.indexOf(0, start);
  const boundary = end === -1 || end > start + length ? start + length : end;
  return buffer.subarray(start, boundary).toString('utf8');
}

function validTarChecksum(header) {
  const checksumText = tarString(header, 148, 8).trim();
  if (!/^[0-7]+$/u.test(checksumText)) return false;
  const expected = Number.parseInt(checksumText, 8);
  let actual = 0;
  for (const [index, value] of header.entries()) {
    actual += index >= 148 && index < 156 ? 0x20 : value;
  }
  return actual === expected;
}

function packedManifestFromTarball(tarballBytes, packageName) {
  let archive;
  try {
    archive = gunzipSync(tarballBytes);
  } catch {
    throw new Error(
      `Prepared artifact is not a gzip archive for ${packageName}`,
    );
  }

  const manifests = [];
  let foundEnd = false;
  for (let offset = 0; offset + 512 <= archive.length; ) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every(value => value === 0)) {
      const secondEndBlock = archive.subarray(offset + 512, offset + 1024);
      const trailing = archive.subarray(offset + 1024);
      if (
        secondEndBlock.length !== 512 ||
        secondEndBlock.some(value => value !== 0) ||
        trailing.some(value => value !== 0)
      ) {
        throw new Error(
          `Prepared artifact has an invalid tar terminator for ${packageName}`,
        );
      }
      foundEnd = true;
      break;
    }
    if (!validTarChecksum(header)) {
      throw new Error(
        `Prepared artifact has an invalid tar checksum for ${packageName}`,
      );
    }
    const magic = header.subarray(257, 263).toString('ascii');
    if (magic !== 'ustar\0' && magic !== 'ustar ') {
      throw new Error(
        `Prepared artifact has an invalid tar header for ${packageName}`,
      );
    }
    const type = tarString(header, 156, 1);
    if (new Set(['x', 'g', 'L', 'K', 'N', 'X']).has(type)) {
      throw new Error(
        `Prepared artifact contains unsupported tar extension ${type} for ${packageName}`,
      );
    }
    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const archivePath = `${prefix ? `${prefix}/` : ''}${name}`.replace(
      /^\.\//u,
      '',
    );
    const sizeText = tarString(header, 124, 12).trim();
    if (!/^[0-7]+$/u.test(sizeText)) {
      throw new Error(
        `Prepared artifact has an invalid tar header for ${packageName}`,
      );
    }
    const size = Number.parseInt(sizeText, 8);
    const contentsStart = offset + 512;
    const contentsEnd = contentsStart + size;
    if (!Number.isSafeInteger(size) || contentsEnd > archive.length) {
      throw new Error(
        `Prepared artifact has an invalid tar size for ${packageName}`,
      );
    }
    if (archivePath === 'package/package.json') {
      if (type !== '' && type !== '0') {
        throw new Error(
          `Prepared artifact package manifest is not a regular file for ${packageName}`,
        );
      }
      manifests.push(archive.subarray(contentsStart, contentsEnd));
    }
    offset = contentsStart + Math.ceil(size / 512) * 512;
  }
  if (!foundEnd) {
    throw new Error(
      `Prepared artifact has an invalid tar terminator for ${packageName}`,
    );
  }
  if (manifests.length !== 1) {
    throw new Error(
      `Prepared artifact must contain one package/package.json for ${packageName}`,
    );
  }
  try {
    return JSON.parse(manifests[0].toString('utf8'));
  } catch {
    throw new Error(`Prepared artifact manifest is invalid for ${packageName}`);
  }
}

function commandArguments(args) {
  if (
    args.length !== 3 ||
    args.some(value => typeof value !== 'string' || value.length === 0)
  ) {
    throw new Error(usage);
  }
  return {
    journalArgument: args[1],
    ledgerArgument: args[0],
    releaseTag: args[2],
  };
}

async function defaultRunGit(args, options) {
  return execa('git', args, options);
}

export async function runPublishReleaseCommand({
  args = process.argv.slice(2),
  inspect = inspectRegistryEntry,
  inventory,
  now = Date.now,
  policy = defaultPolicy,
  publish = publishRegistryEntry,
  readFile = fs.promises.readFile,
  realpath = fs.promises.realpath,
  rename = fs.promises.rename,
  repoRoot = defaultRepoRoot,
  runGit = defaultRunGit,
  verifyConflict = verifyRegistryConflict,
  write = console.log,
  writeFile = fs.promises.writeFile,
} = {}) {
  const {journalArgument, ledgerArgument, releaseTag} = commandArguments(args);
  const root = path.resolve(repoRoot);
  const releaseDirectory = path.join(root, releaseDirectoryName);
  const ledgerPath = resolveReleasePath({
    label: 'release ledger',
    releaseDirectory,
    repoRoot: root,
    value: ledgerArgument,
  });
  const journalPath = resolveReleasePath({
    label: 'publication journal',
    releaseDirectory,
    repoRoot: root,
    value: journalArgument,
  });
  const temporaryJournalPath = `${journalPath}.tmp`;
  if (journalPath === ledgerPath) {
    throw new Error(
      'Publication journal path must differ from the release ledger',
    );
  }
  if (temporaryJournalPath === ledgerPath) {
    throw new Error(
      'Publication journal temp path conflicts with release input',
    );
  }

  const [realRoot, realReleaseDirectory] = await Promise.all([
    realpath(root),
    realpath(releaseDirectory),
  ]);
  if (!isWithinDirectory(realRoot, realReleaseDirectory)) {
    throw new Error(`Invalid release directory path: ${releaseDirectory}`);
  }
  const realLedgerPath = await realPathWithin({
    candidate: ledgerPath,
    label: 'release ledger',
    missingMessage: `Release ledger missing: ${ledgerArgument}`,
    realReleaseDirectory,
    realpath,
  });
  const [realJournalPath, realTemporaryJournalPath] = await Promise.all([
    canonicalOutputPath({
      candidate: journalPath,
      label: 'publication journal',
      realReleaseDirectory,
      realpath,
    }),
    canonicalOutputPath({
      candidate: temporaryJournalPath,
      label: 'publication journal temp',
      realReleaseDirectory,
      realpath,
    }),
  ]);
  const canonicalOccupiedPaths = new Set([
    realLedgerPath,
    realJournalPath,
    realTemporaryJournalPath,
  ]);
  if (canonicalOccupiedPaths.size !== 3) {
    throw new Error('Publication path aliases release input');
  }

  const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'));
  validateReleaseLedger({ledger, releaseTag});

  const tagResult = await runGit(['rev-list', '-n', '1', releaseTag], {
    cwd: root,
  });
  const tagCommit = String(tagResult?.stdout ?? tagResult).trim();
  if (tagCommit !== ledger.sourceCommit) {
    throw new Error(
      'Release ledger source commit does not match the release tag',
    );
  }

  const packageInventory =
    inventory ?? createPackageInventory({policy, repoRoot: root});
  const graph = buildRuntimeReleaseGraph(packageInventory);
  const expectedOrder = topologicalReleaseOrder(graph);
  const actualOrder = ledger.packages.map(entry => entry.name);
  if (!isDeepStrictEqual(actualOrder, expectedOrder)) {
    throw new Error('Release ledger is not in dependency-first order');
  }

  const preparedEntries = [];
  const occupiedPaths = new Set([
    ledgerPath,
    journalPath,
    temporaryJournalPath,
  ]);
  for (const entry of ledger.packages) {
    const workspace = packageInventory.byNewName.get(entry.name);
    if (!workspace || workspace.publishable === false) {
      throw new Error(`Release workspace missing or private: ${entry.name}`);
    }
    if (
      !isDeepStrictEqual(entry.prerequisites, [
        ...(graph.get(entry.name) ?? []),
      ])
    ) {
      throw new Error(`Release prerequisites changed for ${entry.name}`);
    }

    let tarballPath;
    try {
      tarballPath = resolveReleasePath({
        label: 'prepared artifact',
        releaseDirectory,
        repoRoot: root,
        value: entry.tarball,
      });
    } catch {
      throw new Error(`Invalid prepared artifact path for ${entry.name}`);
    }
    if (occupiedPaths.has(tarballPath)) {
      throw new Error(`Prepared artifact path is reused for ${entry.name}`);
    }
    occupiedPaths.add(tarballPath);
    const realTarballPath = await realPathWithin({
      candidate: tarballPath,
      label: `prepared artifact for ${entry.name}`,
      missingMessage: `Prepared artifact missing for ${entry.name}`,
      realReleaseDirectory,
      realpath,
    });
    if (canonicalOccupiedPaths.has(realTarballPath)) {
      throw new Error('Publication path aliases release input');
    }
    canonicalOccupiedPaths.add(realTarballPath);

    const workspaceManifest = JSON.parse(
      await readFile(workspace.manifestPath, 'utf8'),
    );
    if (
      workspace.version !== entry.version ||
      workspaceManifest.version !== entry.version
    ) {
      throw new Error(
        `Release ledger version does not match source for ${entry.name}`,
      );
    }
    let tarballBytes;
    try {
      tarballBytes = await readFile(tarballPath);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new Error(`Prepared artifact missing for ${entry.name}`);
      }
      throw error;
    }
    const actualIntegrity = `sha512-${createHash('sha512')
      .update(tarballBytes)
      .digest('base64')}`;
    if (actualIntegrity !== entry.integrity) {
      throw new Error(`Prepared artifact integrity mismatch for ${entry.name}`);
    }

    inspectPackedManifest({
      expectedRepositoryDirectory: path
        .relative(root, path.dirname(workspace.manifestPath))
        .split(path.sep)
        .join('/'),
      expectedVersion: entry.version,
      inventory: packageInventory,
      manifest: packedManifestFromTarball(tarballBytes, entry.name),
      workspace,
      workspaceManifest,
    });
    preparedEntries.push({...entry, tarball: tarballPath});
  }

  const preparedLedger = {...ledger, packages: preparedEntries};
  const persistJournal = async journal => {
    await writeFile(
      temporaryJournalPath,
      `${JSON.stringify(journal, null, 2)}\n`,
    );
    await rename(temporaryJournalPath, journalPath);
  };
  const onProgress = event => write(publicationProgressLine(event));
  const journal = await publishRelease({
    inspect,
    ledger: preparedLedger,
    now,
    onProgress,
    persistJournal,
    publish,
    releaseTag,
    verifyConflict,
  });
  write(`Published ${journal.packages.length} pkg-nec release artifact(s).`);
  return journal;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    await runPublishReleaseCommand();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
