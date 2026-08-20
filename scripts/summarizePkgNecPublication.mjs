/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import path from 'node:path';
import {fileURLToPath} from 'node:url';
import fs from 'graceful-fs';
import {
  publicationSummary,
  publicationSummaryMarkdown,
} from './pkgNec/publicationProgress.mjs';
import {validateReleaseLedger} from './pkgNec/releasePublisher.mjs';

const journalFields = new Set([
  'packages',
  'releaseTag',
  'schemaVersion',
  'sourceCommit',
]);
const journalPackageFields = new Set([
  'completedAt',
  'disposition',
  'integrity',
  'name',
  'order',
  'version',
]);
const journalDispositions = new Set(['published', 'verified-existing']);
const usage =
  'Usage: yarn summarize:pkg-nec-publication <ledger-path> <journal-path>';

function exactFields(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`Invalid ${label}`);
  }
  const extraField = Object.keys(value).find(field => !allowed.has(field));
  if (extraField) throw new Error(`Unexpected ${label} field: ${extraField}`);
  const missingField = [...allowed].find(field => !(field in value));
  if (missingField) throw new Error(`Missing ${label} field: ${missingField}`);
}

function validIsoTimestamp(value) {
  if (typeof value !== 'string') return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function validatePartialPublicationJournal({journal, ledger}) {
  exactFields(journal, journalFields, 'publication journal');
  validateReleaseLedger({ledger, releaseTag: journal.releaseTag});
  if (journal.schemaVersion !== 1) {
    throw new Error('Unsupported publication journal schema');
  }
  if (journal.sourceCommit !== ledger.sourceCommit) {
    throw new Error('Publication journal source commit does not match ledger');
  }
  if (!Array.isArray(journal.packages)) {
    throw new TypeError('Publication journal packages must be an array');
  }
  if (journal.packages.length > ledger.packages.length) {
    throw new Error('Publication journal packages exceed release ledger');
  }

  for (const [index, journalEntry] of journal.packages.entries()) {
    exactFields(
      journalEntry,
      journalPackageFields,
      `publication journal package at order ${index + 1}`,
    );
    const ledgerEntry = ledger.packages[index];
    if (
      journalEntry.integrity !== ledgerEntry.integrity ||
      journalEntry.name !== ledgerEntry.name ||
      journalEntry.order !== ledgerEntry.order ||
      journalEntry.version !== ledgerEntry.version
    ) {
      throw new Error(
        `Publication journal entry does not match ledger at order ${index + 1}`,
      );
    }
    if (!journalDispositions.has(journalEntry.disposition)) {
      throw new Error(
        `Invalid publication disposition for ${journalEntry.name}`,
      );
    }
    if (!validIsoTimestamp(journalEntry.completedAt)) {
      throw new TypeError(
        `Invalid publication completion time for ${journalEntry.name}`,
      );
    }
  }
}

export async function runPublicationSummaryCommand({
  args = process.argv.slice(2),
  readFile = fs.promises.readFile,
  write = value => process.stdout.write(value),
} = {}) {
  if (!Array.isArray(args) || args.length !== 2) throw new Error(usage);

  const [ledgerPath, journalPath] = args;
  const [ledgerText, journalText] = await Promise.all([
    readFile(ledgerPath, 'utf8'),
    readFile(journalPath, 'utf8'),
  ]);
  const ledger = JSON.parse(ledgerText);
  const journal = JSON.parse(journalText);
  validatePartialPublicationJournal({journal, ledger});
  const summary = publicationSummary({journal, ledger});
  write(publicationSummaryMarkdown({journal, ledger}));
  return summary;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    await runPublicationSummaryCommand();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
