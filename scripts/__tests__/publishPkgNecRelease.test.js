/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const repoRoot = process.cwd();
const publisherModuleUrl = pathToFileURL(
  join(repoRoot, 'scripts/pkgNec/releasePublisher.mjs'),
).href;
const validIntegrity = `sha512-${'A'.repeat(86)}==`;
const ledger = {
  packages: [
    {integrity: validIntegrity, name: '@pkg-nec/a', order: 1, version: '1.0.0'},
    {integrity: validIntegrity, name: '@pkg-nec/b', order: 2, version: '2.0.0'},
    {
      integrity: validIntegrity,
      name: '@pkg-nec/c',
      order: 3,
      version: '3.0.0',
    },
  ],
  schemaVersion: 1,
  sourceCommit: '0123456789abcdef',
};

function matchingObserved(entry) {
  return {
    integrity: entry.integrity,
    kind: 'present',
    name: entry.name,
    version: entry.version,
  };
}

function runPublisherScenario(scenario) {
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
        import {publishRelease} from ${JSON.stringify(publisherModuleUrl)};
        const scenario = ${JSON.stringify(scenario)};
        const events = [];
        const persisted = [];
        let originalPublishError;
        const entryJournalEvent = journal => {
          const completed = journal.packages.at(-1);
          return completed
            ? 'journal:' + completed.name + ':' + completed.disposition
            : 'journal:empty';
        };
        try {
          const journal = await publishRelease({
            inspect: async entry => {
              events.push('inspect:' + entry.name);
              return scenario.inspections?.[entry.name] ?? {kind: 'absent'};
            },
            ledger: scenario.ledger,
            now: () => '2026-08-19T12:34:56.000Z',
            persistJournal: async journal => {
              events.push(entryJournalEvent(journal));
              persisted.push(structuredClone(journal));
            },
            publish: async entry => {
              events.push('publish:' + entry.name);
              if (scenario.publishError) {
                originalPublishError = Object.assign(
                  new Error(scenario.publishError.message),
                  {classification: scenario.publishError.classification},
                );
                throw originalPublishError;
              }
            },
            releaseTag: scenario.releaseTag,
            verifyConflict: async entry => {
              events.push('verify-conflict:' + entry.name);
              return scenario.conflictResults?.[entry.name];
            },
          });
          console.log(JSON.stringify({events, journal, persisted}));
        } catch (error) {
          console.log(JSON.stringify({
            error: error.message,
            events,
            isOriginalPublishError: error === originalPublishError,
            persisted,
          }));
        }
      `,
    ],
    {cwd: repoRoot, encoding: 'utf8'},
  );
  if (child.status !== 0) throw new Error(child.stderr || child.stdout);
  return JSON.parse(child.stdout.trim());
}

function scenario(overrides = {}) {
  return {ledger, releaseTag: '@pkg-nec/jest-v30.4.3', ...overrides};
}

test('publishes in ledger order without a post-publish registry verification', () => {
  const result = runPublisherScenario(scenario());

  expect(result.events).toEqual([
    'journal:empty',
    'inspect:@pkg-nec/a',
    'publish:@pkg-nec/a',
    'journal:@pkg-nec/a:published',
    'inspect:@pkg-nec/b',
    'publish:@pkg-nec/b',
    'journal:@pkg-nec/b:published',
    'inspect:@pkg-nec/c',
    'publish:@pkg-nec/c',
    'journal:@pkg-nec/c:published',
  ]);
  expect(result.journal).toEqual({
    packages: [
      {
        completedAt: '2026-08-19T12:34:56.000Z',
        disposition: 'published',
        integrity: validIntegrity,
        name: '@pkg-nec/a',
        order: 1,
        version: '1.0.0',
      },
      {
        completedAt: '2026-08-19T12:34:56.000Z',
        disposition: 'published',
        integrity: validIntegrity,
        name: '@pkg-nec/b',
        order: 2,
        version: '2.0.0',
      },
      {
        completedAt: '2026-08-19T12:34:56.000Z',
        disposition: 'published',
        integrity: validIntegrity,
        name: '@pkg-nec/c',
        order: 3,
        version: '3.0.0',
      },
    ],
    releaseTag: '@pkg-nec/jest-v30.4.3',
    schemaVersion: 1,
    sourceCommit: '0123456789abcdef',
  });
});

test('persists an empty journal before its first inspection and each completed entry', () => {
  const result = runPublisherScenario(
    scenario({ledger: {...ledger, packages: ledger.packages.slice(0, 2)}}),
  );

  expect(result.persisted).toEqual([
    {
      packages: [],
      releaseTag: '@pkg-nec/jest-v30.4.3',
      schemaVersion: 1,
      sourceCommit: '0123456789abcdef',
    },
    {
      packages: [
        {
          completedAt: '2026-08-19T12:34:56.000Z',
          disposition: 'published',
          integrity: validIntegrity,
          name: '@pkg-nec/a',
          order: 1,
          version: '1.0.0',
        },
      ],
      releaseTag: '@pkg-nec/jest-v30.4.3',
      schemaVersion: 1,
      sourceCommit: '0123456789abcdef',
    },
    {
      packages: [
        {
          completedAt: '2026-08-19T12:34:56.000Z',
          disposition: 'published',
          integrity: validIntegrity,
          name: '@pkg-nec/a',
          order: 1,
          version: '1.0.0',
        },
        {
          completedAt: '2026-08-19T12:34:56.000Z',
          disposition: 'published',
          integrity: validIntegrity,
          name: '@pkg-nec/b',
          order: 2,
          version: '2.0.0',
        },
      ],
      releaseTag: '@pkg-nec/jest-v30.4.3',
      schemaVersion: 1,
      sourceCommit: '0123456789abcdef',
    },
  ]);
});

test('resumes a package already present with its matching integrity', () => {
  const entry = ledger.packages[0];
  const result = runPublisherScenario(
    scenario({
      inspections: {[entry.name]: matchingObserved(entry)},
      ledger: {...ledger, packages: [entry]},
    }),
  );

  expect(result.events).toEqual([
    'journal:empty',
    'inspect:@pkg-nec/a',
    'journal:@pkg-nec/a:verified-existing',
  ]);
  expect(result.journal.packages).toEqual([
    {
      completedAt: '2026-08-19T12:34:56.000Z',
      disposition: 'verified-existing',
      integrity: validIntegrity,
      name: '@pkg-nec/a',
      order: 1,
      version: '1.0.0',
    },
  ]);
});

test('rejects mismatched present integrity without publishing', () => {
  const entry = ledger.packages[0];
  const result = runPublisherScenario(
    scenario({
      inspections: {
        [entry.name]: {
          ...matchingObserved(entry),
          integrity: 'sha512-different',
        },
      },
      ledger: {...ledger, packages: [entry]},
    }),
  );

  expect(result.error).toBe('Registry integrity mismatch for @pkg-nec/a@1.0.0');
  expect(result.events).toEqual(['journal:empty', 'inspect:@pkg-nec/a']);
});

test('rejects present packages whose name or version differs', () => {
  const entry = ledger.packages[0];
  const mismatches = [
    {
      integrity: validIntegrity,
      kind: 'present',
      name: '@pkg-nec/unexpected',
      version: '1.0.0',
    },
    {
      integrity: validIntegrity,
      kind: 'present',
      name: '@pkg-nec/a',
      version: '1.0.1',
    },
  ];

  for (const observed of mismatches) {
    const result = runPublisherScenario(
      scenario({
        inspections: {'@pkg-nec/a': observed},
        ledger: {...ledger, packages: [entry]},
      }),
    );

    expect(result.error).toBe(
      'Registry integrity mismatch for @pkg-nec/a@1.0.0',
    );
    expect(result.events).toEqual(['journal:empty', 'inspect:@pkg-nec/a']);
  }
});

test('rejects an indeterminate registry inspection without publishing', () => {
  const entry = ledger.packages[0];
  const result = runPublisherScenario(
    scenario({
      inspections: {[entry.name]: {kind: 'indeterminate'}},
      ledger: {...ledger, packages: [entry]},
    }),
  );

  expect(result.error).toBe(
    'Indeterminate registry state for @pkg-nec/a@1.0.0',
  );
  expect(result.events).toEqual(['journal:empty', 'inspect:@pkg-nec/a']);
});

test('recovers a version conflict only when conflict verification matches', () => {
  const entry = ledger.packages[0];
  const result = runPublisherScenario(
    scenario({
      conflictResults: {[entry.name]: matchingObserved(entry)},
      ledger: {...ledger, packages: [entry]},
      publishError: {
        classification: 'version-conflict',
        message: 'version already exists',
      },
    }),
  );

  expect(result.events).toEqual([
    'journal:empty',
    'inspect:@pkg-nec/a',
    'publish:@pkg-nec/a',
    'verify-conflict:@pkg-nec/a',
    'journal:@pkg-nec/a:verified-existing',
  ]);
  expect(result.journal.packages[0].disposition).toBe('verified-existing');
});

test('rejects a version conflict when verification has mismatched integrity', () => {
  const entry = ledger.packages[0];
  const result = runPublisherScenario(
    scenario({
      conflictResults: {
        [entry.name]: {
          ...matchingObserved(entry),
          integrity: 'sha512-different',
        },
      },
      ledger: {...ledger, packages: [entry]},
      publishError: {
        classification: 'version-conflict',
        message: 'version already exists',
      },
    }),
  );

  expect(result.error).toBe('Registry integrity mismatch for @pkg-nec/a@1.0.0');
  expect(result.events).toEqual([
    'journal:empty',
    'inspect:@pkg-nec/a',
    'publish:@pkg-nec/a',
    'verify-conflict:@pkg-nec/a',
  ]);
});

test('rejects conflict verification whose name or version differs', () => {
  const entry = ledger.packages[0];
  const mismatches = [
    {
      integrity: validIntegrity,
      kind: 'present',
      name: '@pkg-nec/unexpected',
      version: '1.0.0',
    },
    {
      integrity: validIntegrity,
      kind: 'present',
      name: '@pkg-nec/a',
      version: '1.0.1',
    },
  ];

  for (const conflictResult of mismatches) {
    const result = runPublisherScenario(
      scenario({
        conflictResults: {'@pkg-nec/a': conflictResult},
        ledger: {...ledger, packages: [entry]},
        publishError: {
          classification: 'version-conflict',
          message: 'version already exists',
        },
      }),
    );

    expect(result.error).toBe(
      'Registry integrity mismatch for @pkg-nec/a@1.0.0',
    );
    expect(result.events).toEqual([
      'journal:empty',
      'inspect:@pkg-nec/a',
      'publish:@pkg-nec/a',
      'verify-conflict:@pkg-nec/a',
    ]);
  }
});

test('propagates a publish failure and stops before the next ledger entry', () => {
  const result = runPublisherScenario(
    scenario({publishError: {message: 'network unavailable'}}),
  );

  expect(result.error).toBe('network unavailable');
  expect(result.isOriginalPublishError).toBe(true);
  expect(result.events).toEqual([
    'journal:empty',
    'inspect:@pkg-nec/a',
    'publish:@pkg-nec/a',
  ]);
});

test('rejects invalid ledgers before invoking any adapter', () => {
  const invalidLedgers = [
    [{...ledger, schemaVersion: 2}, 'Unsupported release ledger schema'],
    [{...ledger, packages: {}}, 'Release ledger packages must be an array'],
    [
      {...ledger, packages: [{...ledger.packages[0], order: 2}]},
      'Release ledger package order must be contiguous',
    ],
    [
      {
        ...ledger,
        packages: [ledger.packages[0], {...ledger.packages[0], order: 2}],
      },
      'Duplicate release ledger package: @pkg-nec/a',
    ],
    [
      {
        ...ledger,
        packages: [{...ledger.packages[0], integrity: 'sha256-alpha'}],
      },
      'Invalid release ledger integrity for @pkg-nec/a',
    ],
    [
      {...ledger, packages: [{...ledger.packages[0], integrity: 'sha512-'}]},
      'Invalid release ledger integrity for @pkg-nec/a',
    ],
    [
      {
        ...ledger,
        packages: [{...ledger.packages[0], integrity: 'sha512-not-base64!'}],
      },
      'Invalid release ledger integrity for @pkg-nec/a',
    ],
    [
      {...ledger, packages: [{...ledger.packages[0], integrity: 'sha512-abc'}]},
      'Invalid release ledger integrity for @pkg-nec/a',
    ],
  ];

  for (const [invalidLedger, message] of invalidLedgers) {
    const result = runPublisherScenario(scenario({ledger: invalidLedger}));
    expect(result.error).toBe(message);
    expect(result.events).toEqual([]);
  }

  const result = runPublisherScenario(scenario({releaseTag: ''}));
  expect(result.error).toBe('Release tag is required');
  expect(result.events).toEqual([]);
});
