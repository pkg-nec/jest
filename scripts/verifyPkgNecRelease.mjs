/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import path from 'node:path';
import {fileURLToPath} from 'node:url';
import execa from 'execa';
import fs from 'graceful-fs';
import {verifyReleaseBatch} from './pkgNec/releaseVerification.mjs';

const usage =
  'Usage: yarn verify:pkg-nec-release <ledger-path> <journal-path> <evidence-json-path> <evidence-markdown-path>';

function commandArguments(args) {
  if (
    args.length !== 4 ||
    args.some(value => typeof value !== 'string' || value.length === 0)
  ) {
    throw new Error(usage);
  }
  return {
    evidenceJsonPath: args[2],
    evidenceMarkdownPath: args[3],
    journalPath: args[1],
    ledgerPath: args[0],
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

export async function queryPublicRegistry(entry, {signal}, runNpm = execa) {
  return runNpm(
    'npm',
    [
      'view',
      `${entry.name}@${entry.version}`,
      '--json',
      '--registry=https://registry.npmjs.org/',
    ],
    {signal},
  );
}

export async function runVerifyReleaseCommand({
  args = process.argv.slice(2),
  deadlineMs = 480_000,
  intervalMs = 5000,
  maxConcurrency = 8,
  now = Date.now,
  queryTimeoutMs = 10_000,
  readFile = fs.promises.readFile,
  runNpm = execa,
  sleep,
  write = console.log,
  writeFile = fs.promises.writeFile,
} = {}) {
  const {evidenceJsonPath, evidenceMarkdownPath, journalPath, ledgerPath} =
    commandArguments(args);
  const [ledgerText, journalText] = await Promise.all([
    readFile(ledgerPath, 'utf8'),
    readFile(journalPath, 'utf8'),
  ]);
  const ledger = JSON.parse(ledgerText);
  const journal = JSON.parse(journalText);
  const query = (entry, options) => queryPublicRegistry(entry, options, runNpm);
  const persistEvidence = async evidence => {
    await writeFile(evidenceJsonPath, `${JSON.stringify(evidence, null, 2)}\n`);
    await writeFile(evidenceMarkdownPath, registryEvidenceMarkdown(evidence));
  };

  try {
    const evidence = await verifyReleaseBatch({
      deadlineMs,
      intervalMs,
      journal,
      ledger,
      maxConcurrency,
      now,
      query,
      queryTimeoutMs,
      ...(sleep === undefined ? {} : {sleep}),
    });
    await persistEvidence(evidence);
    write(`Verified ${evidence.packages.length} pkg-nec release artifact(s).`);
    return evidence;
  } catch (error) {
    if (error?.evidence) await persistEvidence(error.evidence);
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
