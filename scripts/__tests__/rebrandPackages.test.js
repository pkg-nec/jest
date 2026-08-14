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

const repoRoot = process.cwd();
const identityModuleUrl = pathToFileURL(
  join(repoRoot, 'scripts/pkgNecPackageIdentity.mjs'),
).href;
const moduleCandidatesUrl = pathToFileURL(
  join(repoRoot, 'scripts/pkgNec/moduleCandidates.mjs'),
).href;
const repositoryFilesUrl = pathToFileURL(
  join(repoRoot, 'scripts/pkgNec/repositoryFiles.mjs'),
).href;
const structuredCandidatesUrl = pathToFileURL(
  join(repoRoot, 'scripts/pkgNec/structuredCandidates.mjs'),
).href;

function rewriteModule(code, filePath) {
  const program = `
    import {discoverPackageIdentities} from ${JSON.stringify(identityModuleUrl)};
    import {applyTextEdits, collectModuleCandidates} from ${JSON.stringify(moduleCandidatesUrl)};

    const code = ${JSON.stringify(code)};
    const filePath = ${JSON.stringify(filePath)};
    const inventory = discoverPackageIdentities({repoRoot: ${JSON.stringify(repoRoot)}});
    const edits = collectModuleCandidates({code, filePath, inventory});
    console.log(JSON.stringify(applyTextEdits(code, edits)));
  `;
  const child = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', program],
    {cwd: repoRoot, encoding: 'utf8'},
  );

  if (child.status !== 0) throw new Error(child.stderr);
  return JSON.parse(child.stdout);
}

function rewriteStructured(text, filePath, category) {
  const program = `
    import {discoverPackageIdentities} from ${JSON.stringify(identityModuleUrl)};
    import {applyTextEdits} from ${JSON.stringify(moduleCandidatesUrl)};
    import {collectStructuredCandidates} from ${JSON.stringify(structuredCandidatesUrl)};

    const text = ${JSON.stringify(text)};
    const inventory = discoverPackageIdentities({repoRoot: ${JSON.stringify(repoRoot)}});
    const edits = collectStructuredCandidates({
      category: ${JSON.stringify(category)},
      filePath: ${JSON.stringify(filePath)},
      inventory,
      text,
    });
    console.log(JSON.stringify(applyTextEdits(text, edits)));
  `;
  const child = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', program],
    {cwd: repoRoot, encoding: 'utf8'},
  );

  if (child.status !== 0) throw new Error(child.stderr);
  return JSON.parse(child.stdout);
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

describe('pkg-nec rewrite candidates', () => {
  test('collects supported JavaScript and TypeScript module specifiers', () => {
    const source = `
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

    const result = rewriteModule(source, 'fixture.ts');

    expect(result).toContain("from '@pkg-nec/jest-types'");
    expect(result).toContain("from '@pkg-nec/expect'");
    expect(result).toContain(
      "export type {Config as RuntimeConfig} from '@pkg-nec/jest-runtime'",
    );
    expect(result).toContain("export * from '@pkg-nec/jest-util'");
    expect(result).toContain("import('@pkg-nec/jest-runtime/build/index.js')");
    expect(result).toContain("require('@pkg-nec/jest-util')");
    expect(result).toContain("require.resolve('@pkg-nec/jest-types')");
    expect(result.match(/@pkg-nec\/jest-globals/g)).toHaveLength(2);
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
    const source = `jest.disableAutomock().${method}('jest-util');`;

    expect(rewriteModule(source, join('fixtures', 'module.js'))).toBe(
      `jest.disableAutomock().${method}('@pkg-nec/jest-util');`,
    );
  });

  test.each([
    ['component.tsx', "const value: string = <Widget source='jest-util' />;"],
    ['component.jsx', "const value: string = <Widget source='jest-util' />;"],
  ])('parses %s without treating JSX values as modules', (filePath, source) => {
    expect(rewriteModule(source, filePath)).toBe(source);
  });

  test('collects TypeScript import types from function signatures', () => {
    const source = `
      function load<T extends import('jest-util').ErrorWithStack>(): import('@jest/types').Config {}
    `;

    expect(rewriteModule(source, 'signature.ts')).toBe(`
      function load<T extends import('@pkg-nec/jest-util').ErrorWithStack>(): import('@pkg-nec/jest-types').Config {}
    `);
  });

  test('leaves non-module and third-party strings unchanged', () => {
    const source = `
      import fc from '@fast-check/jest';
      import path from 'node:path';
      import sibling from './jest-util';
      const config = {testEnvironment: 'node'};
      const packageDescription = 'jest-util is useful prose';
      const jest = () => 'jest';
    `;

    expect(rewriteModule(source, 'fixture.js')).toBe(source);
  });

  test('rejects shadowed Jest bindings and accepts global or imported Jest APIs', () => {
    const source = `
      const jest = {mock() {}};
      jest.mock('jest-util');
      function configure(jest) {
        jest.requireActual('@jest/types');
      }
    `;
    expect(rewriteModule(source, 'shadowed.js')).toBe(source);

    expect(rewriteModule("jest.mock('jest-util');", 'global.js')).toBe(
      "jest.mock('@pkg-nec/jest-util');",
    );

    const imported = `
      import {jest as testJest} from '@jest/globals';
      testJest.disableAutomock().mock('jest-util');
    `;
    expect(rewriteModule(imported, 'imported.js')).toBe(`
      import {jest as testJest} from '@pkg-nec/jest-globals';
      testJest.disableAutomock().mock('@pkg-nec/jest-util');
    `);
  });

  test('collects shadowing declarations from exports, loops, and switches', () => {
    const exported = `
      export const jest = localApi;
      jest.mock('jest-util');
    `;
    expect(rewriteModule(exported, 'exported.js')).toBe(exported);

    const loop = `
      for (const jest of values) jest.mock('jest-util');
    `;
    expect(rewriteModule(loop, 'loop.js')).toBe(loop);

    const switched = `
      switch (kind) {
        case 'local':
          const jest = localApi;
          jest.mock('jest-util');
          break;
      }
    `;
    expect(rewriteModule(switched, 'switch.js')).toBe(switched);
  });

  test.each([
    "for (const jest of jest.mock('jest-util')) {}",
    "for (const jest in jest.mock('jest-util')) {}",
  ])('applies a loop binding temporal dead zone to its RHS: %s', source => {
    expect(rewriteModule(source, 'loop-tdz.js')).toBe(source);
  });

  test('rewrites manifest identity names and keys without changing ranges', () => {
    const manifest = JSON.stringify({
      dependencies: {
        '@fast-check/jest': '^2.1.1',
        '@jest/globals': 'workspace:*',
      },
      name: '@jest/monorepo',
      resolutions: {'jest-runtime': 'workspace:^'},
    });

    expect(
      JSON.parse(rewriteStructured(manifest, 'package.json', 'manifest')),
    ).toEqual({
      dependencies: {
        '@fast-check/jest': '^2.1.1',
        '@pkg-nec/jest-globals': 'workspace:*',
      },
      name: '@pkg-nec/monorepo',
      resolutions: {'@pkg-nec/jest-runtime': 'workspace:^'},
    });
  });

  test('rewrites JSONC compiler type entries while preserving formatting', () => {
    const jsonc =
      '{/* keep */"compilerOptions":{"types":["@jest/globals","node"]}}';

    expect(rewriteStructured(jsonc, 'tsconfig.json', 'jsonc')).toBe(
      '{/* keep */"compilerOptions":{"types":["@pkg-nec/jest-globals","node"]}}',
    );
  });

  test('rewrites package positions in structured identity-array tuples', () => {
    const jsonc = JSON.stringify({
      ignored: [['jest-util', {label: '@jest/types'}]],
      reporters: [['@jest/reporters', {label: 'jest-util'}]],
      watchPlugins: [['@jest/test-sequencer', {relatedPackage: '@jest/types'}]],
    });

    expect(
      JSON.parse(rewriteStructured(jsonc, 'jest.config.json', 'jsonc')),
    ).toEqual({
      ignored: [['jest-util', {label: '@jest/types'}]],
      reporters: [['@pkg-nec/jest-reporters', {label: 'jest-util'}]],
      watchPlugins: [
        ['@pkg-nec/jest-test-sequencer', {relatedPackage: '@jest/types'}],
      ],
    });
  });

  test('preserves upstream npm identities in nested fixture locks', () => {
    const thirdPartyJest29Entry =
      '"@jest/types@npm:^29.6.3":\n  resolution: "@jest/types@npm:29.6.3"\n';

    expect(
      rewriteStructured(
        thirdPartyJest29Entry,
        'e2e/global-setup/yarn.lock',
        'fixture-lock',
      ),
    ).toBe(thirdPartyJest29Entry);
  });

  test('rewrites documentation package contexts but leaves prose alone', () => {
    const documentation = [
      'npm install jest @jest/globals',
      "import {expect} from 'expect';",
      '`jest-runtime/build/index.js`',
      '[npm](https://www.npmjs.com/package/jest-util)',
      '[types](https://www.npmjs.com/package/@jest/types)',
      'npm install jest # expect stays prose',
      '| jest-mock | expect stays prose |',
      'Jest documentation says expect is an ordinary verb.',
    ].join('\n');

    expect(rewriteStructured(documentation, 'README.md', 'documentation')).toBe(
      [
        'npm install @pkg-nec/jest @pkg-nec/jest-globals',
        "import {expect} from '@pkg-nec/expect';",
        '`@pkg-nec/jest-runtime/build/index.js`',
        '[npm](https://www.npmjs.com/package/@pkg-nec/jest-util)',
        '[types](https://www.npmjs.com/package/@pkg-nec/jest-types)',
        'npm install @pkg-nec/jest # expect stays prose',
        '| @pkg-nec/jest-mock | expect stays prose |',
        'Jest documentation says expect is an ordinary verb.',
      ].join('\n'),
    );
  });

  test.each(['documentation', 'workflow', 'text'])(
    'preserves protected quoted CLI, prose, and config text in %s files',
    category => {
      const protectedText = [
        'run: "yarn jest"',
        'description: "expect better results"',
        'packageName: "jest"',
        '`yarn jest --runInBand`',
        'moduleNameMapper: {"^jest$": "<rootDir>/test.js"}',
      ].join('\n');

      expect(rewriteStructured(protectedText, 'fixture.txt', category)).toBe(
        protectedText,
      );
    },
  );

  test.each([
    'https://example.invalid/?type=@jest/types',
    'https://example.invalid/package/@jest/types',
  ])('preserves scoped identities in non-npm URL %s', url => {
    const documentation = `[reference](${url})`;

    expect(rewriteStructured(documentation, 'README.md', 'documentation')).toBe(
      documentation,
    );
  });

  test('requires code-like import or export framing before from strings', () => {
    const documentation = "Results differ from 'expect'";

    expect(rewriteStructured(documentation, 'README.md', 'documentation')).toBe(
      documentation,
    );
  });

  test('enumerates supported files with exclusions and nested lock categories', async () => {
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
      '.yarn/cache/archive.js',
      'node_modules/pkg/index.js',
      'packages/example/build/index.js',
      'coverage/report.json',
      'scripts/pkgNec/upstreamManifestBaseline.json',
      'docs/pkg-nec-rebrand-technical-guide.md',
      'docs/superpowers/specs/2026-08-12-pkg-nec-package-rebrand-design.md',
      'docs/superpowers/plans/2026-08-12-pkg-nec-package-rebrand.md',
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
