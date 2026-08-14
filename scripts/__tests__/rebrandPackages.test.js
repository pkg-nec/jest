/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {spawnSync} from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, relative} from 'node:path';
import {pathToFileURL} from 'node:url';

import upstreamManifestBaseline from '../pkgNec/upstreamManifestBaseline.json';

const repoRoot = process.cwd();
const oldJestGlobals = ['@jest', 'globals'].join('/');
const moduleCandidatesUrl = pathToFileURL(
  join(repoRoot, 'scripts/pkgNec/moduleCandidates.mjs'),
).href;
const repositoryFilesUrl = pathToFileURL(
  join(repoRoot, 'scripts/pkgNec/repositoryFiles.mjs'),
).href;
const structuredCandidatesUrl = pathToFileURL(
  join(repoRoot, 'scripts/pkgNec/structuredCandidates.mjs'),
).href;
const migrationPlanUrl = pathToFileURL(
  join(repoRoot, 'scripts/pkgNec/migrationPlan.mjs'),
).href;

function upstreamInventoryProgram() {
  const identities = Object.entries(upstreamManifestBaseline).map(
    ([manifestPath, manifest]) => ({
      manifestPath,
      newName:
        manifest.name === '@jest/monorepo'
          ? '@pkg-nec/monorepo'
          : manifest.name.startsWith('@jest/')
            ? `@pkg-nec/jest-${manifest.name.slice(6)}`
            : `@pkg-nec/${manifest.name}`,
      oldName: manifest.name,
    }),
  );

  return `
    const identities = ${JSON.stringify(identities)};
    const inventory = {
      byNewName: new Map(identities.map(item => [item.newName, item])),
      byOldName: new Map(identities.map(item => [item.oldName, item])),
    };
  `;
}

function runMigrationProgram(program, cwd = repoRoot) {
  return spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
        import {
          applyMigrationPlan,
          buildMigrationPlan,
          validateMigrationPlan,
        } from ${JSON.stringify(migrationPlanUrl)};
        ${program}
      `,
    ],
    {cwd, encoding: 'utf8'},
  );
}

function migrationFixtureProgram({baseline, body, identities, root}) {
  return `
    const identities = ${JSON.stringify(identities)};
    const root = ${JSON.stringify(root)};
    const inventory = {
      byNewName: new Map([root, ...identities].map(item => [item.newName, item])),
      byOldName: new Map([root, ...identities].map(item => [item.oldName, item])),
      packages: identities,
      root,
    };
    const baseline = ${JSON.stringify(baseline)};
    ${body}
  `;
}

function rewriteModule(code, filePath) {
  const program = `
    import {applyTextEdits, collectModuleCandidates} from ${JSON.stringify(moduleCandidatesUrl)};

    const code = ${JSON.stringify(code)};
    const filePath = ${JSON.stringify(filePath)};
    ${upstreamInventoryProgram()}
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
    import {applyTextEdits} from ${JSON.stringify(moduleCandidatesUrl)};
    import {collectStructuredCandidates} from ${JSON.stringify(structuredCandidatesUrl)};

    const text = ${JSON.stringify(text)};
    ${upstreamInventoryProgram()}
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
        [oldJestGlobals]: 'workspace:*',
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

describe('pkg-nec migration plan', () => {
  test('rejects overlapping edits before writing any file', async () => {
    const temporaryRepo = await mkdtemp(join(tmpdir(), 'pkg-nec-plan-'));
    const fixturePath = join(temporaryRepo, 'fixture.js');
    const before = "import 'jest-util';\n";
    await writeFile(fixturePath, before);

    try {
      const overlappingPlan = {
        files: [
          {
            after: "import '@pkg-nec/jest-util';\n",
            before,
            edits: [
              {
                category: 'module',
                end: 17,
                oldValue: 'jest-util',
                replacement: '@pkg-nec/jest-util',
                start: 8,
              },
              {
                category: 'module',
                end: 12,
                oldValue: 'jest',
                replacement: '@pkg-nec/jest',
                start: 8,
              },
            ],
            path: fixturePath,
          },
        ],
        manifestComparisons: [],
      };
      const child = runMigrationProgram(
        `applyMigrationPlan(${JSON.stringify(overlappingPlan)});`,
        temporaryRepo,
      );

      expect(child.status).not.toBe(0);
      expect(child.stderr).toMatch(/overlapping edits/);
      expect(await readFile(fixturePath, 'utf8')).toBe(before);
    } finally {
      await rm(temporaryRepo, {force: true, recursive: true});
    }
  });

  test('rejects changed dependency values during preservation preflight', () => {
    const rangeChangingPlan = {
      files: [],
      manifestComparisons: [
        {
          after: '^3.0.0',
          before: '^2.1.1',
          field: 'devDependencies.@fast-check/jest',
          path: 'package.json',
        },
      ],
    };
    const child = runMigrationProgram(
      `validateMigrationPlan(${JSON.stringify(rangeChangingPlan)});`,
    );

    expect(child.status).not.toBe(0);
    expect(child.stderr).toMatch(/dependency value changed/);
  });

  test.each([
    ['empty', []],
    [
      'fabricated',
      [
        {
          after: '30.4.1',
          before: '30.4.1',
          field: 'version',
          path: 'package.json',
        },
      ],
    ],
  ])(
    'rejects a manifest version edit with %s comparisons',
    async (_label, comparisons) => {
      const temporaryRepo = await mkdtemp(join(tmpdir(), 'pkg-nec-plan-'));
      const manifestPath = join(temporaryRepo, 'package.json');
      const before = `${JSON.stringify(
        {
          name: '@jest/monorepo',
          private: true,
          version: '30.4.1',
        },
        null,
        2,
      )}\n`;
      await writeFile(manifestPath, before);
      const root = {
        directory: temporaryRepo,
        manifestPath,
        newName: '@pkg-nec/monorepo',
        oldName: '@jest/monorepo',
        publishable: false,
        version: '30.4.1',
      };
      const baseline = {
        'package.json': {
          name: '@jest/monorepo',
          private: true,
          version: '30.4.1',
        },
      };

      try {
        const child = runMigrationProgram(
          migrationFixtureProgram({
            baseline,
            body: `
              const plan = buildMigrationPlan({
                baseline,
                inventory,
                repoRoot: ${JSON.stringify(temporaryRepo)},
              });
              const manifestFile = plan.files.find(
                file => file.path === ${JSON.stringify(manifestPath)},
              );
              const versionStart = manifestFile.before.indexOf('30.4.1');
              manifestFile.edits.push({
                category: 'manifest',
                end: versionStart + '30.4.1'.length,
                oldValue: '30.4.1',
                replacement: '99.0.0',
                start: versionStart,
              });
              manifestFile.after = manifestFile.after.replace('30.4.1', '99.0.0');
              plan.manifestComparisons = ${JSON.stringify(comparisons)};
              applyMigrationPlan(plan);
            `,
            identities: [],
            root,
          }),
          temporaryRepo,
        );

        expect(child.status).not.toBe(0);
        expect(child.stderr).toMatch(/version changed|preservation/i);
        expect(await readFile(manifestPath, 'utf8')).toBe(before);
      } finally {
        await rm(temporaryRepo, {force: true, recursive: true});
      }
    },
  );

  test('restores every original when a later commit rename fails', async () => {
    const temporaryRepo = await mkdtemp(join(tmpdir(), 'pkg-nec-plan-'));
    const firstPath = join(temporaryRepo, 'first.js');
    const secondPath = join(temporaryRepo, 'second.js');
    const before = 'jest\n';
    await writeFile(firstPath, before);
    await writeFile(secondPath, before);
    const files = [firstPath, secondPath].map(filePath => ({
      after: '@pkg-nec/jest\n',
      before,
      edits: [
        {
          category: 'module',
          end: 4,
          oldValue: 'jest',
          replacement: '@pkg-nec/jest',
          start: 0,
        },
      ],
      path: filePath,
    }));

    try {
      const child = runMigrationProgram(
        `
          import fs from 'node:fs';
          const fileSystem = Object.create(fs);
          let renameCount = 0;
          fileSystem.renameSync = (from, to) => {
            renameCount += 1;
            if (renameCount === 4) throw new Error('injected rename failure');
            fs.renameSync(from, to);
          };
          applyMigrationPlan(
            ${JSON.stringify({files, manifestComparisons: []})},
            {fileSystem},
          );
        `,
        temporaryRepo,
      );

      expect(child.status).not.toBe(0);
      expect(child.stderr).toMatch(/injected rename failure/);
      expect(await readFile(firstPath, 'utf8')).toBe(before);
      expect(await readFile(secondPath, 'utf8')).toBe(before);
      expect((await readdir(temporaryRepo)).sort()).toEqual([
        'first.js',
        'second.js',
      ]);
    } finally {
      await rm(temporaryRepo, {force: true, recursive: true});
    }
  });

  test.each(['root metadata', 'fixture manifest'])(
    'rejects a post-build %s mutation',
    async mutation => {
      const temporaryRepo = await mkdtemp(join(tmpdir(), 'pkg-nec-plan-'));
      const manifestPath = join(temporaryRepo, 'package.json');
      const fixtureDirectory = join(temporaryRepo, 'fixtures');
      const fixturePath = join(fixtureDirectory, 'package.json');
      const manifestBefore = `${JSON.stringify(
        {
          description: 'upstream root',
          name: '@jest/monorepo',
          private: true,
          version: '30.4.1',
        },
        null,
        2,
      )}\n`;
      const fixtureBefore = `${JSON.stringify(
        {
          description: 'upstream fixture',
          name: 'fixture',
          private: true,
          version: '1.0.0',
        },
        null,
        2,
      )}\n`;
      await mkdir(fixtureDirectory, {recursive: true});
      await writeFile(manifestPath, manifestBefore);
      await writeFile(fixturePath, fixtureBefore);
      const root = {
        directory: temporaryRepo,
        manifestPath,
        newName: '@pkg-nec/monorepo',
        oldName: '@jest/monorepo',
        publishable: false,
        version: '30.4.1',
      };
      const baseline = {
        'package.json': {
          name: '@jest/monorepo',
          private: true,
          version: '30.4.1',
        },
      };

      try {
        const child = runMigrationProgram(
          migrationFixtureProgram({
            baseline,
            body: `
              const plan = buildMigrationPlan({
                baseline,
                inventory,
                repoRoot: ${JSON.stringify(temporaryRepo)},
              });
              if (${JSON.stringify(mutation)} === 'root metadata') {
                const manifestFile = plan.files.find(
                  file => file.path === ${JSON.stringify(manifestPath)},
                );
                const start = manifestFile.before.indexOf('upstream root');
                manifestFile.edits.push({
                  category: 'manifest',
                  end: start + 'upstream root'.length,
                  oldValue: 'upstream root',
                  replacement: 'changed root',
                  start,
                });
                manifestFile.after = manifestFile.after.replace(
                  'upstream root',
                  'changed root',
                );
              } else {
                const before = ${JSON.stringify(fixtureBefore)};
                const start = before.indexOf('upstream fixture');
                plan.files.push({
                  after: before.replace('upstream fixture', 'changed fixture'),
                  before,
                  edits: [{
                    category: 'manifest',
                    end: start + 'upstream fixture'.length,
                    oldValue: 'upstream fixture',
                    replacement: 'changed fixture',
                    start,
                  }],
                  path: ${JSON.stringify(fixturePath)},
                });
              }
              applyMigrationPlan(plan);
            `,
            identities: [],
            root,
          }),
          temporaryRepo,
        );

        expect(child.status).not.toBe(0);
        expect(child.stderr).toMatch(/trusted plan|metadata/i);
        expect(await readFile(manifestPath, 'utf8')).toBe(manifestBefore);
        expect(await readFile(fixturePath, 'utf8')).toBe(fixtureBefore);
      } finally {
        await rm(temporaryRepo, {force: true, recursive: true});
      }
    },
  );

  test('reports a retained backup when post-commit cleanup fails', async () => {
    const temporaryRepo = await mkdtemp(join(tmpdir(), 'pkg-nec-plan-'));
    const fixturePath = join(temporaryRepo, 'fixture.js');
    const before = 'jest\n';
    const after = '@pkg-nec/jest\n';
    await writeFile(fixturePath, before);
    const plan = {
      files: [
        {
          after,
          before,
          edits: [
            {
              category: 'module',
              end: 4,
              oldValue: 'jest',
              replacement: '@pkg-nec/jest',
              start: 0,
            },
          ],
          path: fixturePath,
        },
      ],
      manifestComparisons: [],
    };

    try {
      const child = runMigrationProgram(
        `
          import fs from 'node:fs';
          const fileSystem = Object.create(fs);
          fileSystem.unlinkSync = filePath => {
            if (filePath.endsWith('.backup')) {
              const error = new Error('injected backup cleanup failure');
              error.code = 'EACCES';
              throw error;
            }
            fs.unlinkSync(filePath);
          };
          const report = applyMigrationPlan(
            ${JSON.stringify(plan)},
            {fileSystem},
          );
          console.log(JSON.stringify(report));
        `,
        temporaryRepo,
      );

      expect({status: child.status, stderr: child.stderr}).toEqual({
        status: 0,
        stderr: '',
      });
      const report = JSON.parse(child.stdout);
      expect(report.cleanupWarnings).toHaveLength(1);
      expect(report.cleanupWarnings[0]).toMatchObject({path: fixturePath});
      expect(await readFile(fixturePath, 'utf8')).toBe(after);
      expect(await readFile(report.cleanupWarnings[0].backupPath, 'utf8')).toBe(
        before,
      );
      const entries = await readdir(temporaryRepo);
      expect(entries).toHaveLength(2);
      expect(entries).toContain('fixture.js');
      expect(entries.some(entry => entry.endsWith('.backup'))).toBe(true);
    } finally {
      await rm(temporaryRepo, {force: true, recursive: true});
    }
  });

  test('applies a valid plan once and rejects a second run', async () => {
    const temporaryRepo = await mkdtemp(join(tmpdir(), 'pkg-nec-plan-'));
    const manifestPath = join(temporaryRepo, 'package.json');
    const manifest = {
      name: '@jest/monorepo',
      private: true,
      version: '30.4.1',
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const root = {
      directory: temporaryRepo,
      manifestPath,
      newName: '@pkg-nec/monorepo',
      oldName: '@jest/monorepo',
      publishable: false,
      version: '30.4.1',
    };
    const baseline = {
      'package.json': {
        name: '@jest/monorepo',
        private: true,
        version: '30.4.1',
      },
    };

    try {
      const child = runMigrationProgram(
        migrationFixtureProgram({
          baseline,
          body: `
            const validOptions = {baseline, inventory, repoRoot: ${JSON.stringify(temporaryRepo)}};
            applyMigrationPlan(buildMigrationPlan(validOptions));
            buildMigrationPlan(validOptions);
          `,
          identities: [],
          root,
        }),
        temporaryRepo,
      );

      expect(child.status).not.toBe(0);
      expect(child.stderr).toMatch(/already appears to be rebranded/);
      expect(JSON.parse(await readFile(manifestPath, 'utf8')).name).toBe(
        '@pkg-nec/monorepo',
      );
    } finally {
      await rm(temporaryRepo, {force: true, recursive: true});
    }
  });

  test.each([
    {
      expected: "import value from '@pkg-nec/monorepo' assert {type: 'json'};",
      label: 'legacy static import assertions',
      source: "import value from '@jest/monorepo' assert {type: 'json'};",
    },
    {
      expected: "import value from '@pkg-nec/monorepo';\nconst node = <App />;",
      label: 'JavaScript JSX',
      source: "import value from '@jest/monorepo';\nconst node = <App />;",
    },
    {
      expected: null,
      label: 'repository symlink placeholders',
      source: '../package/index.js',
    },
    {
      expected: null,
      label: 'unrelated experimental syntax',
      source: '@Component({})\nclass App {}',
    },
    {
      expected: "import value from '@pkg-nec/jest-util';",
      label: 'escaped module identities',
      source: "import value from 'jest\\u002dutil';",
    },
  ])('plans $label without shifting edits', async ({expected, source}) => {
    const temporaryRepo = await mkdtemp(join(tmpdir(), 'pkg-nec-plan-'));
    const manifestPath = join(temporaryRepo, 'package.json');
    const sourcePath = join(temporaryRepo, 'fixture.js');
    const packageDirectory = join(temporaryRepo, 'packages/jest-util');
    const packageManifestPath = join(packageDirectory, 'package.json');
    await mkdir(packageDirectory, {recursive: true});
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          name: '@jest/monorepo',
          private: true,
          version: '30.4.1',
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      packageManifestPath,
      `${JSON.stringify({name: 'jest-util', version: '30.4.1'}, null, 2)}\n`,
    );
    await writeFile(sourcePath, source);
    const root = {
      directory: temporaryRepo,
      manifestPath,
      newName: '@pkg-nec/monorepo',
      oldName: '@jest/monorepo',
      publishable: false,
      version: '30.4.1',
    };
    const identity = {
      directory: packageDirectory,
      manifestPath: packageManifestPath,
      newName: '@pkg-nec/jest-util',
      oldName: 'jest-util',
      publishable: true,
      version: '30.4.1',
    };
    const baseline = {
      'package.json': {
        name: '@jest/monorepo',
        private: true,
        version: '30.4.1',
      },
      'packages/jest-util/package.json': {
        name: 'jest-util',
        private: false,
        version: '30.4.1',
      },
    };

    try {
      const child = runMigrationProgram(
        migrationFixtureProgram({
          baseline,
          body: `
            const plan = buildMigrationPlan({
              baseline,
              inventory,
              repoRoot: ${JSON.stringify(temporaryRepo)},
            });
            console.log(JSON.stringify(
              plan.files.find(file => file.path === ${JSON.stringify(sourcePath)})?.after ?? null,
            ));
          `,
          identities: [identity],
          root,
        }),
        temporaryRepo,
      );

      expect({status: child.status, stderr: child.stderr}).toEqual({
        status: 0,
        stderr: '',
      });
      expect(child.stdout).toBe(`${JSON.stringify(expected)}\n`);
    } finally {
      await rm(temporaryRepo, {force: true, recursive: true});
    }
  });

  test.each([
    {
      label: 'parsing',
      pattern: /unexpected token|parse/i,
      prepare: async temporaryRepo => {
        await writeFile(
          join(temporaryRepo, 'broken.js'),
          "import value from '@jest/monorepo';\nconst =;",
        );
        return {};
      },
    },
    {
      label: 'canonical-name collision',
      pattern: /collision/,
      prepare: async temporaryRepo => {
        const packageDirectory = join(temporaryRepo, 'packages/example');
        await mkdir(packageDirectory, {recursive: true});
        const manifestPath = join(packageDirectory, 'package.json');
        await writeFile(
          manifestPath,
          `${JSON.stringify({name: 'example', version: '30.4.1'}, null, 2)}\n`,
        );
        return {
          baselineRecord: {
            name: 'example',
            private: false,
            version: '30.4.1',
          },
          identity: {
            directory: packageDirectory,
            manifestPath,
            newName: '@pkg-nec/monorepo',
            oldName: 'example',
            publishable: true,
            version: '30.4.1',
          },
        };
      },
    },
    {
      label: 'double prefix',
      pattern: /double-prefix/,
      prepare: async temporaryRepo => {
        await writeFile(
          join(temporaryRepo, 'README.md'),
          `npm install ${['@pkg-nec/jest-', 'jest-util'].join('')}\n`,
        );
        return {};
      },
    },
    {
      label: 'manifest preservation',
      manifestDependencies: {'@fast-check/jest': '^3.0.0'},
      pattern: /dependency value changed/,
    },
  ])('writes nothing when $label preflight fails', async scenario => {
    const temporaryRepo = await mkdtemp(join(tmpdir(), 'pkg-nec-plan-'));
    const manifestPath = join(temporaryRepo, 'package.json');
    const manifest = {
      devDependencies: scenario.manifestDependencies ?? {
        '@fast-check/jest': '^2.1.1',
      },
      name: '@jest/monorepo',
      private: true,
      version: '30.4.1',
    };
    const before = `${JSON.stringify(manifest, null, 2)}\n`;
    await writeFile(manifestPath, before);

    try {
      const prepared = (await scenario.prepare?.(temporaryRepo)) ?? {};
      const root = {
        directory: temporaryRepo,
        manifestPath,
        newName: '@pkg-nec/monorepo',
        oldName: '@jest/monorepo',
        publishable: false,
        version: '30.4.1',
      };
      const identities = prepared.identity ? [prepared.identity] : [];
      const baseline = {
        'package.json': {
          devDependencies: {'@fast-check/jest': '^2.1.1'},
          name: '@jest/monorepo',
          private: true,
          version: '30.4.1',
        },
        ...(prepared.baselineRecord && {
          'packages/example/package.json': prepared.baselineRecord,
        }),
      };
      const child = runMigrationProgram(
        migrationFixtureProgram({
          baseline,
          body: `
            const plan = buildMigrationPlan({
              baseline,
              inventory,
              repoRoot: ${JSON.stringify(temporaryRepo)},
            });
            applyMigrationPlan(plan);
          `,
          identities,
          root,
        }),
        temporaryRepo,
      );

      expect(child.status).not.toBe(0);
      expect(child.stderr).toMatch(scenario.pattern);
      expect(await readFile(manifestPath, 'utf8')).toBe(before);
    } finally {
      await rm(temporaryRepo, {force: true, recursive: true});
    }
  });
});
