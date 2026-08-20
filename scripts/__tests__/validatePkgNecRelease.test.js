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
