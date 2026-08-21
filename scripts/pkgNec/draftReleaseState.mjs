/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {validateReleasePlan} from './releasePlanSchema.mjs';
import {
  findUnresolvedReleaseState,
  selectPublishedBaseline,
} from './releaseState.mjs';

function fullCommit(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value);
}

function display(value, fallback) {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function bytes(value, name) {
  if (typeof value === 'string') return Buffer.from(value);
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new TypeError(`${name} must be bytes`);
}

function unresolvedSummary(unresolved) {
  return unresolved
    .map(item => {
      const identities = [
        item.planPath,
        item.tag,
        item.runUrl,
        item.draftUrl,
      ].filter(value => typeof value === 'string' && value.length > 0);
      return `${item.kind}:${identities.join('|') || 'unknown'}`;
    })
    .join(', ');
}

function validatedLocalPlans(localPlans) {
  return localPlans.flatMap(local => {
    try {
      return [{path: local?.path, plan: validateReleasePlan(local?.plan)}];
    } catch {
      return [];
    }
  });
}

function matchingReleaseIdentity({plan, releases, tags}) {
  const tag = tags.find(candidate => candidate?.name === plan.anchor.tag);
  if (tag) {
    throw new Error(`Release tag identity already exists: ${plan.anchor.tag}`);
  }
  const release = releases.find(
    candidate => candidate?.tag_name === plan.anchor.tag,
  );
  if (release) {
    throw new Error(
      `GitHub Release identity already exists for ${plan.anchor.tag}: ${display(
        release.html_url,
        plan.anchor.tag,
      )}`,
    );
  }
}

function exactLocalPlan({localPlans, unresolved}) {
  const local = unresolved.filter(item => item.kind === 'local-plan');
  if (unresolved.length !== 1 || local.length !== 1) {
    throw new Error(
      `Expected exactly one unresolved local release plan; found ${
        unresolvedSummary(unresolved) || 'none'
      }`,
    );
  }
  const expected = local[0];
  const matches = validatedLocalPlans(localPlans).filter(
    candidate =>
      candidate.path === expected.planPath &&
      candidate.plan.planPath === expected.planPath &&
      candidate.plan.anchor.tag === expected.tag,
  );
  if (matches.length !== 1) {
    throw new Error(
      `Expected one validated tracked plan for ${display(
        expected.tag,
        'unknown tag',
      )} at ${display(expected.planPath, 'unknown plan path')}; found ${matches.length}`,
    );
  }
  return matches[0].plan;
}

function assertPlanState({head, plan, planState}) {
  const {currentBytes, introductionBytes, introductionCommit, isAncestor} =
    planState ?? {};
  if (!fullCommit(introductionCommit)) {
    throw new Error(
      `Release plan ${plan.planPath} has an invalid introduction commit: ${display(
        introductionCommit,
        'missing',
      )}`,
    );
  }
  if (
    !bytes(introductionBytes, 'introductionBytes').equals(
      bytes(currentBytes, 'currentBytes'),
    )
  ) {
    throw new Error(
      `Release plan ${plan.planPath} changed after introduction commit ${introductionCommit}`,
    );
  }
  if (isAncestor !== true) {
    throw new Error(
      `Release plan introduction commit ${introductionCommit} is not an ancestor of main ${head}`,
    );
  }
  return introductionCommit;
}

function assertMainPackageVersions({mainPackages, plan}) {
  if (!Array.isArray(mainPackages)) {
    throw new TypeError('mainPackages must be an array');
  }
  const versions = new Map();
  for (const item of mainPackages) {
    if (
      !item ||
      typeof item.name !== 'string' ||
      typeof item.version !== 'string' ||
      versions.has(item.name)
    ) {
      throw new TypeError('mainPackages must contain unique package versions');
    }
    versions.set(item.name, item.version);
  }
  for (const entry of plan.packages) {
    const mainVersion = versions.get(entry.name);
    if (mainVersion !== entry.toVersion) {
      throw new Error(
        `Plan ${plan.planPath} package version differs from main for ${entry.name}: planned ${entry.toVersion}, main ${display(
          mainVersion,
          'missing',
        )}`,
      );
    }
  }
}

function nodeRunError(run, introductionCommit) {
  const fields = [];
  if (run?.conclusion !== 'success') fields.push('conclusion');
  if (run?.event !== 'push') fields.push('event');
  if (run?.head_branch !== 'main') fields.push('branch');
  if (run?.path !== '.github/workflows/nodejs.yml')
    fields.push('workflow path');
  if (run?.status !== 'completed') fields.push('status');
  if (run?.head_sha !== introductionCommit) fields.push('commit');
  return `Node CI run ${display(run?.html_url, 'with no URL')} has an invalid ${
    fields.join(', ') || 'identity'
  }`;
}

function assertNodeCi({introductionCommit, nodeRuns}) {
  if (!Array.isArray(nodeRuns))
    throw new TypeError('nodeRuns must be an array');
  const exact = nodeRuns.find(
    run =>
      run?.conclusion === 'success' &&
      run?.event === 'push' &&
      run?.head_branch === 'main' &&
      run?.head_sha === introductionCommit &&
      run?.path === '.github/workflows/nodejs.yml' &&
      run?.status === 'completed',
  );
  if (exact) return;

  const sameCommit = nodeRuns.find(run => run?.head_sha === introductionCommit);
  if (sameCommit) throw new Error(nodeRunError(sameCommit, introductionCommit));

  const successfulOtherCommit = nodeRuns.find(
    run =>
      run?.conclusion === 'success' &&
      run?.event === 'push' &&
      run?.head_branch === 'main' &&
      run?.path === '.github/workflows/nodejs.yml' &&
      run?.status === 'completed',
  );
  if (successfulOtherCommit) {
    throw new Error(
      `Successful Node CI run ${display(
        successfulOtherCommit.html_url,
        'with no URL',
      )} belongs to commit ${display(
        successfulOtherCommit.head_sha,
        'missing',
      )}, not introduction commit ${introductionCommit}`,
    );
  }
  throw new Error(
    `No successful completed Node CI run for introduction commit ${introductionCommit} at .github/workflows/nodejs.yml`,
  );
}

export function resolveDraftReleaseState({
  head,
  localPlans,
  mainPackages,
  nodeRuns,
  originMain,
  planState,
  releases,
  tags,
}) {
  if (!fullCommit(head) || !fullCommit(originMain)) {
    throw new Error('HEAD and origin/main must be full commits');
  }
  if (head !== originMain) {
    throw new Error(`HEAD ${head} does not equal origin/main ${originMain}`);
  }
  if (
    !Array.isArray(localPlans) ||
    !Array.isArray(releases) ||
    !Array.isArray(tags)
  ) {
    throw new TypeError('Invalid draft release state collections');
  }

  const preliminaryPlans = validatedLocalPlans(localPlans);
  if (preliminaryPlans.length === 1) {
    matchingReleaseIdentity({
      plan: preliminaryPlans[0].plan,
      releases,
      tags,
    });
  }

  const releaseRuns = releases.flatMap(release => release?.releaseRuns ?? []);
  const baseline = selectPublishedBaseline({releaseRuns, releases});
  const unresolved = findUnresolvedReleaseState({
    localPlans,
    releaseRuns,
    releases,
    tags,
  });
  const plan = exactLocalPlan({localPlans, unresolved});

  if (
    plan.previousRelease.tag !== baseline.tag ||
    plan.previousRelease.commit !== baseline.commit
  ) {
    throw new Error(
      `Plan ${plan.anchor.tag} previous release ${plan.previousRelease.tag} (${plan.previousRelease.commit}) differs from latest completed release ${baseline.tag} (${baseline.commit})`,
    );
  }

  const planIntroductionCommit = assertPlanState({head, plan, planState});
  assertMainPackageVersions({mainPackages, plan});
  assertNodeCi({introductionCommit: planIntroductionCommit, nodeRuns});

  return {plan, planIntroductionCommit, tag: plan.anchor.tag};
}
