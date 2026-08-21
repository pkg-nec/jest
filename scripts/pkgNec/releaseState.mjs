/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {createHash} from 'node:crypto';
import {
  releasePlanPathFromTag,
  validateReleasePlan,
} from './releasePlanSchema.mjs';

const requiredAssetNames = [
  'workflow-summary.md',
  'release-ledger.json',
  'publication-journal.json',
  'registry-evidence.json',
  'provenance-evidence.json',
];

function compare(left, right) {
  return left.localeCompare(right);
}

function fullCommit(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value);
}

function assetContent(asset) {
  if (asset?.content === undefined) return null;
  if (typeof asset.content !== 'string') return asset.content;
  if (asset.name === 'workflow-summary.md') return asset.content;
  try {
    return JSON.parse(asset.content);
  } catch {
    return null;
  }
}

function packageVersions(value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  const names = new Set();
  const packages = [];
  for (const [index, item] of value.entries()) {
    if (
      !item ||
      typeof item !== 'object' ||
      typeof item.name !== 'string' ||
      typeof item.version !== 'string' ||
      names.has(item.name)
    ) {
      return null;
    }
    const order = item.order ?? index + 1;
    if (order !== index + 1) return null;
    names.add(item.name);
    packages.push({name: item.name, order, version: item.version});
  }
  return packages;
}

function samePackages(left, right) {
  return (
    left.length === right.length &&
    left.every(
      (item, index) =>
        item.name === right[index].name &&
        item.order === right[index].order &&
        item.version === right[index].version,
    )
  );
}

function validLedgerSchema({assets, ledger, packages, releaseTag}) {
  if (ledger?.schemaVersion === 1) return true;
  if (ledger?.schemaVersion !== 2) return false;
  let expectedPath;
  try {
    expectedPath = releasePlanPathFromTag(releaseTag);
  } catch {
    return false;
  }
  if (
    ledger.releasePlan?.path !== expectedPath ||
    !/^sha256-[0-9a-f]{64}$/u.test(ledger.releasePlan?.digest)
  ) {
    return false;
  }
  const planAsset = assets.get(expectedPath.split('/').at(-1));
  if (typeof planAsset?.content !== 'string') return false;
  const actualDigest = `sha256-${createHash('sha256')
    .update(planAsset.content)
    .digest('hex')}`;
  if (actualDigest !== ledger.releasePlan.digest) return false;

  let plan;
  try {
    plan = validateReleasePlan(JSON.parse(planAsset.content));
  } catch {
    return false;
  }
  const planPackages = plan.packages.map(item => ({
    name: item.name,
    order: item.order,
    version: item.toVersion,
  }));
  return (
    plan.planPath === expectedPath &&
    plan.anchor.tag === releaseTag &&
    samePackages(packages, planPackages)
  );
}

function parseWorkflowSummary(summary) {
  if (typeof summary !== 'string') return null;
  const match =
    /^# pkg-nec release workflow evidence\r?\n\r?\n- Release tag: `([^`\r\n]+)`\r?\n- Source workflow run: (https:\/\/github\.com\/pkg-nec\/jest\/actions\/runs\/\d+)\r?\n- Validate job: `([^`\r\n]+)`\r?\n- Publish job: `([^`\r\n]+)`\r?\n- Verify job: `([^`\r\n]+)`\r?\n$/u.exec(
      summary,
    );
  if (!match) return null;
  return {
    publish: match[4],
    runUrl: match[2],
    tag: match[1],
    validate: match[3],
    verify: match[5],
  };
}

function releaseWorkflowRun({commit, releaseRuns, summary, tag}) {
  const recorded = parseWorkflowSummary(summary);
  if (
    recorded?.tag !== tag ||
    recorded.validate !== 'success' ||
    recorded.publish !== 'success' ||
    recorded.verify !== 'success'
  ) {
    return undefined;
  }
  return releaseRuns.find(
    run =>
      run?.conclusion === 'success' &&
      run?.event === 'release' &&
      run?.head_branch === tag &&
      run?.head_sha === commit &&
      run?.html_url === recorded.runUrl &&
      run?.path === '.github/workflows/release.yml' &&
      run?.status === 'completed',
  );
}

function inspectCompletedRelease(release, releaseRuns) {
  if (
    release?.draft !== false ||
    release?.prerelease !== false ||
    typeof release?.published_at !== 'string' ||
    typeof release?.tag_name !== 'string' ||
    !fullCommit(release?.tagCommit)
  ) {
    return null;
  }

  const assets = new Map(
    (release.assets ?? []).map(asset => [asset?.name, asset]),
  );
  if (requiredAssetNames.some(name => !assets.has(name))) return null;

  const ledger = assetContent(assets.get('release-ledger.json'));
  const journal = assetContent(assets.get('publication-journal.json'));
  const registry = assetContent(assets.get('registry-evidence.json'));
  const provenance = assetContent(assets.get('provenance-evidence.json'));
  const summary = assetContent(assets.get('workflow-summary.md'));
  const packages = packageVersions(ledger?.packages);
  if (
    packages === null ||
    !validLedgerSchema({
      assets,
      ledger,
      packages,
      releaseTag: release.tag_name,
    }) ||
    ledger?.sourceCommit !== release.tagCommit
  ) {
    return null;
  }

  for (const evidence of [journal, registry, provenance]) {
    const evidencePackages = packageVersions(evidence?.packages);
    if (
      evidence?.schemaVersion !== 1 ||
      evidence?.releaseTag !== release.tag_name ||
      evidence?.sourceCommit !== release.tagCommit ||
      evidencePackages === null ||
      !samePackages(packages, evidencePackages)
    ) {
      return null;
    }
  }

  const run = releaseWorkflowRun({
    commit: release.tagCommit,
    releaseRuns,
    summary,
    tag: release.tag_name,
  });
  if (run === undefined) return null;

  return {
    commit: release.tagCommit,
    ledgerSchemaVersion: ledger.schemaVersion,
    packages,
    publishedAt: release.published_at,
    releaseUrl: release.html_url,
    runUrl: run.html_url,
    tag: release.tag_name,
  };
}

function nestedReleaseRuns(releases) {
  return releases.flatMap(release => release?.releaseRuns ?? []);
}

function workflowRunId(runUrl) {
  if (typeof runUrl !== 'string') return null;
  const match = /\/actions\/runs\/([1-9]\d*)$/u.exec(runUrl);
  return match ? BigInt(match[1]) : null;
}

function completedRunSupersedes({completed, run}) {
  const completedId = workflowRunId(completed?.runUrl);
  const runId = workflowRunId(run?.html_url);
  return (
    completedId !== null &&
    runId !== null &&
    completedId > runId &&
    run?.event === 'release' &&
    run?.head_branch === completed?.tag &&
    run?.head_sha === completed?.commit &&
    run?.path === '.github/workflows/release.yml'
  );
}

export function selectPublishedBaseline({releases, releaseRuns}) {
  if (!Array.isArray(releases) || !Array.isArray(releaseRuns)) {
    throw new TypeError('Invalid GitHub release state');
  }
  const completed = releases
    .map(release => inspectCompletedRelease(release, releaseRuns))
    .filter(Boolean)
    .sort(
      (left, right) =>
        compare(right.publishedAt, left.publishedAt) ||
        compare(right.tag, left.tag),
    );
  if (completed.length === 0) {
    throw new Error(
      'No completed published release is available as a baseline',
    );
  }
  return completed[0];
}

function manualState(kind, details, explanation) {
  return {
    ...details,
    kind,
    message: `${explanation}; manual investigation is required`,
  };
}

function plannedVersions(plan) {
  return (plan?.packages ?? []).map(item => ({
    fromVersion: item?.fromVersion,
    name: item?.name,
    toVersion: item?.toVersion,
  }));
}

function releaseVersions(release) {
  const ledgerAsset = (release?.assets ?? []).find(
    asset => asset?.name === 'release-ledger.json',
  );
  return packageVersions(assetContent(ledgerAsset)?.packages) ?? [];
}

function planPublicationMismatches(plan, publishedPackages) {
  const planned = new Map(
    (plan?.packages ?? []).map(item => [item?.name, item?.toVersion]),
  );
  const published = new Map(
    publishedPackages.map(item => [item.name, item.version]),
  );
  return [...new Set([...planned.keys(), ...published.keys()])]
    .sort(compare)
    .filter(name => planned.get(name) !== published.get(name))
    .map(name => ({
      name,
      plannedVersion: planned.get(name) ?? null,
      publishedVersion: published.get(name) ?? null,
    }));
}

function inspectLocalPlan(local) {
  try {
    const plan = validateReleasePlan(local?.plan);
    const derivedPath = releasePlanPathFromTag(plan.anchor.tag);
    if (local?.path !== plan.planPath || local.path !== derivedPath) {
      throw new Error('Tracked path does not match the release plan path');
    }
    return {plan};
  } catch (error) {
    return {
      error:
        error instanceof Error ? error.message : 'Invalid tracked release plan',
    };
  }
}

function laterThanBaseline(value, baseline) {
  return typeof value !== 'string' || compare(value, baseline.publishedAt) > 0;
}

export function findUnresolvedReleaseState({
  localPlans,
  releaseRuns = null,
  releases,
  tags = [],
}) {
  if (
    !Array.isArray(localPlans) ||
    !Array.isArray(releases) ||
    (releaseRuns !== null && !Array.isArray(releaseRuns)) ||
    !Array.isArray(tags)
  ) {
    throw new TypeError('Invalid release state collections');
  }
  const allReleaseRuns = releaseRuns ?? nestedReleaseRuns(releases);
  const baseline = selectPublishedBaseline({
    releaseRuns: allReleaseRuns,
    releases,
  });
  const completedByTag = new Map();
  for (const release of releases) {
    const completed = inspectCompletedRelease(release, allReleaseRuns);
    if (completed) completedByTag.set(completed.tag, completed);
  }
  const releaseTags = new Set(
    releases
      .map(release => release?.tag_name)
      .filter(tag => typeof tag === 'string'),
  );
  const releasesByTag = new Map(
    releases
      .filter(release => typeof release?.tag_name === 'string')
      .map(release => [release.tag_name, release]),
  );

  const unresolved = [];
  const validLocalPlans = [];
  for (const local of [...localPlans].sort((left, right) =>
    compare(left?.path ?? '', right?.path ?? ''),
  )) {
    const inspection = inspectLocalPlan(local);
    if (inspection.error) {
      unresolved.push(
        manualState(
          'invalid-local-plan',
          {
            planPath: local?.path ?? null,
            tag:
              typeof local?.plan?.anchor?.tag === 'string'
                ? local.plan.anchor.tag
                : null,
            validationError: inspection.error,
            versions: plannedVersions(local?.plan),
          },
          'A tracked release plan is invalid or path-aliased',
        ),
      );
      continue;
    }
    const plan = inspection.plan;
    validLocalPlans.push({path: local.path, plan});
    const tag = plan.anchor.tag;
    const completed = completedByTag.get(tag);
    if (!completed) {
      const relatedRelease = releasesByTag.get(tag);
      const relatedRun = allReleaseRuns.find(
        run =>
          run?.head_branch === tag ||
          (fullCommit(relatedRelease?.tagCommit) &&
            run?.head_sha === relatedRelease.tagCommit),
      );
      unresolved.push(
        manualState(
          'local-plan',
          {
            draftUrl:
              relatedRelease?.draft === true
                ? (relatedRelease.html_url ?? null)
                : null,
            planPath: local?.path ?? null,
            runUrl: relatedRun?.html_url ?? null,
            tag,
            versions: plannedVersions(plan),
          },
          'A local release plan has no matching completed publication',
        ),
      );
      continue;
    }
    const mismatches = planPublicationMismatches(plan, completed.packages);
    if (mismatches.length > 0) {
      unresolved.push(
        manualState(
          'plan-publication-mismatch',
          {
            planPath: local?.path ?? null,
            tag,
            versions: mismatches,
          },
          'The local plan versions do not match durable publication state',
        ),
      );
    }
  }

  const laterReleases = releases
    .filter(release =>
      laterThanBaseline(release?.published_at ?? release?.created_at, baseline),
    )
    .sort((left, right) =>
      compare(left?.created_at ?? '', right?.created_at ?? ''),
    );
  for (const release of laterReleases) {
    if (release?.draft === true) {
      unresolved.push(
        manualState(
          'draft-release',
          {
            draftUrl: release?.html_url ?? null,
            tag: release?.tag_name ?? null,
            versions: releaseVersions(release),
          },
          'A later draft GitHub Release exists',
        ),
      );
      continue;
    }
    if (release?.prerelease === true) {
      unresolved.push(
        manualState(
          'prerelease',
          {
            draftUrl: release?.html_url ?? null,
            tag: release?.tag_name ?? null,
            versions: releaseVersions(release),
          },
          'A later prerelease exists outside the completed baseline',
        ),
      );
      continue;
    }
    if (release?.published_at && !completedByTag.has(release?.tag_name)) {
      unresolved.push(
        manualState(
          'incomplete-release',
          {
            tag: release?.tag_name ?? null,
            versions: releaseVersions(release),
          },
          'A later published Release lacks successful durable evidence',
        ),
      );
    }
  }

  const unmatchedTags = tags
    .filter(
      tag =>
        typeof tag?.name === 'string' &&
        tag.name.startsWith('@pkg-nec/') &&
        !releaseTags.has(tag.name),
    )
    .sort((left, right) => compare(left.name, right.name));
  const blockingUnmatchedTags = unmatchedTags.filter(
    tag => tag?.relationToBaseline !== 'ancestor',
  );
  for (const tag of blockingUnmatchedTags) {
    unresolved.push(
      manualState(
        'unmatched-tag',
        {
          commit: fullCommit(tag.commit) ? tag.commit : null,
          relationToBaseline: tag.relationToBaseline ?? 'unknown',
          tag: tag.name,
          versions: [],
        },
        'A non-historical pkg-nec tag has no matching GitHub Release',
      ),
    );
  }

  const relevantLaterTags = new Set([
    ...completedByTag.keys(),
    ...laterReleases.map(release => release?.tag_name),
    ...validLocalPlans.map(local => local.plan.anchor.tag),
    ...blockingUnmatchedTags.map(tag => tag.name),
  ]);
  const relevantCommitsByTag = new Map();
  const relevantTagsByCommit = new Map();
  for (const tag of [
    ...[...completedByTag.values()].map(completed => ({
      commit: completed.commit,
      name: completed.tag,
    })),
    ...laterReleases.map(release => ({
      commit: release?.tagCommit,
      name: release?.tag_name,
    })),
    ...blockingUnmatchedTags,
  ]) {
    if (fullCommit(tag?.commit) && typeof tag?.name === 'string') {
      const commitsForTag = relevantCommitsByTag.get(tag.name) ?? new Set();
      commitsForTag.add(tag.commit);
      relevantCommitsByTag.set(tag.name, commitsForTag);
      const tagsForCommit = relevantTagsByCommit.get(tag.commit) ?? new Set();
      tagsForCommit.add(tag.name);
      relevantTagsByCommit.set(tag.commit, tagsForCommit);
    }
  }
  const seenRuns = new Set();
  for (const run of allReleaseRuns) {
    const key = run?.html_url ?? String(run?.id ?? '');
    const branchTag = relevantLaterTags.has(run?.head_branch)
      ? run.head_branch
      : undefined;
    const commitTags = relevantTagsByCommit.get(run?.head_sha);
    const ambiguousCommit = branchTag === undefined && commitTags?.size > 1;
    const matchingTag =
      branchTag ?? (commitTags?.size === 1 ? [...commitTags][0] : undefined);
    if (seenRuns.has(key) || (matchingTag === undefined && !ambiguousCommit)) {
      continue;
    }
    seenRuns.add(key);
    if (ambiguousCommit) {
      unresolved.push(
        manualState(
          'failed-run',
          {
            runUrl: run?.html_url ?? null,
            tag: null,
            versions: [],
          },
          'A release run commit matches multiple relevant tags',
        ),
      );
      continue;
    }
    if (run?.head_branch !== matchingTag) {
      unresolved.push(
        manualState(
          'failed-run',
          {
            runUrl: run?.html_url ?? null,
            tag: matchingTag,
            versions: [],
          },
          'A correlated release run has an invalid tag identity',
        ),
      );
      continue;
    }
    const matchingCommits = relevantCommitsByTag.get(matchingTag);
    if (matchingCommits?.size !== 1 || !matchingCommits.has(run?.head_sha)) {
      unresolved.push(
        manualState(
          'failed-run',
          {
            runUrl: run?.html_url ?? null,
            tag: matchingTag,
            versions: [],
          },
          'A correlated release run has an invalid source commit',
        ),
      );
      continue;
    }
    if (run?.path !== '.github/workflows/release.yml') {
      unresolved.push(
        manualState(
          'failed-run',
          {
            runUrl: run?.html_url ?? null,
            tag: matchingTag,
            versions: [],
          },
          'A correlated release run has an invalid workflow identity',
        ),
      );
      continue;
    }
    if (run?.status !== 'completed') {
      unresolved.push(
        manualState(
          'in-progress-run',
          {
            runUrl: run?.html_url ?? null,
            tag: matchingTag,
            versions: [],
          },
          'A later release workflow run is still in progress',
        ),
      );
    } else if (run?.conclusion !== 'success') {
      if (
        completedRunSupersedes({
          completed: completedByTag.get(matchingTag),
          run,
        })
      ) {
        continue;
      }
      unresolved.push(
        manualState(
          'failed-run',
          {
            runUrl: run?.html_url ?? null,
            tag: matchingTag,
            versions: [],
          },
          'A later release workflow run did not succeed',
        ),
      );
    }
  }

  const kindOrder = new Map([
    ['invalid-local-plan', 0],
    ['local-plan', 0],
    ['plan-publication-mismatch', 0],
    ['incomplete-release', 1],
    ['draft-release', 2],
    ['prerelease', 2],
    ['unmatched-tag', 3],
    ['failed-run', 4],
    ['in-progress-run', 5],
  ]);
  return unresolved.sort(
    (left, right) =>
      kindOrder.get(left.kind) - kindOrder.get(right.kind) ||
      compare(
        left.planPath ?? left.tag ?? left.runUrl ?? '',
        right.planPath ?? right.tag ?? right.runUrl ?? '',
      ),
  );
}
