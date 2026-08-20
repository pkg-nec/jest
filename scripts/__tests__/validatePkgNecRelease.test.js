/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

const {spawnSync} = require('node:child_process');
const {pathToFileURL} = require('node:url');
const {join} = require('node:path');

const repoRoot = process.cwd();
const validationModuleUrl = pathToFileURL(
  join(repoRoot, 'scripts/pkgNec/releaseValidation.mjs'),
).href;
const validateCommandModuleUrl = pathToFileURL(
  join(repoRoot, 'scripts/validatePkgNecRelease.mjs'),
).href;
const sourceCommit = '0123456789abcdef0123456789abcdef01234567';
const packageNames = [
  '@pkg-nec/jest',
  ...Array.from(
    {length: 54},
    (_, index) => `@pkg-nec/package-${String(index + 1).padStart(2, '0')}`,
  ),
];

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
  const inventoryEntries = packageNames.map((name, index) => [
    name,
    {
      newName: name,
      publishable: true,
      version: index === 0 ? '30.4.3' : '30.4.2',
    },
  ]);
  const packages = inventoryEntries.map(([name, identity], index) => ({
    name,
    order: index + 1,
    version: identity.version,
  }));
  return {
    event: {
      release: {
        body: [
          `Source commit: ${sourceCommit}`,
          ...packages.map(item => `- \`${item.name}@${item.version}\``),
        ].join('\n'),
        name: '@pkg-nec/jest-v30.4.3',
        tag_name: '@pkg-nec/jest-v30.4.3',
      },
    },
    inventoryEntries,
    ledger: {packages, schemaVersion: 1, sourceCommit},
    tagCommit: sourceCommit,
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
        tagCommit: input.tagCommit,
      });
      console.log(JSON.stringify({result}));
    } catch (error) {
      console.log(JSON.stringify({error: error.message}));
    }
  `);
}

test('parses release tags, selects the anchor, and validates patch-only transitions', () => {
  const result = runValidationProgram(`
    import {
      parseReleaseTag,
      selectReleaseAnchor,
      validatePatchTransitions,
    } from ${JSON.stringify(validationModuleUrl)};

    let invalidTag;
    try {
      parseReleaseTag('v30.4.3');
    } catch (error) {
      invalidTag = error.message;
    }
    let invalidTransition;
    try {
      validatePatchTransitions({
        currentPackages: new Map([['@pkg-nec/jest', '30.5.0']]),
        previousPackages: new Map([['@pkg-nec/jest', '30.4.2']]),
      });
    } catch (error) {
      invalidTransition = error.message;
    }
    console.log(JSON.stringify({
      invalidTag,
      invalidTransition,
      parsed: parseReleaseTag('@pkg-nec/jest-v30.4.3'),
      selected: selectReleaseAnchor([
        '@pkg-nec/jest-reporters',
        '@pkg-nec/jest',
      ]),
      transitions: validatePatchTransitions({
        currentPackages: new Map([['@pkg-nec/jest', '30.4.3']]),
        previousPackages: new Map([['@pkg-nec/jest', '30.4.2']]),
      }),
    }));
  `);

  expect(result).toEqual({
    invalidTag: expect.stringMatching(/release tag/i),
    invalidTransition: expect.stringMatching(/one patch/i),
    parsed: {anchorName: '@pkg-nec/jest', anchorVersion: '30.4.3'},
    selected: '@pkg-nec/jest',
    transitions: ['@pkg-nec/jest'],
  });
});

test('validates a complete 55-package release event against the packed ledger', () => {
  expect(validateFixture(releaseFixture())).toEqual({
    result: {
      anchorName: '@pkg-nec/jest',
      anchorVersion: '30.4.3',
      packageCount: 55,
      sourceCommit,
      tagName: '@pkg-nec/jest-v30.4.3',
    },
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
          {...input.ledger.packages[0], order: 55},
        ],
      },
    }),
    /duplicate|publishable package/i,
  ],
  [
    'a release body missing a published package entry',
    input => ({
      ...input,
      event: {
        release: {
          ...input.event.release,
          body: input.event.release.body.replace(
            /\n- `@pkg-nec\/package-54@30\.4\.2`$/u,
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
          name: '@pkg-nec/jest-v30.4.2',
          tag_name: '@pkg-nec/jest-v30.4.2',
        },
      },
    }),
    /anchor|tag/i,
  ],
  [
    'a ledger with fewer than 55 packages',
    input => ({
      ...input,
      ledger: {...input.ledger, packages: input.ledger.packages.slice(0, -1)},
    }),
    /55 release package/i,
  ],
  [
    'a ledger version that differs from the source manifest',
    input => ({
      ...input,
      inventoryEntries: input.inventoryEntries.map(([name, identity]) =>
        name === '@pkg-nec/package-01'
          ? [name, {...identity, version: '30.4.3'}]
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
        name === '@pkg-nec/package-01'
          ? [name, {...identity, publishable: false}]
          : [name, identity],
      ),
    }),
    /publishable/i,
  ],
  [
    'a ledger that omits a public inventory package',
    input => ({
      ...input,
      inventoryEntries: [
        ...input.inventoryEntries,
        [
          '@pkg-nec/package-55',
          {
            newName: '@pkg-nec/package-55',
            publishable: true,
            version: '30.4.2',
          },
        ],
      ],
    }),
    /public package set/i,
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
    /invalid release package at order 1/i,
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

test('collects the tagged release context and accepts the matching Node CI run', () => {
  const result = runValidateCommandProgram(`
    const fetchCalls = [];
    const gitCalls = [];
    const lines = [];
    const inventory = {
      byNewName: new Map(Array.from({length: 55}, (_, index) => {
        const name = index === 0 ? '@pkg-nec/jest' : '@pkg-nec/package-' + String(index).padStart(2, '0');
        return [name, {
          manifestPath: '/repo/packages/package-' + String(index).padStart(2, '0') + '/package.json',
          newName: name,
          publishable: true,
          version: '30.4.3',
        }];
      })),
    };
    const ledger = {
      packages: Array.from(inventory.byNewName.values(), (item, index) => ({
        name: item.newName, order: index + 1, version: item.version,
      })),
      schemaVersion: 1,
      sourceCommit: 'abc123',
    };
    const result = await runValidateReleaseCommand({
      args: ['release-ledger.json'],
      createInventory: () => inventory,
      env: {
        GITHUB_EVENT_PATH: 'event.json',
        GITHUB_REPOSITORY: 'pkg-nec/jest',
        GITHUB_TOKEN: 'github-test-token',
      },
      fetchImpl: async (url, options) => {
        fetchCalls.push({headers: options.headers, url});
        return {json: async () => ({workflow_runs: [{
          conclusion: 'success', event: 'push', head_branch: 'main', head_sha: 'abc123',
        }]})};
      },
      readFile: async file => file === 'event.json'
        ? JSON.stringify({release: {tag_name: '@pkg-nec/jest-v30.4.3'}})
        : JSON.stringify(ledger),
      runGit: async (args, options) => {
        gitCalls.push({args, cwd: options.cwd});
        if (args[0] === 'rev-list') return 'abc123';
        if (args[0] === 'describe') return '@pkg-nec/jest-v30.4.2';
        if (args[0] === 'show') return JSON.stringify({version: '30.4.2'});
        return '';
      },
      validateReleaseMetadata: () => ({
        packageCount: 55, sourceCommit: 'abc123', tagName: '@pkg-nec/jest-v30.4.3',
      }),
      repoRoot: '/repo',
      write: line => lines.push(line),
    });
    console.log(JSON.stringify({fetchCalls, gitCalls, lines, result}));
  `);

  expect(result.fetchCalls).toEqual([
    {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: 'Bearer github-test-token',
        'x-github-api-version': '2022-11-28',
      },
      url: 'https://api.github.com/repos/pkg-nec/jest/actions/workflows/nodejs.yml/runs?head_sha=abc123&status=completed&per_page=100',
    },
  ]);
  expect(result.gitCalls.map(call => call.args)).toEqual([
    ['rev-list', '-n', '1', '@pkg-nec/jest-v30.4.3'],
    ['merge-base', '--is-ancestor', 'abc123', 'origin/main'],
    ['describe', '--tags', '--abbrev=0', '@pkg-nec/jest-v30.4.3^'],
    ...Array.from({length: 55}, (_, index) => [
      'show',
      `@pkg-nec/jest-v30.4.2:packages/package-${String(index).padStart(2, '0')}/package.json`,
    ]),
  ]);
  expect(result).toEqual(
    expect.objectContaining({
      lines: [
        'classification=valid',
        'tag=@pkg-nec/jest-v30.4.3',
        'sourceCommit=abc123',
        'packageCount=55',
      ],
      result: {
        packageCount: 55,
        sourceCommit: 'abc123',
        tagName: '@pkg-nec/jest-v30.4.3',
      },
    }),
  );
});

test('rejects invalid arguments and redacts GitHub tokens from adapter errors', () => {
  const result = runValidateCommandProgram(`
    const cases = [];
    for (const input of [
      {args: [], env: {}},
      {
        args: ['ledger.json'],
        env: {
          GITHUB_EVENT_PATH: 'event.json',
          GITHUB_REPOSITORY: 'pkg-nec/jest',
          GITHUB_TOKEN: 'github-secret-token',
        },
        fetchImpl: async () => {throw new Error('request failed: Bearer github-secret-token');},
        readFile: async file => file === 'event.json'
          ? JSON.stringify({release: {tag_name: '@pkg-nec/jest-v30.4.3'}})
          : JSON.stringify({packages: [], schemaVersion: 1, sourceCommit: 'abc123'}),
        runGit: async () => 'abc123',
        createInventory: () => ({byNewName: new Map()}),
        validateReleaseMetadata: () => ({}),
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
    try {
      await runValidateReleaseCommand({
        args: ['ledger.json'],
        createInventory: () => ({byNewName: new Map()}),
        env: {
          GITHUB_EVENT_PATH: 'event.json',
          GITHUB_REPOSITORY: 'pkg-nec/jest',
          GITHUB_TOKEN: 'github-test-token',
        },
        fetchImpl: async () => ({json: async () => ({workflow_runs: [{
          conclusion: 'failure', event: 'push', head_branch: 'main', head_sha: 'abc123',
        }]})}),
        readFile: async file => file === 'event.json'
          ? JSON.stringify({release: {tag_name: '@pkg-nec/jest-v30.4.3'}})
          : JSON.stringify({packages: [], schemaVersion: 1, sourceCommit: 'abc123'}),
        runGit: async args => args[0] === 'describe'
          ? '@pkg-nec/jest-v30.4.2'
          : args[0] === 'show'
            ? JSON.stringify({version: '30.4.2'})
            : 'abc123',
        validateReleaseMetadata: () => ({}),
      });
    } catch (error) {
      console.log(JSON.stringify(error.message));
    }
  `);

  expect(result).toBe('Node CI did not succeed for abc123');
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
        GITHUB_TOKEN: '',
      },
    },
  );

  expect(command.status).toBe(1);
  expect(command.stdout).toBe('');
  expect(command.stderr).toBe(
    'Required environment: GITHUB_EVENT_PATH, GITHUB_REPOSITORY, GITHUB_TOKEN\n',
  );
});
