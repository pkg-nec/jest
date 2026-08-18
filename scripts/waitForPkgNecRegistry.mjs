/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {readFile as readFileFromDisk} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import execa from 'execa';
import {
  classifyRegistryError,
  releaseEntryFromLedger,
  waitForExactVersion,
} from './pkgNec/registryVisibility.mjs';

const usage = 'Usage: yarn check:pkg-nec-registry <ledger-path> <package-name>';

function parseLedgerArguments(args) {
  if (args.length !== 2 || !args[0] || !args[1]) throw new Error(usage);
  return {ledgerPath: args[0], packageName: args[1]};
}

async function queryRegistry(args, {signal}) {
  const query = execa('npm', args);
  const cancel = () => query.cancel();

  if (signal.aborted) cancel();
  else signal.addEventListener('abort', cancel, {once: true});

  try {
    return await query;
  } catch (error) {
    if (signal.aborted) {
      error.code = 'ABORT_ERR';
      error.name = 'AbortError';
    }
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

export async function runRegistryVisibilityCommand({
  args = process.argv.slice(2),
  query = queryRegistry,
  readFile = readFileFromDisk,
  now,
  sleep,
  write = console.log,
}) {
  const {ledgerPath, packageName} = parseLedgerArguments(args);
  const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'));
  const {
    integrity: expectedIntegrity,
    name,
    version,
  } = releaseEntryFromLedger({
    ledger,
    packageName,
  });
  const evidence = await waitForExactVersion({
    expectedIntegrity,
    name,
    now,
    query,
    sleep,
    version,
  });

  write(`package=${evidence.name}`);
  write(`version=${evidence.version}`);
  write(`attempts=${evidence.attempts}`);
  write(`elapsedMs=${evidence.elapsedMs}`);
  write(`integrity=${evidence.integrity}`);
  write('classification=visible');
  return evidence;
}

const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  try {
    await runRegistryVisibilityCommand({});
  } catch (error) {
    console.error(error.message);
    console.error(
      `classification=${error.classification ?? classifyRegistryError(error)}`,
    );
    process.exitCode = 1;
  }
}
