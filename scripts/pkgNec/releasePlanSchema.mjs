/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import semver from 'semver';

function invalid(message) {
  throw new Error(`invalid release plan: ${message}`);
}

function exactObject(value, fields, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalid(`${name} must be an object`);
  }
  const keys = Object.keys(value).sort(compare);
  const expected = [...fields].sort(compare);
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    invalid(`${name} has unknown or missing fields`);
  }
}

function compare(left, right) {
  return left.localeCompare(right);
}

function repositoryPath(value, name) {
  if (typeof value !== 'string') invalid(`${name} must be a path`);
  const normalized = value.replaceAll('\\', '/');
  if (
    normalized !== value ||
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:/u.test(normalized) ||
    normalized.split('/').includes('..')
  ) {
    invalid(`${name} must be repository-relative`);
  }
  return value;
}

function sortedUniquePaths(value, name) {
  if (!Array.isArray(value)) invalid(`${name} must be an array`);
  const paths = value.map(path => repositoryPath(path, name));
  if (
    paths.some(
      (path, index) => index > 0 && compare(paths[index - 1], path) >= 0,
    )
  ) {
    invalid(`${name} must contain sorted unique paths`);
  }
  return paths;
}

function commit(value, name) {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/u.test(value)) {
    invalid(`${name} must be a full 40-hex commit`);
  }
}

function version(value, name) {
  if (typeof value !== 'string' || semver.valid(value) !== value) {
    invalid(`${name} must be a SemVer version`);
  }
}

function packageName(value, name) {
  if (
    typeof value !== 'string' ||
    !/^@pkg-nec\/[a-z0-9][a-z0-9-]*$/u.test(value)
  ) {
    invalid(`${name} must be a pkg-nec package name`);
  }
}

function releaseTag({name, version: tagVersion}, nameForError) {
  packageName(name, `${nameForError}.name`);
  version(tagVersion, `${nameForError}.version`);
  return `${name}-v${tagVersion}`;
}

function reasonSortKey(reason) {
  if (reason.kind === 'changed') {
    return JSON.stringify(['changed', reason.files]);
  }
  if (reason.kind === 'root-impact') {
    return JSON.stringify(['root-impact', reason.classification, reason.files]);
  }
  return JSON.stringify(['dependent', reason.paths]);
}

function validateReason(reason, packageNameValue, index) {
  const name = `packages.reasons[${index}]`;
  if (!reason || typeof reason !== 'object' || Array.isArray(reason)) {
    invalid(`${name} must be an object`);
  }
  if (reason.kind === 'changed') {
    exactObject(reason, ['files', 'kind'], name);
    sortedUniquePaths(reason.files, `${name}.files`);
    return;
  }
  if (reason.kind === 'root-impact') {
    exactObject(reason, ['classification', 'files', 'kind'], name);
    if (!['all-packages', 'ambiguous-all'].includes(reason.classification)) {
      invalid(`${name}.classification is invalid`);
    }
    sortedUniquePaths(reason.files, `${name}.files`);
    return;
  }
  if (reason.kind === 'dependent') {
    exactObject(reason, ['kind', 'paths'], name);
    if (!Array.isArray(reason.paths) || reason.paths.length === 0) {
      invalid(`${name}.paths must be a non-empty array`);
    }
    let previous = null;
    for (const path of reason.paths) {
      if (!Array.isArray(path) || path.length < 2) {
        invalid(`${name}.paths must contain dependency paths`);
      }
      for (const [pathIndex, item] of path.entries()) {
        packageName(item, `${name}.paths[${pathIndex}]`);
      }
      if (path.at(-1) !== packageNameValue) {
        invalid(`${name}.paths must end at the selected package`);
      }
      const serialized = JSON.stringify(path);
      if (previous !== null && compare(previous, serialized) >= 0) {
        invalid(`${name}.paths must be sorted and unique`);
      }
      previous = serialized;
    }
    return;
  }
  invalid(`${name}.kind is invalid`);
}

function validateChangedFiles(changedFiles) {
  exactObject(changedFiles, ['packages', 'root'], 'changedFiles');
  if (!Array.isArray(changedFiles.packages)) {
    invalid('changedFiles.packages must be an array');
  }
  let previousName = null;
  const changedNames = new Set();
  for (const item of changedFiles.packages) {
    exactObject(item, ['files', 'name'], 'changedFiles.packages[]');
    packageName(item.name, 'changedFiles.packages[].name');
    if (previousName !== null && compare(previousName, item.name) >= 0) {
      invalid('changedFiles.packages must be sorted and unique');
    }
    previousName = item.name;
    changedNames.add(item.name);
    sortedUniquePaths(item.files, 'changedFiles.packages[].files');
  }
  exactObject(
    changedFiles.root,
    ['allPackages', 'ambiguous', 'noImpact'],
    'changedFiles.root',
  );
  sortedUniquePaths(changedFiles.root.noImpact, 'changedFiles.root.noImpact');
  sortedUniquePaths(
    changedFiles.root.allPackages,
    'changedFiles.root.allPackages',
  );
  sortedUniquePaths(changedFiles.root.ambiguous, 'changedFiles.root.ambiguous');
  return changedNames;
}

export function releasePlanPathFromTag(tag) {
  if (typeof tag !== 'string') invalid('release tag must be a string');
  const match =
    /^(@pkg-nec\/[a-z0-9][a-z0-9-]*)-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/u.exec(
      tag,
    );
  if (!match || semver.valid(match[2]) !== match[2]) {
    invalid('release tag is invalid');
  }
  const planPath = `docs/releases/${tag.replace('@', '').replace('/', '-')}-plan.json`;
  if (
    !planPath.startsWith('docs/releases/') ||
    planPath.split('/').includes('..')
  ) {
    invalid('derived plan path is outside docs/releases');
  }
  return planPath;
}

export function validateReleasePlan(plan) {
  exactObject(
    plan,
    [
      'anchor',
      'changedFiles',
      'packages',
      'planPath',
      'preparedFrom',
      'previousRelease',
      'rootImpact',
      'schemaVersion',
    ],
    'release plan',
  );
  if (plan.schemaVersion !== 1) invalid('schemaVersion must be 1');

  exactObject(plan.previousRelease, ['commit', 'tag'], 'previousRelease');
  commit(plan.previousRelease.commit, 'previousRelease.commit');
  if (typeof plan.previousRelease.tag !== 'string') {
    invalid('previousRelease.tag must be a string');
  }
  releasePlanPathFromTag(plan.previousRelease.tag);
  commit(plan.preparedFrom, 'preparedFrom');

  exactObject(plan.anchor, ['name', 'tag', 'version'], 'anchor');
  const expectedAnchorTag = releaseTag(plan.anchor, 'anchor');
  if (plan.anchor.tag !== expectedAnchorTag)
    invalid('anchor.tag does not match anchor');

  repositoryPath(plan.planPath, 'planPath');
  if (plan.planPath !== releasePlanPathFromTag(plan.anchor.tag)) {
    invalid('planPath does not match anchor.tag');
  }

  const changedNames = validateChangedFiles(plan.changedFiles);

  exactObject(plan.rootImpact, ['applied', 'requested'], 'rootImpact');
  if (!['all', 'none', null].includes(plan.rootImpact.requested)) {
    invalid('rootImpact.requested is invalid');
  }
  if (!['all', 'none', 'not-needed'].includes(plan.rootImpact.applied)) {
    invalid('rootImpact.applied is invalid');
  }

  if (!Array.isArray(plan.packages) || plan.packages.length === 0) {
    invalid('packages must be a non-empty array');
  }
  const selectedNames = new Set();
  for (const [index, item] of plan.packages.entries()) {
    exactObject(
      item,
      ['bump', 'fromVersion', 'name', 'order', 'path', 'reasons', 'toVersion'],
      'packages[]',
    );
    if (item.order !== index + 1)
      invalid('packages must have contiguous order');
    packageName(item.name, 'packages[].name');
    if (selectedNames.has(item.name))
      invalid('packages must have unique names');
    selectedNames.add(item.name);
    repositoryPath(item.path, 'packages[].path');
    version(item.fromVersion, 'packages[].fromVersion');
    version(item.toVersion, 'packages[].toVersion');
    if (!['patch', 'minor', 'major'].includes(item.bump)) {
      invalid('packages[].bump is invalid');
    }
    if (semver.inc(item.fromVersion, item.bump) !== item.toVersion) {
      invalid('packages[].toVersion does not match bump');
    }
    if (!Array.isArray(item.reasons) || item.reasons.length === 0) {
      invalid('packages[].reasons must be a non-empty array');
    }
    let previousReason = null;
    for (const [reasonIndex, reason] of item.reasons.entries()) {
      validateReason(reason, item.name, reasonIndex);
      const key = reasonSortKey(reason);
      if (previousReason !== null && compare(previousReason, key) >= 0) {
        invalid('packages[].reasons must be sorted and unique');
      }
      previousReason = key;
    }
  }
  if (!selectedNames.has(plan.anchor.name)) {
    invalid('anchor.name must be selected');
  }
  const anchorPackage = plan.packages.find(
    item => item.name === plan.anchor.name,
  );
  if (anchorPackage.toVersion !== plan.anchor.version) {
    invalid('anchor.version must match the selected package version');
  }
  for (const changedName of changedNames) {
    if (!selectedNames.has(changedName)) {
      invalid('changed package must be selected');
    }
  }
  return plan;
}

export function canonicalReleasePlan(plan) {
  return `${JSON.stringify(validateReleasePlan(plan), null, 2)}\n`;
}
