/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';

const repoRoot = process.cwd();
const moduleUrl = pathToFileURL(
  join(repoRoot, 'scripts/pkgNec/releaseChangePolicy.mjs'),
).href;
const policyPath = join(repoRoot, 'scripts/pkgNec/releaseImpactPolicy.json');
const artifactBuildInputs = [
  'eslint.config.mjs',
  'scripts/babel-plugin-jest-native-globals.js',
  'scripts/bundleTs.mjs',
  'scripts/removeBuildDeclarations.mjs',
  'scripts/writeBundledDeclarations.mjs',
];

const inventory = {
  packages: [
    {
      manifestPath: 'packages/jest/package.json',
      newName: '@pkg-nec/jest',
      publishable: true,
    },
    {
      manifestPath: 'packages/jest-reporters/package.json',
      newName: '@pkg-nec/jest-reporters',
      publishable: true,
    },
    {
      manifestPath: 'packages/private-helper/package.json',
      newName: '@pkg-nec/private-helper',
      publishable: false,
    },
  ],
};

function classify(changedFiles) {
  const program = `
    import fs from 'graceful-fs';
    import {classifyReleaseChanges} from ${JSON.stringify(moduleUrl)};
    const value = classifyReleaseChanges({
      changedFiles: ${JSON.stringify(changedFiles)},
      inventory: ${JSON.stringify(inventory)},
      policy: JSON.parse(fs.readFileSync(${JSON.stringify(policyPath)}, 'utf8')),
    });
    console.log(JSON.stringify({
      packageChanges: Array.from(value.packageChanges.entries()),
      root: value.root,
    }));
  `;
  const child = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', program],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    },
  );
  if (child.status !== 0) throw new Error(child.stderr);
  return JSON.parse(child.stdout);
}

function classifyError(changedFiles) {
  try {
    classify(changedFiles);
  } catch (error) {
    return error.message;
  }
  throw new Error('expected classification to fail');
}

test('maps every public package path to its longest matching package directory', () => {
  const result = classify([
    'packages\\jest-reporters\\src\\index.ts',
    'packages/jest/package.json',
  ]);

  expect(new Map(result.packageChanges)).toEqual(
    new Map([
      ['@pkg-nec/jest', ['packages/jest/package.json']],
      ['@pkg-nec/jest-reporters', ['packages/jest-reporters/src/index.ts']],
    ]),
  );
});

test.each([
  ['documentation', ['docs/pkg-nec-maintenance.md'], 'noImpact'],
  ['license', ['LICENSE'], 'allPackages'],
  ['unreviewed root input', ['yarn.lock'], 'ambiguous'],
  [
    'private workspace input',
    ['packages/private-helper/src/index.ts'],
    'ambiguous',
  ],
])('classifies %s as a root input', (_kind, files, classification) => {
  const result = classify(files);

  expect(result.packageChanges).toEqual([]);
  expect(result.root).toEqual({
    allPackages: classification === 'allPackages' ? files : [],
    ambiguous: classification === 'ambiguous' ? files : [],
    noImpact: classification === 'noImpact' ? files : [],
  });
});

test.each(artifactBuildInputs)(
  'classifies package artifact build input %s as all-package impact',
  file => {
    expect(classify([file])).toEqual({
      packageChanges: [],
      root: {allPackages: [file], ambiguous: [], noImpact: []},
    });
  },
);

test('deduplicates and sorts repository-relative paths deterministically', () => {
  const result = classify([
    'packages/jest-reporters/z.ts',
    'packages/jest-reporters/a.ts',
    'packages/jest-reporters/a.ts',
    'docs/z.md',
    'docs/a.md',
  ]);

  expect(new Map(result.packageChanges)).toEqual(
    new Map([
      [
        '@pkg-nec/jest-reporters',
        ['packages/jest-reporters/a.ts', 'packages/jest-reporters/z.ts'],
      ],
    ]),
  );
  expect(result.root.noImpact).toEqual(['docs/a.md', 'docs/z.md']);
});

test.each([
  ['/absolute/path'],
  ['C:\\absolute\\path'],
  ['packages/jest/../outside.ts'],
  ['..\\outside.ts'],
])('rejects unsafe changed path %p', files => {
  expect(classifyError(files)).toMatch(/invalid repository-relative path/i);
});
