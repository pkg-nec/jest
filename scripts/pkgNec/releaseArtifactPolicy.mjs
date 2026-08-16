/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

export function normalizePackageFiles(files) {
  return [
    ...new Set(
      [...files]
        .map(file => file.replaceAll('\\', '/'))
        .map(file => file.replace(/^\.\//, '').replace(/^package\//, ''))
        .filter(file => file && !file.endsWith('/')),
    ),
  ].sort();
}

export function comparePackageFiles({actualFiles, expectedFiles}) {
  const actual = normalizePackageFiles(actualFiles);
  const expected = normalizePackageFiles(expectedFiles);
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const added = actual.filter(file => !expectedSet.has(file));
  const missing = expected.filter(file => !actualSet.has(file));
  return {
    actualCount: actual.length,
    added,
    exact: added.length === 0 && missing.length === 0,
    expectedCount: expected.length,
    missing,
  };
}

const prohibitedBasenames = new Set(['.eslintcache', 'tsconfig.tsbuildinfo']);
const declarationPattern = /\.d\.(?:m|c)?ts$/u;

function collectStrings(value, files) {
  if (typeof value === 'string') files.add(value.replace(/^\.\//, ''));
  else if (value && typeof value === 'object') {
    for (const child of Object.values(value)) collectStrings(child, files);
  }
}

export function manifestEntryFiles(manifest) {
  const files = new Set();
  collectStrings(manifest?.exports, files);
  if (typeof manifest?.main === 'string') files.add(manifest.main);
  if (typeof manifest?.types === 'string') files.add(manifest.types);
  return normalizePackageFiles(files);
}

export function validateReleaseFiles({files, helper, manifest, packageName}) {
  const normalizedFiles = normalizePackageFiles(files);
  const entries = manifestEntryFiles(manifest);
  const required = ['LICENSE', 'package.json'];
  const problems = new Set(
    required
      .filter(file => !normalizedFiles.includes(file))
      .map(file => `missing ${file}`),
  );

  for (const file of normalizedFiles) {
    const basename = file.split('/').at(-1);
    if (prohibitedBasenames.has(basename)) problems.add(`prohibited ${file}`);
    if (file.startsWith('src/')) problems.add(`prohibited ${file}`);
    if (file === 'tsconfig.json') problems.add(`prohibited ${file}`);
    if (declarationPattern.test(file) && !entries.includes(file)) {
      problems.add(`unreachable declaration ${file}`);
    }
  }

  if (helper) {
    const comparison = comparePackageFiles({
      actualFiles: normalizedFiles,
      expectedFiles: [...new Set([...required, 'README.md', ...entries])],
    });
    for (const file of comparison.missing) problems.add(`missing ${file}`);
    for (const file of comparison.added) problems.add(`additional ${file}`);
  }

  if (problems.size > 0) {
    throw new Error(
      `${packageName} release files invalid: ${[...problems].sort().join(', ')}`,
    );
  }
  return normalizedFiles;
}
