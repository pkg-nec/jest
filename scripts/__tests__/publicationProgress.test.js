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
const publicationProgressModuleUrl = pathToFileURL(
  join(repoRoot, 'scripts/pkgNec/publicationProgress.mjs'),
).href;
const publicationSummaryCommandModuleUrl = pathToFileURL(
  join(repoRoot, 'scripts/summarizePkgNecPublication.mjs'),
).href;

function runPublicationProgressProgram(program) {
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
        import {
          publicationProgressLine,
          publicationSummary,
          publicationSummaryMarkdown,
        } from ${JSON.stringify(publicationProgressModuleUrl)};
        ${program}
      `,
    ],
    {cwd: repoRoot, encoding: 'utf8'},
  );
  if (child.status !== 0) throw new Error(child.stderr || child.stdout);
  return JSON.parse(child.stdout.trim());
}

function runPublicationSummaryCommand(input) {
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
        import {runPublicationSummaryCommand} from ${JSON.stringify(publicationSummaryCommandModuleUrl)};
        const input = ${JSON.stringify(input)};
        const writes = [];
        try {
          const summary = await runPublicationSummaryCommand({
            args: input.args,
            readFile: async path => input.files[path],
            write: value => writes.push(value),
          });
          console.log(JSON.stringify({summary, writes}));
        } catch (error) {
          console.log(JSON.stringify({error: error.message, writes}));
        }
      `,
    ],
    {cwd: repoRoot, encoding: 'utf8'},
  );
  if (child.status !== 0) throw new Error(child.stderr || child.stdout);
  return JSON.parse(child.stdout.trim());
}

function runPublicationSummaryCli(args) {
  return spawnSync(
    process.execPath,
    [join(repoRoot, 'scripts/summarizePkgNecPublication.mjs'), ...args],
    {cwd: repoRoot, encoding: 'utf8'},
  );
}

const ledger = {
  packages: [{name: '@pkg-nec/a'}, {name: '@pkg-nec/b'}, {name: '@pkg-nec/c'}],
};
const journal = {
  packages: [
    {disposition: 'published', name: '@pkg-nec/a'},
    {disposition: 'verified-existing', name: '@pkg-nec/b'},
  ],
};
const validIntegrity = `sha512-${'A'.repeat(86)}==`;
const validatedLedger = {
  packages: [
    {
      files: ['package.json'],
      integrity: validIntegrity,
      name: '@pkg-nec/a',
      order: 1,
      prerequisites: [],
      tarball: '.pkg-nec-release/pkg-nec-a-1.0.0.tgz',
      version: '1.0.0',
    },
    {
      files: ['package.json'],
      integrity: validIntegrity,
      name: '@pkg-nec/b',
      order: 2,
      prerequisites: [],
      tarball: '.pkg-nec-release/pkg-nec-b-2.0.0.tgz',
      version: '2.0.0',
    },
  ],
  schemaVersion: 1,
  sourceCommit: '0123456789abcdef0123456789abcdef01234567',
};
const validatedJournal = {
  packages: [
    {
      completedAt: '2026-08-20T00:00:00.000Z',
      disposition: 'published',
      integrity: validIntegrity,
      name: '@pkg-nec/a',
      order: 1,
      version: '1.0.0',
    },
  ],
  releaseTag: '@pkg-nec/jest-v30.4.3',
  schemaVersion: 1,
  sourceCommit: '0123456789abcdef0123456789abcdef01234567',
};

// Mutation caught: omitting a completed package's live terminal line or
// rendering its order, identity, version, or disposition incorrectly.
test('renders a live publication progress line', () => {
  const event = {
    completedAt: '2026-08-20T00:00:00.000Z',
    disposition: 'verified-existing',
    name: '@pkg-nec/a',
    order: 17,
    total: 23,
    version: '1.2.3',
  };
  expect(
    runPublicationProgressProgram(
      `console.log(JSON.stringify(publicationProgressLine(${JSON.stringify(event)})));`,
    ),
  ).toBe('[17/23] @pkg-nec/a@1.2.3: verified-existing');
});

// Mutation caught: treating verified-existing packages as published, or
// deriving the selected total from completed journal entries.
test('summarizes published and verified-existing packages separately', () => {
  expect(
    runPublicationProgressProgram(
      `console.log(JSON.stringify(publicationSummary(${JSON.stringify({journal, ledger})})));`,
    ),
  ).toEqual({
    completed: 2,
    published: 1,
    total: 3,
    verifiedExisting: 1,
  });
});

// Mutation caught: omitting or mislabelling a durable partial aggregate line.
test('renders a markdown publication summary', () => {
  expect(
    runPublicationProgressProgram(
      `console.log(JSON.stringify(publicationSummaryMarkdown(${JSON.stringify({journal, ledger})})));`,
    ),
  ).toBe(
    '# pkg-nec publication summary\n\n' +
      '- Total selected packages: 3\n' +
      '- Completed: 2\n' +
      '- Published: 1\n' +
      '- Verified existing: 1\n',
  );
});

// Mutation caught: counting a completed journal package which was not selected
// by the release ledger.
test('rejects a journal package absent from the ledger', () => {
  const input = {
    journal: {packages: [{disposition: 'published', name: '@pkg-nec/other'}]},
    ledger,
  };
  expect(
    runPublicationProgressProgram(`
      try {
        publicationSummary(${JSON.stringify(input)});
      } catch (error) {
        console.log(JSON.stringify(error.message));
      }
    `),
  ).toBe('Invalid publication summary entry: @pkg-nec/other');
});

// Mutation caught: allowing a package to increase aggregate counts twice.
test('rejects duplicate journal packages', () => {
  const input = {
    journal: {
      packages: [
        {disposition: 'published', name: '@pkg-nec/a'},
        {disposition: 'verified-existing', name: '@pkg-nec/a'},
      ],
    },
    ledger,
  };
  expect(
    runPublicationProgressProgram(`
      try {
        publicationSummary(${JSON.stringify(input)});
      } catch (error) {
        console.log(JSON.stringify(error.message));
      }
    `),
  ).toBe('Invalid publication summary entry: @pkg-nec/a');
});

// Mutation caught: silently categorizing an unrecognized publication outcome.
test('rejects invalid publication dispositions', () => {
  const input = {
    journal: {
      packages: [{disposition: 'indeterminate', name: '@pkg-nec/a'}],
    },
    ledger,
  };
  expect(
    runPublicationProgressProgram(`
      try {
        publicationSummary(${JSON.stringify(input)});
      } catch (error) {
        console.log(JSON.stringify(error.message));
      }
    `),
  ).toBe('Invalid publication disposition: indeterminate');
});

// Mutation caught: reporting more completed packages than the selected ledger.
test('rejects completed counts greater than the ledger total', () => {
  const input = {
    journal: {
      packages: [
        {disposition: 'published', name: '@pkg-nec/a'},
        {disposition: 'published', name: '@pkg-nec/b'},
        {disposition: 'published', name: '@pkg-nec/c'},
        {disposition: 'published', name: '@pkg-nec/d'},
      ],
    },
    ledger,
  };
  expect(
    runPublicationProgressProgram(`
      try {
        publicationSummary(${JSON.stringify(input)});
      } catch (error) {
        console.log(JSON.stringify(error.message));
      }
    `),
  ).toBe('Completed publication count exceeds release ledger total');
});

// Mutation caught: reading a partial durable journal without validating it,
// returning the wrong aggregate, or writing more than one summary.
test('writes one validated partial publication summary', () => {
  const result = runPublicationSummaryCommand({
    args: ['release-ledger.json', 'publication-journal.json'],
    files: {
      'publication-journal.json': JSON.stringify(validatedJournal),
      'release-ledger.json': JSON.stringify(validatedLedger),
    },
  });

  expect(result).toEqual({
    summary: {
      completed: 1,
      published: 1,
      total: 2,
      verifiedExisting: 0,
    },
    writes: [
      '# pkg-nec publication summary\n\n' +
        '- Total selected packages: 2\n' +
        '- Completed: 1\n' +
        '- Published: 1\n' +
        '- Verified existing: 0\n',
    ],
  });
});

// Mutation caught: accepting an incomplete command invocation with ambiguous
// ledger or journal paths.
test('rejects summary command usage without reading or writing', () => {
  const result = runPublicationSummaryCommand({args: [], files: {}});

  expect(result).toEqual({
    error:
      'Usage: yarn summarize:pkg-nec-publication <ledger-path> <journal-path>',
    writes: [],
  });
});

// Mutation caught: failing to recognize direct script execution or reporting
// standalone CLI usage as a successful no-op.
test('reports summary command usage on direct invocation', () => {
  const result = runPublicationSummaryCli([]);

  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe(
    'Usage: yarn summarize:pkg-nec-publication <ledger-path> <journal-path>\n',
  );
});

// Mutation caught: bypassing the established release-ledger validator or
// accepting a malformed partial journal before rendering output.
test('rejects invalid summary ledger and journal inputs before writing', () => {
  const cases = [
    {
      files: {
        'publication-journal.json': JSON.stringify(validatedJournal),
        'release-ledger.json': JSON.stringify({
          ...validatedLedger,
          schemaVersion: 2,
        }),
      },
      message: 'Unsupported release ledger schema',
    },
    {
      files: {
        'publication-journal.json': JSON.stringify({
          ...validatedJournal,
          packages: [{...validatedJournal.packages[0], unexpected: true}],
        }),
        'release-ledger.json': JSON.stringify(validatedLedger),
      },
      message:
        'Unexpected publication journal package at order 1 field: unexpected',
    },
  ];

  for (const {files, message} of cases) {
    expect(
      runPublicationSummaryCommand({
        args: ['release-ledger.json', 'publication-journal.json'],
        files,
      }),
    ).toEqual({error: message, writes: []});
  }
});
