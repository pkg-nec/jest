/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import path from 'node:path';
import semver from 'semver';
import {
  releasePlanPathFromTag,
  validateReleasePlan,
} from './releasePlanSchema.mjs';
import {selectReleaseAnchor} from './releaseValidation.mjs';
import {
  buildWorkspaceReleaseGraph,
  selectDependentClosure,
  selectedReleaseOrder,
} from './selectiveReleaseGraph.mjs';

function compare(left, right) {
  return left.localeCompare(right);
}

function noChanges() {
  return {kind: 'no-changes', message: 'no releasable package changes'};
}

function publicPackages(inventory) {
  return inventory.packages
    .filter(identity => identity.publishable !== false)
    .sort((left, right) => compare(left.newName, right.newName));
}

function packageMap(inventory) {
  return new Map(
    inventory.packages.map(identity => [identity.newName, identity]),
  );
}

function reasonKey(reason) {
  if (reason.kind === 'changed') {
    return JSON.stringify(['changed', reason.files]);
  }
  if (reason.kind === 'root-impact') {
    return JSON.stringify(['root-impact', reason.classification, reason.files]);
  }
  return JSON.stringify(['dependent', reason.paths]);
}

function packagePath(identity, inventory) {
  const rootDirectory = inventory.root?.directory;
  if (rootDirectory !== undefined) {
    const relative = path
      .relative(rootDirectory, identity.directory)
      .replaceAll('\\', '/');
    if (
      relative.length === 0 ||
      relative.startsWith('../') ||
      path.isAbsolute(relative)
    ) {
      throw new Error(
        `Package path is outside the repository: ${identity.newName}`,
      );
    }
    return relative;
  }
  const normalized = identity.manifestPath.replaceAll('\\', '/');
  if (
    !path.isAbsolute(identity.manifestPath) &&
    normalized.endsWith('/package.json')
  ) {
    return normalized.slice(0, -'/package.json'.length);
  }
  throw new Error(`Cannot derive package path for ${identity.newName}`);
}

function validateInventories({baselineInventory, currentInventory}) {
  const baseline = new Map(
    publicPackages(baselineInventory).map(identity => [
      identity.newName,
      identity,
    ]),
  );
  const current = new Map(
    publicPackages(currentInventory).map(identity => [
      identity.newName,
      identity,
    ]),
  );
  if (
    baseline.size !== current.size ||
    [...baseline.keys()].some(name => !current.has(name))
  ) {
    throw new Error('Baseline and current public package sets differ');
  }
  return {baseline, current};
}

export function parseBumpOverrides(values) {
  if (!Array.isArray(values)) {
    throw new TypeError('Bump overrides must be an array');
  }
  const overrides = new Map();
  for (const value of values) {
    const match =
      typeof value === 'string'
        ? /^(@pkg-nec\/[a-z0-9][a-z0-9-]*)=(patch|minor|major)$/u.exec(value)
        : null;
    if (!match) throw new Error(`Invalid bump override: ${value}`);
    if (overrides.has(match[1])) {
      throw new Error(`Duplicate bump override: ${match[1]}`);
    }
    overrides.set(match[1], match[2]);
  }
  return new Map(
    [...overrides].sort(([left], [right]) => compare(left, right)),
  );
}

function validateOverrideTargets({currentInventory, overrides, selectedNames}) {
  const all = packageMap(currentInventory);
  const selected = new Set(selectedNames);
  for (const name of overrides.keys()) {
    const identity = all.get(name);
    if (!identity) throw new Error(`Unknown bump override package: ${name}`);
    if (identity.publishable === false) {
      throw new Error(`Private bump override package: ${name}`);
    }
    if (!selected.has(name)) {
      throw new Error(`Unselected bump override package: ${name}`);
    }
  }
}

function validatePreApplyVersions({baseline, current, selectedNames}) {
  const selected = new Set(selectedNames);
  for (const [name, currentIdentity] of current) {
    const baselineIdentity = baseline.get(name);
    if (currentIdentity.version !== baselineIdentity.version) {
      const selection = selected.has(name) ? 'Selected' : 'Unselected';
      throw new Error(
        `${selection} package ${name} differs from baseline ${baselineIdentity.version}: current ${currentIdentity.version}`,
      );
    }
  }
}

function addReason(reasons, name, reason) {
  const packageReasons = reasons.get(name) ?? [];
  packageReasons.push(reason);
  reasons.set(name, packageReasons);
}

export function createSelectiveReleasePlan({
  baselineInventory,
  bumpOverrideValues = [],
  changes,
  commits,
  currentInventory,
  preparedFrom,
  previousRelease,
  rootImpactRequest = null,
}) {
  if (![null, 'all', 'none'].includes(rootImpactRequest)) {
    throw new Error(`Invalid root-impact request: ${rootImpactRequest}`);
  }
  if (!Array.isArray(commits)) throw new TypeError('Commits must be an array');
  const overrides = parseBumpOverrides(bumpOverrideValues);
  const {baseline, current} = validateInventories({
    baselineInventory,
    currentInventory,
  });

  const allIdentities = packageMap(currentInventory);
  for (const name of overrides.keys()) {
    const identity = allIdentities.get(name);
    if (!identity) throw new Error(`Unknown bump override package: ${name}`);
    if (identity.publishable === false) {
      throw new Error(`Private bump override package: ${name}`);
    }
  }

  if (commits.length === 0) {
    validateOverrideTargets({
      currentInventory,
      overrides,
      selectedNames: [],
    });
    validatePreApplyVersions({baseline, current, selectedNames: []});
    return noChanges();
  }

  const changedPackageNames = [...changes.packageChanges.keys()].sort(compare);
  for (const name of changedPackageNames) {
    if (!current.has(name)) {
      throw new Error(`Changed package is not public: ${name}`);
    }
  }

  const hasKnownAllImpact = changes.root.allPackages.length > 0;
  const hasAmbiguousImpact = changes.root.ambiguous.length > 0;
  if (!hasKnownAllImpact && hasAmbiguousImpact && rootImpactRequest === null) {
    validatePreApplyVersions({
      baseline,
      current,
      selectedNames: changedPackageNames,
    });
    return {files: [...changes.root.ambiguous], kind: 'ambiguous-root'};
  }

  let applied = 'not-needed';
  let selectAll = false;
  if (hasKnownAllImpact) {
    applied = 'all';
    selectAll = true;
  } else if (hasAmbiguousImpact) {
    applied = rootImpactRequest;
    selectAll = rootImpactRequest === 'all';
  }

  const directNames = new Set(changedPackageNames);
  if (selectAll) {
    for (const name of current.keys()) directNames.add(name);
  }
  if (directNames.size === 0) {
    validateOverrideTargets({
      currentInventory,
      overrides,
      selectedNames: [],
    });
    validatePreApplyVersions({baseline, current, selectedNames: []});
    return noChanges();
  }

  const graph = buildWorkspaceReleaseGraph(currentInventory);
  const closure = selectDependentClosure({
    directNames: [...directNames],
    graph,
  });
  validateOverrideTargets({
    currentInventory,
    overrides,
    selectedNames: closure.selectedNames,
  });

  validatePreApplyVersions({
    baseline,
    current,
    selectedNames: closure.selectedNames,
  });

  const reasons = new Map();
  for (const [name, files] of changes.packageChanges) {
    addReason(reasons, name, {files: [...files], kind: 'changed'});
  }
  if (hasKnownAllImpact) {
    for (const name of current.keys()) {
      addReason(reasons, name, {
        classification: 'all-packages',
        files: [...changes.root.allPackages],
        kind: 'root-impact',
      });
    }
  }
  if (!hasKnownAllImpact && hasAmbiguousImpact && selectAll) {
    for (const name of current.keys()) {
      addReason(reasons, name, {
        classification: 'ambiguous-all',
        files: [...changes.root.ambiguous],
        kind: 'root-impact',
      });
    }
  }
  for (const [name, paths] of closure.dependentPaths) {
    addReason(reasons, name, {kind: 'dependent', paths});
  }
  for (const packageReasons of reasons.values()) {
    packageReasons.sort((left, right) =>
      compare(reasonKey(left), reasonKey(right)),
    );
  }

  const order = selectedReleaseOrder({
    graph,
    selectedNames: closure.selectedNames,
  });
  const packages = order.map((name, index) => {
    const identity = current.get(name);
    const fromVersion = baseline.get(name).version;
    const bump = overrides.get(name) ?? 'patch';
    const toVersion = semver.inc(fromVersion, bump);
    if (toVersion === null) {
      throw new Error(`Cannot apply ${bump} bump to ${name}@${fromVersion}`);
    }
    return {
      bump,
      fromVersion,
      name,
      order: index + 1,
      path: packagePath(identity, currentInventory),
      reasons: reasons.get(name),
      toVersion,
    };
  });
  const anchorName = selectReleaseAnchor(order);
  const anchorVersion = packages.find(
    item => item.name === anchorName,
  ).toVersion;
  const anchorTag = `${anchorName}-v${anchorVersion}`;
  const plan = {
    anchor: {name: anchorName, tag: anchorTag, version: anchorVersion},
    changedFiles: {
      packages: [...changes.packageChanges].map(([name, files]) => ({
        files: [...files],
        name,
      })),
      root: {
        allPackages: [...changes.root.allPackages],
        ambiguous: [...changes.root.ambiguous],
        noImpact: [...changes.root.noImpact],
      },
    },
    packages,
    planPath: releasePlanPathFromTag(anchorTag),
    preparedFrom,
    previousRelease,
    rootImpact: {applied, requested: rootImpactRequest},
    schemaVersion: 1,
  };
  validateReleasePlan(plan);
  return {kind: 'release', plan};
}
