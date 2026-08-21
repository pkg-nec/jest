/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {createHash} from 'node:crypto';
import {readFile as readFileFromDisk} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import execa from 'execa';
import {
  releasePlanPathFromTag,
  validateReleasePlan,
} from './pkgNec/releasePlanSchema.mjs';
import {
  parseReleaseTag,
  validatePlannedTransitions,
  validateReleaseMetadata,
} from './pkgNec/releaseValidation.mjs';
import {buildWorkspaceReleaseGraph} from './pkgNec/selectiveReleaseGraph.mjs';
import {createPackageInventory} from './pkgNecPackageIdentity.mjs';

const usage = 'Usage: yarn validate:pkg-nec-release <ledger-path>';
const requiredEnvironment =
  'Required environment: GITHUB_EVENT_PATH, GITHUB_REPOSITORY, GITHUB_SHA, GITHUB_TOKEN';
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
    GITHUB_SHA: eventCommit,
    GITHUB_TOKEN: token,
  } = env;
  if (!eventPath || !repository || !eventCommit || !token) {
    throw new Error(requiredEnvironment);
  }
  return {eventCommit, eventPath, repository, token};
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
  const {stdout} = await execa('git', args, {
    cwd,
    env: {...process.env, GIT_NO_REPLACE_OBJECTS: '1'},
    stripFinalNewline: false,
  });
  return stdout;
}

function gitOutput(result) {
  return String(result?.stdout ?? result).trim();
}

function fullCommit(value, label) {
  const commit = typeof value === 'string' ? value.trim() : '';
  if (!/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error(`${label} must be a full Git commit`);
  }
  return commit;
}

async function bindReleaseSource({
  eventCommit: unvalidatedEventCommit,
  ledgerSourceCommit,
  planPath,
  releaseTag,
  repoRoot,
  runGit,
}) {
  const eventCommit = fullCommit(
    unvalidatedEventCommit,
    'Release event GITHUB_SHA',
  );
  const tagCommit = fullCommit(
    gitOutput(
      await runGit(['rev-list', '-n', '1', releaseTag], {cwd: repoRoot}),
    ),
    'Release tag commit',
  );
  const checkoutCommit = fullCommit(
    gitOutput(await runGit(['rev-parse', 'HEAD'], {cwd: repoRoot})),
    'Release checkout HEAD',
  );
  const sourceCommit = fullCommit(
    ledgerSourceCommit,
    'Release ledger source commit',
  );
  if (
    eventCommit !== tagCommit ||
    tagCommit !== checkoutCommit ||
    checkoutCommit !== sourceCommit
  ) {
    throw new Error('Release event, tag, and checkout commits must match');
  }
  try {
    await runGit(['merge-base', '--is-ancestor', sourceCommit, 'origin/main'], {
      cwd: repoRoot,
    });
  } catch {
    throw new Error('Release source commit is not on origin/main');
  }

  const history = gitOutput(
    await runGit(['rev-list', '--parents', '-n', '1', sourceCommit], {
      cwd: repoRoot,
    }),
  ).split(/\s+/u);
  if (
    history[0] !== sourceCommit ||
    history.some(commit => !/^[0-9a-f]{40}$/u.test(commit))
  ) {
    throw new Error('Release source has invalid first-parent history');
  }
  const firstParent = history[1];
  if (firstParent) {
    const priorPlan = gitOutput(
      await runGit(['ls-tree', '--name-only', firstParent, '--', planPath], {
        cwd: repoRoot,
      }),
    );
    if (priorPlan !== '') {
      throw new Error(
        'Release plan must be introduced by the release source commit',
      );
    }
  }
  return sourceCommit;
}

async function assertReleaseSourceStable({
  releaseTag,
  repoRoot,
  runGit,
  sourceCommit,
}) {
  const tagCommit = fullCommit(
    gitOutput(
      await runGit(['rev-list', '-n', '1', releaseTag], {cwd: repoRoot}),
    ),
    'Release tag commit',
  );
  const checkoutCommit = fullCommit(
    gitOutput(await runGit(['rev-parse', 'HEAD'], {cwd: repoRoot})),
    'Release checkout HEAD',
  );
  if (tagCommit !== sourceCommit || checkoutCommit !== sourceCommit) {
    throw new Error('Release source commit changed during validation');
  }
}

function sha256Digest(value) {
  return `sha256-${createHash('sha256').update(value).digest('hex')}`;
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
  buildReleaseGraph = buildWorkspaceReleaseGraph,
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
  const {eventCommit, eventPath, repository, token} = releaseEnvironment(env);
  const [eventText, ledgerText] = await Promise.all([
    readFile(eventPath, 'utf8'),
    readFile(ledgerPath, 'utf8'),
  ]);
  const event = JSON.parse(eventText);
  const ledger = JSON.parse(ledgerText);
  const {tag_name: releaseTag} = event?.release ?? {};
  parseReleaseTag(releaseTag);
  const planPath = releasePlanPathFromTag(releaseTag);
  if (
    ledger?.schemaVersion !== 2 ||
    ledger.releasePlan?.path !== planPath ||
    !/^sha256-[0-9a-f]{64}$/u.test(ledger.releasePlan?.digest)
  ) {
    throw new Error('Release ledger does not identify the exact release plan');
  }

  const tagCommit = await bindReleaseSource({
    eventCommit,
    ledgerSourceCommit: ledger.sourceCommit,
    planPath,
    releaseTag,
    repoRoot,
    runGit,
  });
  const planFilePath = path.resolve(repoRoot, ...planPath.split('/'));
  const [planFileBytes, committedPlanText] = await Promise.all([
    readFile(planFilePath),
    runGit(['show', `${tagCommit}:${planPath}`], {cwd: repoRoot}),
  ]);
  const planBytes = Buffer.isBuffer(planFileBytes)
    ? planFileBytes
    : Buffer.from(planFileBytes);
  const committedPlanBytes = Buffer.from(committedPlanText);
  if (!planBytes.equals(committedPlanBytes)) {
    throw new Error('Checked-out release plan differs from the tagged commit');
  }
  if (sha256Digest(planBytes) !== ledger.releasePlan.digest) {
    throw new Error('Release plan digest does not match the ledger');
  }
  const plan = validateReleasePlan(JSON.parse(planBytes.toString('utf8')));
  if (plan.planPath !== planPath || plan.anchor.tag !== releaseTag) {
    throw new Error('Release plan does not match the release tag');
  }
  const previousTagCommitResult = await runGit(
    ['rev-list', '-n', '1', plan.previousRelease.tag],
    {cwd: repoRoot},
  );
  if (previousTagCommitResult.trim() !== plan.previousRelease.commit) {
    throw new Error('Previous release tag does not match the release plan');
  }
  await runGit(
    ['merge-base', '--is-ancestor', plan.previousRelease.commit, tagCommit],
    {cwd: repoRoot},
  );

  const inventory = createInventory
    ? createInventory()
    : createPackageInventory({policy: defaultPolicy, repoRoot});
  const previousPackages = new Map();
  for (const [name, identity] of inventory.byNewName) {
    if (!identity.publishable) continue;
    const manifest = JSON.parse(
      await runGit(
        [
          'show',
          `${plan.previousRelease.commit}:${manifestRelativePath(repoRoot, identity.manifestPath)}`,
        ],
        {cwd: repoRoot},
      ),
    );
    previousPackages.set(name, manifest.version);
  }

  validatePlannedTransitions({inventory, plan, previousPackages});
  const releaseGraph = buildReleaseGraph(inventory);
  await assertReleaseSourceStable({
    releaseTag,
    repoRoot,
    runGit,
    sourceCommit: tagCommit,
  });
  const validation = validateMetadata({
    event,
    inventory,
    ledger,
    plan,
    releaseGraph,
    tagCommit,
  });
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
