/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {spawnSync} from 'node:child_process';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, relative} from 'node:path';
import {pathToFileURL} from 'node:url';

import policy from '../pkgNec/packageIdentityPolicy.json';

const repoRoot = process.cwd();
const oldJestGlobals = ['@jest', 'globals'].join('/');
const candidateModules = {
  module: pathToFileURL(join(repoRoot, 'scripts/pkgNec/moduleCandidates.mjs'))
    .href,
  structured: pathToFileURL(
    join(repoRoot, 'scripts/pkgNec/structuredCandidates.mjs'),
  ).href,
};
const repositoryFilesUrl = pathToFileURL(
  join(repoRoot, 'scripts/pkgNec/repositoryFiles.mjs'),
).href;

function collectCandidates(module, exportName, options) {
  const program = `
    import {${exportName}} from ${JSON.stringify(candidateModules[module])};
    const identities = ${JSON.stringify(policy.packages)};
    const inventory = {
      byNewName: new Map(identities.map(item => [item.newName, item])),
      byOldName: new Map(identities.map(item => [item.oldName, item])),
    };
    console.log(JSON.stringify(${exportName}({
      ...${JSON.stringify(options)},
      inventory,
    })));
  `;
  const child = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', program],
    {cwd: repoRoot, encoding: 'utf8'},
  );

  if (child.status !== 0) throw new Error(child.stderr);
  return JSON.parse(child.stdout);
}

function collectModuleCandidates(options) {
  return collectCandidates('module', 'collectModuleCandidates', options);
}

function collectStructuredCandidates(options) {
  return collectCandidates(
    'structured',
    'collectStructuredCandidates',
    options,
  );
}

function candidateValues(candidates) {
  return candidates.map(({newValue, oldValue}) => [oldValue, newValue]);
}

function enumerateFiles(root) {
  const program = `
    import {enumerateRepositoryFiles} from ${JSON.stringify(repositoryFilesUrl)};
    console.log(JSON.stringify(enumerateRepositoryFiles({repoRoot: ${JSON.stringify(root)}})));
  `;
  const child = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', program],
    {cwd: repoRoot, encoding: 'utf8'},
  );

  if (child.status !== 0) throw new Error(child.stderr);
  return JSON.parse(child.stdout);
}

describe('pkg-nec audit candidates', () => {
  test('collects a canonical old package specifier', () => {
    expect(
      collectModuleCandidates({
        filePath: 'example.js',
        text: "import {expect} from '@jest/globals';",
      }),
    ).toEqual([
      expect.objectContaining({
        filePath: 'example.js',
        oldName: '@jest/globals',
        specifier: '@jest/globals',
      }),
    ]);
  });

  test('collects supported JavaScript and TypeScript module specifiers', () => {
    const text = `
      const emoji = '😀';
      import type {Config} from '@jest/types';
      export {expect} from 'expect';
      export type {Config as RuntimeConfig} from 'jest-runtime';
      export * from 'jest-util';
      const runtime = await import('jest-runtime/build/index.js');
      const util = require('jest-util');
      const resolved = require.resolve('@jest/types');
      jest.disableAutomock().mock('@jest/globals', () => ({
        ...jest.requireActual('@jest/globals'),
      }));
    `;

    expect(
      candidateValues(collectModuleCandidates({filePath: 'fixture.ts', text})),
    ).toEqual([
      ['@jest/types', '@pkg-nec/jest-types'],
      ['expect', '@pkg-nec/expect'],
      ['jest-runtime', '@pkg-nec/jest-runtime'],
      ['jest-util', '@pkg-nec/jest-util'],
      ['jest-runtime/build/index.js', '@pkg-nec/jest-runtime/build/index.js'],
      ['jest-util', '@pkg-nec/jest-util'],
      ['@jest/types', '@pkg-nec/jest-types'],
      ['@jest/globals', '@pkg-nec/jest-globals'],
      ['@jest/globals', '@pkg-nec/jest-globals'],
    ]);
  });

  test.each([
    'mock',
    'doMock',
    'unmock',
    'dontMock',
    'setMock',
    'requireActual',
    'requireMock',
    'createMockFromModule',
  ])('collects jest.%s module arguments even when chained', method => {
    expect(
      collectModuleCandidates({
        filePath: join('fixtures', 'module.js'),
        text: `jest.disableAutomock().${method}('jest-util');`,
      }),
    ).toEqual([
      expect.objectContaining({
        newValue: '@pkg-nec/jest-util',
        oldValue: 'jest-util',
      }),
    ]);
  });

  test.each([
    ['component.tsx', "const value: string = <Widget source='jest-util' />;"],
    ['component.jsx', "const value: string = <Widget source='jest-util' />;"],
  ])('parses %s without treating JSX values as modules', (filePath, text) => {
    expect(collectModuleCandidates({filePath, text})).toEqual([]);
  });

  test('collects TypeScript import types and deep imports', () => {
    expect(
      candidateValues(
        collectModuleCandidates({
          filePath: 'signature.ts',
          text: `
            function load<T extends import('jest-util').ErrorWithStack>(): import('@jest/types').Config {}
            const runtime = import('jest-runtime/build/index.js');
          `,
        }),
      ),
    ).toEqual([
      ['jest-util', '@pkg-nec/jest-util'],
      ['@jest/types', '@pkg-nec/jest-types'],
      ['jest-runtime/build/index.js', '@pkg-nec/jest-runtime/build/index.js'],
    ]);
  });

  test('leaves non-module, third-party, relative, and prose strings alone', () => {
    const text = `
      import fc from '@fast-check/jest';
      import path from 'node:path';
      import sibling from './jest-util';
      const config = {testEnvironment: 'node'};
      const packageDescription = 'jest-util is useful prose';
      const jest = () => 'jest';
    `;

    expect(collectModuleCandidates({filePath: 'fixture.js', text})).toEqual([]);
  });

  test('rejects shadowed Jest bindings and accepts global or imported APIs', () => {
    const shadowed = `
      const jest = {mock() {}};
      jest.mock('jest-util');
      function configure(jest) {
        jest.requireActual('@jest/types');
      }
    `;
    expect(
      collectModuleCandidates({filePath: 'shadowed.js', text: shadowed}),
    ).toEqual([]);
    expect(
      candidateValues(
        collectModuleCandidates({
          filePath: 'global.js',
          text: "jest.mock('jest-util');",
        }),
      ),
    ).toEqual([['jest-util', '@pkg-nec/jest-util']]);

    const imported = `
      import {jest as testJest} from '@jest/globals';
      testJest.disableAutomock().mock('jest-util');
    `;
    expect(
      candidateValues(
        collectModuleCandidates({filePath: 'imported.js', text: imported}),
      ),
    ).toEqual([
      ['@jest/globals', '@pkg-nec/jest-globals'],
      ['jest-util', '@pkg-nec/jest-util'],
    ]);
  });

  test.each([
    "export const jest = localApi; jest.mock('jest-util');",
    "for (const jest of values) jest.mock('jest-util');",
    "switch (kind) { case 'local': const jest = localApi; jest.mock('jest-util'); }",
    "for (const jest of jest.mock('jest-util')) {}",
    "for (const jest in jest.mock('jest-util')) {}",
  ])('does not collect from a shadowed Jest binding: %s', text => {
    expect(collectModuleCandidates({filePath: 'shadowed.js', text})).toEqual(
      [],
    );
  });

  test('collects manifest identity names and keys without ranges', () => {
    const text = JSON.stringify({
      dependencies: {
        '@fast-check/jest': '^2.1.1',
        [oldJestGlobals]: 'workspace:*',
      },
      name: '@jest/monorepo',
      resolutions: {'jest-runtime': 'workspace:^'},
    });

    expect(
      candidateValues(
        collectStructuredCandidates({
          category: 'manifest',
          filePath: 'package.json',
          text,
        }),
      ),
    ).toEqual([
      ['@jest/globals', '@pkg-nec/jest-globals'],
      ['@jest/monorepo', '@pkg-nec/monorepo'],
      ['jest-runtime', '@pkg-nec/jest-runtime'],
    ]);
  });

  test('collects JSONC compiler type entries', () => {
    expect(
      candidateValues(
        collectStructuredCandidates({
          category: 'jsonc',
          filePath: 'tsconfig.json',
          text: '{/* keep */"compilerOptions":{"types":["@jest/globals","node"]}}',
        }),
      ),
    ).toEqual([['@jest/globals', '@pkg-nec/jest-globals']]);
  });

  test('collects package positions in structured identity-array tuples', () => {
    const text = JSON.stringify({
      ignored: [['jest-util', {label: '@jest/types'}]],
      reporters: [['@jest/reporters', {label: 'jest-util'}]],
      watchPlugins: [['@jest/test-sequencer', {related: '@jest/types'}]],
    });

    expect(
      candidateValues(
        collectStructuredCandidates({
          category: 'jsonc',
          filePath: 'jest.config.json',
          text,
        }),
      ),
    ).toEqual([
      ['@jest/reporters', '@pkg-nec/jest-reporters'],
      ['@jest/test-sequencer', '@pkg-nec/jest-test-sequencer'],
    ]);
  });

  test('preserves upstream npm identities in nested fixture locks', () => {
    expect(
      collectStructuredCandidates({
        category: 'fixture-lock',
        filePath: 'e2e/global-setup/yarn.lock',
        text: '"@jest/types@npm:^29.6.3":\n  resolution: "@jest/types@npm:29.6.3"\n',
      }),
    ).toEqual([]);
  });

  test('collects documentation package contexts but leaves prose alone', () => {
    const text = [
      'npm install jest @jest/globals',
      "import {expect} from 'expect';",
      '`jest-runtime/build/index.js`',
      '[npm](https://www.npmjs.com/package/jest-util)',
      '[types](https://www.npmjs.com/package/@jest/types)',
      'npm install jest # expect stays prose',
      '| jest-mock | expect stays prose |',
      'Jest documentation says expect is an ordinary verb.',
    ].join('\n');

    expect(
      candidateValues(
        collectStructuredCandidates({
          category: 'documentation',
          filePath: 'README.md',
          text,
        }),
      ),
    ).toEqual([
      ['jest', '@pkg-nec/jest'],
      ['@jest/globals', '@pkg-nec/jest-globals'],
      ['expect', '@pkg-nec/expect'],
      ['jest-runtime', '@pkg-nec/jest-runtime'],
      ['jest-util', '@pkg-nec/jest-util'],
      ['@jest/types', '@pkg-nec/jest-types'],
      ['jest', '@pkg-nec/jest'],
      ['jest-mock', '@pkg-nec/jest-mock'],
    ]);
  });

  test.each(['documentation', 'workflow', 'text'])(
    'preserves protected quoted CLI, prose, and config text in %s files',
    category => {
      const text = [
        'run: "yarn jest"',
        'description: "expect better results"',
        'packageName: "jest"',
        '`yarn jest --runInBand`',
        'moduleNameMapper: {"^jest$": "<rootDir>/test.js"}',
      ].join('\n');

      expect(
        collectStructuredCandidates({
          category,
          filePath: 'fixture.txt',
          text,
        }),
      ).toEqual([]);
    },
  );

  test.each([
    'https://example.invalid/?type=@jest/types',
    'https://example.invalid/package/@jest/types',
  ])('preserves scoped identities in non-npm URL %s', url => {
    expect(
      collectStructuredCandidates({
        category: 'documentation',
        filePath: 'README.md',
        text: `[reference](${url})`,
      }),
    ).toEqual([]);
  });

  test('requires code-like framing before collecting from strings', () => {
    expect(
      collectStructuredCandidates({
        category: 'documentation',
        filePath: 'README.md',
        text: "Results differ from 'expect'",
      }),
    ).toEqual([]);
  });

  test('enumerates supported files with generated-directory exclusions', async () => {
    const temporaryRepo = await mkdtemp(join(tmpdir(), 'pkg-nec-files-'));
    const files = [
      'README.md',
      'package.json',
      'src/index.ts',
      'tsconfig.json',
      'yarn.lock',
      'e2e/fixture/yarn.lock',
      '.github/workflows/test.yml',
      '.git/config.js',
      '.worktrees/linked/index.js',
      '.yarn/cache/archive.js',
      'node_modules/pkg/index.js',
      'packages/example/build/index.js',
      'coverage/report.json',
      'docs/pkg-nec-rebrand-technical-guide.md',
      'docs/superpowers/specs/current-design.md',
    ];

    try {
      for (const file of files) {
        const absolutePath = join(temporaryRepo, file);
        await mkdir(join(absolutePath, '..'), {recursive: true});
        await writeFile(absolutePath, 'fixture');
      }

      const enumerated = enumerateFiles(temporaryRepo).map(entry => ({
        ...entry,
        path: relative(temporaryRepo, entry.path).replaceAll('\\', '/'),
      }));

      expect(enumerated).toEqual([
        {category: 'workflow', path: '.github/workflows/test.yml'},
        {category: 'documentation', path: 'README.md'},
        {
          category: 'documentation',
          path: 'docs/pkg-nec-rebrand-technical-guide.md',
        },
        {category: 'fixture-lock', path: 'e2e/fixture/yarn.lock'},
        {category: 'manifest', path: 'package.json'},
        {category: 'module', path: 'src/index.ts'},
        {category: 'jsonc', path: 'tsconfig.json'},
        {category: 'lock', path: 'yarn.lock'},
      ]);
    } finally {
      await rm(temporaryRepo, {force: true, recursive: true});
    }
  });
});
