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

test('detects cycles in the selected induced publish graph', () => {
  const inventory = createInventory([
    {
      manifest: {dependencies: {'@pkg-nec/b': 'workspace:*'}},
      name: '@pkg-nec/a',
    },
    {
      manifest: {dependencies: {'@pkg-nec/a': 'workspace:*'}},
      name: '@pkg-nec/b',
    },
  ]);

  expect(
    runGraph(
      inventory,
      `
        const graph = buildWorkspaceReleaseGraph(inventory);
        selectedReleaseOrder({
          graph,
          selectedNames: ['@pkg-nec/a', '@pkg-nec/b'],
        });
      `,
    ).error,
  ).toMatch(/workspace cycle.*@pkg-nec\/a, @pkg-nec\/b/iu);
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
