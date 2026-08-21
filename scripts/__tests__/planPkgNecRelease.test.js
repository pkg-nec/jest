/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

const {spawnSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const fs = require('graceful-fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');

const repoRoot = process.cwd();
const moduleUrl = pathToFileURL(
  path.join(repoRoot, 'scripts/planPkgNecRelease.mjs'),
).href;
const identityPolicy = JSON.parse(
  fs.readFileSync(
    path.join(repoRoot, 'scripts/pkgNec/packageIdentityPolicy.json'),
    'utf8',
  ),
);
const baselineCommit = '1111111111111111111111111111111111111111';
const headCommit = '2222222222222222222222222222222222222222';
const baselineTag = '@pkg-nec/jest-v30.4.3';
const runUrl = 'https://github.com/pkg-nec/jest/actions/runs/100';

const publishedPackages = identityPolicy.packages
  .filter(item => item.publishable)
  .map((item, index) => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(repoRoot, item.manifestPath), 'utf8'),
    );
    return {name: item.newName, order: index + 1, version: manifest.version};
  });

function completedRelease() {
  const publication = {
    packages: publishedPackages,
    releaseTag: baselineTag,
    schemaVersion: 1,
    sourceCommit: baselineCommit,
  };
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
          packages: publishedPackages,
          schemaVersion: 1,
          sourceCommit: baselineCommit,
        },
        name: 'release-ledger.json',
      },
      {content: publication, name: 'publication-journal.json'},
      {content: publication, name: 'registry-evidence.json'},
      {content: publication, name: 'provenance-evidence.json'},
    ],
    created_at: '2026-08-01T00:00:00.000Z',
    draft: false,
    html_url: `https://github.com/pkg-nec/jest/releases/tag/${baselineTag}`,
    prerelease: false,
    published_at: '2026-08-01T01:00:00.000Z',
    tag_name: baselineTag,
  };
}

function schema2ReleaseFixture() {
  const planPath = 'docs/releases/pkg-nec-jest-v30.4.3-plan.json';
  const planAssetName = 'pkg-nec-jest-v30.4.3-plan.json';
  const identities = new Map(
    identityPolicy.packages.map(item => [item.newName, item]),
  );
  const fixturePackages = [
    {
      ...publishedPackages.find(item => item.name === '@pkg-nec/jest'),
      order: 1,
    },
  ];
  const plan = {
    anchor: {name: '@pkg-nec/jest', tag: baselineTag, version: '30.4.3'},
    changedFiles: {
      packages: fixturePackages
        .map(item => ({
          files: [identities.get(item.name).manifestPath],
          name: item.name,
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
      root: {allPackages: [], ambiguous: [], noImpact: []},
    },
    packages: fixturePackages.map((item, index) => {
      const identity = identities.get(item.name);
      const parts = item.version.split('.').map(Number);
      parts[2] -= 1;
      return {
        bump: 'patch',
        fromVersion: parts.join('.'),
        name: item.name,
        order: index + 1,
        path: path.posix.dirname(identity.manifestPath),
        reasons: [{files: [identity.manifestPath], kind: 'changed'}],
        toVersion: item.version,
      };
    }),
    planPath,
    preparedFrom: '9999999999999999999999999999999999999999',
    previousRelease: {
      commit: '0000000000000000000000000000000000000000',
      tag: '@pkg-nec/jest-v30.4.2',
    },
    rootImpact: {applied: 'not-needed', requested: null},
    schemaVersion: 1,
  };
  const planContent = JSON.stringify(plan);
  const release = completedRelease();
  release.assets.find(asset => asset.name === 'release-ledger.json').content = {
    packages: fixturePackages,
    releasePlan: {
      digest: `sha256-${createHash('sha256')
        .update(planContent)
        .digest('hex')}`,
      path: planPath,
    },
    schemaVersion: 2,
    sourceCommit: baselineCommit,
  };
  for (const assetName of [
    'publication-journal.json',
    'registry-evidence.json',
    'provenance-evidence.json',
  ]) {
    release.assets.find(asset => asset.name === assetName).content.packages =
      fixturePackages;
  }
  release.assets.push({content: planContent, name: planAssetName});
  const assetContents = {};
  release.assets = release.assets.map((asset, index) => {
    const url = `https://api.github.com/repos/pkg-nec/jest/releases/assets/${index + 1}`;
    assetContents[url] =
      typeof asset.content === 'string'
        ? asset.content
        : JSON.stringify(asset.content);
    return {name: asset.name, url};
  });
  return {assetContents, plan, release};
}

function workflowRun(overrides = {}) {
  return {
    conclusion: 'success',
    event: 'release',
    head_branch: baselineTag,
    head_sha: baselineCommit,
    html_url: runUrl,
    path: '.github/workflows/release.yml',
    status: 'completed',
    ...overrides,
  };
}

function trackedPlan({tag = '@pkg-nec/jest-v30.5.0', version = '30.5.0'} = {}) {
  return {
    anchor: {name: '@pkg-nec/jest', tag, version},
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
        toVersion: version,
      },
    ],
    planPath: `docs/releases/${tag
      .replace('@', '')
      .replace('/', '-')}-plan.json`,
    preparedFrom: headCommit,
    previousRelease: {commit: baselineCommit, tag: baselineTag},
    rootImpact: {applied: 'not-needed', requested: null},
    schemaVersion: 1,
  };
}

function runCommand({
  args = [],
  assetContents = {},
  changedFiles = ['packages/create-jest/src/index.ts'],
  dirty = false,
  head = headCommit,
  localPlans = [],
  manifestOverrides = {},
  originMain = headCommit,
  releases = [completedRelease()],
  runs = [workflowRun()],
  tagManifestOverrides = {},
  tags = [
    {
      commit: baselineCommit,
      createdAt: '2026-08-01T00:00:00.000Z',
      name: baselineTag,
    },
  ],
} = {}) {
  const scenario = {
    args,
    assetContents,
    changedFiles,
    dirty,
    head,
    localPlans,
    manifestOverrides,
    originMain,
    releases,
    runs,
    tagManifestOverrides,
    tags,
  };
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
        import fs from 'graceful-fs';
        import path from 'node:path';
        import {runPlanReleaseCommand} from ${JSON.stringify(moduleUrl)};

        const repoRoot = ${JSON.stringify(repoRoot)};
        const scenario = ${JSON.stringify(scenario)};
        const baselineCommit = ${JSON.stringify(baselineCommit)};
        const events = [];
        const output = [];
        const releaseResponse = JSON.stringify([scenario.releases]);
        const runResponse = JSON.stringify([{workflow_runs: scenario.runs}]);
        const planFiles = new Map(
          scenario.localPlans.map(item => [
            item.path,
            item.content ?? JSON.stringify(item.plan),
          ]),
        );

        const runGit = async args => {
          events.push({args, kind: 'git'});
          if (args[0] === 'status') return scenario.dirty ? ' M package.json\\n' : '';
          if (args[0] === 'fetch') return '';
          if (args.join(' ') === 'rev-parse HEAD') return scenario.head;
          if (args.join(' ') === 'rev-parse origin/main') return scenario.originMain;
          if (args[0] === 'for-each-ref') {
            return scenario.tags
              .map(tag => tag.name)
              .join('\\n');
          }
          if (args[0] === 'rev-list' && args[1] === '-n' && args[2] === '1') {
            const tagName = args[3].startsWith('refs/tags/')
              ? args[3].slice('refs/tags/'.length)
              : args[3];
            const tag = scenario.tags.find(item => item.name === tagName);
            return tag?.commit ?? '';
          }
          if (args[0] === 'ls-files') {
            return scenario.localPlans.map(item => item.path).join('\\0');
          }
          if (args[0] === 'merge-base') {
            const left = args[2];
            const right = args[3];
            if (left === baselineCommit && right === 'HEAD') return '';
            const relatedCommit =
              left === baselineCommit ? right : left;
            const relatedTag = scenario.tags.find(
              tag => tag.commit === relatedCommit,
            );
            if (
              relatedTag?.relationToBaseline === 'ancestor' &&
              left === relatedTag.commit &&
              right === baselineCommit
            ) {
              return '';
            }
            if (
              relatedTag?.relationToBaseline === 'descendant' &&
              left === baselineCommit &&
              right === relatedTag.commit
            ) {
              return '';
            }
            throw new Error('Commits are not ancestors');
          }
          if (args[0] === 'diff') return scenario.changedFiles.join('\\0') + '\\0';
          if (args[0] === 'show') {
            const separator = args[1].indexOf(':');
            const manifestPath = args[1].slice(separator + 1);
            const manifest = JSON.parse(
              await fs.promises.readFile(
                path.join(repoRoot, manifestPath),
                'utf8',
              ),
            );
            return JSON.stringify({
              ...manifest,
              ...scenario.tagManifestOverrides[manifestPath],
            });
          }
          throw new Error('Unexpected git arguments: ' + JSON.stringify(args));
        };
        const runGh = async args => {
          events.push({args, kind: 'gh'});
          if (args[0] === 'repo') {
            return JSON.stringify({nameWithOwner: 'pkg-nec/jest'});
          }
          const endpoint = args.at(-1);
          if (endpoint === 'repos/pkg-nec/jest/releases?per_page=100') {
            return releaseResponse;
          }
          if (
            endpoint ===
            'repos/pkg-nec/jest/actions/workflows/release.yml/runs?per_page=100'
          ) {
            return runResponse;
          }
          if (args[0] === 'api' && scenario.assetContents[args[1]]) {
            return scenario.assetContents[args[1]];
          }
          throw new Error('Unexpected gh arguments: ' + JSON.stringify(args));
        };
        const readFile = async (file, encoding) => {
          const normalized = String(file).replaceAll('\\\\', '/');
          events.push({file: normalized, kind: 'read'});
          if (planFiles.has(normalized)) return planFiles.get(normalized);
          const relative = path.relative(repoRoot, String(file)).replaceAll('\\\\', '/');
          if (scenario.manifestOverrides[relative]) {
            const manifest = JSON.parse(
              await fs.promises.readFile(file, encoding),
            );
            return JSON.stringify({
              ...manifest,
              ...scenario.manifestOverrides[relative],
            });
          }
          return fs.promises.readFile(file, encoding);
        };

        let value;
        try {
          value = await runPlanReleaseCommand({
            args: scenario.args,
            readFile,
            runGh,
            runGit,
            write: text => {
              events.push({kind: 'write', text});
              output.push(text);
            },
          });
        } catch (error) {
          value = {details: error.details, error: error.message};
        }
        console.log(JSON.stringify({events, output, value}));
      `,
    ],
    {cwd: repoRoot, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024},
  );
  if (child.status !== 0) throw new Error(child.stderr || child.stdout);
  return JSON.parse(child.stdout.trim());
}

const expectedPreflight = [
  {args: ['status', '--porcelain'], kind: 'git'},
  {
    args: ['fetch', 'origin', 'main:refs/remotes/origin/main', '--tags'],
    kind: 'git',
  },
  {args: ['rev-parse', 'HEAD'], kind: 'git'},
  {args: ['rev-parse', 'origin/main'], kind: 'git'},
  {args: ['repo', 'view', '--json', 'nameWithOwner'], kind: 'gh'},
  {
    args: [
      'api',
      '--paginate',
      '--slurp',
      'repos/pkg-nec/jest/releases?per_page=100',
    ],
    kind: 'gh',
  },
];

test('runs the exact preflight before state discovery and baseline diffing', () => {
  const result = runCommand();
  const commandEvents = result.events.filter(event => event.kind !== 'read');

  expect(commandEvents.slice(0, expectedPreflight.length)).toEqual(
    expectedPreflight,
  );
  const diffIndex = commandEvents.findIndex(
    event => event.kind === 'git' && event.args[0] === 'diff',
  );
  const ancestorIndex = commandEvents.findIndex(
    event => event.kind === 'git' && event.args[0] === 'merge-base',
  );
  expect(ancestorIndex).toBeGreaterThan(expectedPreflight.length - 1);
  expect(diffIndex).toBeGreaterThan(ancestorIndex);
  expect(
    commandEvents.find(
      event => event.kind === 'git' && event.args[0] === 'rev-list',
    ).args,
  ).toEqual(['rev-list', '-n', '1', `refs/tags/${baselineTag}`]);
  expect(commandEvents[diffIndex].args).toEqual([
    'diff',
    '--name-only',
    '-z',
    `${baselineCommit}..HEAD`,
  ]);
  expect(
    commandEvents
      .slice(diffIndex + 1)
      .filter(event => event.kind === 'git' && event.args[0] === 'show')
      .every(event => event.args[1].startsWith(`${baselineCommit}:`)),
  ).toBe(true);
});

test('stops a dirty worktree before fetch and produces no output', () => {
  const result = runCommand({dirty: true});

  expect(result.value.error).toMatch(/clean worktree/iu);
  expect(result.events).toEqual([
    {args: ['status', '--porcelain'], kind: 'git'},
  ]);
  expect(result.output).toEqual([]);
});

test('stops stale main after the fetched comparison and produces no output', () => {
  const result = runCommand({originMain: baselineCommit});

  expect(result.value.error).toMatch(/HEAD.*origin\/main/iu);
  expect(result.events).toEqual(expectedPreflight.slice(0, 4));
  expect(result.output).toEqual([]);
});

test.each([
  [['--since', baselineTag]],
  [[baselineTag]],
  [['--unknown']],
  [['--bump=@pkg-nec/jest=minor']],
  [['--root-impact', 'none']],
  [['--root-impact=some']],
  [['--apply', '--apply']],
])('rejects unsupported planner arguments %j before preflight', args => {
  const result = runCommand({args});

  expect(result.value.error).toMatch(/usage|argument|option/iu);
  expect(result.events).toEqual([]);
  expect(result.output).toEqual([]);
});

test('blocks unresolved state before ancestry checks or diff output', () => {
  const planPath = 'docs/releases/pkg-nec-jest-v30.5.0-plan.json';
  const plan = trackedPlan();
  const result = runCommand({localPlans: [{path: planPath, plan}]});

  expect(result.value.error).toMatch(/unresolved release state/iu);
  expect(result.value.details).toEqual([
    expect.objectContaining({
      kind: 'local-plan',
      message: expect.stringMatching(/manual investigation/iu),
      planPath,
      tag: '@pkg-nec/jest-v30.5.0',
    }),
  ]);
  expect(
    result.events.some(
      event => event.kind === 'git' && event.args[0] === 'merge-base',
    ),
  ).toBe(false);
  expect(result.output).toEqual([]);
});

test('blocks malformed tracked plan JSON without output or mutation', () => {
  const planPath = 'docs/releases/pkg-nec-jest-v30.4.3-plan.json';
  const result = runCommand({
    localPlans: [{content: '{', path: planPath}],
  });

  expect(result.value.details).toEqual([
    expect.objectContaining({kind: 'invalid-local-plan', planPath}),
  ]);
  expect(result.output).toEqual([]);
  expect(
    result.events.some(
      event => event.kind === 'git' && event.args[0] === 'merge-base',
    ),
  ).toBe(false);
});

test('prints no-change and ambiguous-root outcomes without plan JSON', () => {
  const noChanges = runCommand({changedFiles: ['docs/maintenance.md']});
  expect(noChanges.value.kind).toBe('no-changes');
  expect(noChanges.output).toEqual(['no releasable package changes\n']);

  const ambiguous = runCommand({changedFiles: ['yarn.lock']});
  expect(ambiguous.value.error).toMatch(/root impact/iu);
  expect(ambiguous.output.join('')).toBe(
    'Ambiguous root files:\n- yarn.lock\n',
  );
  expect(ambiguous.output.join('')).not.toContain('"schemaVersion"');
});

test('accepts only the planned options and prints canonical JSON plus a package table', () => {
  const result = runCommand({
    args: [
      '--bump',
      '@pkg-nec/create-jest=minor',
      '--root-impact=none',
      '--apply',
    ],
  });
  const output = result.output.join('');

  expect(result.value.kind).toBe('release');
  expect(result.value.apply).toBe(true);
  expect(output).toContain('"schemaVersion": 1');
  expect(output).toContain(
    '| Order | Package | From | To | Bump |\n| ---: | --- | --- | --- | --- |',
  );
  expect(output).toContain(
    '| @pkg-nec/create-jest | 30.4.3 | 30.5.0 | minor |',
  );
  expect(output).not.toMatch(/undefined/iu);
});

test('builds dependent closure from manifests supplied by the file adapter', () => {
  const result = runCommand({
    manifestOverrides: {
      'packages/jest-phabricator/package.json': {
        dependencies: {'@pkg-nec/create-jest': 'workspace:*'},
      },
    },
  });

  expect(result.value.plan.packages.map(item => item.name)).toContain(
    '@pkg-nec/jest-phabricator',
  );
});

test('uses completed tag manifests as the full baseline for a second selective release', () => {
  const fixture = schema2ReleaseFixture();
  const result = runCommand({
    assetContents: fixture.assetContents,
    localPlans: [{path: fixture.plan.planPath, plan: fixture.plan}],
    manifestOverrides: {
      'packages/create-jest/package.json': {version: '30.4.2'},
    },
    releases: [fixture.release],
    runs: [
      workflowRun({
        conclusion: 'failure',
        html_url: 'https://github.com/pkg-nec/jest/actions/runs/99',
      }),
      workflowRun(),
    ],
    tagManifestOverrides: {
      'packages/create-jest/package.json': {version: '30.4.2'},
    },
  });

  expect(result.value).toMatchObject({
    kind: 'release',
    plan: {
      packages: [
        {
          fromVersion: '30.4.2',
          name: '@pkg-nec/create-jest',
          toVersion: '30.4.3',
        },
      ],
      previousRelease: {commit: baselineCommit, tag: baselineTag},
    },
  });
  expect(
    result.events.filter(
      event =>
        event.kind === 'gh' &&
        event.args[0] === 'api' &&
        event.args[1]?.includes('/releases/assets/'),
    ),
  ).toEqual(
    expect.arrayContaining([
      {
        args: [
          'api',
          'https://api.github.com/repos/pkg-nec/jest/releases/assets/6',
          '--header',
          'Accept: application/octet-stream',
        ],
        kind: 'gh',
      },
    ]),
  );
  expect(result.output.join('')).toContain(
    '| @pkg-nec/create-jest | 30.4.2 | 30.4.3 | patch |',
  );
  expect(mutationEvents(result)).toEqual([]);
});

test('validates schema-2 recorded versions against tag manifests', () => {
  const fixture = schema2ReleaseFixture();
  const result = runCommand({
    assetContents: fixture.assetContents,
    releases: [fixture.release],
    tagManifestOverrides: {
      'packages/jest/package.json': {version: '30.4.2'},
    },
  });

  expect(result.value).toEqual({
    details: [
      expect.objectContaining({
        kind: 'baseline-version-mismatch',
        versions: [
          {
            manifestVersion: '30.4.2',
            name: '@pkg-nec/jest',
            recordedVersion: '30.4.3',
          },
        ],
      }),
    ],
    error: expect.stringMatching(/unresolved release state/iu),
  });
  expect(result.output).toEqual([]);
  expect(mutationEvents(result)).toEqual([]);
});

test('keeps schema-1 completed baselines full-inventory', () => {
  const candidate = completedRelease();
  const onlyPackage = [{...publishedPackages[0], order: 1}];
  for (const asset of candidate.assets) {
    if (asset.content?.packages) {
      asset.content = {...asset.content, packages: onlyPackage};
    }
  }
  const result = runCommand({releases: [candidate]});

  expect(result.value).toEqual({
    details: [
      expect.objectContaining({
        kind: 'baseline-version-mismatch',
        versions: expect.arrayContaining([
          expect.objectContaining({
            name: '@pkg-nec/create-jest',
            recordedVersion: null,
          }),
        ]),
      }),
    ],
    error: expect.stringMatching(/unresolved release state/iu),
  });
  expect(result.output).toEqual([]);
});

test.each([
  ['ancestor', '2099-01-01T00:00:00.000Z', false],
  ['unrelated', '2000-01-01T00:00:00.000Z', true],
])(
  'uses Git topology for a %s unmatched tag regardless of creator date',
  (relationToBaseline, createdAt, blocked) => {
    const tag = {
      commit: '8888888888888888888888888888888888888888',
      createdAt,
      name: '@pkg-nec/jest-v99.0.0',
      relationToBaseline,
    };
    const result = runCommand({
      tags: [
        {
          commit: baselineCommit,
          createdAt: '2026-08-01T00:00:00.000Z',
          name: baselineTag,
        },
        tag,
      ],
    });

    expect(
      result.value.details?.some(item => item.kind === 'unmatched-tag') ??
        false,
    ).toBe(blocked);
    expect(result.output.length > 0).toBe(!blocked);
    expect(
      result.events.some(
        event =>
          event.kind === 'git' &&
          event.args.join(' ') ===
            `merge-base --is-ancestor ${tag.commit} ${baselineCommit}`,
      ),
    ).toBe(true);
  },
);
