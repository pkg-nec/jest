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
import {classifyReleaseChanges} from './pkgNec/releaseChangePolicy.mjs';
import {
  canonicalReleasePlan,
  releasePlanPathFromTag,
} from './pkgNec/releasePlanSchema.mjs';
import {
  findUnresolvedReleaseState,
  selectPublishedBaseline,
} from './pkgNec/releaseState.mjs';
import {
  createSelectiveReleasePlan,
  parseBumpOverrides,
} from './pkgNec/selectiveReleasePlanner.mjs';
import {createPackageInventory} from './pkgNecPackageIdentity.mjs';

const usage =
  'Usage: yarn plan:pkg-nec-release [--bump <name>=patch|minor|major] [--root-impact=all|none] [--apply]';
const releaseEndpoint = 'repos/pkg-nec/jest/releases?per_page=100';
const releaseRunsEndpoint =
  'repos/pkg-nec/jest/actions/workflows/release.yml/runs?per_page=100';
const requiredAssetNames = new Set([
  'workflow-summary.md',
  'release-ledger.json',
  'publication-journal.json',
  'registry-evidence.json',
  'provenance-evidence.json',
]);

function commandText(result) {
  if (typeof result === 'string') return result;
  if (typeof result?.stdout === 'string') return result.stdout;
  throw new TypeError('Command adapter must return stdout text');
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON from ${label}`);
  }
}

function parseOptions(args) {
  if (!Array.isArray(args)) throw new Error(usage);
  const bumpOverrideValues = [];
  let apply = false;
  let rootImpactRequest = null;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--bump') {
      const value = args[++index];
      if (typeof value !== 'string' || value.startsWith('--')) {
        throw new Error(usage);
      }
      bumpOverrideValues.push(value);
      continue;
    }
    if (argument === '--apply') {
      if (apply) throw new Error(`Duplicate option --apply\n${usage}`);
      apply = true;
      continue;
    }
    if (argument === '--root-impact=all' || argument === '--root-impact=none') {
      if (rootImpactRequest !== null) {
        throw new Error(`Duplicate option --root-impact\n${usage}`);
      }
      rootImpactRequest = argument.slice('--root-impact='.length);
      continue;
    }
    throw new Error(`Unrecognized planner argument: ${argument}\n${usage}`);
  }
  parseBumpOverrides(bumpOverrideValues);
  return {apply, bumpOverrideValues, rootImpactRequest};
}

function fullCommit(value, label) {
  const commit = value.trim();
  if (!/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error(`${label} must resolve to a full 40-hex commit`);
  }
  return commit;
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

function parseTags(text) {
  return text
    .split(/\r?\n/u)
    .filter(Boolean)
    .map(name => ({name}));
}

function safePlanPaths(text) {
  return text
    .split('\0')
    .filter(Boolean)
    .map(value => value.replaceAll('\\', '/'))
    .filter(value => {
      if (
        !value.startsWith('docs/releases/') ||
        !value.endsWith('-plan.json') ||
        value.split('/').includes('..')
      ) {
        throw new Error(`Unsafe release plan path: ${value}`);
      }
      return true;
    })
    .sort((left, right) => left.localeCompare(right));
}

async function hydrateReleaseAssets({release, runGh}) {
  const selectedAssetNames = new Set(requiredAssetNames);
  try {
    selectedAssetNames.add(
      releasePlanPathFromTag(release.tag_name).split('/').at(-1),
    );
  } catch {
    // Baseline inspection rejects releases whose tags are not plan-compatible.
  }
  const assets = [];
  for (const asset of release.assets ?? []) {
    if (!selectedAssetNames.has(asset?.name) || asset.content !== undefined) {
      assets.push(asset);
      continue;
    }
    if (
      typeof asset.url !== 'string' ||
      !/^https:\/\/api\.github\.com\/repos\/pkg-nec\/jest\/releases\/assets\/\d+$/u.test(
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

function inventoryVersionMap(inventory) {
  return new Map(
    inventory.packages
      .filter(item => item.publishable)
      .map(item => [item.newName, item.version]),
  );
}

function versionMismatches(left, right, fields) {
  return [...new Set([...left.keys(), ...right.keys()])]
    .sort((a, b) => a.localeCompare(b))
    .filter(name => left.get(name) !== right.get(name))
    .map(name => ({
      name,
      [fields[0]]: left.get(name) ?? null,
      [fields[1]]: right.get(name) ?? null,
    }));
}

function unresolvedError(details, message = 'Unresolved release state') {
  const error = new Error(`${message}; manual investigation is required`);
  error.details = details;
  return error;
}

function packageTable(plan) {
  const lines = [
    '| Order | Package | From | To | Bump |',
    '| ---: | --- | --- | --- | --- |',
    ...plan.packages.map(
      item =>
        `| ${item.order} | ${item.name} | ${item.fromVersion} | ${item.toVersion} | ${item.bump} |`,
    ),
  ];
  return `${lines.join('\n')}\n`;
}

async function defaultRun(command, args, repoRoot) {
  const {stdout} = await execa(command, args, {
    cwd: repoRoot,
    stripFinalNewline: false,
  });
  return stdout;
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

export async function runPlanReleaseCommand({
  args = process.argv.slice(2),
  readFile = fs.promises.readFile,
  runGh,
  runGit,
  write = value => process.stdout.write(value),
} = {}) {
  const options = parseOptions(args);
  const repoRoot = path.resolve(process.cwd());
  const invokeGit = runGit ?? (gitArgs => defaultRun('git', gitArgs, repoRoot));
  const invokeGh = runGh ?? (ghArgs => defaultRun('gh', ghArgs, repoRoot));

  const status = commandText(await invokeGit(['status', '--porcelain']));
  if (status.trim().length > 0) {
    throw new Error('Planner requires a clean worktree');
  }
  await invokeGit([
    'fetch',
    'origin',
    'main:refs/remotes/origin/main',
    '--tags',
  ]);
  const head = fullCommit(
    commandText(await invokeGit(['rev-parse', 'HEAD'])),
    'HEAD',
  );
  const originMain = fullCommit(
    commandText(await invokeGit(['rev-parse', 'origin/main'])),
    'origin/main',
  );
  if (head !== originMain) {
    throw new Error('HEAD must equal freshly fetched origin/main');
  }

  const repository = parseJson(
    commandText(await invokeGh(['repo', 'view', '--json', 'nameWithOwner'])),
    'gh repo view',
  );
  if (repository?.nameWithOwner !== 'pkg-nec/jest') {
    throw new Error('Planner must run against the pkg-nec/jest repository');
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

  const tags = parseTags(
    commandText(
      await invokeGit([
        'for-each-ref',
        '--format=%(refname:short)',
        'refs/tags/@pkg-nec/*-v*',
      ]),
    ),
  );
  const tagsByName = new Map(tags.map(tag => [tag.name, tag]));
  for (const release of releases) {
    if (
      typeof release?.tag_name === 'string' &&
      !tagsByName.has(release.tag_name)
    ) {
      tagsByName.set(release.tag_name, {
        name: release.tag_name,
      });
    }
  }
  for (const tag of tagsByName.values()) {
    tag.commit = fullCommit(
      commandText(
        await invokeGit(['rev-list', '-n', '1', `refs/tags/${tag.name}`]),
      ),
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
        await readFile(planPath, 'utf8'),
        `release plan ${planPath}`,
      );
    } catch (error) {
      plan = {parseError: error.message};
    }
    localPlans.push({path: planPath, plan});
  }
  const unresolved = findUnresolvedReleaseState({
    localPlans,
    releaseRuns,
    releases: hydratedReleases,
    tags: [...tagsByName.values()],
  });
  if (unresolved.length > 0) throw unresolvedError(unresolved);

  const resolvedBaselineTag = tagsByName.get(baseline.tag)?.commit;
  if (resolvedBaselineTag !== baseline.commit) {
    throw unresolvedError(
      [
        {
          kind: 'baseline-tag-mismatch',
          message:
            'The baseline tag does not resolve to its recorded full commit',
          recordedCommit: baseline.commit,
          resolvedCommit: resolvedBaselineTag ?? null,
          tag: baseline.tag,
          versions: baseline.packages,
        },
      ],
      'Baseline tag mismatch',
    );
  }
  try {
    await invokeGit(['merge-base', '--is-ancestor', baseline.commit, 'HEAD']);
  } catch {
    throw unresolvedError(
      [
        {
          commit: baseline.commit,
          kind: 'baseline-not-ancestor',
          message: 'The completed baseline is not an ancestor of HEAD',
          tag: baseline.tag,
          versions: baseline.packages,
        },
      ],
      'Invalid completed baseline ancestry',
    );
  }
  const changedFiles = commandText(
    await invokeGit(['diff', '--name-only', '-z', `${baseline.commit}..HEAD`]),
  )
    .split('\0')
    .filter(Boolean);

  const identityPolicyPath = path.join(
    repoRoot,
    'scripts/pkgNec/packageIdentityPolicy.json',
  );
  const impactPolicyPath = path.join(
    repoRoot,
    'scripts/pkgNec/releaseImpactPolicy.json',
  );
  const identityPolicy = parseJson(
    await readFile(identityPolicyPath, 'utf8'),
    'package identity policy',
  );
  const impactPolicy = parseJson(
    await readFile(impactPolicyPath, 'utf8'),
    'release impact policy',
  );
  const baselineManifests = new Map();
  const currentManifests = new Map();
  for (const identity of identityPolicy.packages ?? []) {
    const absolutePath = path.resolve(repoRoot, identity.manifestPath);
    baselineManifests.set(
      absolutePath,
      commandText(
        await invokeGit([
          'show',
          `${baseline.commit}:${identity.manifestPath}`,
        ]),
      ),
    );
    currentManifests.set(absolutePath, await readFile(absolutePath, 'utf8'));
  }
  const baselineInventory = createPackageInventory({
    policy: identityPolicy,
    readFile: file => baselineManifests.get(path.resolve(file)),
    repoRoot,
  });
  const currentInventory = createPackageInventory({
    policy: identityPolicy,
    readFile: file => currentManifests.get(path.resolve(file)),
    repoRoot,
  });

  const recordedVersions = new Map(
    baseline.packages.map(item => [item.name, item.version]),
  );
  const baselineVersions = inventoryVersionMap(baselineInventory);
  const recordedManifestVersions =
    baseline.ledgerSchemaVersion === 2
      ? new Map(
          [...recordedVersions.keys()].map(name => [
            name,
            baselineVersions.get(name),
          ]),
        )
      : baselineVersions;
  const baselineMismatches = versionMismatches(
    recordedVersions,
    recordedManifestVersions,
    ['recordedVersion', 'manifestVersion'],
  );
  if (baselineMismatches.length > 0) {
    throw unresolvedError([
      {
        kind: 'baseline-version-mismatch',
        message:
          'Baseline manifests do not match the completed publication versions',
        tag: baseline.tag,
        versions: baselineMismatches,
      },
    ]);
  }
  const currentMismatches = versionMismatches(
    baselineVersions,
    inventoryVersionMap(currentInventory),
    ['baselineVersion', 'currentVersion'],
  );
  if (currentMismatches.length > 0) {
    throw unresolvedError([
      {
        kind: 'unexplained-version-change',
        message: 'Current package versions changed without a completed release',
        planPath: null,
        tag: null,
        versions: currentMismatches,
      },
    ]);
  }

  const changes = classifyReleaseChanges({
    changedFiles,
    inventory: currentInventory,
    policy: impactPolicy,
  });
  const result = createSelectiveReleasePlan({
    baselineInventory,
    bumpOverrideValues: options.bumpOverrideValues,
    changes,
    commits: baseline.commit === head ? [] : [head],
    currentInventory,
    preparedFrom: head,
    previousRelease: {commit: baseline.commit, tag: baseline.tag},
    readManifest: file => currentManifests.get(path.resolve(file)),
    rootImpactRequest: options.rootImpactRequest,
  });
  if (result.kind === 'ambiguous-root') {
    write(
      `Ambiguous root files:\n${result.files.map(file => `- ${file}`).join('\n')}\n`,
    );
    const error = new Error(
      'Root impact is ambiguous; use --root-impact=all or --root-impact=none',
    );
    error.details = result.files;
    throw error;
  }
  if (result.kind === 'no-changes') {
    write(`${result.message}\n`);
    return {...result, apply: options.apply};
  }

  write(canonicalReleasePlan(result.plan));
  write(packageTable(result.plan));
  return {...result, apply: options.apply};
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    await runPlanReleaseCommand();
  } catch (error) {
    console.error(error.message);
    if (error.details) console.error(JSON.stringify(error.details, null, 2));
    process.exitCode = 1;
  }
}
