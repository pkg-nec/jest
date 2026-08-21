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
const plannerModuleUrl = pathToFileURL(
  path.join(repoRoot, 'scripts/pkgNec/selectiveReleasePlanner.mjs'),
).href;
const validationModuleUrl = pathToFileURL(
  path.join(repoRoot, 'scripts/pkgNec/releaseValidation.mjs'),
).href;
const previousCommit = '1111111111111111111111111111111111111111';
const preparedFrom = '2222222222222222222222222222222222222222';
const temporaryDirectories = [];

function packageDirectory(name) {
  return name.slice('@pkg-nec/'.length);
}

function createInventories(definitions) {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'pkg-nec-selective-planner-'),
  );
  temporaryDirectories.push(fixtureRoot);
  const currentPackages = definitions.map(definition => {
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
        name: definition.name,
        version: definition.currentVersion ?? '1.2.3',
        ...definition.manifest,
      }),
    );
    return {
      directory,
      manifestPath,
      newName: definition.name,
      oldName: definition.name,
      publishable: definition.publishable !== false,
      version: definition.currentVersion ?? '1.2.3',
    };
  });
  const baselinePackages = currentPackages.map((identity, index) => ({
    ...identity,
    version: definitions[index].baselineVersion ?? '1.2.3',
  }));
  return {
    baselineInventory: {
      packages: baselinePackages,
      root: {directory: fixtureRoot},
    },
    currentInventory: {
      packages: currentPackages,
      root: {directory: fixtureRoot},
    },
  };
}

function classification({
  allPackages = [],
  ambiguous = [],
  packages = [],
} = {}) {
  return {
    packageChanges: packages,
    root: {allPackages, ambiguous, noImpact: []},
  };
}

function runPlanner({
  bumpOverrideValues = [],
  changes = classification(),
  commits = ['change'],
  definitions,
  rootImpactRequest = null,
}) {
  const inventories = createInventories(definitions);
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
      import {createSelectiveReleasePlan} from ${JSON.stringify(plannerModuleUrl)};

      function reviveInventory(value) {
        return {
          ...value,
          byNewName: new Map(value.packages.map(item => [item.newName, item])),
          byOldName: new Map(value.packages.map(item => [item.oldName, item])),
        };
      }

      const changes = ${JSON.stringify(changes)};
      changes.packageChanges = new Map(changes.packageChanges);
      try {
        const result = createSelectiveReleasePlan({
          baselineInventory: reviveInventory(${JSON.stringify(inventories.baselineInventory)}),
          bumpOverrideValues: ${JSON.stringify(bumpOverrideValues)},
          changes,
          commits: ${JSON.stringify(commits)},
          currentInventory: reviveInventory(${JSON.stringify(inventories.currentInventory)}),
          preparedFrom: ${JSON.stringify(preparedFrom)},
          previousRelease: {
            commit: ${JSON.stringify(previousCommit)},
            tag: '@pkg-nec/jest-v1.2.3',
          },
          rootImpactRequest: ${JSON.stringify(rootImpactRequest)},
        });
        console.log(JSON.stringify(result));
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

function decisionPackages() {
  return [{name: '@pkg-nec/create-jest'}, {name: '@pkg-nec/jest-phabricator'}];
}

function summarizeDecision(result) {
  if (result.kind !== 'release') return result;
  return {
    applied: result.plan.rootImpact.applied,
    kind: result.kind,
    reasons: result.plan.packages.map(item => [item.name, item.reasons]),
    requested: result.plan.rootImpact.requested,
    selected: result.plan.packages.map(item => item.name),
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, {force: true, recursive: true});
  }
});

test('parses repeatable bump overrides into a deterministic map', () => {
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
      import {parseBumpOverrides} from ${JSON.stringify(plannerModuleUrl)};
      const results = [];
      for (const values of [
        ['@pkg-nec/z=major', '@pkg-nec/a=patch'],
        ['@pkg-nec/a=minor', '@pkg-nec/a=major'],
        ['@pkg-nec/a=prerelease'],
      ]) {
        try {
          results.push([...parseBumpOverrides(values)]);
        } catch (error) {
          results.push({error: error.message});
        }
      }
      console.log(JSON.stringify(results));
    `,
    ],
    {cwd: repoRoot, encoding: 'utf8'},
  );
  if (child.status !== 0) throw new Error(child.stderr || child.stdout);

  expect(JSON.parse(child.stdout.trim())).toEqual([
    [
      ['@pkg-nec/a', 'patch'],
      ['@pkg-nec/z', 'major'],
    ],
    {error: 'Duplicate bump override: @pkg-nec/a'},
    {error: 'Invalid bump override: @pkg-nec/a=prerelease'},
  ]);
});

test.each([
  [
    'no commits even with a flag',
    {commits: [], rootImpactRequest: 'all'},
    {kind: 'no-changes', message: 'no releasable package changes'},
  ],
  [
    'package changes only with an unnecessary flag',
    {
      changes: classification({
        packages: [
          ['@pkg-nec/create-jest', ['packages/create-jest/src/index.ts']],
        ],
      }),
      rootImpactRequest: 'all',
    },
    {
      applied: 'not-needed',
      kind: 'release',
      reasons: [
        [
          '@pkg-nec/create-jest',
          [
            {
              files: ['packages/create-jest/src/index.ts'],
              kind: 'changed',
            },
          ],
        ],
      ],
      requested: 'all',
      selected: ['@pkg-nec/create-jest'],
    },
  ],
  [
    'known no-impact roots only',
    {},
    {kind: 'no-changes', message: 'no releasable package changes'},
  ],
  [
    'ambiguous roots without a decision',
    {changes: classification({ambiguous: ['yarn.lock']})},
    {files: ['yarn.lock'], kind: 'ambiguous-root'},
  ],
  [
    'ambiguous roots resolved to none',
    {
      changes: classification({ambiguous: ['yarn.lock']}),
      rootImpactRequest: 'none',
    },
    {kind: 'no-changes', message: 'no releasable package changes'},
  ],
  [
    'ambiguous roots resolved to all',
    {
      changes: classification({ambiguous: ['yarn.lock']}),
      rootImpactRequest: 'all',
    },
    {
      applied: 'all',
      kind: 'release',
      reasons: [
        [
          '@pkg-nec/create-jest',
          [
            {
              classification: 'ambiguous-all',
              files: ['yarn.lock'],
              kind: 'root-impact',
            },
          ],
        ],
        [
          '@pkg-nec/jest-phabricator',
          [
            {
              classification: 'ambiguous-all',
              files: ['yarn.lock'],
              kind: 'root-impact',
            },
          ],
        ],
      ],
      requested: 'all',
      selected: ['@pkg-nec/create-jest', '@pkg-nec/jest-phabricator'],
    },
  ],
  [
    'package and ambiguous roots resolved to none',
    {
      changes: classification({
        ambiguous: ['yarn.lock'],
        packages: [
          ['@pkg-nec/create-jest', ['packages/create-jest/src/index.ts']],
        ],
      }),
      rootImpactRequest: 'none',
    },
    {
      applied: 'none',
      kind: 'release',
      reasons: [
        [
          '@pkg-nec/create-jest',
          [
            {
              files: ['packages/create-jest/src/index.ts'],
              kind: 'changed',
            },
          ],
        ],
      ],
      requested: 'none',
      selected: ['@pkg-nec/create-jest'],
    },
  ],
  [
    'package and ambiguous roots resolved to all',
    {
      changes: classification({
        ambiguous: ['yarn.lock'],
        packages: [
          ['@pkg-nec/create-jest', ['packages/create-jest/src/index.ts']],
        ],
      }),
      rootImpactRequest: 'all',
    },
    {
      applied: 'all',
      kind: 'release',
      reasons: [
        [
          '@pkg-nec/create-jest',
          [
            {
              files: ['packages/create-jest/src/index.ts'],
              kind: 'changed',
            },
            {
              classification: 'ambiguous-all',
              files: ['yarn.lock'],
              kind: 'root-impact',
            },
          ],
        ],
        [
          '@pkg-nec/jest-phabricator',
          [
            {
              classification: 'ambiguous-all',
              files: ['yarn.lock'],
              kind: 'root-impact',
            },
          ],
        ],
      ],
      requested: 'all',
      selected: ['@pkg-nec/create-jest', '@pkg-nec/jest-phabricator'],
    },
  ],
  [
    'known all-package input with a none flag',
    {
      changes: classification({allPackages: ['LICENSE']}),
      rootImpactRequest: 'none',
    },
    {
      applied: 'all',
      kind: 'release',
      reasons: [
        [
          '@pkg-nec/create-jest',
          [
            {
              classification: 'all-packages',
              files: ['LICENSE'],
              kind: 'root-impact',
            },
          ],
        ],
        [
          '@pkg-nec/jest-phabricator',
          [
            {
              classification: 'all-packages',
              files: ['LICENSE'],
              kind: 'root-impact',
            },
          ],
        ],
      ],
      requested: 'none',
      selected: ['@pkg-nec/create-jest', '@pkg-nec/jest-phabricator'],
    },
  ],
])('implements the root-impact decision row for %s', (_name, options, want) => {
  const result = runPlanner({definitions: decisionPackages(), ...options});
  expect(summarizeDecision(result)).toEqual(want);
});

test('applies patch defaults and direct or dependent SemVer overrides', () => {
  const result = runPlanner({
    bumpOverrideValues: [
      '@pkg-nec/jest-reporters=major',
      '@pkg-nec/jest-phabricator=minor',
      '@pkg-nec/create-jest=minor',
    ],
    changes: classification({
      packages: [
        [
          '@pkg-nec/jest-phabricator',
          ['packages/jest-phabricator/src/index.ts'],
        ],
        ['@pkg-nec/jest-reporters', ['packages/jest-reporters/src/index.ts']],
      ],
    }),
    definitions: [
      {name: '@pkg-nec/jest-reporters'},
      {
        manifest: {
          dependencies: {'@pkg-nec/jest-reporters': 'workspace:*'},
        },
        name: '@pkg-nec/create-jest',
      },
      {
        manifest: {
          optionalDependencies: {'@pkg-nec/create-jest': 'workspace:*'},
        },
        name: '@pkg-nec/jest',
      },
      {name: '@pkg-nec/jest-phabricator'},
    ],
  });

  expect(result.kind).toBe('release');
  expect(result.plan.anchor).toEqual({
    name: '@pkg-nec/jest',
    tag: '@pkg-nec/jest-v1.2.4',
    version: '1.2.4',
  });
  expect(result.plan.planPath).toBe(
    'docs/releases/pkg-nec-jest-v1.2.4-plan.json',
  );
  expect(result.plan.packages).toEqual([
    {
      bump: 'minor',
      fromVersion: '1.2.3',
      name: '@pkg-nec/jest-phabricator',
      order: 1,
      path: 'packages/jest-phabricator',
      reasons: [
        {
          files: ['packages/jest-phabricator/src/index.ts'],
          kind: 'changed',
        },
      ],
      toVersion: '1.3.0',
    },
    {
      bump: 'major',
      fromVersion: '1.2.3',
      name: '@pkg-nec/jest-reporters',
      order: 2,
      path: 'packages/jest-reporters',
      reasons: [
        {
          files: ['packages/jest-reporters/src/index.ts'],
          kind: 'changed',
        },
      ],
      toVersion: '2.0.0',
    },
    {
      bump: 'minor',
      fromVersion: '1.2.3',
      name: '@pkg-nec/create-jest',
      order: 3,
      path: 'packages/create-jest',
      reasons: [
        {
          kind: 'dependent',
          paths: [['@pkg-nec/jest-reporters', '@pkg-nec/create-jest']],
        },
      ],
      toVersion: '1.3.0',
    },
    {
      bump: 'patch',
      fromVersion: '1.2.3',
      name: '@pkg-nec/jest',
      order: 4,
      path: 'packages/jest',
      reasons: [
        {
          kind: 'dependent',
          paths: [
            [
              '@pkg-nec/jest-reporters',
              '@pkg-nec/create-jest',
              '@pkg-nec/jest',
            ],
          ],
        },
      ],
      toVersion: '1.2.4',
    },
  ]);
});

test('plans the complete closure when one member of a workspace cycle changes', () => {
  const result = runPlanner({
    changes: classification({
      packages: [
        ['@pkg-nec/create-jest', ['packages/create-jest/src/index.ts']],
      ],
    }),
    definitions: [
      {
        manifest: {
          devDependencies: {'@pkg-nec/jest-phabricator': 'workspace:*'},
        },
        name: '@pkg-nec/create-jest',
      },
      {
        manifest: {
          devDependencies: {'@pkg-nec/create-jest': 'workspace:*'},
        },
        name: '@pkg-nec/jest-phabricator',
      },
    ],
  });

  expect(result.kind).toBe('release');
  expect(result.plan.packages).toEqual([
    {
      bump: 'patch',
      fromVersion: '1.2.3',
      name: '@pkg-nec/create-jest',
      order: 1,
      path: 'packages/create-jest',
      reasons: [
        {
          files: ['packages/create-jest/src/index.ts'],
          kind: 'changed',
        },
      ],
      toVersion: '1.2.4',
    },
    {
      bump: 'patch',
      fromVersion: '1.2.3',
      name: '@pkg-nec/jest-phabricator',
      order: 2,
      path: 'packages/jest-phabricator',
      reasons: [
        {
          kind: 'dependent',
          paths: [['@pkg-nec/create-jest', '@pkg-nec/jest-phabricator']],
        },
      ],
      toVersion: '1.2.4',
    },
  ]);
});

test.each([
  [
    'duplicate',
    ['@pkg-nec/create-jest=patch', '@pkg-nec/create-jest=minor'],
    /duplicate bump override.*@pkg-nec\/create-jest/iu,
  ],
  [
    'unknown',
    ['@pkg-nec/missing=minor'],
    /unknown bump override.*@pkg-nec\/missing/iu,
  ],
  [
    'private',
    ['@pkg-nec/private-helper=minor'],
    /private bump override.*@pkg-nec\/private-helper/iu,
  ],
  [
    'unselected',
    ['@pkg-nec/jest-phabricator=minor'],
    /unselected bump override.*@pkg-nec\/jest-phabricator/iu,
  ],
])('rejects a %s bump override', (_name, bumpOverrideValues, want) => {
  const result = runPlanner({
    bumpOverrideValues,
    changes: classification({
      packages: [
        ['@pkg-nec/create-jest', ['packages/create-jest/src/index.ts']],
      ],
    }),
    definitions: [
      {name: '@pkg-nec/create-jest'},
      {name: '@pkg-nec/jest-phabricator'},
      {name: '@pkg-nec/private-helper', publishable: false},
    ],
  });
  expect(result.error).toMatch(want);
});

test('rejects selected and unselected pre-apply versions that differ from baseline', () => {
  const selected = runPlanner({
    changes: classification({
      packages: [
        ['@pkg-nec/create-jest', ['packages/create-jest/src/index.ts']],
      ],
    }),
    definitions: [
      {
        baselineVersion: '1.2.3',
        currentVersion: '1.2.4',
        name: '@pkg-nec/create-jest',
      },
    ],
  });
  expect(selected.error).toMatch(
    /selected package @pkg-nec\/create-jest.*baseline 1\.2\.3.*current 1\.2\.4/iu,
  );

  const unselected = runPlanner({
    changes: classification({
      packages: [
        ['@pkg-nec/create-jest', ['packages/create-jest/src/index.ts']],
      ],
    }),
    definitions: [
      {name: '@pkg-nec/create-jest'},
      {
        baselineVersion: '1.2.3',
        currentVersion: '1.2.4',
        name: '@pkg-nec/jest-phabricator',
      },
    ],
  });
  expect(unselected.error).toMatch(
    /unselected package @pkg-nec\/jest-phabricator.*baseline 1\.2\.3.*current 1\.2\.4/iu,
  );
});

test('rejects unexplained versions before non-release outcomes', () => {
  const noCommits = runPlanner({
    commits: [],
    definitions: [
      {
        baselineVersion: '1.2.3',
        currentVersion: '1.2.4',
        name: '@pkg-nec/create-jest',
      },
    ],
  });
  expect(noCommits.error).toMatch(
    /unselected package @pkg-nec\/create-jest.*baseline 1\.2\.3.*current 1\.2\.4/iu,
  );

  const ambiguous = runPlanner({
    changes: classification({ambiguous: ['yarn.lock']}),
    definitions: [
      {
        baselineVersion: '1.2.3',
        currentVersion: '1.2.4',
        name: '@pkg-nec/create-jest',
      },
    ],
  });
  expect(ambiguous.error).toMatch(
    /unselected package @pkg-nec\/create-jest.*baseline 1\.2\.3.*current 1\.2\.4/iu,
  );
});

test('preserves the documented anchor preference order', () => {
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
      import {selectReleaseAnchor} from ${JSON.stringify(validationModuleUrl)};
      const fallbacks = [
        '@pkg-nec/create-jest',
        '@pkg-nec/jest-create-cache-key-function',
        '@pkg-nec/jest-environment-jsdom',
        '@pkg-nec/jest-environment-jsdom-abstract',
        '@pkg-nec/jest-phabricator',
        '@pkg-nec/jest-test-globals',
      ];
      console.log(JSON.stringify({
        fallbacks: fallbacks.map((_, index) =>
          selectReleaseAnchor([...fallbacks.slice(index)].reverse()),
        ),
        jest: selectReleaseAnchor([...fallbacks, '@pkg-nec/jest']),
      }));
    `,
    ],
    {cwd: repoRoot, encoding: 'utf8'},
  );
  if (child.status !== 0) throw new Error(child.stderr || child.stdout);

  expect(JSON.parse(child.stdout.trim())).toEqual({
    fallbacks: [
      '@pkg-nec/create-jest',
      '@pkg-nec/jest-create-cache-key-function',
      '@pkg-nec/jest-environment-jsdom',
      '@pkg-nec/jest-environment-jsdom-abstract',
      '@pkg-nec/jest-phabricator',
      '@pkg-nec/jest-test-globals',
    ],
    jest: '@pkg-nec/jest',
  });
});
