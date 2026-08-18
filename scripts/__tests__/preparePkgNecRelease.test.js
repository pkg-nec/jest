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

async function writeManifest(repo, directory, manifest) {
  const manifestDirectory = join(repo, directory);
  await mkdir(manifestDirectory, {recursive: true});
  await writeFile(
    join(manifestDirectory, 'package.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
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
        version: '31.0.0-security.1',
      };
      const validManifest = {
        dependencies: {
          '@pkg-nec/jest-core': '=31.0.0-security.2',
          chalk: '^5.0.0',
        },
        name: '@pkg-nec/example',
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
        version: '31.0.0-security.1',
      };
      const validManifest = {
        dependencies: {
          '@pkg-nec/jest-core': '31.0.0-security.2',
          chalk: '^5.0.0',
        },
        name: '@pkg-nec/example',
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
        sourceCommit: '0123456789abcdef',
      })));
    `);

    expect(result).toMatchObject({
      generatedAt: '2026-08-18T00:00:00.000Z',
      nodeVersion: 'v22.23.1',
      packageManager: 'yarn@4.18.0',
      schemaVersion: 1,
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

  test('packs fixtures with exact Yarn arguments and writes reviewed ledgers safely', async () => {
    const temporaryRepo = await mkdtemp(join(tmpdir(), 'pkg-nec-pack-'));

    try {
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
                    version: workspace.version,
                  }
                : {
                    name: workspace.newName,
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
                  version: '30.4.2',
                }
              : {
                  dependencies: {
                    '@pkg-nec/jest-core': '30.4.2',
                    'import-local': '^3.2.0',
                  },
                  name: '@pkg-nec/jest',
                  publishConfig: {access: 'public'},
                  version: '30.4.2',
                },
            };
          },
          inventory,
          makeStagingDirectory: async () => {
            fs.mkdirSync(stagingDirectory);
            return stagingDirectory;
          },
          readSourceCommit: async () => '0123456789abcdef',
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
        schemaVersion: 1,
        sourceCommit: '0123456789abcdef',
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
          JSON.stringify({name: packageName, version: '1.0.0'}),
        );
        fs.writeFileSync(path.join(repoRoot, 'LICENSE'), 'license');
        let message;
        try {
          await runPrepareReleaseCommand({
            audit: () => [],
            buildGraph: () => new Map([[packageName, new Set()]]),
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
                version: '1.0.0',
              },
            }),
            inventory,
            makeStagingDirectory: async () => {
              fs.mkdirSync(stagingDirectory);
              return stagingDirectory;
            },
            orderGraph: graph => [...graph.keys()],
            repackTarball: async ({finalTarballPath}) => {
              fs.writeFileSync(finalTarballPath, 'final');
            },
            repoRoot,
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
          JSON.stringify({name: packageName, version: '1.0.0'}),
        );
        fs.mkdirSync(outputDirectory);
        fs.writeFileSync(path.join(outputDirectory, 'previous.tgz'), 'previous');
        fs.writeFileSync(path.join(repoRoot, 'LICENSE'), 'license');
        let message;
        try {
          await runPrepareReleaseCommand({
            audit: () => [],
            buildGraph: () => new Map([[packageName, new Set()]]),
            inspectTarball: async () => ({
              files: ['package/package.json'],
              manifest: {
                name: packageName,
                publishConfig: {access: 'public'},
                version: '1.0.0',
              },
            }),
            inventory,
            makeStagingDirectory: async () => {
              fs.mkdirSync(stagingDirectory);
              return stagingDirectory;
            },
            orderGraph: graph => [...graph.keys()],
            repackTarball: async () => {
              throw new Error('repack failed');
            },
            repoRoot,
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
          JSON.stringify({name: packageName, version: '1.0.0'}),
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
            audit: () => [],
            buildGraph: () => new Map([[packageName, new Set()]]),
            inspectTarball: async () => ({
              files: ['package/package.json'],
              manifest: {
                name: packageName,
                publishConfig: {access: 'public'},
                version: '1.0.0',
              },
            }),
            inventory,
            makeStagingDirectory: async () => stagingDirectory,
            orderGraph: graph => [...graph.keys()],
            repackTarball: async () => {
              throw new Error('repack failed');
            },
            repoRoot,
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
      const result = runModuleProgram(`
        import path from 'node:path';
        import fs from 'graceful-fs';
        import {runPrepareReleaseCommand} from ${JSON.stringify(releaseModuleUrl)};

        const repoRoot = ${JSON.stringify(temporaryRepo)};
        const outsideDirectory = ${JSON.stringify(outsideDirectory)};
        const marker = path.join(outsideDirectory, 'keep.txt');
        fs.writeFileSync(marker, 'keep');
        let message;
        try {
          await runPrepareReleaseCommand({
            audit: () => [],
            buildGraph: () => new Map(),
            inventory: {
              byNewName: new Map(),
              byOldName: new Map(),
              packages: [],
              root: null,
            },
            makeStagingDirectory: async () => outsideDirectory,
            repoRoot,
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
                    version: workspace.version,
                  }
                : {
                    name: workspace.newName,
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
              audit: () => [],
              buildGraph: () => graph,
              inspectTarball: async tarballPath => ({
                files: [
                  ...(tarballPath.includes('.raw-') ? [] : ['package/LICENSE']),
                  'package/package.json',
                ],
                manifest: tarballPath.includes('jest-core')
                  ? {
                      name: '@pkg-nec/jest-core',
                      publishConfig: {access: 'public'},
                      version: '30.4.2',
                    }
                  : {
                      dependencies: {'@pkg-nec/jest-core': '30.4.2'},
                      name: '@pkg-nec/jest',
                      publishConfig: {access: 'public'},
                      version: '30.4.2',
                    },
              }),
              inventory,
              makeStagingDirectory: async () => {
                fs.mkdirSync(stagingDirectory);
                return stagingDirectory;
              },
              readSourceCommit: async () => '0123456789abcdef',
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
