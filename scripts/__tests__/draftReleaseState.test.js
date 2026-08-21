/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

const {spawnSync} = require('node:child_process');
const path = require('node:path');
const {pathToFileURL} = require('node:url');

const baselineCommit = '1111111111111111111111111111111111111111';
const introductionCommit = '2222222222222222222222222222222222222222';
const laterCommit = '3333333333333333333333333333333333333333';
const baselineTag = '@pkg-nec/jest-v30.4.3';
const planTag = '@pkg-nec/jest-v30.5.0';
const planPath = 'docs/releases/pkg-nec-jest-v30.5.0-plan.json';
const nodeRunUrl = 'https://github.com/pkg-nec/jest/actions/runs/200';

const resolverUrl = pathToFileURL(
  path.join(process.cwd(), 'scripts/pkgNec/draftReleaseState.mjs'),
).href;

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

function secondPlan() {
  const candidate = plan();
  candidate.anchor = {
    ...candidate.anchor,
    tag: '@pkg-nec/jest-v30.5.1',
    version: '30.5.1',
  };
  candidate.packages = [
    {
      ...candidate.packages[0],
      bump: 'patch',
      fromVersion: '30.5.0',
      toVersion: '30.5.1',
    },
  ];
  candidate.planPath = 'docs/releases/pkg-nec-jest-v30.5.1-plan.json';
  return candidate;
}

function completedRelease() {
  const packages = [{name: '@pkg-nec/jest', order: 1, version: '30.4.3'}];
  const evidence = {
    packages,
    releaseTag: baselineTag,
    schemaVersion: 1,
    sourceCommit: baselineCommit,
  };
  const runUrl = 'https://github.com/pkg-nec/jest/actions/runs/100';
  return {
    assets: [
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
        content: {
          packages,
          schemaVersion: 1,
          sourceCommit: baselineCommit,
        },
        name: 'release-ledger.json',
      },
      {content: evidence, name: 'publication-journal.json'},
      {content: evidence, name: 'registry-evidence.json'},
      {content: evidence, name: 'provenance-evidence.json'},
    ],
    draft: false,
    html_url: `https://github.com/pkg-nec/jest/releases/tag/${baselineTag}`,
    prerelease: false,
    published_at: '2026-08-20T00:00:00.000Z',
    releaseRuns: [
      {
        conclusion: 'success',
        event: 'release',
        head_branch: baselineTag,
        head_sha: baselineCommit,
        html_url: runUrl,
        path: '.github/workflows/release.yml',
        status: 'completed',
      },
    ],
    tagCommit: baselineCommit,
    tag_name: baselineTag,
  };
}

function successfulNodeRun(overrides = {}) {
  return {
    conclusion: 'success',
    event: 'push',
    head_branch: 'main',
    head_sha: introductionCommit,
    html_url: nodeRunUrl,
    path: '.github/workflows/nodejs.yml',
    status: 'completed',
    ...overrides,
  };
}

function nodeRunMissing(field) {
  const run = successfulNodeRun();
  delete run[field];
  return run;
}

function input(overrides = {}) {
  const candidate = plan();
  const planBytes = Buffer.from(`${JSON.stringify(candidate)}\n`);
  return {
    head: introductionCommit,
    localPlans: [{path: planPath, plan: candidate}],
    mainPackages: [{name: '@pkg-nec/jest', version: '30.5.0'}],
    nodeRuns: [successfulNodeRun()],
    originMain: introductionCommit,
    planState: {
      currentBytes: planBytes,
      introductionBytes: Buffer.from(planBytes),
      introductionCommit,
      isAncestor: true,
    },
    releases: [completedRelease()],
    tags: [],
    ...overrides,
  };
}

function resolve(inputValue) {
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
        import {resolveDraftReleaseState} from ${JSON.stringify(resolverUrl)};
        const revive = value => {
          if (value && value.type === 'Buffer' && Array.isArray(value.data)) {
            return Buffer.from(value.data);
          }
          if (Array.isArray(value)) return value.map(revive);
          if (value && typeof value === 'object') {
            return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, revive(item)]));
          }
          return value;
        };
        try {
          console.log(JSON.stringify({ok: true, value: resolveDraftReleaseState(revive(${JSON.stringify(inputValue)}))}));
        } catch (error) {
          console.log(JSON.stringify({error: error.message, ok: false}));
        }
      `,
    ],
    {encoding: 'utf8'},
  );
  if (child.status !== 0) throw new Error(child.stderr || child.stdout);
  const output = JSON.parse(child.stdout.trim());
  if (!output.ok) throw new Error(output.error);
  return output.value;
}

function errorFor(overrides) {
  try {
    resolve(input(overrides));
  } catch (error) {
    return error.message;
  }
  throw new Error('Expected resolver to reject');
}

test('resolves one immutable unreleased plan with exact Node CI', () => {
  const result = resolve(input());

  expect(result).toEqual({
    plan: plan(),
    planIntroductionCommit: introductionCommit,
    tag: planTag,
  });
});

test.each([
  [
    'zero unresolved plans',
    {localPlans: []},
    /exactly one unresolved local release plan/u,
  ],
  [
    'two unresolved plans',
    {
      localPlans: [
        {path: planPath, plan: plan()},
        {
          path: 'docs/releases/pkg-nec-jest-v30.5.1-plan.json',
          plan: secondPlan(),
        },
      ],
    },
    /pkg-nec-jest-v30\.5\.1-plan\.json/u,
  ],
  [
    'invalid tracked plan',
    {localPlans: [{path: planPath, plan: {parseError: 'bad JSON'}}]},
    /invalid-local-plan.*pkg-nec-jest-v30\.5\.0-plan\.json/u,
  ],
  [
    'unmatched tag',
    {
      tags: [
        {
          commit: laterCommit,
          name: '@pkg-nec/jest-v30.5.1',
          relationToBaseline: 'descendant',
        },
      ],
    },
    /unmatched-tag.*@pkg-nec\/jest-v30\.5\.1/u,
  ],
  [
    'draft release',
    {
      releases: [
        completedRelease(),
        {
          created_at: '2026-08-21T00:00:00.000Z',
          draft: true,
          html_url: 'https://github.com/pkg-nec/jest/releases/300',
          prerelease: false,
          published_at: null,
          tag_name: '@pkg-nec/jest-v30.5.1',
        },
      ],
    },
    /draft-release.*releases\/300/u,
  ],
  [
    'prerelease',
    {
      releases: [
        completedRelease(),
        {
          created_at: '2026-08-21T00:00:00.000Z',
          draft: false,
          html_url: 'https://github.com/pkg-nec/jest/releases/301',
          prerelease: true,
          published_at: '2026-08-21T00:00:00.000Z',
          tag_name: '@pkg-nec/jest-v30.5.1',
        },
      ],
    },
    /prerelease.*releases\/301/u,
  ],
  [
    'failed release run',
    {
      releases: [
        {
          ...completedRelease(),
          releaseRuns: [
            ...completedRelease().releaseRuns,
            {
              conclusion: 'failure',
              event: 'release',
              head_branch: planTag,
              head_sha: introductionCommit,
              html_url: 'https://github.com/pkg-nec/jest/actions/runs/302',
              path: '.github/workflows/release.yml',
              status: 'completed',
            },
          ],
        },
      ],
    },
    /failed-run.*runs\/302/u,
  ],
  [
    'active release run',
    {
      releases: [
        completedRelease(),
        {
          created_at: '2026-08-21T00:00:00.000Z',
          draft: false,
          prerelease: false,
          published_at: '2026-08-21T00:00:00.000Z',
          releaseRuns: [
            {
              conclusion: null,
              event: 'release',
              head_branch: '@pkg-nec/jest-v30.5.1',
              head_sha: laterCommit,
              html_url: 'https://github.com/pkg-nec/jest/actions/runs/303',
              path: '.github/workflows/release.yml',
              status: 'in_progress',
            },
          ],
          tagCommit: laterCommit,
          tag_name: '@pkg-nec/jest-v30.5.1',
        },
      ],
    },
    /in-progress-run.*runs\/303/u,
  ],
  [
    'unexplained published version change',
    {
      releases: [
        completedRelease(),
        {
          draft: false,
          prerelease: false,
          published_at: '2026-08-21T00:00:00.000Z',
          tag_name: '@pkg-nec/jest-v30.5.1',
        },
      ],
    },
    /incomplete-release.*@pkg-nec\/jest-v30\.5\.1/u,
  ],
])('rejects unresolved state containing %s', (_label, overrides, expected) => {
  expect(errorFor(overrides)).toMatch(expected);
});

test('rejects a plan whose baseline differs from the latest published release', () => {
  const candidate = plan();
  candidate.previousRelease = {
    commit: laterCommit,
    tag: '@pkg-nec/jest-v30.4.4',
  };
  const message = errorFor({localPlans: [{path: planPath, plan: candidate}]});

  expect(message).toMatch(/@pkg-nec\/jest-v30\.4\.4/u);
  expect(message).toContain(baselineTag);
});

test.each([
  [
    'a modified plan file',
    {currentBytes: Buffer.from('changed')},
    /changed after introduction.*2222222222222222222222222222222222222222/u,
  ],
  [
    'a non-ancestor introduction commit',
    {isAncestor: false},
    /not an ancestor.*2222222222222222222222222222222222222222/u,
  ],
  [
    'a non-full introduction commit',
    {introductionCommit: 'short'},
    /introduction commit.*short/u,
  ],
])('rejects %s', (_label, state, expected) => {
  expect(errorFor({planState: {...input().planState, ...state}})).toMatch(
    expected,
  );
});

test('rejects absence of a successful exact Node CI run', () => {
  expect(errorFor({nodeRuns: []})).toMatch(
    /No successful completed Node CI run.*2222222222222222222222222222222222222222/u,
  );
});

test.each([
  ['workflow path', {path: '.github/workflows/other.yml'}],
  ['event', {event: 'workflow_dispatch'}],
  ['branch', {head_branch: 'release'}],
  ['status', {status: 'in_progress'}],
  ['conclusion', {conclusion: 'failure'}],
])('rejects a Node CI run with the wrong %s', (_label, mutation) => {
  const message = errorFor({nodeRuns: [successfulNodeRun(mutation)]});

  expect(message).toMatch(/Node CI run.*runs\/200/u);
  expect(message).toMatch(new RegExp(_label, 'iu'));
});

test.each([
  ['workflow path', 'path'],
  ['event', 'event'],
  ['branch', 'head_branch'],
  ['status', 'status'],
  ['conclusion', 'conclusion'],
])('rejects a Node CI run with a missing %s', (_label, field) => {
  const message = errorFor({nodeRuns: [nodeRunMissing(field)]});

  expect(message).toMatch(/Node CI run.*runs\/200/u);
  expect(message).toMatch(new RegExp(_label, 'iu'));
});

test('rejects a successful Node CI run belonging to a later commit', () => {
  const message = errorFor({
    nodeRuns: [successfulNodeRun({head_sha: laterCommit})],
  });

  expect(message).toContain(laterCommit);
  expect(message).toContain(nodeRunUrl);
});

test.each([
  [
    'local tag',
    {
      tags: [
        {
          commit: introductionCommit,
          name: planTag,
          relationToBaseline: 'descendant',
        },
      ],
    },
  ],
  [
    'remote tag',
    {
      tags: [
        {
          commit: introductionCommit,
          name: planTag,
          relationToBaseline: 'descendant',
          remote: true,
        },
      ],
    },
  ],
  [
    'draft release',
    {
      releases: [
        completedRelease(),
        {
          draft: true,
          html_url: 'https://github.com/pkg-nec/jest/releases/400',
          prerelease: false,
          tag_name: planTag,
        },
      ],
    },
  ],
  [
    'published release',
    {
      releases: [
        completedRelease(),
        {
          draft: false,
          prerelease: false,
          published_at: '2026-08-21T00:00:00.000Z',
          tag_name: planTag,
        },
      ],
    },
  ],
])('rejects a matching %s identity', (_label, overrides) => {
  expect(errorFor(overrides)).toContain(planTag);
});

test('rejects plan package versions that differ from main', () => {
  const message = errorFor({
    mainPackages: [{name: '@pkg-nec/jest', version: '30.4.9'}],
  });

  expect(message).toContain('@pkg-nec/jest');
  expect(message).toContain('30.4.9');
  expect(message).toContain('30.5.0');
  expect(message).toContain(planPath);
});

test.each([
  [
    'tag',
    candidate => {
      candidate.anchor = {
        ...candidate.anchor,
        tag: '@pkg-nec/jest-v30.5.1',
      };
    },
  ],
  [
    'path',
    candidate => {
      candidate.planPath = 'docs/releases/aliased-plan.json';
    },
  ],
  [
    'anchor',
    candidate => {
      candidate.anchor = {...candidate.anchor, name: '@pkg-nec/expect'};
    },
  ],
])('rejects a plan with a mismatched %s', (_label, mutate) => {
  const candidate = plan();
  mutate(candidate);
  const message = errorFor({
    localPlans: [{path: candidate.planPath, plan: candidate}],
  });

  expect(message).toMatch(/invalid-local-plan/u);
  expect(message).toContain(candidate.planPath);
});

test('redacts tokens and response bodies from preflight errors', () => {
  const token = 'token-that-must-not-appear';
  const responseBody = '{"body":"must-not-appear"}';
  const message = errorFor({
    nodeRuns: [
      successfulNodeRun({
        path: '.github/workflows/other.yml',
        responseBody,
        token,
      }),
    ],
  });

  expect(message).toContain(nodeRunUrl);
  expect(message).not.toContain(token);
  expect(message).not.toContain(responseBody);
});
