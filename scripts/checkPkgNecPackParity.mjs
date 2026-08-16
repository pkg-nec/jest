/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {randomUUID} from 'node:crypto';
import {
  readFile as defaultReadFile,
  mkdtemp,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import execa from 'execa';
import {classifyRegistryError} from './pkgNec/registryVisibility.mjs';
import {
  comparePackageFiles,
  isHelperReleasePackageName,
  normalizePackageFiles,
  validateReleaseFiles,
} from './pkgNec/releaseArtifactPolicy.mjs';
import {canonicalName} from './pkgNecPackageIdentity.mjs';

const publicRegistry = 'https://registry.npmjs.org/';
const defaultRepoRoot = path.resolve(
  fileURLToPath(new URL('..', import.meta.url)),
);
const defaultBaseline = JSON.parse(
  await defaultReadFile(
    new URL('pkgNec/upstreamManifestBaseline.json', import.meta.url),
    'utf8',
  ),
);
const publishablePrivatePackages = new Set([
  '@jest/test-globals',
  '@jest/test-utils',
]);

function redactRegistryError(value) {
  return String(value ?? '')
    .replaceAll(
      /(authorization\s*[:=]\s*)(?:basic|bearer)?\s*[^\s,;]+/gi,
      '$1[REDACTED]',
    )
    .replaceAll(
      /((?:_authToken|_auth|_password)\s*[:=]\s*)[^\s,;]+/gi,
      '$1[REDACTED]',
    )
    .replaceAll(/\b(?:basic|bearer)\s+[^\s,;]+/gi, '[REDACTED]')
    .replaceAll(/npm_[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replaceAll(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@');
}

function registryAdapterError({error, operation, packageName}) {
  const classification = classifyRegistryError(error);
  const details = redactRegistryError(
    error?.stderr ?? error?.message ?? error?.stdout,
  );
  const message = `${operation} failed for ${packageName} (${classification})${
    details ? `: ${details}` : ''
  }`;
  return new Error(message);
}

function normalizeAdapterFailure({error, operation, packageName}) {
  if (
    error instanceof Error &&
    error.message.startsWith(`${operation} failed for ${packageName} (`)
  ) {
    return new Error(redactRegistryError(error.message));
  }
  return registryAdapterError({error, operation, packageName});
}

function parseJson(value, description) {
  try {
    return JSON.parse(value);
  } catch {
    throw new TypeError(`${description} returned malformed JSON`);
  }
}

export function parseNpmPackResult({oldName, output, version}) {
  const packed = parseJson(output, `npm pack for ${oldName}@${version}`);
  if (
    !Array.isArray(packed) ||
    packed.length !== 1 ||
    !Array.isArray(packed[0]?.files) ||
    !packed[0].files.every(file => typeof file?.path === 'string')
  ) {
    throw new TypeError(
      `npm pack for ${oldName}@${version} returned an invalid result`,
    );
  }
  return {files: packed[0].files.map(file => file.path)};
}

async function defaultQueryLatest(oldName) {
  try {
    const {stdout} = await execa('npm', [
      'view',
      oldName,
      'dist-tags.latest',
      '--json',
      `--registry=${publicRegistry}`,
    ]);
    const latest = parseJson(stdout, `npm view for ${oldName}`);
    if (typeof latest !== 'string' || latest.length === 0) {
      throw new TypeError(`npm view for ${oldName} returned no latest version`);
    }
    return latest;
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw registryAdapterError({
      error,
      operation: 'npm view',
      packageName: oldName,
    });
  }
}

async function defaultPackUpstream(oldName, version, destination) {
  try {
    const {stdout} = await execa('npm', [
      'pack',
      `${oldName}@${version}`,
      '--ignore-scripts',
      '--json',
      `--registry=${publicRegistry}`,
      `--pack-destination=${destination}`,
    ]);
    return parseNpmPackResult({oldName, output: stdout, version});
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw registryAdapterError({
      error,
      operation: 'npm pack',
      packageName: oldName,
    });
  }
}

async function defaultMakeTemporaryDirectory() {
  return mkdtemp(path.join(tmpdir(), 'pkg-nec-pack-parity-'));
}

function baselineIdentities(baseline) {
  const identities = new Map();
  for (const [manifestPath, record] of Object.entries(baseline)) {
    if (
      typeof record?.name !== 'string' ||
      typeof record?.version !== 'string'
    ) {
      throw new TypeError(`Invalid manifest baseline record: ${manifestPath}`);
    }
    const localName = canonicalName(record.name, {
      isRoot: manifestPath === 'package.json',
    });
    if (identities.has(localName)) {
      throw new Error(`Canonical package name collision: ${localName}`);
    }
    if (
      record.private === true &&
      !publishablePrivatePackages.has(record.name)
    ) {
      continue;
    }
    identities.set(localName, {
      localName,
      manifestPath,
      oldName: record.name,
      version: record.version,
    });
  }
  return identities;
}

function validateLedger(ledger, identities) {
  if (!Array.isArray(ledger?.packages)) {
    throw new TypeError('Release ledger is missing packages');
  }
  const seen = new Set();
  for (const entry of ledger.packages) {
    if (
      typeof entry?.name !== 'string' ||
      typeof entry?.version !== 'string' ||
      !Array.isArray(entry?.files)
    ) {
      throw new TypeError('Release ledger contains an invalid package entry');
    }
    if (seen.has(entry.name)) {
      throw new Error(`Duplicate release ledger package: ${entry.name}`);
    }
    seen.add(entry.name);
    if (!identities.has(entry.name)) {
      throw new Error(`Unexpected release ledger package: ${entry.name}`);
    }
    if (entry.version !== identities.get(entry.name).version) {
      throw new Error(
        `Release ledger version changed for ${entry.name}: ${entry.version}`,
      );
    }
  }
  const missing = [...identities.keys()].filter(name => !seen.has(name));
  if (missing.length > 0) {
    throw new Error(`Release ledger missing package(s): ${missing.join(', ')}`);
  }
}

function parityResult({
  comparison,
  identity,
  localFiles,
  status,
  upstreamVersion,
}) {
  return {
    added: comparison.added,
    localCount: localFiles.length,
    localName: identity.localName,
    localVersion: identity.version,
    missing: comparison.missing,
    oldName: identity.oldName,
    status,
    upstreamCount: comparison.expectedCount,
    upstreamVersion,
  };
}

function errorResult({error, identity, localFiles, upstreamVersion = null}) {
  return {
    added: [],
    error: redactRegistryError(
      error instanceof Error ? error.message : String(error),
    ),
    localCount: localFiles.length,
    localName: identity.localName,
    localVersion: identity.version,
    missing: [],
    oldName: identity.oldName,
    status: 'error',
    upstreamCount: null,
    upstreamVersion,
  };
}

function versionMismatchResult({identity, localFiles, upstreamVersion}) {
  return {
    added: [],
    localCount: localFiles.length,
    localName: identity.localName,
    localVersion: identity.version,
    missing: [],
    oldName: identity.oldName,
    status: 'version-mismatch',
    upstreamCount: null,
    upstreamVersion,
  };
}

function markdownPaths(paths) {
  return paths.length === 0 ? 'none' : paths.join('<br>');
}

function markdownError(error) {
  return String(error)
    .replaceAll('\\', '\\\\')
    .replaceAll('|', '\\|')
    .replaceAll(/\r\n?|\n/g, '<br>');
}

function statusCounts(results) {
  return [
    ...results.reduce((counts, item) => {
      counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
      return counts;
    }, new Map()),
  ]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => `${status}=${count}`)
    .join(', ');
}

export function parityMarkdown(report, reportPaths) {
  const lines = [
    '# pkg-nec Upstream Pack Parity',
    '',
    `Generated at: ${report.generatedAt}`,
    '',
    '| Local package | Upstream package | Local version | Latest upstream | Status | Local files | Upstream files | Missing | Added | Error |',
    '| --- | --- | --- | --- | --- | ---: | ---: | --- | --- | --- |',
  ];
  for (const item of report.packages) {
    lines.push(
      `| ${item.localName} | ${item.oldName} | ${item.localVersion} | ${
        item.upstreamVersion ?? 'n/a'
      } | ${item.status} | ${item.localCount} | ${
        item.upstreamCount ?? 'n/a'
      } | ${markdownPaths(item.missing)} | ${markdownPaths(item.added)} | ${
        item.error ? markdownError(item.error) : 'none'
      } |`,
    );
  }
  if (reportPaths) {
    lines.push(
      '',
      `JSON report: ${reportPaths.jsonPath}`,
      `Markdown report: ${reportPaths.markdownPath}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

async function moveIfPresent({from, renameFile, to}) {
  try {
    await renameFile(from, to);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function writeReportPair({
  report,
  reportDirectory,
  removeFile = rm,
  renameFile = rename,
  writeReportFile = writeFile,
}) {
  const jsonPath = path.join(reportDirectory, 'upstream-parity.json');
  const markdownPath = path.join(reportDirectory, 'upstream-parity.md');
  const token = randomUUID();
  const temporaryJson = path.join(
    reportDirectory,
    `.upstream-parity-${token}.json`,
  );
  const temporaryMarkdown = path.join(
    reportDirectory,
    `.upstream-parity-${token}.md`,
  );
  const backupJson = path.join(
    reportDirectory,
    `.upstream-parity-${token}.json.bak`,
  );
  const backupMarkdown = path.join(
    reportDirectory,
    `.upstream-parity-${token}.md.bak`,
  );
  const reportPaths = {jsonPath, markdownPath};
  const files = [
    [
      jsonPath,
      temporaryJson,
      backupJson,
      `${JSON.stringify(report, null, 2)}\n`,
    ],
    [
      markdownPath,
      temporaryMarkdown,
      backupMarkdown,
      parityMarkdown(report, reportPaths),
    ],
  ];

  const cleanupErrors = [];
  const attemptCleanup = async operation => {
    try {
      await operation();
      return true;
    } catch (error) {
      cleanupErrors.push(error);
      return false;
    }
  };
  const finishFailure = primaryError => {
    if (cleanupErrors.length > 0) primaryError.cleanupErrors = cleanupErrors;
    throw primaryError;
  };

  const writes = await Promise.allSettled(
    files.map(([, temporaryPath, , contents]) =>
      writeReportFile(temporaryPath, contents),
    ),
  );
  const failedWrite = writes.find(result => result.status === 'rejected');
  if (failedWrite) {
    await Promise.all(
      [temporaryJson, temporaryMarkdown].map(filePath =>
        attemptCleanup(() => removeFile(filePath, {force: true})),
      ),
    );
    finishFailure(failedWrite.reason);
  }

  const movedPrevious = [];
  const promoted = [];
  let primaryError;
  try {
    for (const [finalPath, , backupPath] of files) {
      movedPrevious.push(
        await moveIfPresent({from: finalPath, renameFile, to: backupPath}),
      );
    }
    for (const [finalPath, temporaryPath] of files) {
      await renameFile(temporaryPath, finalPath);
      promoted.push(finalPath);
    }
  } catch (error) {
    primaryError = error;
    for (let index = files.length - 1; index >= 0; index -= 1) {
      const [finalPath, temporaryPath, backupPath] = files[index];
      if (promoted.includes(finalPath)) {
        await attemptCleanup(() => removeFile(finalPath, {force: true}));
      }
      if (movedPrevious[index]) {
        const restored = await attemptCleanup(() =>
          renameFile(backupPath, finalPath),
        );
        if (!restored) continue;
      }
      await attemptCleanup(() => removeFile(temporaryPath, {force: true}));
    }
    finishFailure(primaryError);
  }

  await Promise.all(
    [temporaryJson, temporaryMarkdown, backupJson, backupMarkdown].map(
      filePath => attemptCleanup(() => removeFile(filePath, {force: true})),
    ),
  );
  if (cleanupErrors.length > 0) {
    const error = new Error('Completed report replacement cleanup failed');
    error.cleanupErrors = cleanupErrors;
    throw error;
  }
  return reportPaths;
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}

function isGeneratedTemporaryDirectory(systemTemporaryDirectory, candidate) {
  return (
    isWithin(systemTemporaryDirectory, candidate) &&
    candidate !== systemTemporaryDirectory &&
    path.basename(candidate).startsWith('pkg-nec-pack-parity-')
  );
}

export async function runPackParityCommand({
  baseline = defaultBaseline,
  ledgerPath,
  makeTemporaryDirectory = defaultMakeTemporaryDirectory,
  packUpstream = defaultPackUpstream,
  queryLatest = defaultQueryLatest,
  readFile = defaultReadFile,
  removeDirectory = rm,
  removeFile = rm,
  rename: renameFile = rename,
  repoRoot = defaultRepoRoot,
  write = console.log,
  writeFile: writeReportFile = writeFile,
} = {}) {
  const root = path.resolve(repoRoot);
  const resolvedLedgerPath = path.resolve(
    ledgerPath ?? path.join(root, '.pkg-nec-release', 'release-ledger.json'),
  );
  const reportDirectory = path.dirname(resolvedLedgerPath);
  const ledger = JSON.parse(await readFile(resolvedLedgerPath, 'utf8'));
  const identities = baselineIdentities(baseline);
  validateLedger(ledger, identities);
  const temporaryDirectory = path.resolve(await makeTemporaryDirectory());
  const systemTemporaryDirectory = path.resolve(tmpdir());
  if (
    !isGeneratedTemporaryDirectory(systemTemporaryDirectory, temporaryDirectory)
  ) {
    throw new Error(
      `Temporary pack directory must be a generated child of the system temp directory: ${temporaryDirectory}`,
    );
  }

  const results = [];
  let completedReport;
  let primaryError;
  try {
    for (const entry of ledger.packages) {
      const identity = identities.get(entry.name);
      const localFiles = normalizePackageFiles(entry.files);
      const helper = isHelperReleasePackageName(identity.localName);
      if (helper) {
        try {
          const manifestPath = path.join(root, identity.manifestPath);
          const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
          validateReleaseFiles({
            files: localFiles,
            helper: true,
            manifest,
            packageName: identity.localName,
          });
          results.push({
            added: [],
            localCount: localFiles.length,
            localName: identity.localName,
            localVersion: identity.version,
            missing: [],
            oldName: identity.oldName,
            status: 'helper-policy',
            upstreamCount: null,
            upstreamVersion: null,
          });
        } catch (error) {
          results.push(errorResult({error, identity, localFiles}));
        }
        continue;
      }

      let upstreamVersion = null;
      try {
        try {
          upstreamVersion = await queryLatest(identity.oldName);
          if (
            typeof upstreamVersion !== 'string' ||
            upstreamVersion.length === 0
          ) {
            throw new TypeError(
              `npm view for ${identity.oldName} returned no latest version`,
            );
          }
        } catch (error) {
          throw normalizeAdapterFailure({
            error,
            operation: 'npm view',
            packageName: identity.oldName,
          });
        }
        if (upstreamVersion !== identity.version) {
          results.push(
            versionMismatchResult({identity, localFiles, upstreamVersion}),
          );
          continue;
        }
        let packed;
        try {
          packed = await packUpstream(
            identity.oldName,
            upstreamVersion,
            temporaryDirectory,
          );
          if (!Array.isArray(packed?.files)) {
            throw new TypeError(
              `npm pack for ${identity.oldName}@${upstreamVersion} returned an invalid result`,
            );
          }
        } catch (error) {
          throw normalizeAdapterFailure({
            error,
            operation: 'npm pack',
            packageName: identity.oldName,
          });
        }
        const comparison = comparePackageFiles({
          actualFiles: localFiles,
          expectedFiles: packed.files,
        });
        results.push(
          parityResult({
            comparison,
            identity,
            localFiles,
            status: comparison.exact ? 'exact' : 'mismatch',
            upstreamVersion,
          }),
        );
      } catch (error) {
        results.push(
          errorResult({error, identity, localFiles, upstreamVersion}),
        );
      }
    }
    const report = {generatedAt: new Date().toISOString(), packages: results};
    const reportPaths = await writeReportPair({
      removeFile,
      renameFile,
      report,
      reportDirectory,
      writeReportFile,
    });
    const failures = results.filter(
      item => item.status !== 'exact' && item.status !== 'helper-policy',
    );
    if (failures.length > 0) {
      throw new Error(
        `Upstream pack parity failed: ${failures
          .map(
            item =>
              `${item.localName} <- ${item.oldName} (${item.status}): local version ${item.localVersion}, latest upstream ${item.upstreamVersion ?? 'unavailable'}, local files ${item.localCount}, upstream files ${item.upstreamCount ?? 'unavailable'}, missing [${item.missing.join(', ')}], added [${item.added.join(', ')}]${item.error ? `, ${item.error}` : ''}`,
          )
          .join(
            '; ',
          )}. Reports: ${reportPaths.jsonPath}; ${reportPaths.markdownPath}`,
      );
    }
    write(
      `Checked ${results.length} pkg-nec release artifact(s): ${statusCounts(results)}.`,
    );
    write(`Upstream parity JSON: ${reportPaths.jsonPath}`);
    write(`Upstream parity Markdown: ${reportPaths.markdownPath}`);
    completedReport = report;
  } catch (error) {
    primaryError = error;
  } finally {
    if (
      isGeneratedTemporaryDirectory(
        systemTemporaryDirectory,
        temporaryDirectory,
      )
    ) {
      try {
        await removeDirectory(temporaryDirectory, {
          force: true,
          recursive: true,
        });
      } catch (error) {
        if (!primaryError) primaryError = error;
      }
    }
  }
  if (primaryError) throw primaryError;
  return completedReport;
}

const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  try {
    await runPackParityCommand();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
