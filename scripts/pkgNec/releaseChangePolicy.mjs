/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

function compare(left, right) {
  return left.localeCompare(right);
}

function normalizeRepositoryPath(value) {
  if (typeof value !== 'string') {
    throw new TypeError('invalid repository-relative path');
  }
  const normalized = value.replaceAll('\\', '/');
  if (
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:/u.test(normalized) ||
    normalized.split('/').includes('..')
  ) {
    throw new Error(`invalid repository-relative path ${value}`);
  }
  return normalized;
}

function packageDirectory(manifestPath) {
  const normalized = manifestPath.replaceAll('\\', '/');
  const suffix = '/package.json';
  if (!normalized.endsWith(suffix)) return null;
  const directory = normalized.slice(0, -suffix.length);
  const packageIndex = directory.lastIndexOf('/packages/');
  if (packageIndex !== -1) return directory.slice(packageIndex + 1);
  return directory.startsWith('packages/') ? directory : null;
}

function publicPackageDirectories(inventory) {
  const entries = inventory?.packages ?? [];
  return entries
    .filter(entry => entry.publishable !== false)
    .map(entry => ({
      directory: packageDirectory(entry.manifestPath),
      name: entry.newName,
    }))
    .filter(entry => entry.directory !== null)
    .sort(
      (left, right) =>
        right.directory.length - left.directory.length ||
        compare(left.name, right.name),
    );
}

function policyMatches(path, paths, prefixes) {
  return (
    paths.includes(path) || prefixes.some(prefix => path.startsWith(prefix))
  );
}

function validatePolicy(policy) {
  const fields = [
    'noImpactPaths',
    'noImpactPrefixes',
    'allPackagePaths',
    'allPackagePrefixes',
  ];
  if (!policy || fields.some(field => !Array.isArray(policy[field]))) {
    throw new TypeError('invalid release impact policy');
  }
}

export function classifyReleaseChanges({changedFiles, inventory, policy}) {
  validatePolicy(policy);
  const packageChanges = new Map();
  const root = {allPackages: [], ambiguous: [], noImpact: []};
  const directories = publicPackageDirectories(inventory);

  for (const path of [
    ...new Set([...changedFiles].map(normalizeRepositoryPath)),
  ].sort(compare)) {
    const matchingPackage = directories.find(
      entry =>
        path === entry.directory || path.startsWith(`${entry.directory}/`),
    );
    if (matchingPackage) {
      const files = packageChanges.get(matchingPackage.name) ?? [];
      files.push(path);
      packageChanges.set(matchingPackage.name, files);
    } else if (
      policyMatches(path, policy.noImpactPaths, policy.noImpactPrefixes)
    ) {
      root.noImpact.push(path);
    } else if (
      policyMatches(path, policy.allPackagePaths, policy.allPackagePrefixes)
    ) {
      root.allPackages.push(path);
    } else {
      root.ambiguous.push(path);
    }
  }

  return {
    packageChanges: new Map(
      [...packageChanges.entries()].sort(([left], [right]) =>
        compare(left, right),
      ),
    ),
    root,
  };
}
