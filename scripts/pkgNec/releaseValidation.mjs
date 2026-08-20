/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import semver from 'semver';

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

export function validatePatchTransitions({currentPackages, previousPackages}) {
  const changed = [];
  for (const [name, previousVersion] of previousPackages) {
    const currentVersion = currentPackages.get(name);
    if (currentVersion !== semver.inc(previousVersion, 'patch')) {
      throw new Error(
        `${name} must advance by exactly one patch from ${previousVersion}`,
      );
    }
    changed.push(name);
  }
  if (currentPackages.size !== previousPackages.size) {
    throw new Error('Current and previous public package sets differ');
  }
  return changed.sort((left, right) => left.localeCompare(right));
}

function releaseEvent(event) {
  if (!event?.release || typeof event.release !== 'object') {
    throw new TypeError('GitHub release event is missing release metadata');
  }
  return event.release;
}

function validateReleasePackages({inventory, packages}) {
  if (packages.length !== 55) {
    throw new Error(`Expected 55 release packages, found ${packages.length}`);
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
    if (typeof item.name !== 'string' || typeof item.version !== 'string') {
      throw new TypeError(`Invalid release package at order ${item.order}`);
    }
    if (names.has(item.name)) {
      throw new Error(`Duplicate release package: ${item.name}`);
    }
    names.add(item.name);

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
  const publicPackageNames = new Set();
  for (const [name, workspace] of inventory?.byNewName ?? []) {
    if (workspace?.publishable === true) publicPackageNames.add(name);
  }
  if (
    publicPackageNames.size !== names.size ||
    [...publicPackageNames].some(name => !names.has(name))
  ) {
    throw new Error(
      'Release ledger public package set does not match inventory',
    );
  }
  return names;
}

export function validateReleaseMetadata({event, inventory, ledger, tagCommit}) {
  if (ledger?.schemaVersion !== 1 || !Array.isArray(ledger.packages)) {
    throw new TypeError('Unsupported pkg-nec release ledger');
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
  });
  const anchorName = selectReleaseAnchor(packageNames);
  const anchorVersion = ledger.packages.find(
    item => item.name === anchorName,
  ).version;
  const release = releaseEvent(event);
  const {anchorName: taggedAnchor, anchorVersion: taggedVersion} =
    parseReleaseTag(release.tag_name);
  if (taggedAnchor !== anchorName || taggedVersion !== anchorVersion) {
    throw new Error('Release tag does not match the calculated anchor');
  }
  if (release.name !== release.tag_name) {
    throw new Error('Release name does not match the release tag');
  }
  if (typeof release.body !== 'string' || !release.body.includes(tagCommit)) {
    throw new Error('Release body does not include the full source commit');
  }
  for (const {name, version} of ledger.packages) {
    if (!release.body.includes(`\`${name}@${version}\``)) {
      throw new Error(`Release body is missing ${name}@${version}`);
    }
  }

  return {
    anchorName,
    anchorVersion,
    packageCount: 55,
    sourceCommit: ledger.sourceCommit,
    tagName: release.tag_name,
  };
}
