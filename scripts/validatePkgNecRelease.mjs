/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {readFile as readFileFromDisk} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import execa from 'execa';
import {
  parseReleaseTag,
  validatePatchTransitions,
  validateReleaseMetadata,
} from './pkgNec/releaseValidation.mjs';
import {createPackageInventory} from './pkgNecPackageIdentity.mjs';

const usage = 'Usage: yarn validate:pkg-nec-release <ledger-path>';
const requiredEnvironment =
  'Required environment: GITHUB_EVENT_PATH, GITHUB_REPOSITORY, GITHUB_TOKEN';
const defaultRepoRoot = path.resolve(
  fileURLToPath(new URL('..', import.meta.url)),
);
const defaultPolicy = JSON.parse(
  await readFileFromDisk(
    new URL('pkgNec/packageIdentityPolicy.json', import.meta.url),
    'utf8',
  ),
);

function parseLedgerArgument(args) {
  if (args.length !== 1 || !args[0]) throw new Error(usage);
  return args[0];
}

function releaseEnvironment(env) {
  const {
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_REPOSITORY: repository,
    GITHUB_TOKEN: token,
  } = env;
  if (!eventPath || !repository || !token) throw new Error(requiredEnvironment);
  return {eventPath, repository, token};
}

function manifestRelativePath(repoRoot, manifestPath) {
  return path.relative(repoRoot, manifestPath).split(path.sep).join('/');
}

function redactMessage(message, token) {
  const redacted = String(message).replaceAll(
    /Bearer\s+[^\s]+/giu,
    'Bearer <github-token-redacted>',
  );
  return token
    ? redacted.replaceAll(token, '<github-token-redacted>')
    : redacted;
}

async function defaultRunGit(args, {cwd}) {
  const {stdout} = await execa('git', args, {cwd});
  return stdout;
}

async function nodeCiSucceeded({fetchImpl, repository, tagCommit, token}) {
  const url = `https://api.github.com/repos/${repository}/actions/workflows/nodejs.yml/runs?head_sha=${encodeURIComponent(tagCommit)}&status=completed&per_page=100`;
  let response;
  try {
    response = await fetchImpl(url, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
      },
    });
  } catch (error) {
    throw new Error(redactMessage(error.message, token));
  }
  const payload = await response.json();
  const succeeded = payload?.workflow_runs?.some(
    run =>
      run?.conclusion === 'success' &&
      run.event === 'push' &&
      run.head_branch === 'main' &&
      run.head_sha === tagCommit,
  );
  if (!succeeded) throw new Error(`Node CI did not succeed for ${tagCommit}`);
}

export async function runValidateReleaseCommand({
  args = process.argv.slice(2),
  createInventory,
  env = process.env,
  fetchImpl = fetch,
  readFile = readFileFromDisk,
  repoRoot = defaultRepoRoot,
  runGit = defaultRunGit,
  validateReleaseMetadata: validateMetadata = validateReleaseMetadata,
  write = console.log,
}) {
  const ledgerPath = parseLedgerArgument(args);
  const {eventPath, repository, token} = releaseEnvironment(env);
  const [eventText, ledgerText] = await Promise.all([
    readFile(eventPath, 'utf8'),
    readFile(ledgerPath, 'utf8'),
  ]);
  const event = JSON.parse(eventText);
  const ledger = JSON.parse(ledgerText);
  const {tag_name: releaseTag} = event?.release ?? {};
  parseReleaseTag(releaseTag);

  const tagCommitResult = await runGit(['rev-list', '-n', '1', releaseTag], {
    cwd: repoRoot,
  });
  const tagCommit = tagCommitResult.trim();
  await runGit(['merge-base', '--is-ancestor', tagCommit, 'origin/main'], {
    cwd: repoRoot,
  });
  const previousTagResult = await runGit(
    ['describe', '--tags', '--abbrev=0', `${releaseTag}^`],
    {cwd: repoRoot},
  );
  const previousTag = previousTagResult.trim();

  const inventory = createInventory
    ? createInventory()
    : createPackageInventory({policy: defaultPolicy, repoRoot});
  const currentPackages = new Map();
  const previousPackages = new Map();
  for (const [name, identity] of inventory.byNewName) {
    if (!identity.publishable) continue;
    currentPackages.set(name, identity.version);
    const manifest = JSON.parse(
      await runGit(
        [
          'show',
          `${previousTag}:${manifestRelativePath(repoRoot, identity.manifestPath)}`,
        ],
        {cwd: repoRoot},
      ),
    );
    previousPackages.set(name, manifest.version);
  }

  validatePatchTransitions({currentPackages, previousPackages});
  const validation = validateMetadata({event, inventory, ledger, tagCommit});
  await nodeCiSucceeded({fetchImpl, repository, tagCommit, token});

  write('classification=valid');
  write(`tag=${validation.tagName}`);
  write(`sourceCommit=${validation.sourceCommit}`);
  write(`packageCount=${validation.packageCount}`);
  return validation;
}

const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  try {
    await runValidateReleaseCommand({});
  } catch (error) {
    console.error(redactMessage(error.message, process.env.GITHUB_TOKEN ?? ''));
    process.exitCode = 1;
  }
}
