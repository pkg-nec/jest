/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

const {spawnSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const {join} = require('node:path');
const {pathToFileURL} = require('node:url');
const fs = require('graceful-fs');
const yaml = require('js-yaml');

const repoRoot = process.cwd();
const validationModuleUrl = pathToFileURL(
  join(repoRoot, 'scripts/pkgNec/releaseValidation.mjs'),
).href;
const validateCommandModuleUrl = pathToFileURL(
  join(repoRoot, 'scripts/validatePkgNecRelease.mjs'),
).href;
const sourceCommit = '0123456789abcdef0123456789abcdef01234567';

function runValidationProgram(program) {
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

function releaseFixture() {
  const inventoryEntries = [
    ['@pkg-nec/create-jest', '1.1.0'],
    ['@pkg-nec/jest-phabricator', '2.0.1'],
    ['@pkg-nec/jest-test-globals', '3.0.0'],
  ].map(([name, version]) => [
    name,
    {newName: name, publishable: true, version},
  ]);
  const packages = [
    {
      files: ['package.json'],
      integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
      name: '@pkg-nec/create-jest',
      order: 1,
      prerequisites: [],
      tarball: '.pkg-nec-release/pkg-nec-create-jest-1.1.0.tgz',
      version: '1.1.0',
    },
    {
      files: ['package.json'],
      integrity: `sha512-${Buffer.alloc(64, 2).toString('base64')}`,
      name: '@pkg-nec/jest-phabricator',
      order: 2,
      prerequisites: ['@pkg-nec/create-jest'],
      tarball: '.pkg-nec-release/pkg-nec-jest-phabricator-2.0.1.tgz',
      version: '2.0.1',
    },
  ];
  const releaseTag = '@pkg-nec/create-jest-v1.1.0';
  const planPath = 'docs/releases/pkg-nec-create-jest-v1.1.0-plan.json';
  return {
    event: {
      release: {
        body: [
          `Source commit: ${sourceCommit}`,
          ...packages.map(item => `- \`${item.name}@${item.version}\``),
        ].join('\n'),
        draft: false,
        name: releaseTag,
        prerelease: false,
        tag_name: releaseTag,
      },
    },
    inventoryEntries,
    ledger: {
      generatedAt: '2026-08-20T00:00:00.000Z',
      nodeVersion: 'v24.18.0',
      packageManager: 'yarn@4.18.0',
      packages,
      releasePlan: {digest: `sha256-${'a'.repeat(64)}`, path: planPath},
      schemaVersion: 2,
      sourceCommit,
    },
    plan: {
      anchor: {
        name: '@pkg-nec/create-jest',
        tag: releaseTag,
        version: '1.1.0',
      },
      changedFiles: {
        packages: [
          {
            files: ['packages/create-jest/index.js'],
            name: '@pkg-nec/create-jest',
          },
        ],
        root: {allPackages: [], ambiguous: [], noImpact: []},
      },
      packages: [
        {
          bump: 'minor',
          fromVersion: '1.0.0',
          name: '@pkg-nec/create-jest',
          order: 1,
          path: 'packages/create-jest',
          reasons: [
            {files: ['packages/create-jest/index.js'], kind: 'changed'},
          ],
          toVersion: '1.1.0',
        },
        {
          bump: 'patch',
          fromVersion: '2.0.0',
          name: '@pkg-nec/jest-phabricator',
          order: 2,
          path: 'packages/jest-phabricator',
          reasons: [
            {
              kind: 'dependent',
              paths: [['@pkg-nec/create-jest', '@pkg-nec/jest-phabricator']],
            },
          ],
          toVersion: '2.0.1',
        },
      ],
      planPath,
      preparedFrom: '1111111111111111111111111111111111111111',
      previousRelease: {
        commit: '2222222222222222222222222222222222222222',
        tag: '@pkg-nec/create-jest-v1.0.0',
      },
      rootImpact: {applied: 'not-needed', requested: null},
      schemaVersion: 1,
    },
    releaseGraphEntries: [
      ['@pkg-nec/create-jest', []],
      ['@pkg-nec/jest-phabricator', ['@pkg-nec/create-jest']],
      ['@pkg-nec/jest-test-globals', []],
    ],
    tagCommit: sourceCommit,
  };
}

function validateCommandFixture() {
  const fixture = releaseFixture();
  const planText = `${JSON.stringify(fixture.plan, null, 2)}\n`;
  return {
    ...fixture,
    inventoryEntries: fixture.inventoryEntries.map(([name, identity]) => [
      name,
      {
        ...identity,
        manifestPath: `/repo/${name.slice('@pkg-nec/'.length)}/package.json`,
      },
    ]),
    ledger: {
      ...fixture.ledger,
      releasePlan: {
        ...fixture.ledger.releasePlan,
        digest: `sha256-${createHash('sha256').update(planText).digest('hex')}`,
      },
    },
    planText,
  };
}

function validateFixture(input) {
  return runValidationProgram(`
    import {validateReleaseMetadata} from ${JSON.stringify(validationModuleUrl)};

    const input = ${JSON.stringify(input)};
    const inventory = {byNewName: new Map(input.inventoryEntries)};
    try {
      const result = validateReleaseMetadata({
        event: input.event,
        inventory,
        ledger: input.ledger,
        plan: input.plan,
        releaseGraph: new Map(
          input.releaseGraphEntries.map(([name, dependencies]) => [
            name,
            new Set(dependencies),
          ]),
        ),
        tagCommit: input.tagCommit,
      });
      console.log(JSON.stringify({result}));
    } catch (error) {
      console.log(JSON.stringify({error: error.message}));
    }
  `);
}

test('metadata accepts cyclic schema-2 prerequisites in component order', () => {
  const input = releaseFixture();
  input.ledger.packages = input.ledger.packages.map(item => ({
    ...item,
    prerequisites:
      item.name === '@pkg-nec/create-jest'
        ? ['@pkg-nec/jest-phabricator']
        : ['@pkg-nec/create-jest'],
  }));
  input.releaseGraphEntries = [
    ['@pkg-nec/create-jest', ['@pkg-nec/jest-phabricator']],
    ['@pkg-nec/jest-phabricator', ['@pkg-nec/create-jest']],
    ['@pkg-nec/jest-test-globals', []],
  ];

  expect(validateFixture(input)).toEqual({
    result: {
      anchorName: '@pkg-nec/create-jest',
      anchorVersion: '1.1.0',
      packageCount: 2,
      sourceCommit,
      tagName: '@pkg-nec/create-jest-v1.1.0',
    },
  });
});

test('parses release tags and selects the anchor', () => {
  const result = runValidationProgram(`
    import {
      parseReleaseTag,
      selectReleaseAnchor,
    } from ${JSON.stringify(validationModuleUrl)};

    let invalidTag;
    let invalidTagErrorName;
    try {
      parseReleaseTag(null);
    } catch (error) {
      invalidTag = error.message;
      invalidTagErrorName = error.constructor.name;
    }
    console.log(JSON.stringify({
      invalidTag,
      invalidTagErrorName,
      parsed: parseReleaseTag('@pkg-nec/jest-v30.4.3'),
      selected: selectReleaseAnchor([
        '@pkg-nec/jest-reporters',
        '@pkg-nec/jest',
      ]),
    }));
  `);

  expect(result).toEqual({
    invalidTag: expect.stringMatching(/release tag/i),
    invalidTagErrorName: 'Error',
    parsed: {anchorName: '@pkg-nec/jest', anchorVersion: '30.4.3'},
    selected: '@pkg-nec/jest',
  });
});

test('validates planned selected transitions and unchanged unselected packages', () => {
  const result = runValidationProgram(`
    import {validatePlannedTransitions} from ${JSON.stringify(validationModuleUrl)};

    const baseInput = {
      inventory: {
        byNewName: new Map([
          [
            '@pkg-nec/create-jest',
            {
              newName: '@pkg-nec/create-jest',
              publishable: true,
              version: '1.3.0',
            },
          ],
          [
            '@pkg-nec/jest-phabricator',
            {
              newName: '@pkg-nec/jest-phabricator',
              publishable: true,
              version: '2.0.0',
            },
          ],
          [
            '@pkg-nec/private-helper',
            {
              newName: '@pkg-nec/private-helper',
              publishable: false,
              version: '9.9.9',
            },
          ],
        ]),
      },
      plan: {
        packages: [
          {
            fromVersion: '1.2.3',
            name: '@pkg-nec/create-jest',
            toVersion: '1.3.0',
          },
        ],
      },
      previousPackages: new Map([
        ['@pkg-nec/create-jest', '1.2.3'],
        ['@pkg-nec/jest-phabricator', '2.0.0'],
      ]),
    };
    const evaluate = input => {
      try {
        return {result: validatePlannedTransitions(input)};
      } catch (error) {
        return {error: error.message};
      }
    };

    console.log(JSON.stringify({
      baselineMismatch: evaluate({
        ...baseInput,
        plan: {
          packages: [
            {
              fromVersion: '1.2.2',
              name: '@pkg-nec/create-jest',
              toVersion: '1.3.0',
            },
          ],
        },
      }),
      currentMismatch: evaluate({
        ...baseInput,
        inventory: {
          byNewName: new Map([
            ...baseInput.inventory.byNewName,
            [
              '@pkg-nec/create-jest',
              {
                newName: '@pkg-nec/create-jest',
                publishable: true,
                version: '1.3.1',
              },
            ],
          ]),
        },
      }),
      success: evaluate(baseInput),
      unselectedMismatch: evaluate({
        ...baseInput,
        inventory: {
          byNewName: new Map([
            ...baseInput.inventory.byNewName,
            [
              '@pkg-nec/jest-phabricator',
              {
                newName: '@pkg-nec/jest-phabricator',
                publishable: true,
                version: '2.0.1',
              },
            ],
          ]),
        },
      }),
    }));
  `);

  expect(result).toEqual({
    baselineMismatch: {
      error: expect.stringMatching(
        /@pkg-nec\/create-jest.*fromVersion.*1\.2\.3/iu,
      ),
    },
    currentMismatch: {
      error: expect.stringMatching(
        /@pkg-nec\/create-jest.*toVersion.*1\.3\.1/iu,
      ),
    },
    success: {result: ['@pkg-nec/create-jest']},
    unselectedMismatch: {
      error: expect.stringMatching(
        /unselected package @pkg-nec\/jest-phabricator.*2\.0\.0.*2\.0\.1/iu,
      ),
    },
  });
});

test('binds a two-package release event and ledger to the committed plan', () => {
  expect(validateFixture(releaseFixture())).toEqual({
    result: {
      anchorName: '@pkg-nec/create-jest',
      anchorVersion: '1.1.0',
      packageCount: 2,
      sourceCommit,
      tagName: '@pkg-nec/create-jest-v1.1.0',
    },
  });
});

test.each([
  ['draft', {draft: true}],
  ['prerelease', {prerelease: true}],
])('rejects a %s GitHub Release', (_description, releaseChanges) => {
  const input = releaseFixture();
  input.event.release = {...input.event.release, ...releaseChanges};

  expect(validateFixture(input)).toEqual({
    error: expect.stringMatching(/stable GitHub Release/i),
  });
});

// Mutation caught: treating every @pkg-nec-prefixed code span as a package
// entry instead of extracting only complete valid name@semver tokens.
test('ignores prose and malformed code spans in the release body', () => {
  const noisy = releaseFixture();
  noisy.event.release.body += [
    '',
    'Prose mention: @pkg-nec/not-selected@9.9.9.',
    '`@pkg-nec/not-selected`',
    '`@pkg-nec/Uppercase@1.0.0`',
    '`@pkg-nec/not-selected@not-semver`',
    '`prefix @pkg-nec/not-selected@9.9.9`',
    '`@pkg-nec/not-selected@9.9.9 trailing`',
  ].join('\n');
  expect(validateFixture(noisy)).toEqual({
    result: expect.objectContaining({packageCount: 2}),
  });
});

test('rejects duplicate or extra complete package tokens in the release body', () => {
  const input = releaseFixture();
  input.event.release.body += '\n- `@pkg-nec/create-jest@1.1.0`';
  expect(validateFixture(input)).toEqual({
    error: expect.stringMatching(/release body/i),
  });

  const prereleaseExtra = releaseFixture();
  prereleaseExtra.event.release.body +=
    '\n- `@pkg-nec/not-selected@9.9.9-beta.1`';
  expect(validateFixture(prereleaseExtra)).toEqual({
    error: expect.stringMatching(/release body/i),
  });
});

test.each([
  [
    'a tag resolved to a different source commit',
    input => ({...input, tagCommit: `${sourceCommit.slice(0, -1)}8`}),
    /source commit/i,
  ],
  [
    'a duplicated ledger package that omits another package',
    input => ({
      ...input,
      ledger: {
        ...input.ledger,
        packages: [
          ...input.ledger.packages.slice(0, -1),
          {...input.ledger.packages[0], order: 2},
        ],
      },
    }),
    /duplicate|plan/i,
  ],
  [
    'a release body missing a published package entry',
    input => ({
      ...input,
      event: {
        release: {
          ...input.event.release,
          body: input.event.release.body.replace(
            /\n- `@pkg-nec\/jest-phabricator@2\.0\.1`$/u,
            '',
          ),
        },
      },
    }),
    /release body/i,
  ],
  [
    'a Release name different from its tag',
    input => ({
      ...input,
      event: {
        release: {...input.event.release, name: 'pkg-nec Jest release'},
      },
    }),
    /release name/i,
  ],
  [
    'a tag whose anchor version differs from the ledger',
    input => ({
      ...input,
      event: {
        release: {
          ...input.event.release,
          name: '@pkg-nec/create-jest-v1.0.0',
          tag_name: '@pkg-nec/create-jest-v1.0.0',
        },
      },
    }),
    /anchor|tag|plan path/i,
  ],
  [
    'a ledger with fewer packages than the plan',
    input => ({
      ...input,
      ledger: {...input.ledger, packages: input.ledger.packages.slice(0, -1)},
    }),
    /plan|package/i,
  ],
  [
    'a ledger version that differs from the source manifest',
    input => ({
      ...input,
      inventoryEntries: input.inventoryEntries.map(([name, identity]) =>
        name === '@pkg-nec/create-jest'
          ? [name, {...identity, version: '1.1.1'}]
          : [name, identity],
      ),
    }),
    /version/i,
  ],
  [
    'a private workspace in the release ledger',
    input => ({
      ...input,
      inventoryEntries: input.inventoryEntries.map(([name, identity]) =>
        name === '@pkg-nec/create-jest'
          ? [name, {...identity, publishable: false}]
          : [name, identity],
      ),
    }),
    /publishable/i,
  ],
  [
    'a ledger prerequisite that includes an unselected package',
    input => ({
      ...input,
      ledger: {
        ...input.ledger,
        packages: input.ledger.packages.map(item =>
          item.name === '@pkg-nec/jest-phabricator'
            ? {...item, prerequisites: ['@pkg-nec/jest-test-globals']}
            : item,
        ),
      },
    }),
    /prerequisite|plan/i,
  ],
  [
    'an extra package token in the Release body',
    input => ({
      ...input,
      event: {
        release: {
          ...input.event.release,
          body: `${input.event.release.body}\n- \`@pkg-nec/jest-test-globals@3.0.0\``,
        },
      },
    }),
    /release body/i,
  ],
  [
    'ledger package order that differs from the plan',
    input => ({
      ...input,
      ledger: {
        ...input.ledger,
        packages: [...input.ledger.packages]
          .reverse()
          .map((item, index) => ({...item, order: index + 1})),
      },
    }),
    /plan|order|prerequisite/i,
  ],
  [
    'a malformed ledger package entry',
    input => ({
      ...input,
      ledger: {
        ...input.ledger,
        packages: [null, ...input.ledger.packages.slice(1)],
      },
    }),
    /invalid release (?:ledger )?package at order 1/i,
  ],
  [
    'a release with a non-string tag name',
    input => ({
      ...input,
      event: {
        release: {...input.event.release, tag_name: null},
      },
    }),
    /invalid pkg-nec release tag/i,
  ],
])('rejects %s', (_description, mutate, message) => {
  expect(validateFixture(mutate(releaseFixture()))).toEqual({
    error: expect.stringMatching(message),
  });
});

function runValidateCommandProgram(program) {
  return runValidationProgram(`
    import {runValidateReleaseCommand} from ${JSON.stringify(
      validateCommandModuleUrl,
    )};
    ${program}
  `);
}

test('rejects unstable release events before GitHub or output side effects', () => {
  const fixture = validateCommandFixture();
  const result = runValidateCommandProgram(`
    const fixture = ${JSON.stringify(fixture)};
    const inventory = {
      byNewName: new Map(fixture.inventoryEntries),
      packages: fixture.inventoryEntries.map(([, identity]) => identity),
    };
    const releaseGraph = new Map(
      fixture.releaseGraphEntries.map(([name, dependencies]) => [
        name,
        new Set(dependencies),
      ]),
    );
    const results = [];
    for (const [kind, changes] of [
      ['draft', {draft: true}],
      ['prerelease', {prerelease: true}],
    ]) {
      const event = {
        release: {...fixture.event.release, ...changes},
      };
      const fetchCalls = [];
      const lines = [];
      try {
        await runValidateReleaseCommand({
          args: ['release-ledger.json'],
          buildReleaseGraph: () => releaseGraph,
          createInventory: () => inventory,
          env: {
            GITHUB_EVENT_PATH: 'event.json',
            GITHUB_REPOSITORY: 'pkg-nec/jest',
            GITHUB_SHA: fixture.ledger.sourceCommit,
            GITHUB_TOKEN: 'github-test-token',
          },
          fetchImpl: async (...args) => {
            fetchCalls.push(args);
            return {json: async () => ({workflow_runs: []})};
          },
          readFile: async file => file === 'event.json'
            ? JSON.stringify(event)
            : String(file).endsWith('plan.json')
              ? fixture.planText
              : JSON.stringify(fixture.ledger),
          repoRoot: '/repo',
          runGit: async args => {
            if (args[0] === 'rev-list' && args[1] === '--parents') {
              return fixture.ledger.sourceCommit + ' ' + 'f'.repeat(40);
            }
            if (args[0] === 'rev-list') {
              return args.at(-1) === fixture.plan.previousRelease.tag
                ? fixture.plan.previousRelease.commit
                : fixture.ledger.sourceCommit;
            }
            if (args[0] === 'rev-parse') return fixture.ledger.sourceCommit;
            if (args[0] === 'show') {
              if (args[1].endsWith(fixture.plan.planPath)) {
                return fixture.planText;
              }
              const selected = fixture.plan.packages.find(item =>
                args[1].includes(item.path.slice('packages/'.length)),
              );
              return JSON.stringify({
                version: selected?.fromVersion ?? '3.0.0',
              });
            }
            return '';
          },
          write: line => lines.push(line),
        });
      } catch (error) {
        results.push({error: error.message, fetchCalls, kind, lines});
      }
    }
    console.log(JSON.stringify(results));
  `);

  expect(result).toEqual([
    {
      error: expect.stringMatching(/stable GitHub Release/i),
      fetchCalls: [],
      kind: 'draft',
      lines: [],
    },
    {
      error: expect.stringMatching(/stable GitHub Release/i),
      fetchCalls: [],
      kind: 'prerelease',
      lines: [],
    },
  ]);
});

test('collects the tagged release context and accepts the matching Node CI run', () => {
  const result = runValidateCommandProgram(`
    import {createHash} from 'node:crypto';
    const fetchCalls = [];
    const gitCalls = [];
    const lines = [];
    const metadataCalls = [];
    const plan = ${JSON.stringify(releaseFixture().plan)};
    const planText = JSON.stringify(plan, null, 2) + '\\n';
    const inventory = {
      byNewName: new Map([
        ['@pkg-nec/create-jest', '1.1.0'],
        ['@pkg-nec/jest-phabricator', '2.0.1'],
        ['@pkg-nec/jest-test-globals', '3.0.0'],
      ].map(([name, version]) => [name, {
          manifestPath: '/repo/' + name.slice('@pkg-nec/'.length) + '/package.json',
          newName: name,
          publishable: true,
          version,
        }])),
    };
    const ledger = {
      packages: [
        {name: '@pkg-nec/create-jest', order: 1, prerequisites: [], version: '1.1.0'},
        {
          name: '@pkg-nec/jest-phabricator',
          order: 2,
          prerequisites: ['@pkg-nec/create-jest'],
          version: '2.0.1',
        },
      ],
      releasePlan: {
        digest: 'sha256-' + createHash('sha256').update(planText).digest('hex'),
        path: plan.planPath,
      },
      schemaVersion: 2,
      sourceCommit: ${JSON.stringify(sourceCommit)},
    };
    const result = await runValidateReleaseCommand({
      args: ['release-ledger.json'],
      buildReleaseGraph: () => new Map([
        ['@pkg-nec/create-jest', new Set()],
        ['@pkg-nec/jest-phabricator', new Set(['@pkg-nec/create-jest'])],
        ['@pkg-nec/jest-test-globals', new Set()],
      ]),
      createInventory: () => inventory,
      env: {
        GITHUB_EVENT_PATH: 'event.json',
        GITHUB_REPOSITORY: 'pkg-nec/jest',
        GITHUB_SHA: ledger.sourceCommit,
        GITHUB_TOKEN: 'github-test-token',
      },
      fetchImpl: async (url, options) => {
        fetchCalls.push({headers: options.headers, url});
        return {json: async () => ({workflow_runs: [{
          conclusion: 'success', event: 'push', head_branch: 'main', head_sha: ledger.sourceCommit,
        }]})};
      },
      readFile: async file => file === 'event.json'
        ? JSON.stringify({release: {tag_name: plan.anchor.tag}})
        : String(file).endsWith('plan.json')
          ? planText
          : JSON.stringify(ledger),
      runGit: async (args, options) => {
        gitCalls.push({args, cwd: options.cwd});
        if (args[0] === 'rev-list' && args[1] === '--parents') {
          return ledger.sourceCommit + ' ' + 'f'.repeat(40);
        }
        if (args[0] === 'rev-list') {
          return args.at(-1) === plan.previousRelease.tag
            ? plan.previousRelease.commit
            : ledger.sourceCommit;
        }
        if (args[0] === 'rev-parse') return ledger.sourceCommit;
        if (args[0] === 'show') {
          if (args[1].endsWith(plan.planPath)) return planText;
          const name = [...inventory.byNewName].find(([, item]) =>
            args[1].endsWith(item.manifestPath.replace('/repo/', '')),
          )[0];
          return JSON.stringify({
            version: name === '@pkg-nec/create-jest'
              ? '1.0.0'
              : name === '@pkg-nec/jest-phabricator'
                ? '2.0.0'
                : '3.0.0',
          });
        }
        return '';
      },
      validateReleaseMetadata: input => {
        metadataCalls.push({
          planPath: input.plan.planPath,
          prerequisites: [...input.releaseGraph.get('@pkg-nec/jest-phabricator')],
        });
        return {
          packageCount: input.plan.packages.length,
          sourceCommit: input.ledger.sourceCommit,
          tagName: input.plan.anchor.tag,
        };
      },
      repoRoot: '/repo',
      write: line => lines.push(line),
    });
    console.log(JSON.stringify({fetchCalls, gitCalls, lines, metadataCalls, result}));
  `);

  expect(result.fetchCalls).toEqual([
    {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: 'Bearer github-test-token',
        'x-github-api-version': '2022-11-28',
      },
      url: `https://api.github.com/repos/pkg-nec/jest/actions/workflows/nodejs.yml/runs?head_sha=${sourceCommit}&status=completed&per_page=100`,
    },
  ]);
  expect(result.gitCalls.map(call => call.args)).toEqual([
    ['rev-list', '-n', '1', '@pkg-nec/create-jest-v1.1.0'],
    ['rev-parse', 'HEAD'],
    ['merge-base', '--is-ancestor', sourceCommit, 'origin/main'],
    ['rev-list', '--parents', '-n', '1', sourceCommit],
    [
      'ls-tree',
      '--name-only',
      'ffffffffffffffffffffffffffffffffffffffff',
      '--',
      'docs/releases/pkg-nec-create-jest-v1.1.0-plan.json',
    ],
    [
      'show',
      `${sourceCommit}:docs/releases/pkg-nec-create-jest-v1.1.0-plan.json`,
    ],
    ['rev-list', '-n', '1', '@pkg-nec/create-jest-v1.0.0'],
    [
      'merge-base',
      '--is-ancestor',
      '2222222222222222222222222222222222222222',
      sourceCommit,
    ],
    ...['create-jest', 'jest-phabricator', 'jest-test-globals'].map(
      directory => [
        'show',
        `2222222222222222222222222222222222222222:${directory}/package.json`,
      ],
    ),
    ['rev-list', '-n', '1', '@pkg-nec/create-jest-v1.1.0'],
    ['rev-parse', 'HEAD'],
  ]);
  expect(result.metadataCalls).toEqual([
    {
      planPath: 'docs/releases/pkg-nec-create-jest-v1.1.0-plan.json',
      prerequisites: ['@pkg-nec/create-jest'],
    },
  ]);
  expect(result).toEqual(
    expect.objectContaining({
      lines: [
        'classification=valid',
        'tag=@pkg-nec/create-jest-v1.1.0',
        `sourceCommit=${sourceCommit}`,
        'packageCount=2',
      ],
      result: {
        packageCount: 2,
        sourceCommit,
        tagName: '@pkg-nec/create-jest-v1.1.0',
      },
    }),
  );
});

// Mutation caught: validating metadata for a tag/checkout/event mismatch, or
// accepting a commit whose first parent already contains this release plan.
test('binds validation to the plan-introduction commit before metadata or network access', () => {
  const result = runValidateCommandProgram(`
    const fixture = ${JSON.stringify(validateCommandFixture())};
    const sourceCommit = fixture.ledger.sourceCommit;
    const firstParent = '3333333333333333333333333333333333333333';
    const featureParent = '4444444444444444444444444444444444444444';
    const otherCommit = '5555555555555555555555555555555555555555';

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
        await runValidateReleaseCommand({
          args: ['release-ledger.json'],
          env: {
            GITHUB_EVENT_PATH: 'event.json',
            GITHUB_REPOSITORY: 'pkg-nec/jest',
            GITHUB_SHA: eventCommit,
            GITHUB_TOKEN: 'github-test-token',
          },
          fetchImpl: async () => {throw new Error('network must not run');},
          readFile: async file => {
            if (file === 'event.json') return JSON.stringify(fixture.event);
            if (file === 'release-ledger.json') {
              return JSON.stringify(fixture.ledger);
            }
            throw new Error('binding accepted');
          },
          repoRoot: '/repo',
          runGit: async args => {
            gitCalls.push(args);
            if (args[0] === 'rev-list' && args[1] === '-n') {
              return tagCommit;
            }
            if (args[0] === 'rev-parse') return headCommit;
            if (args[0] === 'rev-list' && args[1] === '--parents') {
              return [sourceCommit, ...parents].join(' ');
            }
            if (args[0] === 'ls-tree') {
              return planInFirstParent ? fixture.plan.planPath + '\\n' : '';
            }
            return '';
          },
          validateReleaseMetadata: () => {
            throw new Error('metadata must not run');
          },
        });
      } catch (error) {
        message = error.message;
      }
      return {gitCalls, message};
    }

    console.log(JSON.stringify({
      checkoutMismatch: await runCase({headCommit: otherCommit}),
      eventMalformed: await runCase({eventCommit: 'not-a-commit'}),
      eventMismatch: await runCase({eventCommit: otherCommit}),
      exact: await runCase(),
      laterCommit: await runCase({planInFirstParent: true}),
      merge: await runCase({parents: [firstParent, featureParent]}),
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
  expect(result.merge.gitCalls).toContainEqual([
    'ls-tree',
    '--name-only',
    '3333333333333333333333333333333333333333',
    '--',
    'docs/releases/pkg-nec-create-jest-v1.1.0-plan.json',
  ]);
  expect(result.merge.gitCalls).not.toContainEqual(
    expect.arrayContaining(['4444444444444444444444444444444444444444']),
  );
});

// Mutation caught: resolving a mutable release tag only once and continuing
// after it is retargeted before metadata/network validation.
test('rejects a release tag retarget before metadata and network validation', () => {
  const result = runValidateCommandProgram(`
    const fixture = ${JSON.stringify(validateCommandFixture())};
    const inventory = {byNewName: new Map(fixture.inventoryEntries)};
    const sourceCommit = fixture.ledger.sourceCommit;
    const otherCommit = '5555555555555555555555555555555555555555';
    const firstParent = '3333333333333333333333333333333333333333';
    let tagReads = 0;
    let message = 'accepted';
    try {
      await runValidateReleaseCommand({
        args: ['release-ledger.json'],
        buildReleaseGraph: () => new Map(
          fixture.releaseGraphEntries.map(([name, dependencies]) => [
            name,
            new Set(dependencies),
          ]),
        ),
        createInventory: () => inventory,
        env: {
          GITHUB_EVENT_PATH: 'event.json',
          GITHUB_REPOSITORY: 'pkg-nec/jest',
          GITHUB_SHA: sourceCommit,
          GITHUB_TOKEN: 'github-test-token',
        },
        fetchImpl: async () => {throw new Error('network must not run');},
        readFile: async file => file === 'event.json'
          ? JSON.stringify(fixture.event)
          : String(file).endsWith('plan.json')
            ? fixture.planText
            : JSON.stringify(fixture.ledger),
        repoRoot: '/repo',
        runGit: async args => {
          if (args[0] === 'rev-list' && args[1] === '-n') {
            if (args.at(-1) === fixture.plan.previousRelease.tag) {
              return fixture.plan.previousRelease.commit;
            }
            tagReads += 1;
            return tagReads === 1 ? sourceCommit : otherCommit;
          }
          if (args[0] === 'rev-parse') return sourceCommit;
          if (args[0] === 'rev-list' && args[1] === '--parents') {
            return sourceCommit + ' ' + firstParent;
          }
          if (args[0] === 'show' && args[1].endsWith(fixture.plan.planPath)) {
            return fixture.planText;
          }
          if (args[0] === 'show') {
            const name = fixture.inventoryEntries.find(([, item]) =>
              args[1].endsWith(item.manifestPath.replace('/repo/', '')),
            )[0];
            const planned = fixture.plan.packages.find(item => item.name === name);
            return JSON.stringify({version: planned?.fromVersion ?? '3.0.0'});
          }
          return '';
        },
        validateReleaseMetadata: () => {
          throw new Error('metadata must not run');
        },
      });
    } catch (error) {
      message = error.message;
    }
    console.log(JSON.stringify({message, tagReads}));
  `);

  expect(result).toEqual({
    message: 'Release source commit changed during validation',
    tagReads: 2,
  });
});

test('rejects invalid arguments and redacts GitHub tokens from adapter errors', () => {
  const result = runValidateCommandProgram(`
    const fixture = ${JSON.stringify(validateCommandFixture())};
    const inventory = {byNewName: new Map(fixture.inventoryEntries)};
    const runGit = async args => {
      if (args[0] === 'rev-list' && args[1] === '--parents') {
        return fixture.ledger.sourceCommit + ' ' + 'f'.repeat(40);
      }
      if (args[0] === 'rev-list') {
        return args.at(-1) === fixture.plan.previousRelease.tag
          ? fixture.plan.previousRelease.commit
          : fixture.ledger.sourceCommit;
      }
      if (args[0] === 'rev-parse') return fixture.ledger.sourceCommit;
      if (args[0] === 'show' && args[1].endsWith(fixture.plan.planPath)) {
        return fixture.planText;
      }
      if (args[0] === 'show') {
        const name = fixture.inventoryEntries.find(([, item]) =>
          args[1].endsWith(item.manifestPath.replace('/repo/', '')),
        )[0];
        const planned = fixture.plan.packages.find(item => item.name === name);
        return JSON.stringify({version: planned?.fromVersion ?? '3.0.0'});
      }
      return '';
    };
    const cases = [];
    for (const input of [
      {args: [], env: {}},
      {
        args: ['ledger.json'],
        buildReleaseGraph: () => new Map(
          fixture.releaseGraphEntries.map(([name, dependencies]) => [
            name,
            new Set(dependencies),
          ]),
        ),
        env: {
          GITHUB_EVENT_PATH: 'event.json',
          GITHUB_REPOSITORY: 'pkg-nec/jest',
          GITHUB_SHA: fixture.ledger.sourceCommit,
          GITHUB_TOKEN: 'github-secret-token',
        },
        fetchImpl: async () => {throw new Error('request failed: Bearer github-secret-token');},
        readFile: async file => file === 'event.json'
          ? JSON.stringify(fixture.event)
          : String(file).endsWith('plan.json')
            ? fixture.planText
            : JSON.stringify(fixture.ledger),
        runGit,
        createInventory: () => inventory,
        validateReleaseMetadata: () => ({packageCount: 2}),
        repoRoot: '/repo',
      },
    ]) {
      try {
        await runValidateReleaseCommand(input);
      } catch (error) {
        cases.push(error.message);
      }
    }
    console.log(JSON.stringify(cases));
  `);

  expect(result[0]).toBe('Usage: yarn validate:pkg-nec-release <ledger-path>');
  expect(result[1]).toContain('github-token-redacted');
  expect(result[1]).not.toContain('github-secret-token');
});

test('requires a successful main push Node CI run for the tag commit', () => {
  const result = runValidateCommandProgram(`
    const fixture = ${JSON.stringify(validateCommandFixture())};
    const inventory = {byNewName: new Map(fixture.inventoryEntries)};
    try {
      await runValidateReleaseCommand({
        args: ['ledger.json'],
        buildReleaseGraph: () => new Map(
          fixture.releaseGraphEntries.map(([name, dependencies]) => [
            name,
            new Set(dependencies),
          ]),
        ),
        createInventory: () => inventory,
        env: {
          GITHUB_EVENT_PATH: 'event.json',
          GITHUB_REPOSITORY: 'pkg-nec/jest',
          GITHUB_SHA: fixture.ledger.sourceCommit,
          GITHUB_TOKEN: 'github-test-token',
        },
        fetchImpl: async () => ({json: async () => ({workflow_runs: [{
          conclusion: 'failure', event: 'push', head_branch: 'main', head_sha: fixture.ledger.sourceCommit,
        }]})}),
        readFile: async file => file === 'event.json'
          ? JSON.stringify(fixture.event)
          : String(file).endsWith('plan.json')
            ? fixture.planText
            : JSON.stringify(fixture.ledger),
        runGit: async args => {
          if (args[0] === 'rev-list' && args[1] === '--parents') {
            return fixture.ledger.sourceCommit + ' ' + 'f'.repeat(40);
          }
          if (args[0] === 'rev-list') {
            return args.at(-1) === fixture.plan.previousRelease.tag
              ? fixture.plan.previousRelease.commit
              : fixture.ledger.sourceCommit;
          }
          if (args[0] === 'rev-parse') return fixture.ledger.sourceCommit;
          if (args[0] === 'show' && args[1].endsWith(fixture.plan.planPath)) {
            return fixture.planText;
          }
          if (args[0] === 'show') {
            const name = fixture.inventoryEntries.find(([, item]) =>
              args[1].endsWith(item.manifestPath.replace('/repo/', '')),
            )[0];
            const planned = fixture.plan.packages.find(item => item.name === name);
            return JSON.stringify({version: planned?.fromVersion ?? '3.0.0'});
          }
          return '';
        },
        repoRoot: '/repo',
        validateReleaseMetadata: () => ({}),
      });
    } catch (error) {
      console.log(JSON.stringify(error.message));
    }
  `);

  expect(result).toBe(`Node CI did not succeed for ${sourceCommit}`);
});

test('prints one stable error when the standalone command lacks its required environment', () => {
  const command = spawnSync(
    process.execPath,
    ['scripts/validatePkgNecRelease.mjs', 'ledger.json'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_EVENT_PATH: '',
        GITHUB_REPOSITORY: '',
        GITHUB_SHA: '',
        GITHUB_TOKEN: '',
      },
    },
  );

  expect(command.status).toBe(1);
  expect(command.stdout).toBe('');
  expect(command.stderr).toBe(
    'Required environment: GITHUB_EVENT_PATH, GITHUB_REPOSITORY, GITHUB_SHA, GITHUB_TOKEN\n',
  );
});

test('runs the network-free release-plan validator immediately after the tooling suite', () => {
  const workflow = yaml.load(
    fs.readFileSync(join(repoRoot, '.github/workflows/nodejs.yml'), 'utf8'),
  );
  const steps = workflow.jobs['static-checks'].steps;
  const checkout = steps.find(step =>
    step.uses?.startsWith('actions/checkout@'),
  );
  const toolingIndex = steps.findIndex(
    step => step.name === 'Test pkg-nec tooling',
  );
  const validation = steps[toolingIndex + 1];
  const scripts = JSON.parse(
    fs.readFileSync(join(repoRoot, 'package.json'), 'utf8'),
  ).scripts;

  expect(checkout.with).toEqual({
    'fetch-depth': 0,
    'persist-credentials': false,
  });
  expect(validation).toEqual({
    name: 'Validate pkg-nec release preparation',
    run: "yarn validate:pkg-nec-release-plan '${{ github.event.pull_request.base.sha || github.sha }}'",
  });
  expect(scripts['validate:pkg-nec-release-plan']).toBe(
    'node ./scripts/validatePkgNecReleasePlan.mjs',
  );
  expect(scripts['test:pkg-nec-tooling']).toBe(
    'yarn jest scripts/__tests__ --runInBand --color',
  );
});

test('defines a least-privilege provenance release workflow with durable evidence', () => {
  const workflowPath = join(repoRoot, '.github/workflows/release.yml');
  const workflowSource = fs.readFileSync(workflowPath, 'utf8');
  const workflow = yaml.load(workflowSource);
  const {evidence, publish, validate, verify} = workflow.jobs;
  const findStep = (job, name) => job.steps.find(step => step.name === name);
  const actionSteps = Object.values(workflow.jobs).flatMap(job =>
    job.steps.filter(step => step.uses),
  );
  const checkoutSteps = actionSteps.filter(step =>
    step.uses.startsWith('actions/checkout@'),
  );
  const setupNodeSteps = actionSteps.filter(step =>
    step.uses.startsWith('actions/setup-node@'),
  );
  const scripts = JSON.parse(
    fs.readFileSync(join(repoRoot, 'package.json'), 'utf8'),
  ).scripts;

  expect(workflow.on.release.types).toEqual(['published']);
  expect(workflow.on.release.types).not.toContain('created');
  expect(scripts['draft:pkg-nec-release']).toBe(
    'node ./scripts/draftPkgNecRelease.mjs',
  );
  expect(scripts['draft:pkg-nec-release']).not.toContain('publish');
  expect(workflow.permissions).toEqual({});
  expect(workflow.concurrency).toEqual({
    'cancel-in-progress': false,
    group: 'npm-release-${{ github.event.release.tag_name }}',
  });
  expect(Object.keys(workflow.jobs)).toEqual([
    'validate',
    'publish',
    'verify',
    'evidence',
  ]);
  expect(validate.permissions).toEqual({actions: 'read', contents: 'read'});
  expect(publish).toEqual(
    expect.objectContaining({
      environment: 'npm-publish',
      needs: 'validate',
      permissions: {contents: 'read', 'id-token': 'write'},
    }),
  );
  expect(verify).toEqual(
    expect.objectContaining({
      needs: 'publish',
      permissions: {contents: 'read'},
    }),
  );
  expect(evidence).toEqual(
    expect.objectContaining({
      if: "${{ always() && needs.validate.result == 'success' }}",
      needs: ['validate', 'publish', 'verify'],
      permissions: {contents: 'write'},
    }),
  );
  expect(validate.permissions).not.toHaveProperty('id-token');
  expect(verify.permissions).not.toHaveProperty('id-token');
  expect(evidence.permissions).not.toHaveProperty('id-token');
  expect(
    Object.entries(workflow.jobs)
      .filter(([, job]) => job.permissions?.['id-token'] === 'write')
      .map(([name]) => name),
  ).toEqual(['publish']);
  expect(Object.values(workflow.jobs).map(job => job['runs-on'])).toEqual([
    'ubuntu-latest',
    'ubuntu-latest',
    'ubuntu-latest',
    'ubuntu-latest',
  ]);

  const stableReleaseStep = findStep(validate, 'Reject unstable release event');
  expect(validate.steps[0]).toEqual(stableReleaseStep);
  expect(stableReleaseStep).toEqual({
    env: {
      RELEASE_DRAFT: '${{ github.event.release.draft }}',
      RELEASE_PRERELEASE: '${{ github.event.release.prerelease }}',
    },
    name: 'Reject unstable release event',
    run:
      'if [[ "$RELEASE_DRAFT" != "false" || "$RELEASE_PRERELEASE" != "false" ]]; then\n' +
      '  echo "Only stable GitHub Releases may publish pkg-nec packages" >&2\n' +
      '  exit 1\n' +
      'fi\n',
  });

  expect(checkoutSteps).toHaveLength(3);
  for (const step of checkoutSteps) {
    expect(step.with).toEqual(
      expect.objectContaining({
        'persist-credentials': false,
        ref: '${{ github.event.release.tag_name }}',
      }),
    );
  }
  expect(findStep(validate, 'Check out the release tag').with).toEqual(
    expect.objectContaining({'fetch-depth': 0}),
  );
  expect(findStep(validate, 'Fetch main for release validation').run).toBe(
    'git fetch --no-tags origin main:refs/remotes/origin/main',
  );
  expect(setupNodeSteps).toHaveLength(3);
  for (const step of setupNodeSteps) {
    expect(step.with).toEqual({
      'node-version': '24.18.0',
      'registry-url': 'https://registry.npmjs.org',
    });
  }
  expect(findStep(validate, 'Install dependencies').run.split('\n')).toEqual([
    'corepack enable',
    'yarn install --immutable',
    '',
  ]);
  expect(findStep(validate, 'Build and audit package identities').run).toBe(
    'yarn build:js\nyarn check:pkg-nec-identity\n',
  );
  expect(findStep(validate, 'Run focused release tooling tests').run).toBe(
    'yarn run test:pkg-nec-tooling',
  );
  const prepareStep = findStep(validate, 'Prepare release candidate');
  expect(prepareStep).toEqual({
    env: {RELEASE_TAG: '${{ github.event.release.tag_name }}'},
    name: 'Prepare release candidate',
    run: 'yarn prepare:pkg-nec-release "$RELEASE_TAG"',
  });
  expect(findStep(validate, 'Validate release candidate')).toEqual(
    expect.objectContaining({
      env: {GITHUB_TOKEN: '${{ github.token }}'},
      run: 'yarn validate:pkg-nec-release .pkg-nec-release/release-ledger.json',
    }),
  );
  expect(findStep(validate, 'Upload release candidate')).toEqual(
    expect.objectContaining({
      with: {
        'if-no-files-found': 'error',
        'include-hidden-files': true,
        name: 'pkg-nec-release-candidate',
        path: '.pkg-nec-release/',
        'retention-days': 30,
      },
    }),
  );

  expect(findStep(publish, 'Install exact npm').run).toBe(
    'npm install --global npm@11.19.0',
  );
  expect(findStep(publish, 'Download release candidate').with).toEqual({
    name: 'pkg-nec-release-candidate',
    path: '.pkg-nec-release',
  });
  const publishStep = findStep(
    publish,
    'Publish in ledger order with strict resumption',
  );
  expect(publishStep).toEqual({
    env: {RELEASE_TAG: '${{ github.event.release.tag_name }}'},
    name: 'Publish in ledger order with strict resumption',
    run:
      'yarn publish:pkg-nec-release .pkg-nec-release/release-ledger.json ' +
      '.pkg-nec-release/publication-journal.json "$RELEASE_TAG"',
  });
  expect(findStep(publish, 'Summarize publication progress')).toEqual({
    if: '${{ always() }}',
    name: 'Summarize publication progress',
    run:
      'if [[ -f .pkg-nec-release/publication-journal.json ]]; then\n' +
      '  yarn summarize:pkg-nec-publication \\\n' +
      '    .pkg-nec-release/release-ledger.json \\\n' +
      '    .pkg-nec-release/publication-journal.json >> "$GITHUB_STEP_SUMMARY"\n' +
      'fi\n',
  });
  expect(findStep(publish, 'Upload publication journal')).toEqual(
    expect.objectContaining({
      if: '${{ always() }}',
      with: expect.objectContaining({
        'include-hidden-files': true,
        name: 'pkg-nec-publication-evidence',
        path: '.pkg-nec-release/publication-journal.json',
      }),
    }),
  );

  expect(findStep(verify, 'Install exact npm').run).toBe(
    'npm install --global npm@11.19.0',
  );
  expect(findStep(verify, 'Verify complete registry batch').run).toBe(
    'yarn verify:pkg-nec-release \\\n' +
      '  .pkg-nec-release/release-ledger.json \\\n' +
      '  .pkg-nec-release/publication-journal.json \\\n' +
      '  .pkg-nec-release/registry-evidence.json \\\n' +
      '  .pkg-nec-release/registry-evidence.md \\\n' +
      '  .pkg-nec-release/provenance-evidence.json \\\n' +
      '  .pkg-nec-release/provenance-evidence.md\n',
  );
  expect(findStep(verify, 'Upload registry evidence')).toEqual(
    expect.objectContaining({
      if: '${{ always() }}',
      with: expect.objectContaining({
        'if-no-files-found': 'warn',
        'include-hidden-files': true,
        name: 'pkg-nec-registry-evidence',
        path:
          '.pkg-nec-release/registry-evidence.json\n' +
          '.pkg-nec-release/registry-evidence.md\n' +
          '.pkg-nec-release/provenance-evidence.json\n' +
          '.pkg-nec-release/provenance-evidence.md\n',
      }),
    }),
  );

  for (const artifactName of [
    'pkg-nec-release-candidate',
    'pkg-nec-publication-evidence',
    'pkg-nec-registry-evidence',
  ]) {
    expect(findStep(evidence, `Download ${artifactName}`).with).toEqual({
      name: artifactName,
      path: '.pkg-nec-release',
    });
    expect(
      findStep(evidence, `Download ${artifactName}`)['continue-on-error'],
    ).toBe(true);
  }
  expect(findStep(evidence, 'Write workflow summary')).toEqual(
    expect.objectContaining({
      env: {RELEASE_TAG: '${{ github.event.release.tag_name }}'},
      run: expect.stringContaining('${{ needs.verify.result }}'),
    }),
  );
  const attachEvidenceStep = findStep(
    evidence,
    'Attach durable release evidence',
  );
  expect(evidence.permissions).toEqual({contents: 'write'});
  expect(
    evidence.steps.filter(step => step.uses?.startsWith('actions/checkout@')),
  ).toEqual([]);
  expect(attachEvidenceStep).toEqual(
    expect.objectContaining({
      env: {
        GH_TOKEN: '${{ github.token }}',
        RELEASE_TAG: '${{ github.event.release.tag_name }}',
      },
      run: expect.stringContaining(
        'gh release upload "$RELEASE_TAG" "${assets[@]}" --repo "${{ github.repository }}" --clobber',
      ),
    }),
  );
  expect(attachEvidenceStep.run).toContain(
    '.pkg-nec-release/release-ledger.json',
  );
  expect(attachEvidenceStep.run).toContain(
    '.pkg-nec-release/release-ledger.md',
  );
  expect(attachEvidenceStep.run).toContain(
    'jq -er \'.releasePlan.path | select(type == "string")\'',
  );
  expect(attachEvidenceStep.run).toContain(
    'jq -er \'.releasePlan.digest | select(test("^sha256-[0-9a-f]{64}$"))\'',
  );
  expect(attachEvidenceStep.run).toContain(
    '[[ "$plan_path" == "docs/releases/$plan_basename" ]]',
  );
  expect(attachEvidenceStep.run).toContain(
    'actual_plan_digest="sha256-$(sha256sum "$plan_asset" | awk',
  );
  expect(attachEvidenceStep.run).toContain('assets+=("$plan_asset")');
  expect(attachEvidenceStep.run).toContain('if [[ -f "$asset" ]]');
  expect(attachEvidenceStep.run).not.toContain('touch release-ledger.md');
  expect(attachEvidenceStep.env).not.toHaveProperty('GH_REPO');
  expect(attachEvidenceStep.run).not.toMatch(/\.(?:tgz|tar\.gz)\b/u);

  const shellSteps = Object.values(workflow.jobs).flatMap(job =>
    job.steps.filter(step => typeof step.run === 'string'),
  );
  const shellSource = shellSteps.map(step => step.run).join('\n');
  for (const expression of [
    '${{ github.event.release.tag_name }}',
    '${{ github.event.release.draft }}',
    '${{ github.event.release.prerelease }}',
  ]) {
    expect(shellSource).not.toContain(expression);
  }

  for (const [draft, prerelease, expectedStatus] of [
    ['false', 'false', 0],
    ['true', 'false', 1],
    ['false', 'true', 1],
  ]) {
    const child = spawnSync('bash', ['-c', stableReleaseStep.run], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        RELEASE_DRAFT: draft,
        RELEASE_PRERELEASE: prerelease,
      },
    });
    expect(child.status).toBe(expectedStatus);
  }

  const hostileTag = "@pkg-nec/jest-v1.2.3';printf${IFS}INJECTED>&2;'";
  expect(
    spawnSync('git', ['check-ref-format', `refs/tags/${hostileTag}`]).status,
  ).toBe(0);
  for (const [step, expectedArguments] of [
    [prepareStep, ['prepare:pkg-nec-release', hostileTag]],
    [
      publishStep,
      [
        'publish:pkg-nec-release',
        '.pkg-nec-release/release-ledger.json',
        '.pkg-nec-release/publication-journal.json',
        hostileTag,
      ],
    ],
  ]) {
    const child = spawnSync(
      'bash',
      ['-c', `yarn() { printf "%s\\0" "$@"; }\n${step.run}`],
      {
        cwd: repoRoot,
        encoding: 'buffer',
        env: {...process.env, RELEASE_TAG: hostileTag},
      },
    );
    expect(child.status).toBe(0);
    expect(child.stderr.toString('utf8')).not.toContain('INJECTED');
    expect(child.stdout.toString('utf8').split('\0').filter(Boolean)).toEqual(
      expectedArguments,
    );
  }

  const expectedActionNames = [
    'actions/checkout',
    'actions/download-artifact',
    'actions/setup-node',
    'actions/upload-artifact',
  ];
  const actionPinsByName = new Map(
    expectedActionNames.map(actionName => [actionName, new Set()]),
  );
  for (const {uses} of actionSteps) {
    const match = /^([^@\s]+)@([0-9a-f]{40})$/u.exec(uses);
    expect(match).not.toBeNull();
    const [, actionName, pin] = match;
    expect(expectedActionNames).toContain(actionName);
    actionPinsByName.get(actionName).add(pin);
  }
  for (const pins of actionPinsByName.values()) {
    expect(pins.size).toBe(1);
  }

  const actionSourceLines = workflowSource
    .split('\n')
    .filter(line => /^\s*uses:\s+/u.test(line));
  expect(actionSourceLines).toHaveLength(actionSteps.length);
  for (const line of actionSourceLines) {
    expect(line).toMatch(
      /^\s*uses:\s+[^@\s]+@[0-9a-f]{40}\s+# v\d+(?:\.\d+){0,2}\s*$/u,
    );
  }
  expect(workflowSource).not.toMatch(
    /NODE_AUTH_TOKEN|GH_REPO|check:pkg-nec-registry|cache:\s*yarn|yarn test(?:\s|$)/mu,
  );
  expect(
    fs.readFileSync(join(repoRoot, 'scripts/publishPkgNecRelease.mjs'), 'utf8'),
  ).toContain("      '--provenance',");
});
