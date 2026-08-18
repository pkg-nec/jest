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

function isHelperReleasePackageName(packageName) {
  return runPolicyRequest('isHelperReleasePackageName', packageName);
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

const getTypeCompatibilityFiles = [
  'package/LICENSE',
  'package/build/index.d.mts',
  'package/build/index.d.ts',
  'package/build/index.js',
  'package/build/index.mjs',
  'package/package.json',
];

test('accepts the audited get-type 30.1.0 compatibility declaration', () => {
  expect(
    validateReleaseFiles({
      files: getTypeCompatibilityFiles,
      helper: false,
      manifest: {
        ...manifest,
        name: '@pkg-nec/jest-get-type',
        version: '30.1.0',
      },
      packageName: '@pkg-nec/jest-get-type',
    }),
  ).toEqual([
    'LICENSE',
    'build/index.d.mts',
    'build/index.d.ts',
    'build/index.js',
    'build/index.mjs',
    'package.json',
  ]);
});

test.each([
  ['@pkg-nec/jest-get-type', '30.1.1'],
  ['@pkg-nec/jest-regex-util', '30.1.0'],
])(
  'rejects the get-type compatibility declaration for %s@%s',
  (packageName, version) => {
    expect(() =>
      validateReleaseFiles({
        files: getTypeCompatibilityFiles,
        helper: false,
        manifest: {...manifest, name: packageName, version},
        packageName,
      }),
    ).toThrow(
      `${packageName} release files invalid: unreachable declaration build/index.d.mts`,
    );
  },
);

test('rejects an unlisted declaration for get-type 30.1.0', () => {
  expect(() =>
    validateReleaseFiles({
      files: [...getTypeCompatibilityFiles, 'package/build/unlisted.d.mts'],
      helper: false,
      manifest: {
        ...manifest,
        name: '@pkg-nec/jest-get-type',
        version: '30.1.0',
      },
      packageName: '@pkg-nec/jest-get-type',
    }),
  ).toThrow(
    '@pkg-nec/jest-get-type release files invalid: unreachable declaration build/unlisted.d.mts',
  );
});

test.each([
  ['@pkg-nec/jest-pattern', 'package/src/TestPathPatterns.ts'],
  ['@pkg-nec/jest-pattern', 'package/tsconfig.json'],
  ['@pkg-nec/jest-snapshot-utils', 'package/src/utils.ts'],
  ['@pkg-nec/jest-snapshot-utils', 'package/tsconfig.json'],
])('rejects removed build input %s %s', (packageName, file) => {
  expect(() =>
    validateReleaseFiles({
      files: ['package/LICENSE', 'package/package.json', file],
      helper: false,
      manifest: {...manifest, name: packageName, version: '30.4.1'},
      packageName,
    }),
  ).toThrow(`${packageName} release files invalid: prohibited`);
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

test.each([
  {
    entry: '/outside.js',
    kind: 'Unix-absolute main',
    unsafeManifest: {...manifest, main: '/outside.js'},
  },
  {
    entry: '../outside.d.ts',
    kind: 'backslash traversal types',
    unsafeManifest: {...manifest, types: '..\\outside.d.ts'},
  },
  {
    entry: 'C:/outside.d.ts',
    kind: 'drive-absolute nested export',
    unsafeManifest: {
      ...manifest,
      exports: {
        ...manifest.exports,
        './unsafe': {types: 'C:\\outside.d.ts'},
      },
    },
  },
  {
    entry: 'C:outside.js',
    kind: 'drive-relative main',
    unsafeManifest: {...manifest, main: 'C:outside.js'},
  },
  {
    entry: 'C:../outside.d.ts',
    kind: 'drive-relative traversal types',
    unsafeManifest: {...manifest, types: 'C:../outside.d.ts'},
  },
  {
    entry: 'D:outside.d.ts',
    kind: 'drive-relative nested export',
    unsafeManifest: {
      ...manifest,
      exports: {
        ...manifest.exports,
        './unsafe': {types: 'D:outside.d.ts'},
      },
    },
  },
])('rejects a $kind manifest entry', ({entry, unsafeManifest}) => {
  expect(() =>
    validateReleaseFiles({
      files: ['package/LICENSE', 'package/package.json'],
      helper: false,
      manifest: unsafeManifest,
      packageName: '@pkg-nec/example',
    }),
  ).toThrow(`invalid manifest entry ${entry}`);
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

test('names the private release helpers that use the local file policy', () => {
  expect(isHelperReleasePackageName('@pkg-nec/jest-test-globals')).toBe(true);
  expect(isHelperReleasePackageName('@pkg-nec/jest-test-utils')).toBe(true);
  expect(isHelperReleasePackageName('@pkg-nec/jest-core')).toBe(false);
});
