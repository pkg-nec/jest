/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';

const repoRoot = process.cwd();
const moduleUrl = pathToFileURL(
  join(repoRoot, 'scripts/pkgNec/releasePlanSchema.mjs'),
).href;

const preparedFrom = '0123456789abcdef0123456789abcdef01234567';
const previousCommit = 'd8ba8b4b36a84ee019c9f8cdfc99d0fc598b61fb';

function validPlan() {
  return {
    anchor: {
      name: '@pkg-nec/jest',
      tag: '@pkg-nec/jest-v30.5.0',
      version: '30.5.0',
    },
    changedFiles: {
      packages: [
        {
          files: ['packages/jest-reporters/src/index.ts'],
          name: '@pkg-nec/jest-reporters',
        },
      ],
      root: {
        allPackages: [],
        ambiguous: ['yarn.lock'],
        noImpact: ['docs/pkg-nec-maintenance.md'],
      },
    },
    packages: [
      {
        bump: 'minor',
        fromVersion: '30.4.2',
        name: '@pkg-nec/jest-reporters',
        order: 1,
        path: 'packages/jest-reporters',
        reasons: [
          {
            files: ['packages/jest-reporters/src/index.ts'],
            kind: 'changed',
          },
        ],
        toVersion: '30.5.0',
      },
      {
        bump: 'minor',
        fromVersion: '30.4.2',
        name: '@pkg-nec/jest',
        order: 2,
        path: 'packages/jest',
        reasons: [
          {
            kind: 'dependent',
            paths: [['@pkg-nec/jest-reporters', '@pkg-nec/jest']],
          },
          {
            classification: 'ambiguous-all',
            files: ['yarn.lock'],
            kind: 'root-impact',
          },
        ],
        toVersion: '30.5.0',
      },
    ],
    planPath: 'docs/releases/pkg-nec-jest-v30.5.0-plan.json',
    preparedFrom,
    previousRelease: {
      commit: previousCommit,
      tag: '@pkg-nec/jest-v30.4.3',
    },
    rootImpact: {
      applied: 'all',
      requested: 'all',
    },
    schemaVersion: 1,
  };
}

function run(action, input) {
  const program = `
    import * as schema from ${JSON.stringify(moduleUrl)};
    try {
      console.log(JSON.stringify({ok: true, value: schema[${JSON.stringify(action)}](${JSON.stringify(input)})}));
    } catch (error) {
      console.log(JSON.stringify({ok: false, error: error instanceof Error ? error.message : String(error)}));
    }
  `;
  const child = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', program],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    },
  );
  if (child.status !== 0) throw new Error(child.stderr);
  return JSON.parse(child.stdout);
}

function expectInvalid(plan) {
  const result = run('validateReleasePlan', plan);
  expect(result.ok).toBe(false);
  expect(result.error).toMatch(/invalid release plan|must|unknown|expected/i);
}

function without(object, field) {
  const copy = {...object};
  delete copy[field];
  return copy;
}

function changedReasonWithKindBeforeFiles() {
  return Object.fromEntries([
    ['kind', 'changed'],
    ['files', ['packages/jest-reporters/src/index.ts']],
  ]);
}

test('validates and canonically serializes a complete permanent release plan', () => {
  const plan = validPlan();

  expect(run('validateReleasePlan', plan)).toEqual({ok: true, value: plan});
  expect(run('canonicalReleasePlan', plan)).toEqual({
    ok: true,
    value: `${JSON.stringify(plan, null, 2)}\n`,
  });
});

test('derives the plan path from its release tag', () => {
  expect(run('releasePlanPathFromTag', '@pkg-nec/jest-v30.5.0')).toEqual({
    ok: true,
    value: 'docs/releases/pkg-nec-jest-v30.5.0-plan.json',
  });
});

test.each([
  ['top level', plan => ({...plan, injected: true})],
  [
    'previous release',
    plan => ({
      ...plan,
      previousRelease: {...plan.previousRelease, injected: true},
    }),
  ],
  ['anchor', plan => ({...plan, anchor: {...plan.anchor, injected: true}})],
  [
    'changed package',
    plan => ({
      ...plan,
      changedFiles: {
        ...plan.changedFiles,
        packages: [{...plan.changedFiles.packages[0], injected: true}],
      },
    }),
  ],
  [
    'root classification',
    plan => ({
      ...plan,
      changedFiles: {
        ...plan.changedFiles,
        root: {...plan.changedFiles.root, injected: true},
      },
    }),
  ],
  [
    'root impact',
    plan => ({...plan, rootImpact: {...plan.rootImpact, injected: true}}),
  ],
  [
    'package',
    plan => ({
      ...plan,
      packages: [{...plan.packages[0], injected: true}, plan.packages[1]],
    }),
  ],
  [
    'changed reason',
    plan => ({
      ...plan,
      packages: [
        {
          ...plan.packages[0],
          reasons: [{...plan.packages[0].reasons[0], injected: true}],
        },
        plan.packages[1],
      ],
    }),
  ],
  [
    'dependent reason',
    plan => ({
      ...plan,
      packages: [
        plan.packages[0],
        {
          ...plan.packages[1],
          reasons: [{...plan.packages[1].reasons[0], injected: true}],
        },
      ],
    }),
  ],
  [
    'root-impact reason',
    plan => ({
      ...plan,
      packages: [
        plan.packages[0],
        {
          ...plan.packages[1],
          reasons: [
            plan.packages[1].reasons[0],
            {...plan.packages[1].reasons[1], injected: true},
          ],
        },
      ],
    }),
  ],
])('rejects an unknown field in the %s object', (_scope, mutate) => {
  expectInvalid(mutate(validPlan()));
});

test.each([
  ['release plan', plan => without(plan, 'schemaVersion')],
  [
    'previous release',
    plan => ({...plan, previousRelease: without(plan.previousRelease, 'tag')}),
  ],
  ['anchor', plan => ({...plan, anchor: without(plan.anchor, 'version')})],
  [
    'changed files',
    plan => ({...plan, changedFiles: without(plan.changedFiles, 'root')}),
  ],
  [
    'changed package',
    plan => ({
      ...plan,
      changedFiles: {
        ...plan.changedFiles,
        packages: [without(plan.changedFiles.packages[0], 'name')],
      },
    }),
  ],
  [
    'root classification',
    plan => ({
      ...plan,
      changedFiles: {
        ...plan.changedFiles,
        root: without(plan.changedFiles.root, 'ambiguous'),
      },
    }),
  ],
  [
    'root impact',
    plan => ({...plan, rootImpact: without(plan.rootImpact, 'requested')}),
  ],
  [
    'package',
    plan => ({
      ...plan,
      packages: [without(plan.packages[0], 'reasons'), plan.packages[1]],
    }),
  ],
  [
    'changed reason',
    plan => ({
      ...plan,
      packages: [
        {
          ...plan.packages[0],
          reasons: [without(plan.packages[0].reasons[0], 'files')],
        },
        plan.packages[1],
      ],
    }),
  ],
  [
    'dependent reason',
    plan => ({
      ...plan,
      packages: [
        plan.packages[0],
        {
          ...plan.packages[1],
          reasons: [
            without(plan.packages[1].reasons[0], 'paths'),
            plan.packages[1].reasons[1],
          ],
        },
      ],
    }),
  ],
  [
    'root-impact reason',
    plan => ({
      ...plan,
      packages: [
        plan.packages[0],
        {
          ...plan.packages[1],
          reasons: [
            plan.packages[1].reasons[0],
            without(plan.packages[1].reasons[1], 'classification'),
          ],
        },
      ],
    }),
  ],
])('rejects a missing required field in the %s object', (_scope, mutate) => {
  expectInvalid(mutate(validPlan()));
});

test.each([
  ['a short prepared commit', plan => ({...plan, preparedFrom: 'abc123'})],
  [
    'an invalid previous commit',
    plan => ({
      ...plan,
      previousRelease: {...plan.previousRelease, commit: 'g'.repeat(40)},
    }),
  ],
  [
    'a noncontiguous order',
    plan => ({
      ...plan,
      packages: [plan.packages[0], {...plan.packages[1], order: 3}],
    }),
  ],
  [
    'a repeated package name',
    plan => ({
      ...plan,
      packages: [
        plan.packages[0],
        {...plan.packages[1], name: plan.packages[0].name},
      ],
    }),
  ],
  [
    'a version transition that does not match its bump',
    plan => ({
      ...plan,
      packages: [{...plan.packages[0], toVersion: '30.4.3'}, plan.packages[1]],
    }),
  ],
  [
    'an anchor excluded from the package list',
    plan => ({
      ...plan,
      anchor: {...plan.anchor, name: '@pkg-nec/not-selected'},
    }),
  ],
  [
    'an anchor tag that does not match its name and version',
    plan => ({...plan, anchor: {...plan.anchor, tag: '@pkg-nec/jest-v30.5.1'}}),
  ],
  [
    'an anchor whose selected package ends at a different version',
    plan => ({
      ...plan,
      packages: [
        plan.packages[0],
        {...plan.packages[1], bump: 'patch', toVersion: '30.4.3'},
      ],
    }),
  ],
  [
    'a plan filename that does not match its tag',
    plan => ({...plan, planPath: 'docs/releases/other-plan.json'}),
  ],
])('rejects %s', (_description, mutate) => {
  expectInvalid(mutate(validPlan()));
});

test.each([
  [
    'duplicate changed paths',
    plan => ({
      ...plan,
      changedFiles: {
        ...plan.changedFiles,
        root: {
          ...plan.changedFiles.root,
          noImpact: [
            'docs/pkg-nec-maintenance.md',
            'docs/pkg-nec-maintenance.md',
          ],
        },
      },
    }),
  ],
  [
    'unsorted package paths',
    plan => ({
      ...plan,
      changedFiles: {
        ...plan.changedFiles,
        packages: [
          {
            ...plan.changedFiles.packages[0],
            files: [
              'packages/jest-reporters/z.ts',
              'packages/jest-reporters/a.ts',
            ],
          },
        ],
      },
    }),
  ],
  [
    'unsorted package reasons',
    plan => ({
      ...plan,
      packages: [
        plan.packages[0],
        {...plan.packages[1], reasons: [...plan.packages[1].reasons].reverse()},
      ],
    }),
  ],
  [
    'semantically duplicate reasons with different property insertion order',
    plan => ({
      ...plan,
      packages: [
        {
          ...plan.packages[0],
          reasons: [
            {files: ['packages/jest-reporters/src/index.ts'], kind: 'changed'},
            changedReasonWithKindBeforeFiles(),
          ],
        },
        plan.packages[1],
      ],
    }),
  ],
  [
    'an absolute reason file',
    plan => ({
      ...plan,
      packages: [
        {
          ...plan.packages[0],
          reasons: [{files: ['/outside.ts'], kind: 'changed'}],
        },
        plan.packages[1],
      ],
    }),
  ],
  [
    'a traversal package path',
    plan => ({
      ...plan,
      packages: [
        {...plan.packages[0], path: 'packages/../outside'},
        plan.packages[1],
      ],
    }),
  ],
])('rejects %s', (_description, mutate) => {
  expectInvalid(mutate(validPlan()));
});

test.each([
  [
    'changed reasons with only files',
    plan => ({
      ...plan,
      packages: [
        {
          ...plan.packages[0],
          reasons: [
            {files: ['packages/jest-reporters/src/index.ts'], kind: 'changed'},
          ],
        },
        plan.packages[1],
      ],
    }),
  ],
  [
    'root-impact reasons with a reviewed classification',
    plan => ({
      ...plan,
      packages: [
        {
          ...plan.packages[0],
          reasons: [
            {
              classification: 'all-packages',
              files: ['LICENSE'],
              kind: 'root-impact',
            },
          ],
        },
        plan.packages[1],
      ],
    }),
  ],
  [
    'dependent reasons with complete source-to-dependent paths',
    plan => ({
      ...plan,
      packages: [
        plan.packages[0],
        {
          ...plan.packages[1],
          reasons: [
            {
              kind: 'dependent',
              paths: [['@pkg-nec/jest-reporters', '@pkg-nec/jest']],
            },
          ],
        },
      ],
    }),
  ],
])('accepts exact %s union shapes', (_description, mutate) => {
  expect(run('validateReleasePlan', mutate(validPlan())).ok).toBe(true);
});

test.each([
  ['an unrecognized release tag', 'not-a-tag'],
  ['a path traversal tag', '@pkg-nec/../jest-v30.5.0'],
])('rejects %s when deriving a plan path', (_description, tag) => {
  const result = run('releasePlanPathFromTag', tag);
  expect(result.ok).toBe(false);
  expect(result.error).toMatch(/release tag|plan path/i);
});
