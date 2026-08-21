/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {isDeepStrictEqual} from 'node:util';
import semver from 'semver';
import {componentReleaseOrder, induceReleaseGraph} from './releaseGraph.mjs';
import {validateReleasePlan} from './releasePlanSchema.mjs';
import {validateReleaseLedger} from './releasePublisher.mjs';
import {buildWorkspaceReleaseGraph} from './selectiveReleaseGraph.mjs';

const fallbackAnchors = [
  '@pkg-nec/create-jest',
  '@pkg-nec/jest-create-cache-key-function',
  '@pkg-nec/jest-environment-jsdom',
  '@pkg-nec/jest-environment-jsdom-abstract',
  '@pkg-nec/jest-phabricator',
  '@pkg-nec/jest-test-globals',
];

export function parseReleaseTag(tagName) {
  if (typeof tagName !== 'string') {
    // eslint-disable-next-line unicorn/prefer-type-error -- Preserve the legacy public error type.
    throw new Error(`Invalid pkg-nec release tag: ${tagName}`);
  }
  const separator = tagName.lastIndexOf('-v');
  const anchorName = tagName.slice(0, separator);
  const anchorVersion = tagName.slice(separator + 2);
  if (
    separator < 1 ||
    !anchorName.startsWith('@pkg-nec/') ||
    semver.valid(anchorVersion) === null
  ) {
    throw new Error(`Invalid pkg-nec release tag: ${tagName}`);
  }
  return {anchorName, anchorVersion};
}

export function selectReleaseAnchor(packageNames) {
  const selected = new Set(packageNames);
  if (selected.has('@pkg-nec/jest')) return '@pkg-nec/jest';
  const fallback = fallbackAnchors.find(name => selected.has(name));
  if (fallback === undefined) {
    throw new Error('Selected release set has no valid anchor package');
  }
  return fallback;
}

export function validatePlannedTransitions({
  inventory,
  plan,
  previousPackages,
}) {
  const currentPackages = new Map(
    [...inventory.byNewName]
      .filter(([, identity]) => identity.publishable === true)
      .map(([name, identity]) => [name, identity.version]),
  );
  if (
    currentPackages.size !== previousPackages.size ||
    [...previousPackages.keys()].some(name => !currentPackages.has(name))
  ) {
    throw new Error('Current and previous public package sets differ');
  }

  const selected = new Set();
  const changed = [];
  for (const item of plan.packages) {
    if (selected.has(item.name)) {
      throw new Error(`Duplicate planned package: ${item.name}`);
    }
    selected.add(item.name);
    const previousVersion = previousPackages.get(item.name);
    if (previousVersion === undefined) {
      throw new Error(`Planned package is not in the baseline: ${item.name}`);
    }
    const workspace = inventory.byNewName.get(item.name);
    if (workspace?.publishable !== true) {
      throw new Error(`Planned package is not publishable: ${item.name}`);
    }
    if (item.fromVersion !== previousVersion) {
      throw new Error(
        `${item.name} plan fromVersion ${item.fromVersion} does not match baseline ${previousVersion}`,
      );
    }
    if (item.toVersion !== workspace.version) {
      throw new Error(
        `${item.name} plan toVersion ${item.toVersion} does not match current ${workspace.version}`,
      );
    }
    changed.push(item.name);
  }

  for (const [name, previousVersion] of previousPackages) {
    if (selected.has(name)) continue;
    const currentVersion = currentPackages.get(name);
    if (currentVersion !== previousVersion) {
      throw new Error(
        `Unselected package ${name} changed from ${previousVersion} to ${currentVersion}`,
      );
    }
  }
  return changed;
}

function releaseEvent(event) {
  if (!event?.release || typeof event.release !== 'object') {
    throw new TypeError('GitHub release event is missing release metadata');
  }
  return event.release;
}

function validateReleasePackages({inventory, packages, plan, releaseGraph}) {
  if (packages.length !== plan.packages.length) {
    throw new Error('Release ledger package count does not match the plan');
  }
  const plannedNames = plan.packages.map(item => item.name);
  const inducedGraph = induceReleaseGraph({
    graph: releaseGraph,
    selectedNames: plannedNames,
  });
  if (!isDeepStrictEqual(componentReleaseOrder(inducedGraph), plannedNames)) {
    throw new Error('Release plan package order does not match prerequisites');
  }
  const names = new Set();
  for (const [index, item] of packages.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new TypeError(`Invalid release package at order ${index + 1}`);
    }
    if (item.order !== index + 1) {
      throw new Error(
        `Release package order must be contiguous at ${index + 1}`,
      );
    }
    if (
      typeof item.name !== 'string' ||
      typeof item.version !== 'string' ||
      !Array.isArray(item.prerequisites)
    ) {
      throw new TypeError(`Invalid release package at order ${item.order}`);
    }
    if (names.has(item.name)) {
      throw new Error(`Duplicate release package: ${item.name}`);
    }
    names.add(item.name);

    const planned = plan.packages[index];
    if (
      item.name !== planned.name ||
      item.version !== planned.toVersion ||
      item.order !== planned.order
    ) {
      throw new Error(
        `Release ledger package does not match the plan at order ${index + 1}`,
      );
    }
    const expectedPrerequisites = [...inducedGraph.get(item.name)].sort(
      (left, right) => left.localeCompare(right),
    );
    if (!isDeepStrictEqual(item.prerequisites, expectedPrerequisites)) {
      throw new Error(
        `Release ledger prerequisites do not match the plan for ${item.name}`,
      );
    }

    const workspace = inventory?.byNewName?.get(item.name);
    if (!workspace?.publishable) {
      throw new Error(
        `Release package is not a publishable workspace: ${item.name}`,
      );
    }
    if (workspace.version !== item.version) {
      throw new Error(`Release package version changed for ${item.name}`);
    }
  }
  return names;
}

function releaseBodyPackages(body) {
  if (typeof body !== 'string') return [];
  return [...body.matchAll(/`([^`\r\n]+)`/gu)].flatMap(match => {
    const value = match[1];
    const token = /^(@pkg-nec\/[a-z0-9][a-z0-9-]*)@(.+)$/u.exec(value);
    if (!token || semver.valid(token[2]) !== token[2]) return [];
    return [value];
  });
}

export function validateReleaseMetadata({
  event,
  inventory,
  ledger,
  plan: unvalidatedPlan,
  releaseGraph = buildWorkspaceReleaseGraph(inventory),
  tagCommit,
}) {
  if (ledger?.schemaVersion !== 2 || !Array.isArray(ledger.packages)) {
    throw new TypeError('Unsupported pkg-nec release ledger');
  }
  const release = releaseEvent(event);
  if (release.draft !== false || release.prerelease !== false) {
    throw new Error('Only stable GitHub Releases may publish pkg-nec packages');
  }
  const parsedTag = parseReleaseTag(release.tag_name);
  validateReleaseLedger({ledger, releaseTag: release.tag_name});
  const plan = validateReleasePlan(unvalidatedPlan);
  if (
    !ledger.releasePlan ||
    ledger.releasePlan.path !== plan.planPath ||
    !/^sha256-[0-9a-f]{64}$/u.test(ledger.releasePlan.digest)
  ) {
    throw new Error('Release ledger does not match the committed plan');
  }
  if (ledger.sourceCommit !== tagCommit) {
    throw new Error(
      'Release ledger source commit does not match the release tag',
    );
  }
  if (!/^[0-9a-f]{40}$/iu.test(ledger.sourceCommit)) {
    throw new Error('Release ledger source commit must be a full Git commit');
  }

  const packageNames = validateReleasePackages({
    inventory,
    packages: ledger.packages,
    plan,
    releaseGraph,
  });
  const anchorName = selectReleaseAnchor(packageNames);
  if (anchorName !== plan.anchor.name) {
    throw new Error('Release plan anchor does not match the selected packages');
  }
  const anchorVersion = plan.anchor.version;
  const {anchorName: taggedAnchor, anchorVersion: taggedVersion} = parsedTag;
  if (taggedAnchor !== anchorName || taggedVersion !== anchorVersion) {
    throw new Error('Release tag does not match the calculated anchor');
  }
  if (release.name !== release.tag_name) {
    throw new Error('Release name does not match the release tag');
  }
  if (typeof release.body !== 'string' || !release.body.includes(tagCommit)) {
    throw new Error('Release body does not include the full source commit');
  }
  const bodyPackages = releaseBodyPackages(release.body);
  const expectedBodyPackages = plan.packages.map(
    item => `${item.name}@${item.toVersion}`,
  );
  if (
    bodyPackages.length !== new Set(bodyPackages).size ||
    bodyPackages.length !== expectedBodyPackages.length ||
    expectedBodyPackages.some(item => !bodyPackages.includes(item))
  ) {
    throw new Error('Release body package list does not match the plan');
  }

  return {
    anchorName,
    anchorVersion,
    packageCount: plan.packages.length,
    sourceCommit: ledger.sourceCommit,
    tagName: release.tag_name,
  };
}
