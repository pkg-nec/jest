/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const repoRoot = process.cwd();
const auditModuleUrl = pathToFileURL(
  join(repoRoot, 'scripts/pkgNec/audit.mjs'),
).href;

function runAuditRequest(action, options) {
  const identities = [...options.inventory.byOldName.values()];
  const request = {
    action,
    options: {
      ...options,
      inventory: {
        identities,
        packages: options.inventory.packages,
        root: options.inventory.root,
      },
    },
  };
  const program = `
    import * as audit from ${JSON.stringify(auditModuleUrl)};
    const request = ${JSON.stringify(request)};
    const identities = request.options.inventory.identities;
    request.options.inventory = {
      byNewName: new Map(identities.map(item => [item.newName, item])),
      byOldName: new Map(identities.map(item => [item.oldName, item])),
      packages: request.options.inventory.packages,
      root: request.options.inventory.root,
    };
    console.log(JSON.stringify(audit[request.action](request.options)));
  `;
  const child = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', program],
    {cwd: repoRoot, encoding: 'utf8'},
  );
  if (child.status !== 0) throw new Error(child.stderr);
  return JSON.parse(child.stdout);
}

function auditText(options) {
  return runAuditRequest('auditText', options);
}

function auditRepository(options) {
  return runAuditRequest('auditRepository', options);
}

function makeIdentity({manifestPath, newName, oldName, publishable = true}) {
  return {
    directory: manifestPath.replace(/[/\\]package\.json$/, ''),
    manifestPath,
    newName,
    oldName,
    publishable,
    version: '1.0.0',
  };
}

function makeInventory(repoRoot = '/repo') {
  const root = makeIdentity({
    manifestPath: join(repoRoot, 'package.json'),
    newName: '@pkg-nec/monorepo',
    oldName: '@jest/monorepo',
    publishable: false,
  });
  const packages = [
    makeIdentity({
      manifestPath: join(repoRoot, 'packages/jest/package.json'),
      newName: '@pkg-nec/jest',
      oldName: 'jest',
    }),
    makeIdentity({
      manifestPath: join(repoRoot, 'packages/expect/package.json'),
      newName: '@pkg-nec/expect',
      oldName: 'expect',
    }),
    makeIdentity({
      manifestPath: join(repoRoot, 'packages/globals/package.json'),
      newName: '@pkg-nec/jest-globals',
      oldName: '@jest/globals',
    }),
    makeIdentity({
      manifestPath: join(repoRoot, 'packages/environment/package.json'),
      newName: '@pkg-nec/jest-environment',
      oldName: '@jest/environment',
    }),
    makeIdentity({
      manifestPath: join(repoRoot, 'packages/jest-util/package.json'),
      newName: '@pkg-nec/jest-util',
      oldName: 'jest-util',
    }),
    makeIdentity({
      manifestPath: join(
        repoRoot,
        'packages/jest-environment-node/package.json',
      ),
      newName: '@pkg-nec/jest-environment-node',
      oldName: 'jest-environment-node',
    }),
  ];
  const identities = [root, ...packages];

  return {
    byNewName: new Map(
      identities.map(identity => [identity.newName, identity]),
    ),
    byOldName: new Map(
      identities.map(identity => [identity.oldName, identity]),
    ),
    packages,
    root,
  };
}

describe('pkg-nec identity audit', () => {
  const inventory = makeInventory();
  const oldExpect = 'expect';
  const oldGlobals = ['@jest', 'globals'].join('/');
  const oldUtil = ['jest', 'util'].join('-');

  test('reports stale manifest names and internal dependency keys', () => {
    const findings = auditText({
      category: 'manifest',
      filePath: 'packages/globals/package.json',
      inventory,
      text: JSON.stringify({
        dependencies: {[oldUtil]: 'workspace:^'},
        name: oldGlobals,
      }),
    });

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'manifest-identity',
          exceptionId: null,
          expected: '@pkg-nec/jest-globals',
          literal: '@jest/globals',
        }),
        expect.objectContaining({
          category: 'manifest-identity',
          exceptionId: null,
          expected: '@pkg-nec/jest-util',
          literal: 'jest-util',
        }),
      ]),
    );

    expect(
      auditText({
        category: 'manifest',
        filePath: 'packages/globals/package.json',
        inventory,
        text: JSON.stringify({
          name: '@pkg-nec/wrong-globals',
          publishConfig: {access: 'public'},
        }),
      }),
    ).toEqual([
      expect.objectContaining({
        category: 'manifest-identity',
        expected: '@pkg-nec/jest-globals',
        literal: '@pkg-nec/wrong-globals',
      }),
    ]);
  });

  test('reports module specifiers and compiler type identities', () => {
    expect(
      auditText({
        category: 'source',
        filePath: 'src/file.ts',
        inventory,
        text: "import '@jest/globals'",
      }),
    ).toEqual([
      expect.objectContaining({
        category: 'module-specifier',
        expected: '@pkg-nec/jest-globals',
        literal: '@jest/globals',
      }),
    ]);

    expect(
      auditText({
        category: 'jsonc',
        filePath: 'tsconfig.json',
        inventory,
        text: '{"compilerOptions":{"types":["@jest/globals","node"]}}',
      }),
    ).toEqual([
      expect.objectContaining({
        category: 'compiler-type',
        expected: '@pkg-nec/jest-globals',
        literal: '@jest/globals',
      }),
    ]);
  });

  test('reports known build identity comparisons, sets, and dependency checks', () => {
    const findings = auditText({
      category: 'source',
      filePath: 'scripts/buildTs.mjs',
      inventory,
      text: [
        `if (dep === '${oldUtil}') found.push(dep);`,
        `if (pkg.name === '${oldGlobals}') found.push(pkg.name);`,
        `const excludedPackages = new Set(['${oldGlobals}', 'node']);`,
        `Object.keys(pkg.dependencies).includes('${oldUtil}');`,
      ].join('\n'),
    });

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'source-identity',
          expected: '@pkg-nec/jest-globals',
          literal: '@jest/globals',
        }),
        expect.objectContaining({
          category: 'source-identity',
          expected: '@pkg-nec/jest-util',
          literal: 'jest-util',
        }),
      ]),
    );
    expect(findings).toHaveLength(2);
  });

  test('reports old package identities in TypeScript module augmentations', () => {
    expect(
      auditText({
        category: 'source',
        filePath: 'examples/expect-extend/toBeWithinRange.ts',
        inventory,
        text: `declare module '${oldExpect}' {}`,
      }),
    ).toEqual([
      expect.objectContaining({
        category: 'source-identity',
        expected: '@pkg-nec/expect',
        literal: 'expect',
      }),
    ]);
  });

  test('reports mapped scoped identities anywhere in package files', () => {
    expect(
      auditText({
        category: 'source',
        filePath: 'packages/runtime/src/index.ts',
        inventory,
        text: [
          "const globalsName = '@jest/globals';",
          "// import from '@jest/globals'",
        ].join('\n'),
      }),
    ).toEqual([
      expect.objectContaining({
        category: 'source-identity',
        expected: '@pkg-nec/jest-globals',
        literal: '@jest/globals',
      }),
    ]);
    expect(
      auditText({
        category: 'documentation',
        filePath: 'packages/runtime/README.md',
        inventory,
        text: '# @jest/globals',
      }),
    ).toEqual([
      expect.objectContaining({
        category: 'source-identity',
        expected: '@pkg-nec/jest-globals',
        literal: '@jest/globals',
      }),
    ]);
  });

  test.each([
    [
      'docs/GlobalAPI.md',
      "Use `import {test} from '@jest/globals'` for explicit imports.",
      '@pkg-nec/jest-globals',
    ],
    [
      'website/versioned_docs/version-30.4/Configuration.md',
      "import {TestEnvironment} from '@jest/environment';",
      '@pkg-nec/jest-environment',
    ],
  ])(
    'reports mapped scoped identities in documentation %s',
    (filePath, text, expected) => {
      expect(
        auditText({category: 'documentation', filePath, inventory, text}),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            category: 'source-identity',
            expected,
          }),
        ]),
      );
    },
  );

  test('preserves source shorthands, global labels, and directory paths', () => {
    expect(
      auditText({
        category: 'source',
        filePath: 'scripts/example.mjs',
        inventory,
        text: [
          "const cli = 'jest-util';",
          "globalThis.jest = 'jest-util';",
          "path.join('packages', 'jest-util');",
          "const testEnvironment = 'node';",
        ].join('\n'),
      }),
    ).toEqual([]);
  });

  test('reports double prefixes and internal-looking identities without mappings', () => {
    const doublePrefixedIdentity = ['@pkg-nec/jest-', 'jest-util'].join('');
    const unresolvedIdentity = ['@jest', 'not-inventory'].join('/');

    expect(
      auditText({
        category: 'source',
        filePath: 'src/file.ts',
        inventory,
        text: `import '${doublePrefixedIdentity}'`,
      }),
    ).toEqual([
      expect.objectContaining({
        category: 'double-prefix',
        expected: '@pkg-nec/jest-util',
        literal: doublePrefixedIdentity,
      }),
    ]);
    expect(
      auditText({
        category: 'source',
        filePath: 'src/file.ts',
        inventory,
        text: `require('${unresolvedIdentity}')`,
      }),
    ).toEqual([
      expect.objectContaining({
        category: 'unresolved-identity',
        expected: null,
        literal: unresolvedIdentity,
      }),
    ]);
  });

  test('allows reviewed external Jest ecosystem module specifiers', () => {
    const externalSpecifier = ['jest', 'watch-typeahead/filename'].join('-');

    expect(
      auditText({
        category: 'config',
        filePath: 'jest.config.mjs',
        inventory,
        text: `require.resolve('${externalSpecifier}')`,
      }),
    ).toEqual([]);
  });

  test('enforces exact fixture link values and rejects published local links', () => {
    const correctFixture = JSON.stringify({
      devDependencies: {
        '@pkg-nec/jest-util': 'link:../../packages/jest-util',
      },
      name: 'fixture',
      private: true,
    });
    expect(
      auditText({
        category: 'manifest',
        filePath: 'e2e/global-setup/package.json',
        inventory,
        text: correctFixture,
      }),
    ).toEqual([]);
    expect(
      auditText({
        category: 'manifest',
        filePath: 'e2e/global-setup/package.json',
        inventory,
        text: correctFixture.replace('../../packages', '../packages'),
      }),
    ).toEqual([
      expect.objectContaining({
        category: 'fixture-link',
        expected: 'link:../../packages/jest-util',
        literal: 'link:../packages/jest-util',
      }),
    ]);
    expect(
      auditText({
        category: 'manifest',
        filePath: 'packages/globals/package.json',
        inventory,
        text: JSON.stringify({
          dependencies: {
            '@pkg-nec/jest-util': 'link:../jest-util',
          },
          name: '@pkg-nec/jest-globals',
          publishConfig: {access: 'public'},
        }),
      }),
    ).toEqual([
      expect.objectContaining({
        category: 'published-link',
        expected: 'registry or workspace protocol',
        literal: 'link:../jest-util',
      }),
    ]);
  });

  test('rejects duplicate fixture links outside their intended field', () => {
    expect(
      auditText({
        category: 'manifest',
        filePath: 'e2e/global-setup/package.json',
        inventory,
        text: JSON.stringify({
          devDependencies: {
            '@pkg-nec/jest-util': 'link:../../packages/jest-util',
          },
          peerDependencies: {
            '@pkg-nec/jest-util': 'link:../jest-util',
          },
        }),
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'fixture-link',
          expected: 'link:../../packages/jest-util',
        }),
      ]),
    );
  });

  test('allows old identities throughout upstream npm fixture-lock records', () => {
    const npmRecord = [
      '"@jest/types@npm:^29.6.3":',
      '  version: 29.6.3',
      '  resolution: "@jest/types@npm:29.6.3"',
      '  dependencies:',
      `    "${oldGlobals}": "npm:^29.6.3"`,
      `    ${oldUtil}: "npm:^29.7.0"`,
    ].join('\n');

    expect(
      auditText({
        category: 'fixture-lock',
        filePath: 'e2e/global-setup/yarn.lock',
        inventory,
        text: npmRecord,
      }),
    ).toEqual([]);
  });

  test('allows old identities throughout upstream npm root-lock records', () => {
    const npmRecord = [
      `"${oldUtil}@npm:^29.7.0":`,
      '  version: 29.7.0',
      `  resolution: "${oldUtil}@npm:29.7.0"`,
      '  dependencies:',
      `    "${oldGlobals}": "npm:^29.6.3"`,
    ].join('\n');

    expect(
      auditText({
        category: 'lock',
        filePath: 'yarn.lock',
        inventory,
        text: npmRecord,
      }),
    ).toEqual([]);
  });

  test('preserves CLI bin labels while auditing workspace dependencies', () => {
    const workspaceRecord = [
      '"@pkg-nec/jest@workspace:packages/jest":',
      '  version: 0.0.0-use.local',
      '  dependencies:',
      `    ${oldUtil}: "workspace:*"`,
      '  bin:',
      '    jest: ./bin/jest.js',
    ].join('\n');

    expect(
      auditText({
        category: 'lock',
        filePath: 'yarn.lock',
        inventory,
        text: workspaceRecord,
      }),
    ).toEqual([
      expect.objectContaining({
        category: 'lock-identity',
        expected: '@pkg-nec/jest-util',
        literal: 'jest-util',
      }),
    ]);
  });

  test.each(['workspace:.', 'link:../../packages/jest-util'])(
    'audits old identities in local fixture-lock %s records',
    protocol => {
      const localRecord = [
        `"fixture@${protocol}":`,
        '  version: 0.0.0-use.local',
        `  resolution: "fixture@${protocol}"`,
        '  dependencies:',
        `    ${oldUtil}: "npm:*"`,
      ].join('\n');

      expect(
        auditText({
          category: 'fixture-lock',
          filePath: 'e2e/global-setup/yarn.lock',
          inventory,
          text: localRecord,
        }),
      ).toEqual([
        expect.objectContaining({
          category: 'lock-identity',
          expected: '@pkg-nec/jest-util',
          literal: 'jest-util',
        }),
      ]);
    },
  );

  test('preserves shorthands, paths, CLI labels, and exact reviewed exceptions', () => {
    const mapperKey = `^${oldGlobals}$`;
    const compilerBridge = JSON.stringify({
      compilerOptions: {paths: {[oldGlobals]: ['./packages/jest-globals']}},
    });

    expect(
      auditText({
        category: 'jsonc',
        filePath: 'tsconfig.test.json',
        inventory,
        text: compilerBridge,
      }),
    ).toEqual([]);
    expect(
      auditText({
        category: 'jsonc',
        filePath: 'tsconfig.other.json',
        inventory,
        text: compilerBridge,
      }),
    ).toEqual([
      expect.objectContaining({
        category: 'compiler-path',
        expected: '@pkg-nec/jest-globals',
        literal: '@jest/globals',
      }),
    ]);

    expect(
      auditText({
        category: 'config',
        filePath: 'jest.config.js',
        inventory,
        text: "testEnvironment: 'node'",
      }),
    ).toEqual([]);
    expect(
      auditText({
        category: 'text',
        filePath: 'fixture.txt',
        inventory,
        text: [
          'run: "yarn jest"',
          'directory: "packages/jest-util"',
          'moduleNameMapper: {"^jest$": "<rootDir>/test.js"}',
        ].join('\n'),
      }),
    ).toEqual([]);
    expect(
      auditText({
        category: 'source',
        filePath: 'e2e/fixture/ignored/symlink.jsx',
        inventory,
        text: '../package/index.js',
      }),
    ).toEqual([]);
    expect(
      auditText({
        category: 'source',
        filePath: 'examples/angular/app.component.ts',
        inventory,
        text: '@Component({})\nclass App {}',
      }),
    ).toEqual([]);

    expect(
      auditText({
        category: 'source',
        filePath:
          'packages/jest-runtime/src/__tests__/test_root/MappedGlobals.js',
        inventory,
        text: "module.exports = require('@jest/globals');",
      }),
    ).toEqual([
      expect.objectContaining({
        expected: '@pkg-nec/jest-globals',
        literal: '@jest/globals',
      }),
    ]);
    expect(
      auditText({
        category: 'source',
        filePath: 'jest.config.mjs',
        inventory,
        text: `const mapper = {'${mapperKey}': '<rootDir>/bridge.js'};`,
      }),
    ).toEqual([]);
    expect(
      auditText({
        category: 'source',
        filePath: 'src/not-jest-config.js',
        inventory,
        text: `const mapper = {'${mapperKey}': '<rootDir>/bridge.js'};`,
      }),
    ).toEqual([
      expect.objectContaining({
        category: 'mapper-key',
        expected: '^@pkg-nec/jest-globals$',
        literal: '^@jest/globals$',
      }),
    ]);
  });

  test.each([
    'CHANGELOG.md',
    'CHANGELOG_PRE_v30.md',
    'docs/pkg-nec-rebrand-technical-guide.md',
    'docs/superpowers/plans/2026-08-12-pkg-nec-package-rebrand.md',
    'docs/superpowers/specs/2026-08-12-pkg-nec-package-rebrand-design.md',
    'scripts/pkgNec/upstreamManifestBaseline.json',
  ])('allows historical package identities only in %s', filePath => {
    expect(
      auditText({
        category: filePath.endsWith('.json') ? 'json' : 'documentation',
        filePath,
        inventory,
        text: 'npm install @jest/globals',
      }),
    ).toEqual([]);
  });

  test('reports an unexpected old identity in an eligible text context', () => {
    expect(
      auditText({
        category: 'documentation',
        filePath: 'README.md',
        inventory,
        text: 'npm install @jest/globals',
      }),
    ).toEqual([
      expect.objectContaining({
        category: 'package-literal',
        expected: '@pkg-nec/jest-globals',
        literal: '@jest/globals',
      }),
    ]);
  });

  test('preserves documentation CLI commands, bin names, and directory paths', () => {
    const protectedDocumentation = [
      'Run `yarn jest scripts/test.js --runInBand`.',
      'Invoke the `jest` CLI with `jest --showConfig`.',
      'Build files live in `packages/jest-util`.',
      'Use `expect` as the injected global.',
    ].join('\n');

    expect(
      auditText({
        category: 'documentation',
        filePath: 'docs/CLI.md',
        inventory,
        text: protectedDocumentation,
      }),
    ).toEqual([]);
  });

  test('still reports documentation install and import package identities', () => {
    expect(
      auditText({
        category: 'documentation',
        filePath: 'docs/GettingStarted.md',
        inventory,
        text: [
          'npm install jest-util',
          "import {expect} from '@jest/globals';",
        ].join('\n'),
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({literal: '@jest/globals'}),
        expect.objectContaining({literal: 'jest-util'}),
      ]),
    );
  });

  test('allows arbitrary current versions and third-party ranges', async () => {
    const temporaryRepo = await mkdtemp(join(tmpdir(), 'pkg-nec-audit-'));
    const manifestPath = join(temporaryRepo, 'package.json');
    await mkdir(join(temporaryRepo, 'packages'), {recursive: true});
    await writeFile(
      manifestPath,
      `${JSON.stringify({
        dependencies: {
          '@pkg-nec/jest-globals': 'workspace:*',
          '@pkg-nec/jest-util': 'workspace:^',
          'unexpected-third-party': '^1.0.0',
        },
        name: '@pkg-nec/monorepo',
        private: true,
        version: '31.0.0',
      })}\n`,
    );
    const repositoryInventory = makeInventory(temporaryRepo);
    repositoryInventory.packages = [];
    try {
      expect(
        auditRepository({
          inventory: repositoryInventory,
          repoRoot: temporaryRepo,
        }),
      ).toEqual([]);
    } finally {
      await rm(temporaryRepo, {force: true, recursive: true});
    }
  });

  test('rejects an unresolved internal workspace dependency', () => {
    const text = JSON.stringify({
      dependencies: {'@pkg-nec/missing': 'workspace:*'},
      name: '@pkg-nec/example',
      publishConfig: {access: 'public'},
      version: '31.0.0',
    });
    expect(
      auditText({
        category: 'manifest',
        filePath: 'packages/example/package.json',
        inventory,
        text,
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({category: 'unresolved-internal-dependency'}),
      ]),
    );
  });

  test('requires public access for known publishable manifests', () => {
    expect(
      auditText({
        category: 'manifest',
        filePath: 'packages/globals/package.json',
        inventory,
        text: JSON.stringify({
          name: '@pkg-nec/jest-globals',
          publishConfig: {access: 'restricted'},
          version: '31.0.0',
        }),
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'publish-access',
          expected: 'public',
          literal: 'restricted',
        }),
      ]),
    );
  });

  test('allows only helper manifests to adopt public privacy metadata', async () => {
    const temporaryRepo = await mkdtemp(join(tmpdir(), 'pkg-nec-audit-'));
    const rootManifestPath = join(temporaryRepo, 'package.json');
    const helperManifestPath = join(
      temporaryRepo,
      'packages/test-utils/package.json',
    );
    await mkdir(join(temporaryRepo, 'packages/test-utils'), {recursive: true});
    await writeFile(
      rootManifestPath,
      `${JSON.stringify({
        name: '@pkg-nec/monorepo',
        private: true,
        version: '1.0.0',
      })}\n`,
    );
    await writeFile(
      helperManifestPath,
      `${JSON.stringify({
        name: '@pkg-nec/jest-test-utils',
        publishConfig: {access: 'public'},
        version: '1.0.0',
      })}\n`,
    );
    const root = makeIdentity({
      manifestPath: rootManifestPath,
      newName: '@pkg-nec/monorepo',
      oldName: '@jest/monorepo',
      publishable: false,
    });
    const helper = makeIdentity({
      manifestPath: helperManifestPath,
      newName: '@pkg-nec/jest-test-utils',
      oldName: '@jest/test-utils',
    });
    const repositoryInventory = {
      byNewName: new Map([
        [root.newName, root],
        [helper.newName, helper],
      ]),
      byOldName: new Map([
        [root.oldName, root],
        [helper.oldName, helper],
      ]),
      packages: [helper],
      root,
    };
    try {
      expect(
        auditRepository({
          inventory: repositoryInventory,
          repoRoot: temporaryRepo,
        }),
      ).toEqual([]);
    } finally {
      await rm(temporaryRepo, {force: true, recursive: true});
    }
  });

  test('normalizes absent public privacy and rejects transition to private', async () => {
    const temporaryRepo = await mkdtemp(join(tmpdir(), 'pkg-nec-audit-'));
    const rootManifestPath = join(temporaryRepo, 'package.json');
    const packageManifestPath = join(
      temporaryRepo,
      'packages/globals/package.json',
    );
    await mkdir(join(temporaryRepo, 'packages/globals'), {recursive: true});
    await writeFile(
      rootManifestPath,
      `${JSON.stringify({
        name: '@pkg-nec/monorepo',
        private: true,
        version: '1.0.0',
      })}\n`,
    );
    const publicManifest = {
      name: '@pkg-nec/jest-globals',
      publishConfig: {access: 'public'},
      version: '1.0.0',
    };
    await writeFile(packageManifestPath, `${JSON.stringify(publicManifest)}\n`);
    const root = makeIdentity({
      manifestPath: rootManifestPath,
      newName: '@pkg-nec/monorepo',
      oldName: '@jest/monorepo',
      publishable: false,
    });
    const packageIdentity = makeIdentity({
      manifestPath: packageManifestPath,
      newName: '@pkg-nec/jest-globals',
      oldName: '@jest/globals',
    });
    const repositoryInventory = {
      byNewName: new Map([
        [root.newName, root],
        [packageIdentity.newName, packageIdentity],
      ]),
      byOldName: new Map([
        [root.oldName, root],
        [packageIdentity.oldName, packageIdentity],
      ]),
      packages: [packageIdentity],
      root,
    };
    try {
      expect(
        auditRepository({
          inventory: repositoryInventory,
          repoRoot: temporaryRepo,
        }),
      ).toEqual([]);

      await writeFile(
        packageManifestPath,
        `${JSON.stringify({...publicManifest, private: true})}\n`,
      );
      expect(
        auditRepository({
          inventory: repositoryInventory,
          repoRoot: temporaryRepo,
        }),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            category: 'publishability',
            expected: false,
            literal: true,
          }),
        ]),
      );
    } finally {
      await rm(temporaryRepo, {force: true, recursive: true});
    }
  });

  test('ignores generated upstream parity evidence but audits the same stale identity in source', async () => {
    const temporaryRepo = await mkdtemp(join(tmpdir(), 'pkg-nec-audit-'));
    const generatedDirectory = join(temporaryRepo, '.pkg-nec-release');
    const sourceDirectory = join(temporaryRepo, 'src');
    const manifestPath = join(temporaryRepo, 'package.json');
    const sourcePath = join(sourceDirectory, 'file.ts');
    const manifest = `${JSON.stringify({
      name: '@pkg-nec/monorepo',
      private: true,
      version: '1.0.0',
    })}\n`;
    const temporaryInventory = makeInventory(temporaryRepo);
    temporaryInventory.packages = [];
    temporaryInventory.byOldName = new Map([
      [temporaryInventory.root.oldName, temporaryInventory.root],
      ['@jest/globals', inventory.byOldName.get('@jest/globals')],
    ]);
    temporaryInventory.byNewName = new Map(
      [...temporaryInventory.byOldName.values()].map(identity => [
        identity.newName,
        identity,
      ]),
    );
    try {
      await mkdir(generatedDirectory, {recursive: true});
      await mkdir(sourceDirectory, {recursive: true});
      await writeFile(manifestPath, manifest);
      await writeFile(
        join(generatedDirectory, 'upstream-parity.md'),
        `| ${oldGlobals} | upstream |\n`,
      );
      await writeFile(sourcePath, `import '${oldGlobals}';\n`);

      expect(
        auditRepository({
          inventory: temporaryInventory,
          repoRoot: temporaryRepo,
        }),
      ).toEqual([
        expect.objectContaining({
          filePath: 'src/file.ts',
          literal: oldGlobals,
        }),
      ]);

      await rm(sourcePath);

      expect(
        auditRepository({
          inventory: temporaryInventory,
          repoRoot: temporaryRepo,
        }),
      ).toEqual([]);
    } finally {
      await rm(temporaryRepo, {force: true, recursive: true});
    }
  });

  test('excludes vendored Yarn release files', async () => {
    const temporaryRepo = await mkdtemp(join(tmpdir(), 'pkg-nec-audit-'));
    const manifestPath = join(temporaryRepo, 'package.json');
    const releasePath = join(temporaryRepo, '.yarn/releases/yarn.cjs');
    const temporaryInventory = makeInventory(temporaryRepo);
    temporaryInventory.packages = [];

    try {
      await mkdir(join(temporaryRepo, '.yarn/releases'), {recursive: true});
      await writeFile(
        manifestPath,
        `${JSON.stringify({
          name: '@pkg-nec/monorepo',
          private: true,
          version: '31.0.0',
        })}\n`,
      );
      await writeFile(releasePath, `require('${oldGlobals}');\n`);

      expect(
        auditRepository({
          inventory: temporaryInventory,
          repoRoot: temporaryRepo,
        }),
      ).toEqual([]);
    } finally {
      await rm(temporaryRepo, {force: true, recursive: true});
    }
  });

  test('audits a repository repeatably without modifying it', async () => {
    const temporaryRepo = await mkdtemp(join(tmpdir(), 'pkg-nec-audit-'));
    const manifestPath = join(temporaryRepo, 'package.json');
    const sourcePath = join(temporaryRepo, 'index.js');
    const manifest = `${JSON.stringify({
      name: '@pkg-nec/monorepo',
      peerDependenciesMeta: {
        '@pkg-nec/jest-globals': {optional: true},
      },
      private: true,
      version: '1.0.0',
    })}\n`;
    const source = "import '@jest/globals';\n";
    await mkdir(join(temporaryRepo, 'packages'), {recursive: true});
    await writeFile(manifestPath, manifest);
    await writeFile(sourcePath, source);
    const repositoryInventory = makeInventory(temporaryRepo);
    repositoryInventory.packages = [];
    repositoryInventory.byOldName = new Map([
      [repositoryInventory.root.oldName, repositoryInventory.root],
      ['@jest/globals', inventory.byOldName.get('@jest/globals')],
    ]);
    repositoryInventory.byNewName = new Map(
      [...repositoryInventory.byOldName.values()].map(identity => [
        identity.newName,
        identity,
      ]),
    );
    try {
      const first = auditRepository({
        inventory: repositoryInventory,
        repoRoot: temporaryRepo,
      });
      const second = auditRepository({
        inventory: repositoryInventory,
        repoRoot: temporaryRepo,
      });

      expect(first).toEqual(second);
      expect(first).toEqual([
        expect.objectContaining({
          category: 'module-specifier',
          filePath: 'index.js',
          literal: '@jest/globals',
        }),
      ]);
      expect(await readFile(manifestPath, 'utf8')).toBe(manifest);
      expect(await readFile(sourcePath, 'utf8')).toBe(source);
    } finally {
      await rm(temporaryRepo, {force: true, recursive: true});
    }
  });
});
