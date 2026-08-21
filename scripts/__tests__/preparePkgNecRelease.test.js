/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

test('defines the complete release preparation pipeline', () => {
  const rootManifest = require('../../package.json');
  expect(rootManifest.scripts['prepare:pkg-nec-release']).toBe(
    'yarn build-clean && yarn build && node ./scripts/preparePkgNecRelease.mjs',
  );
});

test('keeps affected package source and test files out of release packs', async () => {
  const expectedPolicy = [
    '**/__mocks__/**',
    '**/__tests__/**',
    '__typetests__',
    'src',
    'tsconfig.json',
    'tsconfig.tsbuildinfo',
    'api-extractor.json',
    '.eslintcache',
  ];

  const policies = await Promise.all(
    ['jest-pattern', 'jest-snapshot-utils'].map(async packageName =>
      readFile(join(repoRoot, 'packages', packageName, '.npmignore'), 'utf8'),
    ),
  );

  expect(policies).toEqual([
    `${expectedPolicy.join('\n')}\n`,
    `${expectedPolicy.join('\n')}\n`,
  ]);
});

const repoRoot = process.cwd();
const graphModuleUrl = pathToFileURL(
  join(repoRoot, 'scripts/pkgNec/releaseGraph.mjs'),
).href;
const releaseModuleUrl = pathToFileURL(
  join(repoRoot, 'scripts/preparePkgNecRelease.mjs'),
).href;
const publisherModuleUrl = pathToFileURL(
  join(repoRoot, 'scripts/pkgNec/releasePublisher.mjs'),
).href;
const validationModuleUrl = pathToFileURL(
  join(repoRoot, 'scripts/pkgNec/releaseValidation.mjs'),
).href;
const buildUtilsModuleUrl = pathToFileURL(
  join(repoRoot, 'scripts/buildUtils.mjs'),
).href;

function runModuleProgram(program) {
  const child = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', program],
    {cwd: repoRoot, encoding: 'utf8'},
  );

  if (child.status !== 0) {
    throw new Error(child.stderr || child.stdout);
  }

  return JSON.parse(child.stdout.trim());
}

test('builds every public expect export from its source entry point', () => {
  const entries = runModuleProgram(`
    import {createBuildConfigs} from ${JSON.stringify(buildUtilsModuleUrl)};

    const config = createBuildConfigs().find(
      ({pkg}) => pkg.name === '@pkg-nec/expect',
    );
    console.log(JSON.stringify(config.webpackConfig.entry));
  `);

  expect(entries).toEqual({
    index: `${join(repoRoot, 'packages', 'expect')}/src/index.ts`,
    matchers: join(repoRoot, 'packages', 'expect', 'src', 'matchers.ts'),
    toThrowMatchers: join(
      repoRoot,
      'packages',
      'expect',
      'src',
      'toThrowMatchers.ts',
    ),
  });
});

async function writeManifest(repo, directory, manifest) {
  const manifestDirectory = join(repo, directory);
  await mkdir(manifestDirectory, {recursive: true});
  await writeFile(
    join(manifestDirectory, 'package.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

async function writeReleasePlanFixture(repo, {anchor, packages}) {
  const tag = `${anchor.name}-v${anchor.toVersion}`;
  const planPath = `docs/releases/${tag
    .replace('@', '')
    .replace('/', '-')}-plan.json`;
  const changedPackages = [...packages]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(item => ({files: [`${item.path}/index.js`], name: item.name}));
  const plan = {
    anchor: {name: anchor.name, tag, version: anchor.toVersion},
    changedFiles: {
      packages: changedPackages,
      root: {allPackages: [], ambiguous: [], noImpact: []},
    },
    packages: packages.map((item, index) => ({
      bump: item.bump,
      fromVersion: item.fromVersion,
      name: item.name,
      order: index + 1,
      path: item.path,
      reasons: [{files: [`${item.path}/index.js`], kind: 'changed'}],
      toVersion: item.toVersion,
    })),
    planPath,
    preparedFrom: '3333333333333333333333333333333333333333',
    previousRelease: {
      commit: '1111111111111111111111111111111111111111',
      tag: `${anchor.name}-v${anchor.fromVersion}`,
    },
    rootImpact: {applied: 'not-needed', requested: null},
    schemaVersion: 1,
  };
  await mkdir(join(repo, 'docs', 'releases'), {recursive: true});
  await writeFile(
    join(repo, ...planPath.split('/')),
    `${JSON.stringify(plan, null, 2)}\n`,
  );
  return tag;
}

function buildGraph(repo, expectedPackageCount) {
  return runModuleProgram(`
    import fs from 'graceful-fs';
    import path from 'node:path';
    import {buildRuntimeReleaseGraph} from ${JSON.stringify(graphModuleUrl)};

    const repo = ${JSON.stringify(repo)};
    const packages = fs
      .readdirSync(path.join(repo, 'packages'), {withFileTypes: true})
      .filter(entry => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(entry => {
        const manifestPath = path.join(repo, 'packages', entry.name, 'package.json');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        return {
          manifestPath,
          newName: '@pkg-nec/' + manifest.name,
          oldName: manifest.name,
          publishable: manifest.private !== true,
        };
      });
    if (packages.length !== ${expectedPackageCount}) {
      throw new Error('Unexpected fixture package count');
    }
    const identities = packages;
    const inventory = {
      byNewName: new Map(identities.map(item => [item.newName, item])),
      byOldName: new Map(identities.map(item => [item.oldName, item])),
      packages,
    };

    try {
      const graph = buildRuntimeReleaseGraph(inventory);
      console.log(JSON.stringify({
        graph: Object.fromEntries(
          [...graph].map(([name, dependencies]) => [
            name,
            [...dependencies].sort(),
          ]),
        ),
      }));
    } catch (error) {
      console.log(JSON.stringify({error: error.message}));
    }
  `);
}

describe('pkg-nec runtime release graph', () => {
  test('orders dependencies first with lexical tie-breaking and rejects runtime cycles', () => {
    const result = runModuleProgram(`
      import {topologicalReleaseOrder} from ${JSON.stringify(graphModuleUrl)};

      const graph = new Map([
        ['@pkg-nec/jest', new Set(['@pkg-nec/jest-cli'])],
        ['@pkg-nec/jest-cli', new Set(['@pkg-nec/jest-core'])],
        ['@pkg-nec/jest-core', new Set()],
        ['@pkg-nec/expect', new Set()],
      ]);
      const cyclicGraph = new Map([
        ['@pkg-nec/a', new Set(['@pkg-nec/b'])],
        ['@pkg-nec/b', new Set(['@pkg-nec/a'])],
      ]);

      let cycleError;
      try {
        topologicalReleaseOrder(cyclicGraph);
      } catch (error) {
        cycleError = error.message;
      }

      console.log(JSON.stringify({
        cycleError,
        order: topologicalReleaseOrder(graph),
      }));
    `);

    expect(result.order).toEqual([
      '@pkg-nec/expect',
      '@pkg-nec/jest-core',
      '@pkg-nec/jest-cli',
      '@pkg-nec/jest',
    ]);
    expect(result.cycleError).toMatch(/runtime cycle/);
  });

  test('recalculates lexical priority after each emitted dependency', () => {
    const result = runModuleProgram(`
      import {topologicalReleaseOrder} from ${JSON.stringify(graphModuleUrl)};

      const graph = new Map([
        ['@pkg-nec/a', new Set(['@pkg-nec/b'])],
        ['@pkg-nec/b', new Set()],
        ['@pkg-nec/c', new Set()],
      ]);
      console.log(JSON.stringify(topologicalReleaseOrder(graph)));
    `);

    expect(result).toEqual(['@pkg-nec/b', '@pkg-nec/a', '@pkg-nec/c']);
  });

  test('orders strongly connected components without recursion or insertion-order dependence', () => {
    const result = runModuleProgram(`
      import {componentReleaseOrder} from ${JSON.stringify(graphModuleUrl)};

      const entries = [
        ['@pkg-nec/z', new Set(['@pkg-nec/n'])],
        ['@pkg-nec/self', new Set(['@pkg-nec/self'])],
        ['@pkg-nec/root', new Set()],
        ['@pkg-nec/n', new Set(['@pkg-nec/m'])],
        ['@pkg-nec/m', new Set(['@pkg-nec/n', '@pkg-nec/b'])],
        ['@pkg-nec/b', new Set(['@pkg-nec/a'])],
        ['@pkg-nec/a', new Set(['@pkg-nec/b', '@pkg-nec/root'])],
      ];
      const permuted = new Map(
        [...entries]
          .reverse()
          .map(([name, dependencies]) => [
            name,
            new Set([...dependencies].reverse()),
          ]),
      );
      console.log(JSON.stringify({
        forward: componentReleaseOrder(new Map(entries)),
        reversed: componentReleaseOrder(permuted),
      }));
    `);
    const expected = [
      '@pkg-nec/root',
      '@pkg-nec/a',
      '@pkg-nec/b',
      '@pkg-nec/m',
      '@pkg-nec/n',
      '@pkg-nec/self',
      '@pkg-nec/z',
    ];

    expect(result).toEqual({forward: expected, reversed: expected});
  });

  test('builds consumer-to-dependency runtime edges and ignores dev-only cycles', async () => {
    const temporaryRepo = await mkdtemp(join(tmpdir(), 'pkg-nec-graph-'));

    try {
      await writeManifest(temporaryRepo, '.', {
        name: '@jest/monorepo',
        private: true,
        version: '0.0.0',
      });
      await writeManifest(temporaryRepo, 'packages/a', {
        dependencies: {'jest-b': 'workspace:*'},
        devDependencies: {'jest-c': 'workspace:*'},
        name: 'jest-a',
        version: '1.0.0',
      });
      await writeManifest(temporaryRepo, 'packages/b', {
        devDependencies: {'jest-a': 'workspace:*'},
        name: 'jest-b',
        version: '1.0.0',
      });
      await writeManifest(temporaryRepo, 'packages/c', {
        devDependencies: {'jest-a': 'workspace:*'},
        name: 'jest-c',
        version: '1.0.0',
      });

      expect(buildGraph(temporaryRepo, 3).graph).toEqual({
        '@pkg-nec/jest-a': ['@pkg-nec/jest-b'],
        '@pkg-nec/jest-b': [],
        '@pkg-nec/jest-c': [],
      });
    } finally {
      await rm(temporaryRepo, {force: true, recursive: true});
    }
  });

  test('rejects unresolved internal runtime dependencies', async () => {
    const temporaryRepo = await mkdtemp(join(tmpdir(), 'pkg-nec-graph-'));

    try {
      await writeManifest(temporaryRepo, '.', {
        name: '@jest/monorepo',
        private: true,
        version: '0.0.0',
      });
      await writeManifest(temporaryRepo, 'packages/a', {
        dependencies: {'jest-missing': 'workspace:*'},
        name: 'jest-a',
        version: '1.0.0',
      });

      expect(buildGraph(temporaryRepo, 1).error).toMatch(
        /Unresolved internal runtime dependency jest-missing.*@pkg-nec\/jest-a/,
      );
    } finally {
      await rm(temporaryRepo, {force: true, recursive: true});
    }
  });

  test('rejects resolved internal targets absent from the release graph', async () => {
    const temporaryRepo = await mkdtemp(join(tmpdir(), 'pkg-nec-graph-'));

    try {
      await writeManifest(temporaryRepo, '.', {
        name: '@jest/monorepo',
        private: true,
        version: '0.0.0',
      });
      await writeManifest(temporaryRepo, 'packages/a', {
        dependencies: {'jest-b': '^1.0.0'},
        name: 'jest-a',
        version: '1.0.0',
      });
      await writeManifest(temporaryRepo, 'packages/b', {
        name: 'jest-b',
        private: true,
        version: '1.0.0',
      });

      expect(buildGraph(temporaryRepo, 2).error).toMatch(
        /Unresolved internal runtime dependency jest-b.*@pkg-nec\/jest-a/,
      );
    } finally {
      await rm(temporaryRepo, {force: true, recursive: true});
    }
  });
});

describe('pkg-nec release preparation', () => {
  test('accepts a changed version and third-party range from the workspace manifest', () => {
    const result = runModuleProgram(`
      import {inspectPackedManifest} from ${JSON.stringify(releaseModuleUrl)};

      const target = {
        newName: '@pkg-nec/jest-core',
        version: '31.0.0-security.2',
      };
      const workspace = {
        newName: '@pkg-nec/example',
        publishable: true,
        version: '31.0.0-security.1',
      };
      const inventory = {
        byNewName: new Map([
          [target.newName, target],
          [workspace.newName, workspace],
        ]),
      };
      const workspaceManifest = {
        dependencies: {
          '@pkg-nec/jest-core': 'workspace:*',
          chalk: '^5.0.0',
        },
        name: '@pkg-nec/example',
        repository: {
          directory: 'packages/example',
          url: 'https://github.com/pkg-nec/jest.git',
        },
        version: '31.0.0-security.1',
      };
      const validManifest = {
        dependencies: {
          '@pkg-nec/jest-core': '=31.0.0-security.2',
          chalk: '^5.0.0',
        },
        name: '@pkg-nec/example',
        publishConfig: {access: 'public'},
        repository: {
          directory: 'packages/example',
          url: 'https://github.com/pkg-nec/jest.git',
        },
        version: '31.0.0-security.1',
      };

      inspectPackedManifest({
        inventory,
        manifest: validManifest,
        workspace,
        workspaceManifest,
      });
      console.log(JSON.stringify({accepted: true}));
    `);

    expect(result).toEqual({accepted: true});
  });

  test('rejects a packed public package with missing access metadata', () => {
    const result = runModuleProgram(`
      import {inspectPackedManifest} from ${JSON.stringify(releaseModuleUrl)};

      try {
        inspectPackedManifest({
          inventory: {byNewName: new Map()},
          manifest: {
            name: '@pkg-nec/example',
            repository: {
              directory: 'packages/example',
              url: 'https://github.com/pkg-nec/jest.git',
            },
            version: '30.4.3',
          },
          workspace: {newName: '@pkg-nec/example'},
          workspaceManifest: {
            name: '@pkg-nec/example',
            repository: {
              directory: 'packages/example',
              url: 'https://github.com/pkg-nec/jest.git',
            },
            version: '30.4.3',
          },
        });
        console.log(JSON.stringify({error: null}));
      } catch (error) {
        console.log(JSON.stringify({error: error.message}));
      }
    `);

    expect(result).toEqual({
      error: expect.stringMatching(/packed manifest access is not public/i),
    });
  });

  test('rejects packed values that differ from current source manifests', () => {
    const result = runModuleProgram(`
      import {inspectPackedManifest} from ${JSON.stringify(releaseModuleUrl)};

      const target = {
        newName: '@pkg-nec/jest-core',
        version: '31.0.0-security.2',
      };
      const workspace = {
        newName: '@pkg-nec/example',
        publishable: true,
        version: '31.0.0-security.1',
      };
      const inventory = {
        byNewName: new Map([
          [target.newName, target],
          [workspace.newName, workspace],
        ]),
      };
      const workspaceManifest = {
        dependencies: {
          '@pkg-nec/jest-core': 'workspace:*',
          chalk: '^5.0.0',
        },
        name: '@pkg-nec/example',
        repository: {
          directory: 'packages/example',
          url: 'https://github.com/pkg-nec/jest.git',
        },
        version: '31.0.0-security.1',
      };
      const validManifest = {
        dependencies: {
          '@pkg-nec/jest-core': '31.0.0-security.2',
          chalk: '^5.0.0',
        },
        name: '@pkg-nec/example',
        publishConfig: {access: 'public'},
        repository: {
          directory: 'packages/example',
          url: 'https://github.com/pkg-nec/jest.git',
        },
        version: '31.0.0-security.1',
      };
      const cases = [
        {...validManifest, name: '@pkg-nec/other'},
        {...validManifest, version: '99.0.0'},
        {
          ...validManifest,
          dependencies: {
            ...validManifest.dependencies,
            chalk: '^4.0.0',
          },
        },
        {
          ...validManifest,
          dependencies: {
            ...validManifest.dependencies,
            '@pkg-nec/jest-core': '99.0.0',
          },
        },
        {...validManifest, private: true},
        {
          ...validManifest,
          dependencies: {
            ...validManifest.dependencies,
            chalk: 'file:../chalk',
          },
        },
        {
          ...validManifest,
          dependencies: {
            ...validManifest.dependencies,
            chalk: 'link:../chalk',
          },
        },
        {
          ...validManifest,
          dependencies: {
            ...validManifest.dependencies,
            chalk: 'workspace:*',
          },
        },
      ];
      const messages = cases.map(manifest => {
        try {
          inspectPackedManifest({
            inventory,
            manifest,
            workspace,
            workspaceManifest,
          });
          return null;
        } catch (error) {
          return error.message;
        }
      });
      console.log(JSON.stringify(messages));
    `);

    expect(result).toEqual([
      expect.stringMatching(/name changed/i),
      expect.stringMatching(/version changed/i),
      expect.stringMatching(/dependencies\.chalk/i),
      expect.stringMatching(/dependencies\.@pkg-nec\/jest-core/i),
      expect.stringMatching(/private/i),
      expect.stringMatching(/dependencies\.chalk/i),
      expect.stringMatching(/dependencies\.chalk/i),
      expect.stringMatching(/dependencies\.chalk/i),
    ]);
  });

  test('rejects a packed manifest whose repository URL differs from the source policy', () => {
    const result = runModuleProgram(`
      import {inspectPackedManifest} from ${JSON.stringify(releaseModuleUrl)};

      try {
        inspectPackedManifest({
          inventory: {byNewName: new Map()},
          manifest: {
            name: '@pkg-nec/example',
            repository: {
              directory: 'packages/example',
              url: 'https://github.com/other/jest.git',
            },
            version: '30.4.3',
          },
          workspace: {newName: '@pkg-nec/example'},
          workspaceManifest: {
            name: '@pkg-nec/example',
            repository: {
              directory: 'packages/example',
              url: 'https://github.com/pkg-nec/jest.git',
            },
            version: '30.4.3',
          },
        });
        console.log(JSON.stringify({error: null}));
      } catch (error) {
        console.log(JSON.stringify({error: error.message}));
      }
    `);

    expect(result).toEqual({
      error: expect.stringMatching(/packed manifest repository changed/i),
    });
  });

  test('creates a versioned ledger tied to source', () => {
    const result = runModuleProgram(`
      import {createReleaseLedger} from ${JSON.stringify(releaseModuleUrl)};

      const order = ['@pkg-nec/jest-core', '@pkg-nec/jest'];
      const artifacts = [
        {
          files: ['package.json'],
          integrity: 'sha512-consumer',
          name: '@pkg-nec/jest',
          prerequisites: ['@pkg-nec/jest-core'],
          tarball: 'pkg-nec-jest-30.4.2.tgz',
          version: '30.4.2',
        },
        {
          files: ['package.json'],
          integrity: 'sha512-prerequisite',
          name: '@pkg-nec/jest-core',
          prerequisites: [],
          tarball: 'pkg-nec-jest-core-30.4.2.tgz',
          version: '30.4.2',
        },
      ];
      console.log(JSON.stringify(createReleaseLedger({
        artifacts,
        generatedAt: '2026-08-18T00:00:00.000Z',
        nodeVersion: 'v22.23.1',
        order,
        packageManager: 'yarn@4.18.0',
        releasePlan: {
          digest: 'sha256-${'a'.repeat(64)}',
          path: 'docs/releases/pkg-nec-jest-v30.4.2-plan.json',
        },
        sourceCommit: '0123456789abcdef',
      })));
    `);

    expect(result).toMatchObject({
      generatedAt: '2026-08-18T00:00:00.000Z',
      nodeVersion: 'v22.23.1',
      packageManager: 'yarn@4.18.0',
      releasePlan: {
        digest: `sha256-${'a'.repeat(64)}`,
        path: 'docs/releases/pkg-nec-jest-v30.4.2-plan.json',
      },
      schemaVersion: 2,
      sourceCommit: '0123456789abcdef',
    });
    expect(result.packages).toEqual([
      {
        files: ['package.json'],
        integrity: 'sha512-prerequisite',
        name: '@pkg-nec/jest-core',
        order: 1,
        prerequisites: [],
        tarball: 'pkg-nec-jest-core-30.4.2.tgz',
        version: '30.4.2',
      },
      {
        files: ['package.json'],
        integrity: 'sha512-consumer',
        name: '@pkg-nec/jest',
        order: 2,
        prerequisites: ['@pkg-nec/jest-core'],
        tarball: 'pkg-nec-jest-30.4.2.tgz',
        version: '30.4.2',
      },
    ]);
  });

  test('rejects duplicate prepared artifact names before ordering', () => {
    const result = runModuleProgram(`
      import {createReleaseLedger} from ${JSON.stringify(releaseModuleUrl)};

      const artifact = {
        files: ['package.json'],
        integrity: 'sha512-example',
        name: '@pkg-nec/example',
        prerequisites: [],
        tarball: 'pkg-nec-example-1.0.0.tgz',
        version: '1.0.0',
      };
      let message = 'accepted';
      try {
        createReleaseLedger({
          artifacts: [artifact, {...artifact}],
          generatedAt: '2026-08-18T00:00:00.000Z',
          nodeVersion: 'v22.23.1',
          order: ['@pkg-nec/example'],
          packageManager: 'yarn@4.18.0',
          sourceCommit: '0123456789abcdef',
        });
      } catch (error) {
        message = error.message;
      }
      console.log(JSON.stringify(message));
    `);

    expect(result).toBe('Duplicate prepared artifact: @pkg-nec/example');
  });

  test('rejects a prepared artifact without SHA-512 integrity', () => {
    const result = runModuleProgram(`
      import {createReleaseLedger} from ${JSON.stringify(releaseModuleUrl)};

      const artifact = {
        files: ['package.json'],
        integrity: 'sha256-example',
        name: '@pkg-nec/example',
        prerequisites: [],
        tarball: 'pkg-nec-example-1.0.0.tgz',
        version: '1.0.0',
      };
      let message = 'accepted';
      try {
        createReleaseLedger({
          artifacts: [artifact],
          generatedAt: '2026-08-18T00:00:00.000Z',
          nodeVersion: 'v22.23.1',
          order: ['@pkg-nec/example'],
          packageManager: 'yarn@4.18.0',
          sourceCommit: '0123456789abcdef',
        });
      } catch (error) {
        message = error.message;
      }
      console.log(JSON.stringify(message));
    `);

    expect(result).toBe(
      'Invalid prepared artifact integrity for @pkg-nec/example',
    );
  });

  test('prepares, validates, and publishes a cyclic schema-2 plan in component order', async () => {
    const temporaryRepo = await mkdtemp(join(tmpdir(), 'pkg-nec-selective-'));

    try {
      const result = runModuleProgram(`
        import path from 'node:path';
        import fs from 'graceful-fs';
        import {createHash} from 'node:crypto';
        import {runPrepareReleaseCommand} from ${JSON.stringify(releaseModuleUrl)};
        import {publishRelease} from ${JSON.stringify(publisherModuleUrl)};
        import {validateReleaseMetadata} from ${JSON.stringify(validationModuleUrl)};

        const repoRoot = ${JSON.stringify(temporaryRepo)};
        const releaseTag = '@pkg-nec/create-jest-v1.1.0';
        const planPath = 'docs/releases/pkg-nec-create-jest-v1.1.0-plan.json';
        const stagingDirectory = path.join(
          repoRoot,
          '.pkg-nec-release-stage-selective',
        );
        const sourceCommit = '2222222222222222222222222222222222222222';
        const packageInputs = [
          ['@pkg-nec/create-jest', 'packages/create-jest', '1.1.0'],
          ['@pkg-nec/jest-phabricator', 'packages/jest-phabricator', '2.0.1'],
          ['@pkg-nec/jest-test-globals', 'packages/jest-test-globals', '3.0.0'],
        ];
        const packages = packageInputs.map(([newName, directory, version]) => ({
          directory: path.join(repoRoot, directory),
          manifestPath: path.join(repoRoot, directory, 'package.json'),
          newName,
          oldName: newName,
          publishable: true,
          version,
        }));
        const inventory = {
          byNewName: new Map(packages.map(item => [item.newName, item])),
          byOldName: new Map(packages.map(item => [item.oldName, item])),
          packages,
          root: null,
        };
        fs.writeFileSync(
          path.join(repoRoot, 'package.json'),
          JSON.stringify({packageManager: 'yarn@4.18.0'}),
        );
        fs.writeFileSync(path.join(repoRoot, 'LICENSE'), 'license');
        for (const workspace of packages) {
          fs.mkdirSync(workspace.directory, {recursive: true});
          const manifest = {
            name: workspace.newName,
            publishConfig: {access: 'public'},
            repository: {
              directory: path.relative(repoRoot, workspace.directory).replaceAll(path.sep, '/'),
              url: 'https://github.com/pkg-nec/jest.git',
            },
            version: workspace.version,
          };
          if (workspace.newName === '@pkg-nec/create-jest') {
            manifest.devDependencies = {
              '@pkg-nec/jest-phabricator': 'workspace:*',
            };
          }
          if (workspace.newName === '@pkg-nec/jest-phabricator') {
            manifest.dependencies = {
              '@pkg-nec/create-jest': 'workspace:*',
              '@pkg-nec/jest-test-globals': 'workspace:*',
            };
          }
          fs.writeFileSync(workspace.manifestPath, JSON.stringify(manifest));
        }
        const plan = {
          anchor: {name: '@pkg-nec/create-jest', tag: releaseTag, version: '1.1.0'},
          changedFiles: {
            packages: [{name: '@pkg-nec/create-jest', files: ['packages/create-jest/index.js']}],
            root: {allPackages: [], ambiguous: [], noImpact: []},
          },
          packages: [
            {
              bump: 'minor',
              fromVersion: '1.0.0',
              name: '@pkg-nec/create-jest',
              order: 1,
              path: 'packages/create-jest',
              reasons: [{files: ['packages/create-jest/index.js'], kind: 'changed'}],
              toVersion: '1.1.0',
            },
            {
              bump: 'patch',
              fromVersion: '2.0.0',
              name: '@pkg-nec/jest-phabricator',
              order: 2,
              path: 'packages/jest-phabricator',
              reasons: [{kind: 'dependent', paths: [['@pkg-nec/create-jest', '@pkg-nec/jest-phabricator']]}],
              toVersion: '2.0.1',
            },
          ],
          planPath,
          preparedFrom: '3333333333333333333333333333333333333333',
          previousRelease: {
            commit: '1111111111111111111111111111111111111111',
            tag: '@pkg-nec/create-jest-v1.0.0',
          },
          rootImpact: {applied: 'not-needed', requested: null},
          schemaVersion: 1,
        };
        const planBytes = JSON.stringify(plan, null, 2) + '\\n';
        fs.mkdirSync(path.dirname(path.join(repoRoot, planPath)), {recursive: true});
        fs.writeFileSync(path.join(repoRoot, planPath), planBytes);
        const graph = new Map([
          ['@pkg-nec/create-jest', new Set(['@pkg-nec/jest-phabricator'])],
          ['@pkg-nec/jest-phabricator', new Set(['@pkg-nec/create-jest', '@pkg-nec/jest-test-globals'])],
          ['@pkg-nec/jest-test-globals', new Set()],
        ]);
        const packCalls = [];
        const ledger = await runPrepareReleaseCommand({
          args: [releaseTag],
          audit: () => [],
          buildGraph: () => graph,
          inspectTarball: async tarballPath => {
            const name = tarballPath.includes('pkg-nec-create-jest-')
              ? '@pkg-nec/create-jest'
              : tarballPath.includes('pkg-nec-jest-phabricator-')
                ? '@pkg-nec/jest-phabricator'
                : '@pkg-nec/jest-test-globals';
            const workspace = inventory.byNewName.get(name);
            const manifest = JSON.parse(fs.readFileSync(workspace.manifestPath, 'utf8'));
            if (name === '@pkg-nec/create-jest') {
              manifest.devDependencies = {
                '@pkg-nec/jest-phabricator': '2.0.1',
              };
            }
            if (name === '@pkg-nec/jest-phabricator') {
              manifest.dependencies = {
                '@pkg-nec/create-jest': '1.1.0',
                '@pkg-nec/jest-test-globals': '3.0.0',
              };
            }
            return {
              files: [
                ...(tarballPath.endsWith('.raw-packed.tgz') ? [] : ['package/LICENSE']),
                'package/package.json',
              ],
              manifest,
            };
          },
          env: {GITHUB_SHA: sourceCommit},
          inventory,
          makeStagingDirectory: async () => {
            fs.mkdirSync(stagingDirectory);
            return stagingDirectory;
          },
          readCommittedFile: async (_root, _commit, file) =>
            fs.promises.readFile(path.join(repoRoot, ...file.split('/'))),
          readSourceCommit: async () => sourceCommit,
          repackTarball: async ({finalTarballPath}) => {
            fs.writeFileSync(finalTarballPath, 'final');
          },
          repoRoot,
          runCommand: async (_command, args) => {
            packCalls.push(args[1]);
            fs.writeFileSync(args[4], 'raw');
          },
          runGit: async args => {
            if (args[0] === 'rev-list' && args[1] === '--parents') {
              return sourceCommit + ' ' + 'f'.repeat(40);
            }
            return args[0] === 'rev-list' ? sourceCommit : '';
          },
          write: () => {},
        });
        const validation = validateReleaseMetadata({
          event: {
            release: {
              body: [
                'Source commit: ' + sourceCommit,
                '- \`@pkg-nec/create-jest@1.1.0\`',
                '- \`@pkg-nec/jest-phabricator@2.0.1\`',
              ].join('\\n'),
              draft: false,
              name: releaseTag,
              prerelease: false,
              tag_name: releaseTag,
            },
          },
          inventory,
          ledger,
          plan,
          releaseGraph: graph,
          tagCommit: sourceCommit,
        });
        const published = [];
        const journal = await publishRelease({
          inspect: async () => ({kind: 'absent'}),
          ledger,
          now: () => '2026-08-21T00:00:00.000Z',
          persistJournal: async () => {},
          publish: async entry => published.push(entry.name),
          releaseTag,
          verifyConflict: async () => {
            throw new Error('unexpected conflict verification');
          },
        });
        const copiedPlanPath = path.join(
          repoRoot,
          '.pkg-nec-release',
          path.posix.basename(planPath),
        );
        const copiedPlan = fs.existsSync(copiedPlanPath)
          ? fs.readFileSync(copiedPlanPath, 'utf8')
          : null;
        console.log(JSON.stringify({
          copiedPlan,
          ledger,
          journal,
          packCalls,
          planDigest: 'sha256-' + createHash('sha256').update(planBytes).digest('hex'),
          published,
          releaseFiles: fs.readdirSync(path.join(repoRoot, '.pkg-nec-release')).sort(),
          validation,
        }));
      `);

      expect(result.packCalls).toEqual([
        '@pkg-nec/create-jest',
        '@pkg-nec/jest-phabricator',
      ]);
      expect(result.ledger).toMatchObject({
        releasePlan: {
          digest: result.planDigest,
          path: 'docs/releases/pkg-nec-create-jest-v1.1.0-plan.json',
        },
        schemaVersion: 2,
        sourceCommit: '2222222222222222222222222222222222222222',
      });
      expect(result.ledger.packages).toEqual([
        expect.objectContaining({
          name: '@pkg-nec/create-jest',
          order: 1,
          prerequisites: ['@pkg-nec/jest-phabricator'],
          version: '1.1.0',
        }),
        expect.objectContaining({
          name: '@pkg-nec/jest-phabricator',
          order: 2,
          prerequisites: ['@pkg-nec/create-jest'],
          version: '2.0.1',
        }),
      ]);
      expect(result.validation.packageCount).toBe(2);
      expect(result.published).toEqual([
        '@pkg-nec/create-jest',
        '@pkg-nec/jest-phabricator',
      ]);
      expect(result.journal.packages.map(item => item.name)).toEqual(
        result.published,
      );
      expect(result.copiedPlan).toContain('"preparedFrom"');
      expect(result.releaseFiles).not.toContain(
        'pkg-nec-jest-test-globals-3.0.0.tgz',
      );
    } finally {
      await rm(temporaryRepo, {force: true, recursive: true});
    }
  });

  // Mutation caught: trusting checked-out HEAD without binding it to both the
  // release-event SHA and the resolved release tag, or allowing an older plan.
  test('binds preparation to the plan-introduction commit on main first-parent history', async () => {
    const temporaryRepo = await mkdtemp(join(tmpdir(), 'pkg-nec-binding-'));

    try {
      const releaseTag = await writeReleasePlanFixture(temporaryRepo, {
        anchor: {
          fromVersion: '0.9.0',
          name: '@pkg-nec/create-jest',
          toVersion: '1.0.0',
        },
        packages: [
          {
            bump: 'major',
            fromVersion: '0.9.0',
            name: '@pkg-nec/create-jest',
            path: 'packages/create-jest',
            toVersion: '1.0.0',
          },
        ],
      });
      const result = runModuleProgram(`
        import path from 'node:path';
        import fs from 'graceful-fs';
        import {runPrepareReleaseCommand} from ${JSON.stringify(releaseModuleUrl)};

        const repoRoot = ${JSON.stringify(temporaryRepo)};
        const releaseTag = ${JSON.stringify(releaseTag)};
        const planPath = 'docs/releases/pkg-nec-create-jest-v1.0.0-plan.json';
        const sourceCommit = '1111111111111111111111111111111111111111';
        const firstParent = '2222222222222222222222222222222222222222';
        const featureParent = '3333333333333333333333333333333333333333';
        const otherCommit = '4444444444444444444444444444444444444444';

        async function runCase({
          eventCommit = sourceCommit,
          headCommit = sourceCommit,
          parents = [firstParent],
          planInFirstParent = false,
          tagCommit = sourceCommit,
        } = {}) {
          const gitCalls = [];
          let message = 'accepted';
          try {
            await runPrepareReleaseCommand({
              args: [releaseTag],
              audit: () => {throw new Error('binding accepted');},
              env: {GITHUB_SHA: eventCommit},
              inventory: {
                byNewName: new Map(),
                byOldName: new Map(),
                packages: [],
                root: null,
              },
              readCommittedFile: async (_root, _commit, file) =>
                fs.promises.readFile(path.join(repoRoot, ...file.split('/'))),
              readSourceCommit: async () => headCommit,
              repoRoot,
              runGit: async args => {
                gitCalls.push(args);
                if (args[0] === 'rev-list' && args[1] === '-n') {
                  return tagCommit;
                }
                if (args[0] === 'rev-list' && args[1] === '--parents') {
                  return [sourceCommit, ...parents].join(' ');
                }
                if (args[0] === 'ls-tree') {
                  return planInFirstParent ? planPath + '\\n' : '';
                }
                return '';
              },
            });
          } catch (error) {
            message = error.message;
          }
          return {gitCalls, message};
        }

        async function runRetarget() {
          const packageName = '@pkg-nec/create-jest';
          const workspace = {
            directory: path.join(repoRoot, 'packages/create-jest'),
            manifestPath: path.join(repoRoot, 'packages/create-jest/package.json'),
            newName: packageName,
            oldName: packageName,
            publishable: true,
            version: '1.0.0',
          };
          fs.mkdirSync(workspace.directory, {recursive: true});
          const manifest = {
            name: packageName,
            publishConfig: {access: 'public'},
            repository: {
              directory: 'packages/create-jest',
              url: 'https://github.com/pkg-nec/jest.git',
            },
            version: '1.0.0',
          };
          fs.writeFileSync(workspace.manifestPath, JSON.stringify(manifest));
          fs.writeFileSync(
            path.join(repoRoot, 'package.json'),
            JSON.stringify({packageManager: 'yarn@4.18.0'}),
          );
          fs.writeFileSync(path.join(repoRoot, 'LICENSE'), 'license');
          const stagingDirectory = path.join(
            repoRoot,
            '.pkg-nec-release-stage-retarget',
          );
          let tagReads = 0;
          let message = 'accepted';
          try {
            await runPrepareReleaseCommand({
              args: [releaseTag],
              audit: () => [],
              buildGraph: () => new Map([[packageName, new Set()]]),
              env: {GITHUB_SHA: sourceCommit},
              inspectTarball: async tarballPath => ({
                files: tarballPath.includes('.raw-')
                  ? ['package/package.json']
                  : ['package/LICENSE', 'package/package.json'],
                manifest,
              }),
              inventory: {
                byNewName: new Map([[packageName, workspace]]),
                byOldName: new Map([[packageName, workspace]]),
                packages: [workspace],
                root: null,
              },
              makeStagingDirectory: async () => {
                fs.mkdirSync(stagingDirectory);
                return stagingDirectory;
              },
              readCommittedFile: async (_root, _commit, file) =>
                fs.promises.readFile(path.join(repoRoot, ...file.split('/'))),
              readSourceCommit: async () => sourceCommit,
              repackTarball: async ({finalTarballPath}) => {
                fs.writeFileSync(finalTarballPath, 'final');
              },
              repoRoot,
              runCommand: async (_command, args) => {
                fs.writeFileSync(args[4], 'raw');
              },
              runGit: async args => {
                if (args[0] === 'rev-list' && args[1] === '-n') {
                  tagReads += 1;
                  return tagReads === 1 ? sourceCommit : otherCommit;
                }
                if (args[0] === 'rev-list' && args[1] === '--parents') {
                  return sourceCommit + ' ' + firstParent;
                }
                return '';
              },
              write: () => {},
            });
          } catch (error) {
            message = error.message;
          }
          return {message, tagReads};
        }

        console.log(JSON.stringify({
          checkoutMismatch: await runCase({headCommit: otherCommit}),
          eventMalformed: await runCase({eventCommit: 'not-a-commit'}),
          eventMismatch: await runCase({eventCommit: otherCommit}),
          exact: await runCase(),
          laterCommit: await runCase({planInFirstParent: true}),
          merge: await runCase({parents: [firstParent, featureParent]}),
          retarget: await runRetarget(),
          tagMismatch: await runCase({tagCommit: otherCommit}),
        }));
      `);

      expect(result.eventMalformed.message).toBe(
        'Release event GITHUB_SHA must be a full Git commit',
      );
      for (const key of ['checkoutMismatch', 'eventMismatch', 'tagMismatch']) {
        expect(result[key].message).toBe(
          'Release event, tag, and checkout commits must match',
        );
      }
      expect(result.laterCommit.message).toBe(
        'Release plan must be introduced by the release source commit',
      );
      expect(result.exact.message).toBe('binding accepted');
      expect(result.merge.message).toBe('binding accepted');
      expect(result.retarget).toEqual({
        message: 'Release source commit changed during preparation',
        tagReads: 2,
      });
      expect(result.merge.gitCalls).toContainEqual([
        'ls-tree',
        '--name-only',
        '2222222222222222222222222222222222222222',
        '--',
        'docs/releases/pkg-nec-create-jest-v1.0.0-plan.json',
      ]);
      expect(result.merge.gitCalls).not.toContainEqual(
        expect.arrayContaining(['3333333333333333333333333333333333333333']),
      );
    } finally {
      await rm(temporaryRepo, {force: true, recursive: true});
    }
  });

  test('packs fixtures with exact Yarn arguments and writes reviewed ledgers safely', async () => {
    const temporaryRepo = await mkdtemp(join(tmpdir(), 'pkg-nec-pack-'));

    try {
      const releaseTag = await writeReleasePlanFixture(temporaryRepo, {
        anchor: {
          fromVersion: '30.4.1',
          name: '@pkg-nec/jest',
          toVersion: '30.4.2',
        },
        packages: [
          {
            bump: 'patch',
            fromVersion: '30.4.1',
            name: '@pkg-nec/jest-core',
            path: 'packages/jest-core',
            toVersion: '30.4.2',
          },
          {
            bump: 'patch',
            fromVersion: '30.4.1',
            name: '@pkg-nec/jest',
            path: 'packages/jest',
            toVersion: '30.4.2',
          },
        ],
      });
      const result = runModuleProgram(`
        import path from 'node:path';
        import fs from 'graceful-fs';
        import {runPrepareReleaseCommand} from ${JSON.stringify(releaseModuleUrl)};

        const repoRoot = ${JSON.stringify(temporaryRepo)};
        const outputDirectory = path.join(repoRoot, '.pkg-nec-release');
        const stagingDirectory = path.join(
          repoRoot,
          '.pkg-nec-release-stage-fixture',
        );
        const licensePath = path.join(repoRoot, 'LICENSE');
        fs.mkdirSync(outputDirectory, {recursive: true});
        fs.writeFileSync(path.join(outputDirectory, 'stale.tgz'), 'stale');
        fs.writeFileSync(licensePath, 'root license');
        const packages = [
          {
            directory: path.join(repoRoot, 'packages/jest-core'),
            manifestPath: path.join(repoRoot, 'packages/jest-core/package.json'),
            newName: '@pkg-nec/jest-core',
            oldName: '@jest/core',
            publishable: true,
            version: '30.4.2',
          },
          {
            directory: path.join(repoRoot, 'packages/jest'),
            manifestPath: path.join(repoRoot, 'packages/jest/package.json'),
            newName: '@pkg-nec/jest',
            oldName: 'jest',
            publishable: true,
            version: '30.4.2',
          },
        ];
        fs.writeFileSync(
          path.join(repoRoot, 'package.json'),
          JSON.stringify({packageManager: 'yarn@4.18.0'}),
        );
        for (const workspace of packages) {
          fs.mkdirSync(workspace.directory, {recursive: true});
          fs.writeFileSync(
            workspace.manifestPath,
            JSON.stringify(
              workspace.newName === '@pkg-nec/jest'
                ? {
                    dependencies: {
                      '@pkg-nec/jest-core': 'workspace:*',
                      'import-local': '^3.2.0',
                    },
                    name: workspace.newName,
                    repository: {
                      directory: path
                        .relative(repoRoot, workspace.directory)
                        .replaceAll(path.sep, '/'),
                      url: 'https://github.com/pkg-nec/jest.git',
                    },
                    version: workspace.version,
                  }
                : {
                    name: workspace.newName,
                    repository: {
                      directory: path
                        .relative(repoRoot, workspace.directory)
                        .replaceAll(path.sep, '/'),
                      url: 'https://github.com/pkg-nec/jest.git',
                    },
                    version: workspace.version,
                  },
            ),
          );
        }
        const root = {
          directory: repoRoot,
          manifestPath: path.join(repoRoot, 'package.json'),
          newName: '@pkg-nec/monorepo',
          oldName: '@jest/monorepo',
          publishable: false,
          version: '0.0.0',
        };
        const identities = [root, ...packages];
        const inventory = {
          byNewName: new Map(identities.map(item => [item.newName, item])),
          byOldName: new Map(identities.map(item => [item.oldName, item])),
          packages,
          root,
        };
        const graph = new Map([
          ['@pkg-nec/jest', new Set(['@pkg-nec/jest-core'])],
          ['@pkg-nec/jest-core', new Set()],
        ]);
        const calls = [];
        const repackCalls = [];
        const ledger = await runPrepareReleaseCommand({
          args: [${JSON.stringify(releaseTag)}],
          audit: () => [],
          buildGraph: () => graph,
          inspectTarball: async tarballPath => {
            const final = fs.readFileSync(tarballPath, 'utf8').startsWith('final-');
            return {
              files: [
                ...(final ? ['package/LICENSE'] : []),
                'package/z.js',
                'package/package.json',
                'package/a.js',
              ],
              manifest: tarballPath.includes('jest-core')
              ? {
                  name: '@pkg-nec/jest-core',
                  publishConfig: {access: 'public'},
                  repository: {
                    directory: 'packages/jest-core',
                    url: 'https://github.com/pkg-nec/jest.git',
                  },
                  version: '30.4.2',
                }
              : {
                  dependencies: {
                    '@pkg-nec/jest-core': '30.4.2',
                    'import-local': '^3.2.0',
                  },
                  name: '@pkg-nec/jest',
                  publishConfig: {access: 'public'},
                  repository: {
                    directory: 'packages/jest',
                    url: 'https://github.com/pkg-nec/jest.git',
                  },
                  version: '30.4.2',
              },
            };
          },
          env: {GITHUB_SHA: '0123456789abcdef0123456789abcdef01234567'},
          inventory,
          makeStagingDirectory: async () => {
            fs.mkdirSync(stagingDirectory);
            return stagingDirectory;
          },
          readCommittedFile: async (_root, _commit, file) =>
            fs.promises.readFile(path.join(repoRoot, ...file.split('/'))),
          readSourceCommit: async () => '0123456789abcdef0123456789abcdef01234567',
          repoRoot,
          repackTarball: async ({
            finalTarballPath,
            licensePath,
            packageName,
            rawTarballPath,
            stagingDirectory,
          }) => {
            repackCalls.push({
              finalTarballPath,
              licensePath,
              packageName,
              rawTarballPath,
              stagingDirectory,
            });
            fs.writeFileSync(
              finalTarballPath,
              'final-' + fs.readFileSync(rawTarballPath, 'utf8'),
            );
          },
          runCommand: async (command, args, options) => {
            calls.push({args, command, cwd: options.cwd});
            const contents = args[1].endsWith('jest-core')
              ? 'archive-jest-core'
              : 'archive-jest';
            const workspaceDirectory = inventory.byNewName.get(
              args[1],
            ).directory;
            const packOutput = path.isAbsolute(args[4])
              ? args[4]
              : path.join(workspaceDirectory, args[4]);
            fs.mkdirSync(path.dirname(packOutput), {recursive: true});
            fs.writeFileSync(packOutput, contents);
          },
          runGit: async args => {
            if (args[0] === 'rev-list' && args[1] === '--parents') {
              return '0123456789abcdef0123456789abcdef01234567 ' + 'f'.repeat(40);
            }
            return args[0] === 'rev-list'
              ? '0123456789abcdef0123456789abcdef01234567'
              : '';
          },
          write: () => {},
        });
        const jsonLedger = JSON.parse(
          fs.readFileSync(path.join(outputDirectory, 'release-ledger.json')),
        );
        const markdownLedger = fs.readFileSync(
          path.join(outputDirectory, 'release-ledger.md'),
          'utf8',
        );
        console.log(JSON.stringify({
          calls,
          jsonLedger,
          ledger,
          markdownLedger,
          repackCalls,
          staleExists: fs.existsSync(path.join(outputDirectory, 'stale.tgz')),
        }));
      `);

      expect(result.calls).toEqual([
        expect.objectContaining({
          args: [
            'workspace',
            '@pkg-nec/jest-core',
            'pack',
            '--out',
            expect.stringMatching(/pkg-nec-jest-core-30\.4\.2\.raw-/),
          ],
          command: 'yarn',
          cwd: temporaryRepo,
        }),
        expect.objectContaining({
          args: [
            'workspace',
            '@pkg-nec/jest',
            'pack',
            '--out',
            expect.stringMatching(/pkg-nec-jest-30\.4\.2\.raw-/),
          ],
          command: 'yarn',
          cwd: temporaryRepo,
        }),
      ]);
      expect(result.repackCalls).toEqual([
        expect.objectContaining({
          licensePath: join(temporaryRepo, 'LICENSE'),
          packageName: '@pkg-nec/jest-core',
          stagingDirectory: join(
            temporaryRepo,
            '.pkg-nec-release-stage-fixture',
          ),
        }),
        expect.objectContaining({
          licensePath: join(temporaryRepo, 'LICENSE'),
          packageName: '@pkg-nec/jest',
          stagingDirectory: join(
            temporaryRepo,
            '.pkg-nec-release-stage-fixture',
          ),
        }),
      ]);
      expect(result.staleExists).toBe(false);
      expect(result.ledger).toEqual(result.jsonLedger);
      expect(result.ledger).toMatchObject({
        nodeVersion: process.version,
        packageManager: 'yarn@4.18.0',
        schemaVersion: 2,
        sourceCommit: '0123456789abcdef0123456789abcdef01234567',
      });
      expect(result.ledger.packages[0].tarball).toBe(
        '.pkg-nec-release/pkg-nec-jest-core-30.4.2.tgz',
      );
      expect(result.ledger.packages.map(item => item.name)).toEqual([
        '@pkg-nec/jest-core',
        '@pkg-nec/jest',
      ]);
      expect(result.ledger.packages[0]).toEqual(
        expect.objectContaining({
          files: ['LICENSE', 'a.js', 'package.json', 'z.js'],
          integrity: `sha512-${createHash('sha512')
            .update('final-archive-jest-core')
            .digest('base64')}`,
          prerequisites: [],
        }),
      );
      expect(result.markdownLedger).toContain(
        '| 2 | @pkg-nec/jest | 30.4.2 | @pkg-nec/jest-core |',
      );
    } finally {
      await rm(temporaryRepo, {force: true, recursive: true});
    }
  });

  test('rejects a final manifest whose dependencies drift during repacking', async () => {
    const temporaryRepo = await mkdtemp(join(tmpdir(), 'pkg-nec-manifest-'));

    try {
      const releaseTag = await writeReleasePlanFixture(temporaryRepo, {
        anchor: {
          fromVersion: '0.9.0',
          name: '@pkg-nec/jest-core',
          toVersion: '1.0.0',
        },
        packages: [
          {
            bump: 'major',
            fromVersion: '0.9.0',
            name: '@pkg-nec/jest-core',
            path: 'packages/jest-core',
            toVersion: '1.0.0',
          },
        ],
      });
      const result = runModuleProgram(`
        import path from 'node:path';
        import fs from 'graceful-fs';
        import {runPrepareReleaseCommand} from ${JSON.stringify(releaseModuleUrl)};

        const repoRoot = ${JSON.stringify(temporaryRepo)};
        const stagingDirectory = path.join(repoRoot, '.pkg-nec-release-stage-drift');
        const packageName = '@pkg-nec/jest-core';
        const workspace = {
          directory: path.join(repoRoot, 'packages/jest-core'),
          manifestPath: path.join(repoRoot, 'packages/jest-core/package.json'),
          newName: packageName,
          oldName: '@jest/core',
          publishable: true,
          version: '1.0.0',
        };
        const inventory = {
          byNewName: new Map([[packageName, workspace]]),
          byOldName: new Map([['@jest/core', workspace]]),
          packages: [workspace],
          root: null,
        };
        fs.mkdirSync(workspace.directory, {recursive: true});
        fs.writeFileSync(
          workspace.manifestPath,
          JSON.stringify({
            name: packageName,
            repository: {
              directory: 'packages/jest-core',
              url: 'https://github.com/pkg-nec/jest.git',
            },
            version: '1.0.0',
          }),
        );
        fs.writeFileSync(path.join(repoRoot, 'LICENSE'), 'license');
        let message;
        try {
          await runPrepareReleaseCommand({
            args: [${JSON.stringify(releaseTag)}],
            audit: () => [],
            buildGraph: () => new Map([[packageName, new Set()]]),
            env: {GITHUB_SHA: '0123456789abcdef0123456789abcdef01234567'},
            inspectTarball: async tarballPath => ({
              files: tarballPath.includes('.raw-')
                ? ['package/package.json']
                : ['package/LICENSE', 'package/package.json'],
              manifest: {
                ...(tarballPath.includes('.raw-')
                  ? {}
                  : {dependencies: {'left-pad': '1.0.0'}}),
                name: packageName,
                publishConfig: {access: 'public'},
                repository: {
                  directory: 'packages/jest-core',
                  url: 'https://github.com/pkg-nec/jest.git',
                },
                version: '1.0.0',
              },
            }),
            inventory,
            makeStagingDirectory: async () => {
              fs.mkdirSync(stagingDirectory);
              return stagingDirectory;
            },
            orderGraph: graph => [...graph.keys()],
            readCommittedFile: async (_root, _commit, file) =>
              fs.promises.readFile(path.join(repoRoot, ...file.split('/'))),
            readSourceCommit: async () => '0123456789abcdef0123456789abcdef01234567',
            repackTarball: async ({finalTarballPath}) => {
              fs.writeFileSync(finalTarballPath, 'final');
            },
            repoRoot,
            runGit: async args => {
              if (args[0] === 'rev-list' && args[1] === '--parents') {
                return '0123456789abcdef0123456789abcdef01234567 ' + 'f'.repeat(40);
              }
              return args[0] === 'rev-list'
                ? '0123456789abcdef0123456789abcdef01234567'
                : '';
            },
            runCommand: async (_command, args) => {
              fs.writeFileSync(args[4], 'raw');
            },
            write: () => {},
          });
        } catch (error) {
          message = error.message;
        }
        console.log(JSON.stringify({
          message,
          stagingExists: fs.existsSync(stagingDirectory),
        }));
      `);

      expect(result).toEqual({
        message: 'Packed manifest changed after repacking: @pkg-nec/jest-core',
        stagingExists: false,
      });
    } finally {
      await rm(temporaryRepo, {force: true, recursive: true});
    }
  });

  test('preserves the prior release when repacking fails', async () => {
    const temporaryRepo = await mkdtemp(join(tmpdir(), 'pkg-nec-repack-fail-'));

    try {
      const releaseTag = await writeReleasePlanFixture(temporaryRepo, {
        anchor: {
          fromVersion: '0.9.0',
          name: '@pkg-nec/jest-core',
          toVersion: '1.0.0',
        },
        packages: [
          {
            bump: 'major',
            fromVersion: '0.9.0',
            name: '@pkg-nec/jest-core',
            path: 'packages/jest-core',
            toVersion: '1.0.0',
          },
        ],
      });
      const result = runModuleProgram(`
        import path from 'node:path';
        import fs from 'graceful-fs';
        import {runPrepareReleaseCommand} from ${JSON.stringify(releaseModuleUrl)};

        const repoRoot = ${JSON.stringify(temporaryRepo)};
        const outputDirectory = path.join(repoRoot, '.pkg-nec-release');
        const stagingDirectory = path.join(repoRoot, '.pkg-nec-release-stage-failure');
        const packageName = '@pkg-nec/jest-core';
        const workspace = {
          directory: path.join(repoRoot, 'packages/jest-core'),
          manifestPath: path.join(repoRoot, 'packages/jest-core/package.json'),
          newName: packageName,
          oldName: '@jest/core',
          publishable: true,
          version: '1.0.0',
        };
        const inventory = {
          byNewName: new Map([[packageName, workspace]]),
          byOldName: new Map([['@jest/core', workspace]]),
          packages: [workspace],
          root: null,
        };
        fs.mkdirSync(workspace.directory, {recursive: true});
        fs.writeFileSync(
          workspace.manifestPath,
          JSON.stringify({
            name: packageName,
            repository: {
              directory: 'packages/jest-core',
              url: 'https://github.com/pkg-nec/jest.git',
            },
            version: '1.0.0',
          }),
        );
        fs.mkdirSync(outputDirectory);
        fs.writeFileSync(path.join(outputDirectory, 'previous.tgz'), 'previous');
        fs.writeFileSync(path.join(repoRoot, 'LICENSE'), 'license');
        let message;
        try {
          await runPrepareReleaseCommand({
            args: [${JSON.stringify(releaseTag)}],
            audit: () => [],
            buildGraph: () => new Map([[packageName, new Set()]]),
            env: {GITHUB_SHA: '0123456789abcdef0123456789abcdef01234567'},
            inspectTarball: async () => ({
              files: ['package/package.json'],
              manifest: {
                name: packageName,
                publishConfig: {access: 'public'},
                repository: {
                  directory: 'packages/jest-core',
                  url: 'https://github.com/pkg-nec/jest.git',
                },
                version: '1.0.0',
              },
            }),
            inventory,
            makeStagingDirectory: async () => {
              fs.mkdirSync(stagingDirectory);
              return stagingDirectory;
            },
            orderGraph: graph => [...graph.keys()],
            readCommittedFile: async (_root, _commit, file) =>
              fs.promises.readFile(path.join(repoRoot, ...file.split('/'))),
            readSourceCommit: async () => '0123456789abcdef0123456789abcdef01234567',
            repackTarball: async () => {
              throw new Error('repack failed');
            },
            repoRoot,
            runGit: async args => {
              if (args[0] === 'rev-list' && args[1] === '--parents') {
                return '0123456789abcdef0123456789abcdef01234567 ' + 'f'.repeat(40);
              }
              return args[0] === 'rev-list'
                ? '0123456789abcdef0123456789abcdef01234567'
                : '';
            },
            runCommand: async (_command, args) => {
              fs.writeFileSync(args[4], 'raw');
            },
            write: () => {},
          });
        } catch (error) {
          message = error.message;
        }
        console.log(JSON.stringify({
          finalFiles: fs.readdirSync(outputDirectory),
          message,
          previous: fs.readFileSync(path.join(outputDirectory, 'previous.tgz'), 'utf8'),
          stagingExists: fs.existsSync(stagingDirectory),
        }));
      `);

      expect(result).toEqual({
        finalFiles: ['previous.tgz'],
        message: 'repack failed',
        previous: 'previous',
        stagingExists: false,
      });
    } finally {
      await rm(temporaryRepo, {force: true, recursive: true});
    }
  });

  test('preserves the repack failure when staging cleanup also fails', async () => {
    const temporaryRepo = await mkdtemp(
      join(tmpdir(), 'pkg-nec-cleanup-fail-'),
    );

    try {
      const releaseTag = await writeReleasePlanFixture(temporaryRepo, {
        anchor: {
          fromVersion: '0.9.0',
          name: '@pkg-nec/jest-core',
          toVersion: '1.0.0',
        },
        packages: [
          {
            bump: 'major',
            fromVersion: '0.9.0',
            name: '@pkg-nec/jest-core',
            path: 'packages/jest-core',
            toVersion: '1.0.0',
          },
        ],
      });
      const result = runModuleProgram(`
        import path from 'node:path';
        import fs from 'graceful-fs';
        import {runPrepareReleaseCommand} from ${JSON.stringify(releaseModuleUrl)};

        const repoRoot = ${JSON.stringify(temporaryRepo)};
        const stagingDirectory = path.join(repoRoot, '.pkg-nec-release-stage-cleanup');
        const packageName = '@pkg-nec/jest-core';
        const workspace = {
          directory: path.join(repoRoot, 'packages/jest-core'),
          manifestPath: path.join(repoRoot, 'packages/jest-core/package.json'),
          newName: packageName,
          oldName: '@jest/core',
          publishable: true,
          version: '1.0.0',
        };
        const inventory = {
          byNewName: new Map([[packageName, workspace]]),
          byOldName: new Map([['@jest/core', workspace]]),
          packages: [workspace],
          root: null,
        };
        fs.mkdirSync(workspace.directory, {recursive: true});
        fs.writeFileSync(
          workspace.manifestPath,
          JSON.stringify({
            name: packageName,
            repository: {
              directory: 'packages/jest-core',
              url: 'https://github.com/pkg-nec/jest.git',
            },
            version: '1.0.0',
          }),
        );
        const rm = fs.promises.rm;
        fs.promises.rm = async (target, options) => {
          if (path.resolve(target) === path.resolve(stagingDirectory)) {
            throw new Error('staging cleanup failed');
          }
          return rm(target, options);
        };
        fs.mkdirSync(stagingDirectory);
        let message;
        try {
          await runPrepareReleaseCommand({
            args: [${JSON.stringify(releaseTag)}],
            audit: () => [],
            buildGraph: () => new Map([[packageName, new Set()]]),
            env: {GITHUB_SHA: '0123456789abcdef0123456789abcdef01234567'},
            inspectTarball: async () => ({
              files: ['package/package.json'],
              manifest: {
                name: packageName,
                publishConfig: {access: 'public'},
                repository: {
                  directory: 'packages/jest-core',
                  url: 'https://github.com/pkg-nec/jest.git',
                },
                version: '1.0.0',
              },
            }),
            inventory,
            makeStagingDirectory: async () => stagingDirectory,
            orderGraph: graph => [...graph.keys()],
            readCommittedFile: async (_root, _commit, file) =>
              fs.promises.readFile(path.join(repoRoot, ...file.split('/'))),
            readSourceCommit: async () => '0123456789abcdef0123456789abcdef01234567',
            repackTarball: async () => {
              throw new Error('repack failed');
            },
            repoRoot,
            runGit: async args => {
              if (args[0] === 'rev-list' && args[1] === '--parents') {
                return '0123456789abcdef0123456789abcdef01234567 ' + 'f'.repeat(40);
              }
              return args[0] === 'rev-list'
                ? '0123456789abcdef0123456789abcdef01234567'
                : '';
            },
            runCommand: async (_command, args) => {
              fs.writeFileSync(args[4], 'raw');
            },
            write: () => {},
          });
        } catch (error) {
          message = error.message;
        } finally {
          fs.promises.rm = rm;
        }
        console.log(JSON.stringify({message}));
      `);

      expect(result).toEqual({message: 'repack failed'});
    } finally {
      await rm(temporaryRepo, {force: true, recursive: true});
    }
  });

  test('preserves promotion failure diagnostics when rollback also fails', async () => {
    const temporaryRepo = await mkdtemp(
      join(tmpdir(), 'pkg-nec-promotion-fail-'),
    );

    try {
      const releaseTag = await writeReleasePlanFixture(temporaryRepo, {
        anchor: {
          fromVersion: '0.9.0',
          name: '@pkg-nec/create-jest',
          toVersion: '1.0.0',
        },
        packages: [
          {
            bump: 'major',
            fromVersion: '0.9.0',
            name: '@pkg-nec/create-jest',
            path: 'packages/create-jest',
            toVersion: '1.0.0',
          },
        ],
      });
      const result = runModuleProgram(`
        import path from 'node:path';
        import fs from 'graceful-fs';
        import {runPrepareReleaseCommand} from ${JSON.stringify(releaseModuleUrl)};

        const repoRoot = ${JSON.stringify(temporaryRepo)};
        const outputDirectory = path.join(repoRoot, '.pkg-nec-release');
        const stagingDirectory = path.join(
          repoRoot,
          '.pkg-nec-release-stage-promotion',
        );
        fs.writeFileSync(
          path.join(repoRoot, 'package.json'),
          JSON.stringify({packageManager: 'yarn@4.18.0'}),
        );
        fs.writeFileSync(path.join(repoRoot, 'LICENSE'), 'license');
        const packageName = '@pkg-nec/create-jest';
        const workspace = {
          directory: path.join(repoRoot, 'packages/create-jest'),
          manifestPath: path.join(repoRoot, 'packages/create-jest/package.json'),
          newName: packageName,
          oldName: packageName,
          publishable: true,
          version: '1.0.0',
        };
        fs.mkdirSync(workspace.directory, {recursive: true});
        fs.writeFileSync(
          workspace.manifestPath,
          JSON.stringify({
            name: packageName,
            publishConfig: {access: 'public'},
            repository: {
              directory: 'packages/create-jest',
              url: 'https://github.com/pkg-nec/jest.git',
            },
            version: '1.0.0',
          }),
        );
        fs.mkdirSync(outputDirectory);
        fs.writeFileSync(path.join(outputDirectory, 'previous.txt'), 'previous');

        const rename = fs.promises.rename;
        let backupPath;
        let renameCalls = 0;
        fs.promises.rename = async (source, target) => {
          renameCalls += 1;
          if (renameCalls === 1) {
            backupPath = target;
            return rename(source, target);
          }
          if (renameCalls === 2) throw new Error('promotion failed');
          if (renameCalls === 3) throw new Error('rollback failed');
          return rename(source, target);
        };

        let diagnostics;
        try {
          await runPrepareReleaseCommand({
            args: [${JSON.stringify(releaseTag)}],
            audit: () => [],
            buildGraph: () => new Map([[packageName, new Set()]]),
            env: {GITHUB_SHA: '0123456789abcdef0123456789abcdef01234567'},
            inspectTarball: async tarballPath => ({
              files: tarballPath.includes('.raw-')
                ? ['package/package.json']
                : ['package/LICENSE', 'package/package.json'],
              manifest: JSON.parse(fs.readFileSync(workspace.manifestPath, 'utf8')),
            }),
            inventory: {
              byNewName: new Map([[packageName, workspace]]),
              byOldName: new Map([[packageName, workspace]]),
              packages: [workspace],
              root: null,
            },
            makeStagingDirectory: async () => {
              fs.mkdirSync(stagingDirectory);
              return stagingDirectory;
            },
            orderGraph: graph => [...graph.keys()],
            readCommittedFile: async (_root, _commit, file) =>
              fs.promises.readFile(path.join(repoRoot, ...file.split('/'))),
            readSourceCommit: async () => '0123456789abcdef0123456789abcdef01234567',
            repackTarball: async ({finalTarballPath}) => {
              fs.writeFileSync(finalTarballPath, 'final');
            },
            repoRoot,
            runGit: async args => {
              if (args[0] === 'rev-list' && args[1] === '--parents') {
                return '0123456789abcdef0123456789abcdef01234567 ' + 'f'.repeat(40);
              }
              return args[0] === 'rev-list'
                ? '0123456789abcdef0123456789abcdef01234567'
                : '';
            },
            runCommand: async (_command, args) => {
              fs.writeFileSync(args[4], 'raw');
            },
            write: () => {},
          });
        } catch (error) {
          diagnostics = {
            backupPathMatches: error.backupPath === backupPath,
            message: error.message,
            rollbackMessage: error.rollbackError?.message ?? null,
          };
        } finally {
          fs.promises.rename = rename;
        }

        console.log(JSON.stringify({
          ...diagnostics,
          backupContents: fs.readFileSync(
            path.join(backupPath, 'previous.txt'),
            'utf8',
          ),
          backupExists: fs.existsSync(backupPath),
          stagingExists: fs.existsSync(stagingDirectory),
        }));
      `);

      expect(result).toEqual({
        backupContents: 'previous',
        backupExists: true,
        backupPathMatches: true,
        message: 'promotion failed',
        rollbackMessage: 'rollback failed',
        stagingExists: false,
      });
    } finally {
      await rm(temporaryRepo, {force: true, recursive: true});
    }
  });

  test('refuses root and outside output paths before removing files', async () => {
    const temporaryRepo = await mkdtemp(join(tmpdir(), 'pkg-nec-pack-safe-'));

    try {
      const result = runModuleProgram(`
        import path from 'node:path';
        import fs from 'graceful-fs';
        import {runPrepareReleaseCommand} from ${JSON.stringify(releaseModuleUrl)};

        const repoRoot = ${JSON.stringify(temporaryRepo)};
        const marker = path.join(repoRoot, 'keep.txt');
        fs.writeFileSync(marker, 'keep');
        const messages = [];
        const fileSystemRoot = path.parse(repoRoot).root;
        for (const options of [
          {outputDirectory: repoRoot, repoRoot},
          {outputDirectory: path.dirname(repoRoot), repoRoot},
          {
            audit: () => {
              throw new Error('audit must not run for filesystem root');
            },
            outputDirectory: path.join(
              fileSystemRoot,
              '.pkg-nec-release',
            ),
            repoRoot: fileSystemRoot,
          },
        ]) {
          try {
            await runPrepareReleaseCommand(options);
          } catch (error) {
            messages.push(error.message);
          }
        }
        console.log(JSON.stringify({
          marker: fs.readFileSync(marker, 'utf8'),
          messages,
        }));
      `);

      expect(result.marker).toBe('keep');
      expect(result.messages).toEqual([
        expect.stringMatching(/release output directory/i),
        expect.stringMatching(/release output directory/i),
        expect.stringMatching(/repository root must not be a filesystem root/i),
      ]);
    } finally {
      await rm(temporaryRepo, {force: true, recursive: true});
    }
  });

  test('rejects an output symlink or junction that resolves outside the real repository', async () => {
    const temporaryRepo = await mkdtemp(join(tmpdir(), 'pkg-nec-pack-link-'));
    const outsideDirectory = await mkdtemp(
      join(tmpdir(), 'pkg-nec-pack-outside-'),
    );

    try {
      const result = runModuleProgram(`
        import path from 'node:path';
        import fs from 'graceful-fs';
        import {runPrepareReleaseCommand} from ${JSON.stringify(releaseModuleUrl)};

        const repoRoot = ${JSON.stringify(temporaryRepo)};
        const outsideDirectory = ${JSON.stringify(outsideDirectory)};
        const outputDirectory = path.join(repoRoot, '.pkg-nec-release');
        const marker = path.join(outsideDirectory, 'keep.txt');
        fs.writeFileSync(marker, 'keep');
        let supported = true;
        let message = null;
        try {
          fs.symlinkSync(
            outsideDirectory,
            outputDirectory,
            process.platform === 'win32' ? 'junction' : 'dir',
          );
        } catch {
          supported = false;
        }
        if (supported) {
          try {
            await runPrepareReleaseCommand({outputDirectory, repoRoot});
          } catch (error) {
            message = error.message;
          }
        }
        console.log(JSON.stringify({
          marker: fs.readFileSync(marker, 'utf8'),
          message,
          supported,
        }));
      `);

      expect(result.marker).toBe('keep');
      if (result.supported) {
        expect(result.message).toMatch(/outside.*real repository/i);
      }
    } finally {
      await rm(temporaryRepo, {force: true, recursive: true});
      await rm(outsideDirectory, {force: true, recursive: true});
    }
  });

  test('rejects a staging adapter that resolves outside the real repository', async () => {
    const temporaryRepo = await mkdtemp(join(tmpdir(), 'pkg-nec-stage-safe-'));
    const outsideDirectory = await mkdtemp(
      join(tmpdir(), 'pkg-nec-stage-outside-'),
    );

    try {
      const releaseTag = await writeReleasePlanFixture(temporaryRepo, {
        anchor: {
          fromVersion: '0.9.0',
          name: '@pkg-nec/create-jest',
          toVersion: '1.0.0',
        },
        packages: [
          {
            bump: 'major',
            fromVersion: '0.9.0',
            name: '@pkg-nec/create-jest',
            path: 'packages/create-jest',
            toVersion: '1.0.0',
          },
        ],
      });
      const result = runModuleProgram(`
        import path from 'node:path';
        import fs from 'graceful-fs';
        import {runPrepareReleaseCommand} from ${JSON.stringify(releaseModuleUrl)};

        const repoRoot = ${JSON.stringify(temporaryRepo)};
        const outsideDirectory = ${JSON.stringify(outsideDirectory)};
        const marker = path.join(outsideDirectory, 'keep.txt');
        const packageName = '@pkg-nec/create-jest';
        const workspace = {
          directory: path.join(repoRoot, 'packages/create-jest'),
          manifestPath: path.join(repoRoot, 'packages/create-jest/package.json'),
          newName: packageName,
          oldName: packageName,
          publishable: true,
          version: '1.0.0',
        };
        fs.mkdirSync(workspace.directory, {recursive: true});
        fs.writeFileSync(
          workspace.manifestPath,
          JSON.stringify({name: packageName, version: '1.0.0'}),
        );
        fs.writeFileSync(marker, 'keep');
        let message;
        try {
          await runPrepareReleaseCommand({
            args: [${JSON.stringify(releaseTag)}],
            audit: () => [],
            buildGraph: () => new Map([[packageName, new Set()]]),
            env: {GITHUB_SHA: '0123456789abcdef0123456789abcdef01234567'},
            inventory: {
              byNewName: new Map([[packageName, workspace]]),
              byOldName: new Map([[packageName, workspace]]),
              packages: [workspace],
              root: null,
            },
            makeStagingDirectory: async () => outsideDirectory,
            orderGraph: graph => [...graph.keys()],
            readCommittedFile: async (_root, _commit, file) =>
              fs.promises.readFile(path.join(repoRoot, ...file.split('/'))),
            readSourceCommit: async () => '0123456789abcdef0123456789abcdef01234567',
            repoRoot,
            runGit: async args => {
              if (args[0] === 'rev-list' && args[1] === '--parents') {
                return '0123456789abcdef0123456789abcdef01234567 ' + 'f'.repeat(40);
              }
              return args[0] === 'rev-list'
                ? '0123456789abcdef0123456789abcdef01234567'
                : '';
            },
            write: () => {},
          });
        } catch (error) {
          message = error.message;
        }
        console.log(JSON.stringify({
          marker: fs.readFileSync(marker, 'utf8'),
          message,
        }));
      `);

      expect(result).toEqual({
        marker: 'keep',
        message: expect.stringMatching(/staging.*real repository/i),
      });
    } finally {
      await rm(temporaryRepo, {force: true, recursive: true});
      await rm(outsideDirectory, {force: true, recursive: true});
    }
  });

  test('preserves the prior final release and cleans staging on mid-pack and ledger-write failures', async () => {
    const temporaryRepo = await mkdtemp(join(tmpdir(), 'pkg-nec-stage-'));

    try {
      const releaseTag = await writeReleasePlanFixture(temporaryRepo, {
        anchor: {
          fromVersion: '30.4.1',
          name: '@pkg-nec/jest',
          toVersion: '30.4.2',
        },
        packages: [
          {
            bump: 'patch',
            fromVersion: '30.4.1',
            name: '@pkg-nec/jest-core',
            path: 'packages/jest-core',
            toVersion: '30.4.2',
          },
          {
            bump: 'patch',
            fromVersion: '30.4.1',
            name: '@pkg-nec/jest',
            path: 'packages/jest',
            toVersion: '30.4.2',
          },
        ],
      });
      const result = runModuleProgram(`
        import path from 'node:path';
        import fs from 'graceful-fs';
        import {runPrepareReleaseCommand} from ${JSON.stringify(releaseModuleUrl)};

        const repoRoot = ${JSON.stringify(temporaryRepo)};
        const packages = [
          ['@jest/core', '@pkg-nec/jest-core', 'jest-core'],
          ['jest', '@pkg-nec/jest', 'jest'],
        ].map(([oldName, newName, directory]) => ({
          directory: path.join(repoRoot, 'packages', directory),
          manifestPath: path.join(
            repoRoot,
            'packages',
            directory,
            'package.json',
          ),
          newName,
          oldName,
          publishable: true,
          version: '30.4.2',
        }));
        const root = {
          directory: repoRoot,
          manifestPath: path.join(repoRoot, 'package.json'),
          newName: '@pkg-nec/monorepo',
          oldName: '@jest/monorepo',
          publishable: false,
          version: '0.0.0',
        };
        const identities = [root, ...packages];
        const inventory = {
          byNewName: new Map(identities.map(item => [item.newName, item])),
          byOldName: new Map(identities.map(item => [item.oldName, item])),
          packages,
          root,
        };
        fs.writeFileSync(
          path.join(repoRoot, 'package.json'),
          JSON.stringify({packageManager: 'yarn@4.18.0'}),
        );
        for (const workspace of packages) {
          fs.mkdirSync(workspace.directory, {recursive: true});
          fs.writeFileSync(
            workspace.manifestPath,
            JSON.stringify(
              workspace.newName === '@pkg-nec/jest'
                ? {
                    dependencies: {'@pkg-nec/jest-core': 'workspace:*'},
                    name: workspace.newName,
                    repository: {
                      directory: path
                        .relative(repoRoot, workspace.directory)
                        .replaceAll(path.sep, '/'),
                      url: 'https://github.com/pkg-nec/jest.git',
                    },
                    version: workspace.version,
                  }
                : {
                    name: workspace.newName,
                    repository: {
                      directory: path
                        .relative(repoRoot, workspace.directory)
                        .replaceAll(path.sep, '/'),
                      url: 'https://github.com/pkg-nec/jest.git',
                    },
                    version: workspace.version,
                  },
            ),
          );
        }
        const graph = new Map([
          ['@pkg-nec/jest', new Set(['@pkg-nec/jest-core'])],
          ['@pkg-nec/jest-core', new Set()],
        ]);
        const finalDirectory = path.join(repoRoot, '.pkg-nec-release');

        async function runFailure(label, {failLedger = false} = {}) {
          fs.rmSync(finalDirectory, {force: true, recursive: true});
          fs.mkdirSync(finalDirectory);
          fs.writeFileSync(path.join(finalDirectory, 'previous.txt'), label);
          const stagingDirectory = path.join(
            repoRoot,
            '.pkg-nec-release-stage-' + label,
          );
          let packCalls = 0;
          let ledgerWrites = 0;
          let message;
          try {
            await runPrepareReleaseCommand({
              args: [${JSON.stringify(releaseTag)}],
              audit: () => [],
              buildGraph: () => graph,
              env: {GITHUB_SHA: '0123456789abcdef0123456789abcdef01234567'},
              inspectTarball: async tarballPath => ({
                files: [
                  ...(tarballPath.includes('.raw-') ? [] : ['package/LICENSE']),
                  'package/package.json',
                ],
                manifest: tarballPath.includes('jest-core')
                  ? {
                      name: '@pkg-nec/jest-core',
                      publishConfig: {access: 'public'},
                      repository: {
                        directory: 'packages/jest-core',
                        url: 'https://github.com/pkg-nec/jest.git',
                      },
                      version: '30.4.2',
                    }
                  : {
                      dependencies: {'@pkg-nec/jest-core': '30.4.2'},
                      name: '@pkg-nec/jest',
                      publishConfig: {access: 'public'},
                      repository: {
                        directory: 'packages/jest',
                        url: 'https://github.com/pkg-nec/jest.git',
                      },
                      version: '30.4.2',
                    },
              }),
              inventory,
              makeStagingDirectory: async () => {
                fs.mkdirSync(stagingDirectory);
                return stagingDirectory;
              },
              readCommittedFile: async (_root, _commit, file) =>
                fs.promises.readFile(path.join(repoRoot, ...file.split('/'))),
              readSourceCommit: async () => '0123456789abcdef0123456789abcdef01234567',
              repoRoot,
              repackTarball: async ({finalTarballPath}) => {
                fs.writeFileSync(finalTarballPath, 'final');
              },
              runCommand: async (_command, args) => {
                packCalls += 1;
                if (!failLedger && packCalls === 2) {
                  throw new Error('mid-pack failure');
                }
                fs.writeFileSync(args[4], 'archive-' + packCalls);
              },
              runGit: async args => {
                if (args[0] === 'rev-list' && args[1] === '--parents') {
                  return '0123456789abcdef0123456789abcdef01234567 ' + 'f'.repeat(40);
                }
                return args[0] === 'rev-list'
                  ? '0123456789abcdef0123456789abcdef01234567'
                  : '';
              },
              write: () => {},
              writeFile: async (filePath, contents) => {
                ledgerWrites += 1;
                if (failLedger && ledgerWrites === 2) {
                  throw new Error('ledger-write failure');
                }
                await fs.promises.writeFile(filePath, contents);
              },
            });
          } catch (error) {
            message = error.message;
          }
          return {
            finalFiles: fs.readdirSync(finalDirectory).sort(),
            message,
            previous: fs.readFileSync(
              path.join(finalDirectory, 'previous.txt'),
              'utf8',
            ),
            stagingExists: fs.existsSync(stagingDirectory),
          };
        }

        console.log(JSON.stringify({
          ledger: await runFailure('ledger', {failLedger: true}),
          pack: await runFailure('pack'),
        }));
      `);

      expect(result.pack).toEqual({
        finalFiles: ['previous.txt'],
        message: 'mid-pack failure',
        previous: 'pack',
        stagingExists: false,
      });
      expect(result.ledger).toEqual({
        finalFiles: ['previous.txt'],
        message: 'ledger-write failure',
        previous: 'ledger',
        stagingExists: false,
      });
    } finally {
      await rm(temporaryRepo, {force: true, recursive: true});
    }
  });
});
