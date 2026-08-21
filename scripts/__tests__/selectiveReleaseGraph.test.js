/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

const {spawnSync} = require('node:child_process');
const fs = require('graceful-fs');
const os = require('node:os');
const path = require('node:path');
const {pathToFileURL} = require('node:url');

const repoRoot = process.cwd();
const moduleUrl = pathToFileURL(
  path.join(repoRoot, 'scripts/pkgNec/selectiveReleaseGraph.mjs'),
).href;
const identityModuleUrl = pathToFileURL(
  path.join(repoRoot, 'scripts/pkgNecPackageIdentity.mjs'),
).href;
const identityPolicyPath = path.join(
  repoRoot,
  'scripts/pkgNec/packageIdentityPolicy.json',
);
const temporaryDirectories = [];

function packageDirectory(name) {
  return name.slice('@pkg-nec/'.length);
}

function createInventory(definitions) {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'pkg-nec-selective-graph-'),
  );
  temporaryDirectories.push(fixtureRoot);
  const packages = definitions.map(definition => {
    const directory = path.join(
      fixtureRoot,
      'packages',
      packageDirectory(definition.name),
    );
    const manifestPath = path.join(directory, 'package.json');
    fs.mkdirSync(directory, {recursive: true});
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        name: definition.oldName ?? definition.name,
        version: '1.2.3',
        ...definition.manifest,
      }),
    );
    return {
      directory,
      manifestPath,
      newName: definition.name,
      oldName: definition.oldName ?? definition.name,
      publishable: definition.publishable !== false,
      version: '1.2.3',
    };
  });
  return {packages};
}

function runGraph(inventory, body) {
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
      import {
        buildWorkspaceReleaseGraph,
        selectDependentClosure,
        selectedReleaseOrder,
      } from ${JSON.stringify(moduleUrl)};

      const inventory = ${JSON.stringify(inventory)};
      inventory.byNewName = new Map(
        inventory.packages.map(item => [item.newName, item]),
      );
      inventory.byOldName = new Map(
        inventory.packages.map(item => [item.oldName, item]),
      );
      try {
        ${body}
      } catch (error) {
        console.log(JSON.stringify({error: error.message}));
      }
    `,
    ],
    {cwd: repoRoot, encoding: 'utf8'},
  );
  if (child.status !== 0) throw new Error(child.stderr || child.stdout);
  return JSON.parse(child.stdout.trim());
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, {force: true, recursive: true});
  }
});

test.each([
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'devDependencies',
])(
  'propagates public dependents through workspace entries in %s',
  dependencyField => {
    const inventory = createInventory([
      {name: '@pkg-nec/a'},
      {
        manifest: {
          [dependencyField]: {'@pkg-nec/a': 'workspace:*'},
        },
        name: '@pkg-nec/b',
      },
      {
        manifest: {dependencies: {'@pkg-nec/b': 'workspace:^'}},
        name: '@pkg-nec/c',
      },
    ]);

    expect(
      runGraph(
        inventory,
        `
          const graph = buildWorkspaceReleaseGraph(inventory);
          const closure = selectDependentClosure({
            directNames: ['@pkg-nec/a'],
            graph,
          });
          console.log(JSON.stringify({
            dependentPaths: [...closure.dependentPaths],
            order: selectedReleaseOrder({
              graph,
              selectedNames: closure.selectedNames,
            }),
            selectedNames: closure.selectedNames,
          }));
        `,
      ),
    ).toEqual({
      dependentPaths: [
        ['@pkg-nec/b', [['@pkg-nec/a', '@pkg-nec/b']]],
        ['@pkg-nec/c', [['@pkg-nec/a', '@pkg-nec/b', '@pkg-nec/c']]],
      ],
      order: ['@pkg-nec/a', '@pkg-nec/b', '@pkg-nec/c'],
      selectedNames: ['@pkg-nec/a', '@pkg-nec/b', '@pkg-nec/c'],
    });
  },
);

test('keeps all distinct shortest explanation paths in lexical order', () => {
  const inventory = createInventory([
    {name: '@pkg-nec/a'},
    {name: '@pkg-nec/z'},
    {
      manifest: {
        dependencies: {
          '@pkg-nec/a': 'workspace:*',
          '@pkg-nec/z': 'workspace:*',
        },
      },
      name: '@pkg-nec/b',
    },
    {
      manifest: {dependencies: {'@pkg-nec/b': 'workspace:*'}},
      name: '@pkg-nec/c',
    },
  ]);

  expect(
    runGraph(
      inventory,
      `
        const graph = buildWorkspaceReleaseGraph(inventory);
        const closure = selectDependentClosure({
          directNames: ['@pkg-nec/z', '@pkg-nec/a'],
          graph,
        });
        console.log(JSON.stringify({
          dependentPaths: [...closure.dependentPaths],
          selectedNames: closure.selectedNames,
        }));
      `,
    ),
  ).toEqual({
    dependentPaths: [
      [
        '@pkg-nec/b',
        [
          ['@pkg-nec/a', '@pkg-nec/b'],
          ['@pkg-nec/z', '@pkg-nec/b'],
        ],
      ],
      [
        '@pkg-nec/c',
        [
          ['@pkg-nec/a', '@pkg-nec/b', '@pkg-nec/c'],
          ['@pkg-nec/z', '@pkg-nec/b', '@pkg-nec/c'],
        ],
      ],
    ],
    selectedNames: ['@pkg-nec/a', '@pkg-nec/b', '@pkg-nec/c', '@pkg-nec/z'],
  });
});

test('excludes private consumers from the publish closure', () => {
  const inventory = createInventory([
    {name: '@pkg-nec/a'},
    {
      manifest: {dependencies: {'@pkg-nec/a': 'workspace:*'}},
      name: '@pkg-nec/private-b',
      publishable: false,
    },
    {
      manifest: {dependencies: {'@pkg-nec/a': 'workspace:*'}},
      name: '@pkg-nec/c',
    },
  ]);

  expect(
    runGraph(
      inventory,
      `
        const graph = buildWorkspaceReleaseGraph(inventory);
        const closure = selectDependentClosure({
          directNames: ['@pkg-nec/a'],
          graph,
        });
        console.log(JSON.stringify({
          graphNames: [...graph.keys()],
          selectedNames: closure.selectedNames,
        }));
      `,
    ),
  ).toEqual({
    graphNames: ['@pkg-nec/a', '@pkg-nec/c'],
    selectedNames: ['@pkg-nec/a', '@pkg-nec/c'],
  });
});

test('ignores non-workspace values but rejects unknown workspace targets', () => {
  const ignoredInventory = createInventory([
    {name: '@pkg-nec/a'},
    {
      manifest: {dependencies: {'@pkg-nec/a': '^1.2.3'}},
      name: '@pkg-nec/b',
    },
  ]);
  expect(
    runGraph(
      ignoredInventory,
      `
        const graph = buildWorkspaceReleaseGraph(inventory);
        console.log(JSON.stringify([...graph].map(([name, dependencies]) => [
          name,
          [...dependencies],
        ])));
      `,
    ),
  ).toEqual([
    ['@pkg-nec/a', []],
    ['@pkg-nec/b', []],
  ]);

  const invalidInventory = createInventory([
    {
      manifest: {
        dependencies: {'@pkg-nec/missing': 'workspace:*'},
      },
      name: '@pkg-nec/a',
    },
  ]);
  expect(
    runGraph(invalidInventory, 'buildWorkspaceReleaseGraph(inventory);').error,
  ).toMatch(/unknown workspace target @pkg-nec\/missing.*@pkg-nec\/a/iu);
});

test('selecting one cycle member includes and orders its complete dependent closure', () => {
  const inventory = createInventory([
    {
      manifest: {dependencies: {'@pkg-nec/b': 'workspace:*'}},
      name: '@pkg-nec/a',
    },
    {
      manifest: {dependencies: {'@pkg-nec/a': 'workspace:*'}},
      name: '@pkg-nec/b',
    },
    {
      manifest: {dependencies: {'@pkg-nec/b': 'workspace:*'}},
      name: '@pkg-nec/c',
    },
  ]);

  expect(
    runGraph(
      inventory,
      `
        const graph = buildWorkspaceReleaseGraph(inventory);
        const closure = selectDependentClosure({
          directNames: ['@pkg-nec/a'],
          graph,
        });
        console.log(JSON.stringify({
          dependentPaths: [...closure.dependentPaths],
          order: selectedReleaseOrder({
            graph,
            selectedNames: closure.selectedNames,
          }),
          selectedNames: closure.selectedNames,
        }));
      `,
    ),
  ).toEqual({
    dependentPaths: [
      ['@pkg-nec/b', [['@pkg-nec/a', '@pkg-nec/b']]],
      ['@pkg-nec/c', [['@pkg-nec/a', '@pkg-nec/b', '@pkg-nec/c']]],
    ],
    order: ['@pkg-nec/a', '@pkg-nec/b', '@pkg-nec/c'],
    selectedNames: ['@pkg-nec/a', '@pkg-nec/b', '@pkg-nec/c'],
  });
});

test('orders cyclic components deterministically across inventory permutations', () => {
  const definitions = [
    {
      manifest: {
        devDependencies: {
          '@pkg-nec/b': 'workspace:*',
          '@pkg-nec/root': 'workspace:*',
        },
      },
      name: '@pkg-nec/a',
    },
    {
      manifest: {devDependencies: {'@pkg-nec/c': 'workspace:*'}},
      name: '@pkg-nec/b',
    },
    {
      manifest: {devDependencies: {'@pkg-nec/d': 'workspace:*'}},
      name: '@pkg-nec/c',
    },
    {
      manifest: {devDependencies: {'@pkg-nec/a': 'workspace:*'}},
      name: '@pkg-nec/d',
    },
    {
      manifest: {
        dependencies: {'@pkg-nec/d': 'workspace:*'},
        devDependencies: {'@pkg-nec/n': 'workspace:*'},
      },
      name: '@pkg-nec/m',
    },
    {
      manifest: {devDependencies: {'@pkg-nec/m': 'workspace:*'}},
      name: '@pkg-nec/n',
    },
    {name: '@pkg-nec/root'},
    {
      manifest: {devDependencies: {'@pkg-nec/self': 'workspace:*'}},
      name: '@pkg-nec/self',
    },
    {
      manifest: {dependencies: {'@pkg-nec/n': 'workspace:*'}},
      name: '@pkg-nec/z',
    },
  ];
  const expected = [
    '@pkg-nec/root',
    '@pkg-nec/a',
    '@pkg-nec/b',
    '@pkg-nec/c',
    '@pkg-nec/d',
    '@pkg-nec/m',
    '@pkg-nec/n',
    '@pkg-nec/self',
    '@pkg-nec/z',
  ];

  for (const inventory of [
    createInventory(definitions),
    createInventory([...definitions].reverse()),
  ]) {
    const result = runGraph(
      inventory,
      `
        const graph = buildWorkspaceReleaseGraph(inventory);
        const selectedNames = [...graph.keys()].reverse();
        const order = selectedReleaseOrder({graph, selectedNames});
        console.log(JSON.stringify({order, uniqueCount: new Set(order).size}));
      `,
    );
    expect(result).toEqual({order: expected, uniqueCount: expected.length});
  }
});

test('orders the production four-field graph for all 55 public packages', () => {
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
        import fs from 'graceful-fs';
        import {createPackageInventory} from ${JSON.stringify(identityModuleUrl)};
        import {
          buildWorkspaceReleaseGraph,
          selectedReleaseOrder,
        } from ${JSON.stringify(moduleUrl)};

        const policy = JSON.parse(
          fs.readFileSync(${JSON.stringify(identityPolicyPath)}, 'utf8'),
        );
        const inventory = createPackageInventory({
          policy,
          repoRoot: ${JSON.stringify(repoRoot)},
        });
        const graph = buildWorkspaceReleaseGraph(inventory);
        const order = selectedReleaseOrder({
          graph,
          selectedNames: [...graph.keys()].reverse(),
        });
        console.log(JSON.stringify({order, uniqueCount: new Set(order).size}));
      `,
    ],
    {cwd: repoRoot, encoding: 'utf8'},
  );
  if (child.status !== 0) throw new Error(child.stderr || child.stdout);
  const result = JSON.parse(child.stdout.trim());
  const knownCyclicComponent = [
    '@pkg-nec/expect',
    '@pkg-nec/jest-diff',
    '@pkg-nec/jest-environment',
    '@pkg-nec/jest-expect',
    '@pkg-nec/jest-expect-utils',
    '@pkg-nec/jest-fake-timers',
    '@pkg-nec/jest-globals',
    '@pkg-nec/jest-matcher-utils',
    '@pkg-nec/jest-snapshot',
    '@pkg-nec/jest-test-utils',
    '@pkg-nec/jest-transform',
  ];
  const componentStart = result.order.indexOf(knownCyclicComponent[0]);

  expect(result.order).toHaveLength(55);
  expect(result.uniqueCount).toBe(55);
  expect(
    result.order.slice(
      componentStart,
      componentStart + knownCyclicComponent.length,
    ),
  ).toEqual(knownCyclicComponent);
});

test('does not pull unselected dependencies into the induced publish graph', () => {
  const inventory = createInventory([
    {name: '@pkg-nec/internal'},
    {
      manifest: {
        dependencies: {
          '@pkg-nec/internal': 'workspace:*',
          external: '^4.0.0',
        },
      },
      name: '@pkg-nec/consumer',
    },
  ]);

  expect(
    runGraph(
      inventory,
      `
        const graph = buildWorkspaceReleaseGraph(inventory);
        const closure = selectDependentClosure({
          directNames: ['@pkg-nec/consumer'],
          graph,
        });
        console.log(JSON.stringify({
          order: selectedReleaseOrder({
            graph,
            selectedNames: closure.selectedNames,
          }),
          selectedNames: closure.selectedNames,
        }));
      `,
    ),
  ).toEqual({
    order: ['@pkg-nec/consumer'],
    selectedNames: ['@pkg-nec/consumer'],
  });
});
