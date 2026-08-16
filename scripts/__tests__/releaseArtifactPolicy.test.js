/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const repoRoot = process.cwd();
const policyModuleUrl = pathToFileURL(
  join(repoRoot, 'scripts/pkgNec/releaseArtifactPolicy.mjs'),
).href;

function runPolicyRequest(action, input) {
  const program = `
    import * as policy from ${JSON.stringify(policyModuleUrl)};
    const action = ${JSON.stringify(action)};
    const input = ${JSON.stringify(input)};
    try {
      console.log(JSON.stringify({
        ok: true,
        value: policy[action](input),
      }));
    } catch (error) {
      console.log(JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        ok: false,
      }));
    }
  `;
  const child = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', program],
    {cwd: repoRoot, encoding: 'utf8'},
  );
  if (child.status !== 0) throw new Error(child.stderr);
  const response = JSON.parse(child.stdout);
  if (!response.ok) throw new Error(response.error);
  return response.value;
}

function comparePackageFiles(options) {
  return runPolicyRequest('comparePackageFiles', options);
}

function manifestEntryFiles(manifest) {
  return runPolicyRequest('manifestEntryFiles', manifest);
}

function normalizePackageFiles(files) {
  return runPolicyRequest('normalizePackageFiles', files);
}

function validateReleaseFiles(options) {
  return runPolicyRequest('validateReleaseFiles', options);
}

const manifest = {
  exports: {
    '.': {
      import: './build/index.mjs',
      require: './build/index.js',
      types: './build/index.d.ts',
    },
    './package.json': './package.json',
  },
  main: './build/index.js',
  types: './build/index.d.ts',
};

test('normalizes archive prefixes, separators, directories, and duplicates', () => {
  expect(
    normalizePackageFiles([
      'package\\build\\index.js',
      './package/build/index.js',
      'package/build/',
      'package/package.json',
    ]),
  ).toEqual(['build/index.js', 'package.json']);
});

test('reports equal-count filename mismatches', () => {
  expect(
    comparePackageFiles({
      actualFiles: ['build/extra.d.ts', 'package.json'],
      expectedFiles: ['LICENSE', 'package.json'],
    }),
  ).toEqual({
    actualCount: 2,
    added: ['build/extra.d.ts'],
    exact: false,
    expectedCount: 2,
    missing: ['LICENSE'],
  });
});

test('collects unique manifest entry files', () => {
  expect(manifestEntryFiles(manifest)).toEqual([
    'build/index.d.ts',
    'build/index.js',
    'build/index.mjs',
    'package.json',
  ]);
});

test.each([
  'package/tsconfig.tsbuildinfo',
  'package/.eslintcache',
  'package/src/index.ts',
  'package/tsconfig.json',
  'package/build/internal.d.ts',
])('rejects prohibited release file %s', file => {
  expect(() =>
    validateReleaseFiles({
      files: ['package/LICENSE', 'package/package.json', file],
      helper: false,
      manifest,
      packageName: '@pkg-nec/example',
    }),
  ).toThrow(new RegExp(`@pkg-nec/example.*${file.split('/').at(-1)}`));
});

test('accepts manifest-reachable declarations', () => {
  expect(
    validateReleaseFiles({
      files: [
        'package/LICENSE',
        'package/package.json',
        'package/build/index.d.ts',
        'package/build/index.js',
        'package/build/index.mjs',
      ],
      helper: false,
      manifest,
      packageName: '@pkg-nec/example',
    }),
  ).toContain('build/index.d.ts');
});

test('enforces the exact helper release file allowlist', () => {
  const files = [
    'package/LICENSE',
    'package/README.md',
    'package/package.json',
    'package/build/index.d.ts',
    'package/build/index.js',
    'package/build/index.mjs',
  ];
  expect(
    validateReleaseFiles({
      files,
      helper: true,
      manifest,
      packageName: '@pkg-nec/helper',
    }),
  ).toEqual([
    'LICENSE',
    'README.md',
    'build/index.d.ts',
    'build/index.js',
    'build/index.mjs',
    'package.json',
  ]);
  expect(() =>
    validateReleaseFiles({
      files: files.filter(file => !file.endsWith('index.mjs')),
      helper: true,
      manifest,
      packageName: '@pkg-nec/helper',
    }),
  ).toThrow(/@pkg-nec\/helper.*missing.*build\/index\.mjs/);
  expect(() =>
    validateReleaseFiles({
      files: [...files, 'package/src/index.ts'],
      helper: true,
      manifest,
      packageName: '@pkg-nec/helper',
    }),
  ).toThrow(/@pkg-nec\/helper.*additional.*src\/index\.ts/);
});
