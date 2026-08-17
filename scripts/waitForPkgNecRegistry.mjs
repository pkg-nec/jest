/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import path from 'node:path';
import {pathToFileURL} from 'node:url';
import execa from 'execa';
import {
  classifyRegistryError,
  waitForExactVersion,
} from './pkgNec/registryVisibility.mjs';

const usage = 'Usage: yarn check:pkg-nec-registry "@pkg-nec/name@version"';
const exactVersionPattern =
  /^(@pkg-nec\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;

function parseExactPackageVersion(args) {
  const match = args.length === 1 ? exactVersionPattern.exec(args[0]) : null;
  if (!match) throw new Error(usage);
  return {name: match[1], version: match[2]};
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
  now,
  sleep,
  write = console.log,
}) {
  const {name, version} = parseExactPackageVersion(args);
  const evidence = await waitForExactVersion({
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
