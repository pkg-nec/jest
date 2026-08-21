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
import {renderDraftRelease} from './pkgNec/draftReleaseNotes.mjs';
import {resolveDraftReleaseState} from './pkgNec/draftReleaseState.mjs';
import {releasePlanPathFromTag} from './pkgNec/releasePlanSchema.mjs';
import {
  findUnresolvedReleaseState,
  selectPublishedBaseline,
} from './pkgNec/releaseState.mjs';

const usage = 'Usage: yarn draft:pkg-nec-release';
const repository = 'pkg-nec/jest';
const releaseEndpoint = `repos/${repository}/releases?per_page=100`;
const releaseRunsEndpoint = `repos/${repository}/actions/workflows/release.yml/runs?per_page=100`;
const requiredAssetNames = new Set([
  'workflow-summary.md',
  'release-ledger.json',
  'publication-journal.json',
  'registry-evidence.json',
  'provenance-evidence.json',
]);

function commandBytes(result) {
  const output = result?.stdout ?? result;
  if (Buffer.isBuffer(output)) return output;
  if (typeof output === 'string') return Buffer.from(output);
  if (output instanceof Uint8Array) return Buffer.from(output);
  throw new TypeError('Command adapter must return stdout bytes');
}

function commandText(result) {
  return commandBytes(result).toString('utf8');
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON from ${label}`);
  }
}

function slurpedItems(text, field, label) {
  const pages = parseJson(text, label);
  if (!Array.isArray(pages)) throw new Error(`Invalid ${label} response`);
  if (field === null) {
    return pages.flatMap(page => (Array.isArray(page) ? page : [page]));
  }
  return pages.flatMap(page => {
    if (!page || !Array.isArray(page[field])) {
      throw new Error(`Invalid ${label} page`);
    }
    return page[field];
  });
}

function fullCommit(result, label) {
  const commit = commandText(result).trim();
  if (!/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error(`${label} must resolve to a full 40-hex commit`);
  }
  return commit;
}

function safePlanPaths(text) {
  return text
    .split('\0')
    .filter(Boolean)
    .map(value => value.replaceAll('\\', '/'))
    .map(value => {
      if (
        !value.startsWith('docs/releases/') ||
        !value.endsWith('-plan.json') ||
        value.split('/').includes('..')
      ) {
        throw new Error(`Unsafe release plan path: ${value}`);
      }
      return value;
    })
    .sort((left, right) => left.localeCompare(right));
}

function introductionCommit(text, planPath) {
  const normalized = text.replaceAll('\r\n', '\n');
  const withoutFinalNewline = normalized.endsWith('\n')
    ? normalized.slice(0, -1)
    : normalized;
  const lines = withoutFinalNewline.split('\n');
  if (lines.length !== 1 || !/^[0-9a-f]{40}$/u.test(lines[0])) {
    throw new Error(
      `Release plan ${planPath} must have exactly one full introduction commit`,
    );
  }
  return lines[0];
}

async function defaultRun(command, args, repoRoot) {
  const {stdout} = await execa(command, args, {
    cwd: repoRoot,
    stripFinalNewline: false,
  });
  return stdout;
}

async function defaultWriteFile(file, contents) {
  await fs.promises.mkdir(path.dirname(file), {recursive: true});
  await fs.promises.writeFile(file, contents, 'utf8');
}

async function hydrateReleaseAssets({release, runGh}) {
  const selectedNames = new Set(requiredAssetNames);
  try {
    selectedNames.add(
      path.posix.basename(releasePlanPathFromTag(release.tag_name)),
    );
  } catch {
    // Invalid release tags are rejected by published-state inspection.
  }
  const assets = [];
  for (const asset of release.assets ?? []) {
    if (!selectedNames.has(asset?.name) || asset.content !== undefined) {
      assets.push(asset);
      continue;
    }
    if (
      typeof asset.url !== 'string' ||
      !/^https:\/\/api\.github\.com\/repos\/pkg-nec\/jest\/releases\/assets\/[1-9]\d*$/u.test(
        asset.url,
      )
    ) {
      assets.push(asset);
      continue;
    }
    assets.push({
      ...asset,
      content: commandText(
        await runGh([
          'api',
          asset.url,
          '--header',
          'Accept: application/octet-stream',
        ]),
      ),
    });
  }
  return {...release, assets};
}

async function commitRelationToBaseline({baselineCommit, commit, runGit}) {
  if (commit === baselineCommit) return 'equal';
  try {
    await runGit(['merge-base', '--is-ancestor', commit, baselineCommit]);
    return 'ancestor';
  } catch {
    // Continue to distinguish descendants from unrelated commits.
  }
  try {
    await runGit(['merge-base', '--is-ancestor', baselineCommit, commit]);
    return 'descendant';
  } catch {
    return 'unrelated';
  }
}

function validDraftUrl(result) {
  const text = commandText(result).trim();
  if (/\s/u.test(text)) throw new Error('Invalid GitHub draft URL');
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error('Invalid GitHub draft URL');
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'github.com' ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    !url.pathname.startsWith('/pkg-nec/jest/releases/') ||
    url.pathname === '/pkg-nec/jest/releases/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('Invalid GitHub draft URL');
  }
  return text;
}

function partialRemoteError({
  cause,
  draftUrl,
  intendedCommit,
  observedCommit,
  tag,
}) {
  return new Error(
    `Draft creation requires manual investigation for tag ${tag}; intended commit ${intendedCommit}; draft URL ${draftUrl ?? 'unknown'}; observed commit ${observedCommit ?? 'unknown'}; ${cause instanceof Error ? cause.message : String(cause)}`,
  );
}

export async function runDraftReleaseCommand({
  args = process.argv.slice(2),
  readFile = fs.promises.readFile,
  runGh,
  runGit,
  write = value => process.stdout.write(value),
  writeFile = defaultWriteFile,
} = {}) {
  if (!Array.isArray(args) || args.length > 0) throw new Error(usage);

  const repoRoot = path.resolve(process.cwd());
  const invokeGit = runGit ?? (gitArgs => defaultRun('git', gitArgs, repoRoot));
  const invokeGh = runGh ?? (ghArgs => defaultRun('gh', ghArgs, repoRoot));

  const status = commandText(await invokeGit(['status', '--porcelain']));
  if (status.trim().length > 0) {
    throw new Error('Draft release creation requires a clean worktree');
  }
  await invokeGit([
    'fetch',
    'origin',
    'main:refs/remotes/origin/main',
    '--tags',
  ]);
  const head = fullCommit(await invokeGit(['rev-parse', 'HEAD']), 'HEAD');
  const originMain = fullCommit(
    await invokeGit(['rev-parse', 'origin/main']),
    'origin/main',
  );
  if (head !== originMain) {
    throw new Error('HEAD must equal freshly fetched origin/main');
  }

  await invokeGh(['auth', 'status']);
  const repositoryState = parseJson(
    commandText(await invokeGh(['repo', 'view', '--json', 'nameWithOwner'])),
    'gh repo view',
  );
  if (repositoryState?.nameWithOwner !== repository) {
    throw new Error('Draft release creation must run against pkg-nec/jest');
  }

  const releases = slurpedItems(
    commandText(
      await invokeGh(['api', '--paginate', '--slurp', releaseEndpoint]),
    ),
    null,
    'GitHub Releases',
  );
  const releaseRuns = slurpedItems(
    commandText(
      await invokeGh(['api', '--paginate', '--slurp', releaseRunsEndpoint]),
    ),
    'workflow_runs',
    'release workflow runs',
  );

  const tagNames = commandText(
    await invokeGit([
      'for-each-ref',
      '--format=%(refname:short)',
      'refs/tags/@pkg-nec/*-v*',
    ]),
  )
    .split(/\r?\n/u)
    .filter(Boolean);
  const tagsByName = new Map(tagNames.map(name => [name, {name}]));
  for (const release of releases) {
    if (
      typeof release?.tag_name === 'string' &&
      !tagsByName.has(release.tag_name)
    ) {
      tagsByName.set(release.tag_name, {name: release.tag_name});
    }
  }
  for (const tag of tagsByName.values()) {
    tag.commit = fullCommit(
      await invokeGit(['rev-list', '-n', '1', `refs/tags/${tag.name}`]),
      `Tag ${tag.name}`,
    );
  }

  const hydratedReleases = [];
  for (const release of releases) {
    const hydrated = await hydrateReleaseAssets({release, runGh: invokeGh});
    hydratedReleases.push({
      ...hydrated,
      releaseRuns: releaseRuns.filter(
        run => run?.head_branch === hydrated.tag_name,
      ),
      tagCommit: tagsByName.get(hydrated.tag_name)?.commit,
    });
  }
  const baseline = selectPublishedBaseline({
    releaseRuns,
    releases: hydratedReleases,
  });
  for (const tag of tagsByName.values()) {
    tag.relationToBaseline = await commitRelationToBaseline({
      baselineCommit: baseline.commit,
      commit: tag.commit,
      runGit: invokeGit,
    });
  }

  const planPaths = safePlanPaths(
    commandText(
      await invokeGit(['ls-files', '-z', '--', 'docs/releases/*-plan.json']),
    ),
  );
  const localPlans = [];
  for (const planPath of planPaths) {
    let plan;
    try {
      plan = parseJson(
        await readFile(path.resolve(repoRoot, ...planPath.split('/')), 'utf8'),
        `release plan ${planPath}`,
      );
    } catch (error) {
      plan = {
        parseError: error instanceof Error ? error.message : String(error),
      };
    }
    localPlans.push({path: planPath, plan});
  }
  const unresolved = findUnresolvedReleaseState({
    localPlans,
    releases: hydratedReleases,
    tags: [...tagsByName.values()],
  });
  const unresolvedPlans = unresolved.filter(item => item.kind === 'local-plan');
  if (unresolved.length !== 1 || unresolvedPlans.length !== 1) {
    throw new Error(
      `Expected exactly one unresolved local release plan; found ${
        unresolved.map(item => item.kind).join(', ') || 'none'
      }`,
    );
  }
  const localPlan = localPlans.find(
    candidate => candidate.path === unresolvedPlans[0].planPath,
  );
  if (!localPlan) {
    throw new Error('Unresolved release plan does not match a tracked plan');
  }

  const planIntroductionCommit = introductionCommit(
    commandText(
      await invokeGit([
        'log',
        '--diff-filter=A',
        '--format=%H',
        '--reverse',
        '--',
        localPlan.path,
      ]),
    ),
    localPlan.path,
  );
  const currentBytes = commandBytes(
    await readFile(path.resolve(repoRoot, ...localPlan.path.split('/'))),
  );
  const introductionBytes = commandBytes(
    await invokeGit(['show', `${planIntroductionCommit}:${localPlan.path}`]),
  );
  let isAncestor = true;
  try {
    await invokeGit([
      'merge-base',
      '--is-ancestor',
      planIntroductionCommit,
      'origin/main',
    ]);
  } catch {
    isAncestor = false;
  }

  const mainPackages = [];
  for (const planned of localPlan.plan?.packages ?? []) {
    const manifestPath = path.resolve(
      repoRoot,
      ...planned.path.split('/'),
      'package.json',
    );
    const manifest = parseJson(
      await readFile(manifestPath, 'utf8'),
      `package manifest ${planned.name}`,
    );
    if (
      manifest?.name !== planned.name ||
      typeof manifest.version !== 'string'
    ) {
      throw new Error(`Invalid package manifest identity for ${planned.name}`);
    }
    mainPackages.push({name: manifest.name, version: manifest.version});
  }

  const nodeRunsEndpoint = `repos/${repository}/actions/workflows/nodejs.yml/runs?event=push&branch=main&head_sha=${planIntroductionCommit}&status=completed&per_page=100`;
  const nodeRuns = slurpedItems(
    commandText(
      await invokeGh(['api', '--paginate', '--slurp', nodeRunsEndpoint]),
    ),
    'workflow_runs',
    'Node workflow runs',
  );
  const resolved = resolveDraftReleaseState({
    head,
    localPlans,
    mainPackages,
    nodeRuns,
    originMain,
    planState: {
      currentBytes,
      introductionBytes,
      introductionCommit: planIntroductionCommit,
      isAncestor,
    },
    releases: hydratedReleases,
    tags: [...tagsByName.values()],
  });

  const {notes} = renderDraftRelease({
    plan: resolved.plan,
    sourceCommit: resolved.planIntroductionCommit,
  });
  const notesPath = path.join(
    repoRoot,
    '.pkg-nec-release',
    'draft-release-notes.md',
  );
  await writeFile(notesPath, notes, 'utf8');

  const createResult = await invokeGh([
    'release',
    'create',
    resolved.plan.anchor.tag,
    '--draft',
    '--target',
    resolved.planIntroductionCommit,
    '--title',
    resolved.plan.anchor.tag,
    '--notes-file',
    notesPath,
    '--repo',
    repository,
  ]);

  let createdDraftUrl = null;
  let observedCommit = null;
  try {
    createdDraftUrl = validDraftUrl(createResult);
    await invokeGit([
      'fetch',
      'origin',
      `refs/tags/${resolved.tag}:refs/tags/${resolved.tag}`,
    ]);
    observedCommit = fullCommit(
      await invokeGit(['rev-list', '-n', '1', `refs/tags/${resolved.tag}`]),
      `Created tag ${resolved.tag}`,
    );
    if (observedCommit !== resolved.planIntroductionCommit) {
      throw new Error('Created tag does not target the intended commit');
    }
  } catch (error) {
    throw partialRemoteError({
      cause: error,
      draftUrl: createdDraftUrl,
      intendedCommit: resolved.planIntroductionCommit,
      observedCommit,
      tag: resolved.tag,
    });
  }

  write(
    `Draft tag: ${resolved.tag}\n` +
      `Draft commit: ${resolved.planIntroductionCommit}\n` +
      `Draft URL: ${createdDraftUrl}\n` +
      'Review the draft and publish it manually to start the npm provenance workflow.\n',
  );
  return {
    draftUrl: createdDraftUrl,
    introductionCommit: resolved.planIntroductionCommit,
    notesPath,
    tag: resolved.tag,
  };
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    await runDraftReleaseCommand();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
