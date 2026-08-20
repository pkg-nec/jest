/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import fs from 'graceful-fs';
import {
  prepareNpmPackageEvidenceQuery,
  queryNpmPackageEvidence,
} from './pkgNec/npmProvenance.mjs';
import {verifyReleaseBatch} from './pkgNec/releaseVerification.mjs';

const usage =
  'Usage: yarn verify:pkg-nec-release <ledger-path> <journal-path> <registry-json-path> <registry-markdown-path> <provenance-json-path> <provenance-markdown-path>';

function commandArguments(args) {
  if (
    args.length !== 6 ||
    args.some(value => typeof value !== 'string' || value.length === 0)
  ) {
    throw new Error(usage);
  }
  return {
    journalPath: args[1],
    ledgerPath: args[0],
    provenanceJsonPath: args[4],
    provenanceMarkdownPath: args[5],
    registryJsonPath: args[2],
    registryMarkdownPath: args[3],
  };
}

function markdownTableCell(value) {
  return String(value ?? '')
    .replaceAll(/\r\n?|\n/gu, '\\n')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll(/([\\|`*_[\]()!~])/gu, '\\$1');
}

export function registryEvidenceMarkdown(evidence) {
  const lines = [
    '# pkg-nec registry verification',
    '',
    '| Order | Package | Version | Disposition | Attempts | Elapsed milliseconds | Expected integrity | Observed integrity | Classification |',
    '| ---: | --- | --- | --- | ---: | ---: | --- | --- | --- |',
    ...evidence.packages.map(
      entry =>
        `| ${markdownTableCell(entry.order)} | ${markdownTableCell(entry.name)} | ${markdownTableCell(entry.version)} | ${markdownTableCell(entry.disposition)} | ${markdownTableCell(entry.attempts)} | ${markdownTableCell(entry.elapsedMs)} | ${markdownTableCell(entry.expectedIntegrity)} | ${markdownTableCell(entry.observedIntegrity)} | ${markdownTableCell(entry.classification)} |`,
    ),
  ];
  return `${lines.join('\n')}\n`;
}

export function provenanceEvidenceMarkdown(evidence) {
  const lines = [
    '# pkg-nec provenance verification',
    '',
    '| Order | Package | Version | Attempts | Elapsed milliseconds | Predicate type | Repository | Workflow | Ref | Source commit | Runner | Bundle digest | Transparency-log IDs | Classification |',
    '| ---: | --- | --- | ---: | ---: | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...evidence.packages.map(
      entry =>
        `| ${markdownTableCell(entry.order)} | ${markdownTableCell(entry.name)} | ${markdownTableCell(entry.version)} | ${markdownTableCell(entry.attempts)} | ${markdownTableCell(entry.elapsedMs)} | ${markdownTableCell(entry.predicateType)} | ${markdownTableCell(entry.repository)} | ${markdownTableCell(entry.workflowPath)} | ${markdownTableCell(entry.sourceRef)} | ${markdownTableCell(entry.sourceCommit)} | ${markdownTableCell(entry.runnerEnvironment)} | ${markdownTableCell(entry.bundleDigest)} | ${markdownTableCell(entry.transparencyLogIds?.join(', '))} | ${markdownTableCell(entry.classification)} |`,
    ),
  ];
  return `${lines.join('\n')}\n`;
}

function temporaryEvidencePath(destination) {
  return path.join(
    path.dirname(destination),
    `${path.basename(destination)}.${process.pid}.${randomUUID()}.tmp`,
  );
}

function evidencePersistenceError(failedOutputs) {
  const error = new Error(
    `Failed to persist ${failedOutputs.length} evidence output(s)`,
  );
  error.code = 'EEVIDENCEPERSIST';
  error.failedOutputs = [...failedOutputs];
  return error;
}

function persistenceFailureDescriptor(error) {
  return {
    code: 'EEVIDENCEPERSIST',
    failedOutputs: [...error.failedOutputs],
    message: error.message,
  };
}

async function persistEvidenceOutputs({outputs, rename, unlink, writeFile}) {
  const failedOutputs = [];
  for (const {destination, label, value} of outputs) {
    const temporaryPath = temporaryEvidencePath(destination);
    let failed = false;
    let writeCompleted = false;
    let shouldCleanTemporary = true;
    try {
      await writeFile(temporaryPath, value, {flag: 'wx'});
      writeCompleted = true;
      await rename(temporaryPath, destination);
      shouldCleanTemporary = false;
    } catch (error) {
      failed = true;
      if (!writeCompleted && error?.code === 'EEXIST') {
        shouldCleanTemporary = false;
      }
    } finally {
      if (shouldCleanTemporary) {
        try {
          await unlink(temporaryPath);
        } catch (error) {
          if (error?.code !== 'ENOENT') failed = true;
        }
      }
    }
    if (failed) failedOutputs.push(label);
  }
  if (failedOutputs.length > 0) {
    throw evidencePersistenceError(failedOutputs);
  }
}

export async function runVerifyReleaseCommand({
  args = process.argv.slice(2),
  deadlineMs = 480_000,
  intervalMs = 5000,
  maxConcurrency = 8,
  now = Date.now,
  prepareNpmEvidence,
  queryNpmEvidence = queryNpmPackageEvidence,
  queryTimeoutMs = 10_000,
  readFile = fs.promises.readFile,
  rename = fs.promises.rename,
  sleep,
  unlink = fs.promises.unlink,
  write = console.log,
  writeFile = fs.promises.writeFile,
} = {}) {
  const {
    journalPath,
    ledgerPath,
    provenanceJsonPath,
    provenanceMarkdownPath,
    registryJsonPath,
    registryMarkdownPath,
  } = commandArguments(args);
  const [ledgerText, journalText] = await Promise.all([
    readFile(ledgerPath, 'utf8'),
    readFile(journalPath, 'utf8'),
  ]);
  const ledger = JSON.parse(ledgerText);
  const journal = JSON.parse(journalText);
  const batchPreparation =
    prepareNpmEvidence === undefined &&
    queryNpmEvidence === queryNpmPackageEvidence
      ? prepareNpmPackageEvidenceQuery
      : prepareNpmEvidence;
  const query = (entry, {signal}) =>
    queryNpmEvidence({
      entry,
      releaseTag: journal.releaseTag,
      signal,
      sourceCommit: ledger.sourceCommit,
    });
  const persistEvidence = async evidence => {
    await persistEvidenceOutputs({
      outputs: [
        {
          destination: registryJsonPath,
          label: 'registry-json',
          value: `${JSON.stringify(evidence.registryEvidence, null, 2)}\n`,
        },
        {
          destination: registryMarkdownPath,
          label: 'registry-markdown',
          value: registryEvidenceMarkdown(evidence.registryEvidence),
        },
        {
          destination: provenanceJsonPath,
          label: 'provenance-json',
          value: `${JSON.stringify(evidence.provenanceEvidence, null, 2)}\n`,
        },
        {
          destination: provenanceMarkdownPath,
          label: 'provenance-markdown',
          value: provenanceEvidenceMarkdown(evidence.provenanceEvidence),
        },
      ],
      rename,
      unlink,
      writeFile,
    });
  };

  try {
    const evidence = await verifyReleaseBatch({
      deadlineMs,
      intervalMs,
      journal,
      ledger,
      maxConcurrency,
      now,
      ...(batchPreparation
        ? {
            prepareQuery: ({deadlineAt, signal, timeoutMs}) =>
              batchPreparation({
                deadlineAt,
                releaseTag: journal.releaseTag,
                signal,
                sourceCommit: ledger.sourceCommit,
                timeoutMs,
              }),
          }
        : {}),
      query,
      queryTimeoutMs,
      ...(sleep === undefined ? {} : {sleep}),
    });
    await persistEvidence(evidence);
    write(
      `Verified ${evidence.registryEvidence.packages.length} pkg-nec release artifact(s).`,
    );
    return evidence;
  } catch (error) {
    if (error?.evidence) {
      try {
        await persistEvidence(error.evidence);
      } catch (persistenceError) {
        try {
          Object.defineProperty(error, 'persistenceFailure', {
            configurable: true,
            enumerable: false,
            value: persistenceFailureDescriptor(persistenceError),
          });
        } catch {}
      }
    }
    throw error;
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    await runVerifyReleaseCommand();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
