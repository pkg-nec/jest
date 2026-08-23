/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

const {spawnSync} = require('node:child_process');
const path = require('node:path');
const {pathToFileURL} = require('node:url');

const commandUrl = pathToFileURL(
  path.join(process.cwd(), 'scripts/draftPkgNecRelease.mjs'),
).href;

const baselineCommit = '1111111111111111111111111111111111111111';
const introductionCommit = '2222222222222222222222222222222222222222';
const observedCommit = '3333333333333333333333333333333333333333';
const baselineTag = '@pkg-nec/jest-v30.4.3';
const planTag = '@pkg-nec/jest-v30.5.0';
const planPath = 'docs/releases/pkg-nec-jest-v30.5.0-plan.json';
const draftUrl = 'https://github.com/pkg-nec/jest/releases/tag/untagged-abc';
const separator = process.platform === 'win32' ? '\\' : '/';
const notesPath = `${process.cwd()}${separator}.pkg-nec-release${separator}draft-release-notes.md`;

function plan() {
  return {
    anchor: {name: '@pkg-nec/jest', tag: planTag, version: '30.5.0'},
    changedFiles: {
      packages: [
        {files: ['packages/jest/src/index.ts'], name: '@pkg-nec/jest'},
      ],
      root: {allPackages: [], ambiguous: [], noImpact: []},
    },
    packages: [
      {
        bump: 'minor',
        fromVersion: '30.4.3',
        name: '@pkg-nec/jest',
        order: 1,
        path: 'packages/jest',
        reasons: [{files: ['packages/jest/src/index.ts'], kind: 'changed'}],
        toVersion: '30.5.0',
      },
    ],
    planPath,
    preparedFrom: introductionCommit,
    previousRelease: {commit: baselineCommit, tag: baselineTag},
    rootImpact: {applied: 'not-needed', requested: null},
    schemaVersion: 1,
  };
}

function completedRelease() {
  return {
    assets: releaseAssetFixtures().map(({name, url}) => ({name, url})),
    draft: false,
    html_url: `https://github.com/pkg-nec/jest/releases/tag/${baselineTag}`,
    prerelease: false,
    published_at: '2026-08-20T00:00:00.000Z',
    tag_name: baselineTag,
  };
}

function releaseAssetFixtures() {
  const packages = [{name: '@pkg-nec/jest', order: 1, version: '30.4.3'}];
  const evidence = {
    packages,
    releaseTag: baselineTag,
    schemaVersion: 1,
    sourceCommit: baselineCommit,
  };
  const runUrl = 'https://github.com/pkg-nec/jest/actions/runs/100';
  const contents = [
    {
      content:
        '# pkg-nec release workflow evidence\n\n' +
        `- Release tag: \`${baselineTag}\`\n` +
        `- Source workflow run: ${runUrl}\n` +
        '- Validate job: `success`\n' +
        '- Publish job: `success`\n' +
        '- Verify job: `success`\n',
      name: 'workflow-summary.md',
    },
    {
      content: JSON.stringify({
        packages,
        schemaVersion: 1,
        sourceCommit: baselineCommit,
      }),
      name: 'release-ledger.json',
    },
    {content: JSON.stringify(evidence), name: 'publication-journal.json'},
    {content: JSON.stringify(evidence), name: 'registry-evidence.json'},
    {content: JSON.stringify(evidence), name: 'provenance-evidence.json'},
  ];
  return contents.map((asset, index) => ({
    ...asset,
    url: `https://api.github.com/repos/pkg-nec/jest/releases/assets/${index + 1}`,
  }));
}

function releaseRun() {
  return {
    conclusion: 'success',
    event: 'release',
    head_branch: baselineTag,
    head_sha: baselineCommit,
    html_url: 'https://github.com/pkg-nec/jest/actions/runs/100',
    path: '.github/workflows/release.yml',
    status: 'completed',
  };
}

function nodeRun() {
  return {
    conclusion: 'success',
    event: 'push',
    head_branch: 'main',
    head_sha: introductionCommit,
    html_url: 'https://github.com/pkg-nec/jest/actions/runs/200',
    path: '.github/workflows/nodejs.yml',
    status: 'completed',
  };
}

const releaseEndpoint = 'repos/pkg-nec/jest/releases?per_page=100';
const releaseRunsEndpoint =
  'repos/pkg-nec/jest/actions/workflows/release.yml/runs?per_page=100';
const nodeRunsEndpoint = `repos/pkg-nec/jest/actions/workflows/nodejs.yml/runs?event=push&branch=main&head_sha=${introductionCommit}&status=completed&per_page=100`;
const releaseAssetEvents = [
  'gh api release asset workflow-summary.md',
  'gh api release asset release-ledger.json',
  'gh api release asset publication-journal.json',
  'gh api release asset registry-evidence.json',
  'gh api release asset provenance-evidence.json',
];

const keyOrder = [
  'git status --porcelain',
  'git fetch origin main:refs/remotes/origin/main --tags',
  'git rev-parse HEAD',
  'git rev-parse origin/main',
  'gh auth status',
  'gh repo view --json nameWithOwner',
  'gh api releases',
  ...releaseAssetEvents,
  'git log introduction commit',
  'git show introduction plan',
  'git merge-base --is-ancestor introduction origin/main',
  'gh api exact Node runs',
  'write ignored notes',
  'gh api create release tag',
  'git fetch created tag',
  'git rev-list created tag',
  'gh release create --draft --verify-tag',
  'write success URL/instructions',
];

const preDraftFailurePoints = [
  'git status --porcelain',
  'git fetch origin main:refs/remotes/origin/main --tags',
  'git rev-parse HEAD',
  'git rev-parse origin/main',
  'gh auth status',
  'gh repo view --json nameWithOwner',
  'gh api releases',
  'gh api release runs',
  ...releaseAssetEvents,
  'git list release tags',
  'git resolve baseline tag',
  'git list tracked plans',
  'read tracked plan',
  'git log introduction commit',
  'git show introduction plan',
  'git merge-base --is-ancestor introduction origin/main',
  'read planned package manifest',
  'gh api exact Node runs',
  'write ignored notes',
  'gh api create release tag',
  'git fetch created tag',
  'git rev-list created tag',
];

function runScenario({
  args = [],
  createOutput = draftUrl,
  failAt,
  failureMessage,
  releases = [completedRelease()],
  releaseRuns = [releaseRun()],
  tagCommit = introductionCommit,
} = {}) {
  const planText = `${JSON.stringify(plan(), null, 2)}\n`;
  const settings = {
    args,
    baselineCommit,
    baselineTag,
    createOutput,
    draftUrl,
    failAt,
    failureMessage,
    introductionCommit,
    nodeRunsEndpoint,
    notesPath,
    planPath,
    planTag,
    planText,
    releaseAssetFixtures: releaseAssetFixtures(),
    releaseEndpoint,
    releaseRuns,
    releaseRunsEndpoint,
    releaseTagCommits: Object.fromEntries(
      releases.map(release => [
        release.tag_name,
        release.tagCommit ?? baselineCommit,
      ]),
    ),
    releases,
    tagCommit,
  };
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
        import {runDraftReleaseCommand} from ${JSON.stringify(commandUrl)};
        const settings = ${JSON.stringify(settings)};
        const nodeRun = ${JSON.stringify(nodeRun())};
        const events = [];
        const writes = [];
        const record = label => {
          events.push(label);
          if (label === settings.failAt) {
            throw new Error(
              settings.failureMessage ?? 'injected failure: ' + label,
            );
          }
        };
        const runGit = async args => {
          const command = args.join(' ');
          if (command === 'status --porcelain') {
            record('git status --porcelain');
            return '';
          }
          if (command === 'fetch origin main:refs/remotes/origin/main --tags') {
            record('git fetch origin main:refs/remotes/origin/main --tags');
            return '';
          }
          if (command === 'rev-parse HEAD') {
            record('git rev-parse HEAD');
            return settings.introductionCommit + '\\n';
          }
          if (command === 'rev-parse origin/main') {
            record('git rev-parse origin/main');
            return settings.introductionCommit + '\\n';
          }
          if (command === 'for-each-ref --format=%(refname:short) refs/tags/@pkg-nec/*-v*') {
            record('git list release tags');
            return settings.baselineTag + '\\n';
          }
          if (command === 'rev-list -n 1 refs/tags/' + settings.baselineTag) {
            record('git resolve baseline tag');
            return settings.baselineCommit + '\\n';
          }
          if (command.startsWith('rev-list -n 1 refs/tags/')) {
            const tag = command.slice('rev-list -n 1 refs/tags/'.length);
            if (settings.releaseTagCommits[tag]) {
              record('git resolve release tag ' + tag);
              return settings.releaseTagCommits[tag] + '\\n';
            }
          }
          if (command === 'ls-files -z -- docs/releases/*-plan.json') {
            record('git list tracked plans');
            return settings.planPath + '\\0';
          }
          if (command === 'log --diff-filter=A --format=%H --reverse -- ' + settings.planPath) {
            record('git log introduction commit');
            return settings.introductionCommit + '\\n';
          }
          if (command === 'show ' + settings.introductionCommit + ':' + settings.planPath) {
            record('git show introduction plan');
            return settings.planText;
          }
          if (command === 'merge-base --is-ancestor ' + settings.introductionCommit + ' origin/main') {
            record('git merge-base --is-ancestor introduction origin/main');
            return '';
          }
          if (command === 'fetch origin refs/tags/' + settings.planTag + ':refs/tags/' + settings.planTag) {
            record('git fetch created tag');
            return '';
          }
          if (command === 'rev-list -n 1 refs/tags/' + settings.planTag) {
            record('git rev-list created tag');
            return settings.tagCommit + '\\n';
          }
          throw new Error('Unexpected Git command: ' + command);
        };
        const runGh = async args => {
          const command = args.join(' ');
          if (command === 'auth status') {
            record('gh auth status');
            return '';
          }
          if (command === 'repo view --json nameWithOwner') {
            record('gh repo view --json nameWithOwner');
            return JSON.stringify({nameWithOwner: 'pkg-nec/jest'});
          }
          if (command === 'api --paginate --slurp ' + settings.releaseEndpoint) {
            record('gh api releases');
            return JSON.stringify([settings.releases]);
          }
          if (command === 'api --paginate --slurp ' + settings.releaseRunsEndpoint) {
            record('gh api release runs');
            return JSON.stringify([{workflow_runs: settings.releaseRuns}]);
          }
          const releaseAsset = settings.releaseAssetFixtures.find(
            asset =>
              command ===
              'api ' + asset.url +
                ' --header Accept: application/octet-stream',
          );
          if (releaseAsset) {
            record('gh api release asset ' + releaseAsset.name);
            return releaseAsset.content;
          }
          if (command === 'api --paginate --slurp ' + settings.nodeRunsEndpoint) {
            record('gh api exact Node runs');
            return JSON.stringify([{workflow_runs: [nodeRun]}]);
          }
          const createTagCommand = [
            'api', 'repos/pkg-nec/jest/git/refs', '--method', 'POST',
            '--raw-field', 'ref=refs/tags/' + settings.planTag,
            '--raw-field', 'sha=' + settings.introductionCommit,
          ].join(' ');
          if (command === createTagCommand) {
            record('gh api create release tag');
            return JSON.stringify({
              object: {sha: settings.introductionCommit, type: 'commit'},
              ref: 'refs/tags/' + settings.planTag,
            });
          }
          const createCommand = [
            'release', 'create', settings.planTag, '--draft', '--target',
            settings.introductionCommit, '--title', settings.planTag,
            '--notes-file', settings.notesPath, '--repo', 'pkg-nec/jest',
          ].join(' ');
          if (command === createCommand) {
            record('gh release create --draft without tag verification');
            return settings.createOutput + '\\n';
          }
          const verifiedCreateCommand = [
            'release', 'create', settings.planTag, '--draft', '--verify-tag',
            '--target', settings.introductionCommit, '--title', settings.planTag,
            '--notes-file', settings.notesPath, '--repo', 'pkg-nec/jest',
          ].join(' ');
          if (command === verifiedCreateCommand) {
            record('gh release create --draft --verify-tag');
            return settings.createOutput + '\\n';
          }
          throw new Error('Unexpected GitHub command: ' + command);
        };
        const readFile = async (file, encoding) => {
          const normalized = String(file).replaceAll('\\\\', '/');
          if (normalized.endsWith('/' + settings.planPath) || normalized === settings.planPath) {
            record('read tracked plan');
            return encoding ? settings.planText : Buffer.from(settings.planText);
          }
          if (normalized.endsWith('/packages/jest/package.json') || normalized === 'packages/jest/package.json') {
            record('read planned package manifest');
            return JSON.stringify({name: '@pkg-nec/jest', version: '30.5.0'});
          }
          throw new Error('Unexpected read: ' + file);
        };
        const writeFile = async (file, contents) => {
          record('write ignored notes');
          writes.push({contents, file});
        };
        const write = value => {
          record('write success URL/instructions');
          writes.push({stdout: value});
        };
        try {
          const value = await runDraftReleaseCommand({
            args: settings.args,
            readFile,
            runGh,
            runGit,
            write,
            writeFile,
          });
          console.log(JSON.stringify({events, ok: true, value, writes}));
        } catch (error) {
          console.log(JSON.stringify({error: error.message, events, ok: false, writes}));
        }
      `,
    ],
    {cwd: process.cwd(), encoding: 'utf8'},
  );
  if (child.status !== 0) throw new Error(child.stderr || child.stdout);
  return JSON.parse(child.stdout.trim());
}

function keyEvents(events) {
  return events.filter(event => keyOrder.includes(event));
}

test('creates and verifies the exact remote tag before one draft mutation', () => {
  const scenario = runScenario();

  expect(scenario.ok).toBe(true);
  expect(keyEvents(scenario.events)).toEqual(keyOrder);
  expect(
    scenario.events.filter(
      event => event === 'gh release create --draft --verify-tag',
    ),
  ).toHaveLength(1);
  expect(scenario.events).not.toContain(
    'gh release create --draft without tag verification',
  );
  expect(scenario.writes[0]).toEqual({
    contents: expect.stringContaining(
      `- Source commit: \`${introductionCommit}\``,
    ),
    file: notesPath,
  });
  expect(scenario.writes[1].stdout).toContain(planTag);
  expect(scenario.writes[1].stdout).toContain(introductionCommit);
  expect(scenario.writes[1].stdout).toContain(draftUrl);
  expect(scenario.writes[1].stdout).toContain(
    'Review the draft and publish it manually to start the npm provenance workflow.',
  );
  expect(scenario.value).toEqual({
    draftUrl,
    introductionCommit,
    notesPath,
    tag: planTag,
  });
});

test.each([
  ['failed', 'failure', 'completed'],
  ['active', null, 'in_progress'],
])(
  'blocks creation for an orphaned %s plan-tag release run',
  (_label, conclusion, status) => {
    const runUrl = `https://github.com/pkg-nec/jest/actions/runs/${
      conclusion === null ? '402' : '401'
    }`;
    const token = 'workflow-token-that-must-not-appear';
    const responseBody = '{"secret":"workflow-body"}';
    const scenario = runScenario({
      releaseRuns: [
        releaseRun(),
        {
          conclusion,
          event: 'release',
          head_branch: planTag,
          head_sha: introductionCommit,
          html_url: runUrl,
          path: '.github/workflows/release.yml',
          responseBody,
          status,
          token,
        },
      ],
    });

    expect(scenario.ok).toBe(false);
    expect(scenario.error).toContain(planPath);
    expect(scenario.error).toContain(planTag);
    expect(scenario.error).toContain(runUrl);
    expect(scenario.error).not.toContain(token);
    expect(scenario.error).not.toContain(responseBody);
    expect(scenario.events).not.toContain('gh api create release tag');
    expect(scenario.events).not.toContain(
      'gh release create --draft --verify-tag',
    );
  },
);

test('reports sanitized plan, tag, and draft identities at the early unresolved gate', () => {
  const unresolvedDraftUrl =
    'https://github.com/pkg-nec/jest/releases/tag/untagged-def';
  const token = 'draft-token-that-must-not-appear';
  const responseBody = '{"secret":"draft-body"}';
  const scenario = runScenario({
    releases: [
      completedRelease(),
      {
        draft: true,
        html_url: unresolvedDraftUrl,
        prerelease: false,
        responseBody,
        tagCommit: baselineCommit,
        tag_name: planTag,
        token,
      },
    ],
  });

  expect(scenario.ok).toBe(false);
  expect(scenario.error).toContain(planPath);
  expect(scenario.error).toContain(planTag);
  expect(scenario.error).toContain(unresolvedDraftUrl);
  expect(scenario.error).not.toContain(token);
  expect(scenario.error).not.toContain(responseBody);
  expect(scenario.events).not.toContain('gh api create release tag');
  expect(scenario.events).not.toContain(
    'gh release create --draft --verify-tag',
  );
});

test.each(preDraftFailurePoints)(
  'does not create a draft when %s fails',
  failAt => {
    const scenario = runScenario({failAt});

    expect(scenario.ok).toBe(false);
    expect(scenario.error).toEqual(expect.any(String));
    expect(scenario.events).not.toContain(
      'gh release create --draft --verify-tag',
    );
    expect(scenario.events).not.toContain(
      'gh release create --draft without tag verification',
    );
  },
);

test.each([['tag fetch', 'git fetch created tag', introductionCommit]])(
  'reports partial remote state without rollback after %s failure',
  (_label, failAt, tagCommit) => {
    const scenario = runScenario({failAt, tagCommit});

    expect(scenario.ok).toBe(false);
    expect(scenario.error).toContain(planTag);
    expect(scenario.error).toContain(introductionCommit);
    expect(scenario.error).toContain('draft URL unknown');
    expect(scenario.events).not.toContain(
      'gh release create --draft --verify-tag',
    );
    expect(scenario.events.join('\n')).not.toMatch(
      /release delete|push --delete|tag --delete|tag -d/u,
    );
  },
);

test.each([
  [
    'remote tag creation',
    'gh api create release tag',
    'remote tag creation failed',
  ],
  [
    'remote tag verification',
    'git fetch created tag',
    'remote tag verification failed',
  ],
  [
    'draft Release creation',
    'gh release create --draft --verify-tag',
    'draft Release creation failed',
  ],
])('sanitizes adapter details when %s fails', (_label, failAt, safeReason) => {
  const token = 'ghp_remote_failure_token_that_must_not_appear';
  const responseBody = '{"secret":"remote failure response body"}';
  const scenario = runScenario({
    failAt,
    failureMessage: `${token} HTTP 500 ${responseBody}`,
  });

  expect(scenario.ok).toBe(false);
  expect(scenario.error).toContain(safeReason);
  expect(scenario.error).not.toContain(token);
  expect(scenario.error).not.toContain(responseBody);
});

test('does not draft or roll back when remote tag creation rejects', () => {
  const scenario = runScenario({failAt: 'gh api create release tag'});

  expect(scenario.ok).toBe(false);
  expect(scenario.error).toContain('manual investigation');
  expect(scenario.error).toContain(planTag);
  expect(scenario.error).toContain(introductionCommit);
  expect(scenario.error).toContain('draft URL unknown');
  expect(scenario.error).toContain('observed commit unknown');
  expect(scenario.events).not.toContain(
    'gh release create --draft --verify-tag',
  );
  expect(scenario.events.join('\n')).not.toMatch(
    /release delete|push --delete|tag --delete|tag -d/u,
  );
});

test('reports the verified tag when draft creation rejects', () => {
  const scenario = runScenario({
    failAt: 'gh release create --draft --verify-tag',
  });

  expect(scenario.ok).toBe(false);
  expect(scenario.error).toContain('manual investigation');
  expect(scenario.error).toContain(planTag);
  expect(scenario.error).toContain(introductionCommit);
  expect(scenario.error).toContain('draft URL unknown');
  expect(scenario.error).toContain(`observed commit ${introductionCommit}`);
  expect(scenario.events.join('\n')).not.toMatch(
    /release delete|push --delete|tag --delete|tag -d/u,
  );
});

test('reports the observed commit and never rolls back a mismatched tag', () => {
  const scenario = runScenario({tagCommit: observedCommit});

  expect(scenario.ok).toBe(false);
  expect(scenario.error).toMatch(
    new RegExp(
      `${planTag}.*${introductionCommit}.*draft URL unknown.*${observedCommit}`,
      'su',
    ),
  );
  expect(scenario.events).not.toContain(
    'gh release create --draft --verify-tag',
  );
  expect(scenario.events.join('\n')).not.toMatch(
    /release delete|push --delete|tag --delete|tag -d/u,
  );
});

test('does not trust a non-GitHub draft URL after creation', () => {
  const scenario = runScenario({
    createOutput: 'https://example.com/releases/1',
  });

  expect(scenario.ok).toBe(false);
  expect(scenario.error).toMatch(
    new RegExp(`${planTag}.*${introductionCommit}`, 'su'),
  );
  expect(scenario.error).toContain('draft URL unknown');
  expect(scenario.error).toContain(`observed commit ${introductionCommit}`);
  expect(scenario.events).toEqual(
    expect.arrayContaining([
      'gh api create release tag',
      'git fetch created tag',
      'git rev-list created tag',
      'gh release create --draft --verify-tag',
    ]),
  );
  expect(scenario.events).not.toContain('write success URL/instructions');
});

test.each([['tag'], ['--plan'], ['30.5.0']])(
  'rejects the input %p before adapters run',
  argument => {
    const scenario = runScenario({args: [argument]});

    expect(scenario.ok).toBe(false);
    expect(scenario.error).toContain('Usage: yarn draft:pkg-nec-release');
    expect(scenario.events).toEqual([]);
  },
);
