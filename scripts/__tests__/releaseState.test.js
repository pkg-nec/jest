/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

const {spawnSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const path = require('node:path');
const {pathToFileURL} = require('node:url');

const repoRoot = process.cwd();
const moduleUrl = pathToFileURL(
  path.join(repoRoot, 'scripts/pkgNec/releaseState.mjs'),
).href;
const completedCommit = '1111111111111111111111111111111111111111';
const laterCommit = '2222222222222222222222222222222222222222';
const completedTag = '@pkg-nec/jest-v30.4.3';

function packageEntry(name = '@pkg-nec/jest', version = '30.4.3', order = 1) {
  return {name, order, version};
}

function completedPlan({
  packageName = '@pkg-nec/jest',
  tag = completedTag,
  version = '30.4.3',
} = {}) {
  return {
    anchor: {name: packageName, tag, version},
    changedFiles: {
      packages: [{files: ['packages/jest/src/index.ts'], name: packageName}],
      root: {allPackages: [], ambiguous: [], noImpact: []},
    },
    packages: [
      {
        bump: 'patch',
        fromVersion: '30.4.2',
        name: packageName,
        order: 1,
        path: 'packages/jest',
        reasons: [{files: ['packages/jest/src/index.ts'], kind: 'changed'}],
        toVersion: version,
      },
    ],
    planPath: 'docs/releases/pkg-nec-jest-v30.4.3-plan.json',
    preparedFrom: '9999999999999999999999999999999999999999',
    previousRelease: {
      commit: '0000000000000000000000000000000000000000',
      tag: '@pkg-nec/jest-v30.4.2',
    },
    rootImpact: {applied: 'not-needed', requested: null},
    schemaVersion: 1,
  };
}

function unpublishedPlan() {
  const tag = '@pkg-nec/jest-v30.5.0';
  return {
    anchor: {name: '@pkg-nec/jest', tag, version: '30.5.0'},
    changedFiles: {
      packages: [
        {
          files: ['packages/jest/src/index.ts'],
          name: '@pkg-nec/jest',
        },
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
    planPath: 'docs/releases/pkg-nec-jest-v30.5.0-plan.json',
    preparedFrom: laterCommit,
    previousRelease: {commit: completedCommit, tag: completedTag},
    rootImpact: {applied: 'not-needed', requested: null},
    schemaVersion: 1,
  };
}

function digest(content) {
  return `sha256-${createHash('sha256').update(content).digest('hex')}`;
}

function replacePlanContent(assets, mutate) {
  const planAsset = assets.find(
    asset => asset.name === 'pkg-nec-jest-v30.4.3-plan.json',
  );
  const plan = mutate(JSON.parse(planAsset.content));
  planAsset.content = JSON.stringify(plan);
  assets.find(
    asset => asset.name === 'release-ledger.json',
  ).content.releasePlan.digest = digest(planAsset.content);
  return assets;
}

function workflowSummary({
  runUrl = 'https://github.com/pkg-nec/jest/actions/runs/100',
  tag = completedTag,
} = {}) {
  return (
    '# pkg-nec release workflow evidence\n\n' +
    `- Release tag: \`${tag}\`\n` +
    `- Source workflow run: ${runUrl}\n` +
    '- Validate job: `success`\n' +
    '- Publish job: `success`\n' +
    '- Verify job: `success`\n'
  );
}

function releaseRun({
  conclusion = 'success',
  event = 'release',
  headBranch,
  headSha = completedCommit,
  status = 'completed',
  tag = completedTag,
  url = 'https://github.com/pkg-nec/jest/actions/runs/100',
  workflowPath = '.github/workflows/release.yml',
} = {}) {
  const run = {
    conclusion,
    event,
    html_url: url,
    status,
  };
  if (headBranch !== null) run.head_branch = headBranch ?? tag;
  if (headSha !== null) run.head_sha = headSha;
  if (workflowPath !== null) run.path = workflowPath;
  return run;
}

function completedAssets({
  commit = completedCommit,
  ledgerSchemaVersion = 1,
  packages = [packageEntry()],
  runUrl = 'https://github.com/pkg-nec/jest/actions/runs/100',
  tag = completedTag,
} = {}) {
  const publication = {packages, releaseTag: tag, sourceCommit: commit};
  const planContent = JSON.stringify(completedPlan());
  return [
    {
      content: workflowSummary({runUrl, tag}),
      name: 'workflow-summary.md',
    },
    {
      content: {
        packages,
        ...(ledgerSchemaVersion === 2
          ? {
              releasePlan: {
                digest: digest(planContent),
                path: 'docs/releases/pkg-nec-jest-v30.4.3-plan.json',
              },
            }
          : {}),
        schemaVersion: ledgerSchemaVersion,
        sourceCommit: commit,
      },
      name: 'release-ledger.json',
    },
    {
      content: {...publication, schemaVersion: 1},
      name: 'publication-journal.json',
    },
    {
      content: {...publication, schemaVersion: 1},
      name: 'registry-evidence.json',
    },
    {
      content: {...publication, schemaVersion: 1},
      name: 'provenance-evidence.json',
    },
    ...(ledgerSchemaVersion === 2
      ? [
          {
            content: planContent,
            name: 'pkg-nec-jest-v30.4.3-plan.json',
          },
        ]
      : []),
  ];
}

function release({
  assets = completedAssets(),
  createdAt = '2026-08-01T00:00:00.000Z',
  draft = false,
  prerelease = false,
  publishedAt = '2026-08-01T01:00:00.000Z',
  runs = [releaseRun()],
  tag = completedTag,
  tagCommit = completedCommit,
  url = `https://github.com/pkg-nec/jest/releases/tag/${tag}`,
} = {}) {
  return {
    assets,
    created_at: createdAt,
    draft,
    html_url: url,
    prerelease,
    published_at: publishedAt,
    releaseRuns: runs,
    tagCommit,
    tag_name: tag,
  };
}

function runStateProgram({localPlans = [], releases, releaseRuns, tags = []}) {
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
        import {
          findUnresolvedReleaseState,
          selectPublishedBaseline,
        } from ${JSON.stringify(moduleUrl)};

        const releases = ${JSON.stringify(releases)};
        const releaseRuns = ${JSON.stringify(releaseRuns)};
        const output = {};
        try {
          output.baseline = selectPublishedBaseline({releases, releaseRuns});
        } catch (error) {
          output.baselineError = error.message;
        }
        try {
          output.unresolved = findUnresolvedReleaseState({
            localPlans: ${JSON.stringify(localPlans)},
            releases,
            releaseRuns,
            tags: ${JSON.stringify(tags)},
          });
        } catch (error) {
          output.unresolvedError = error.message;
        }
        console.log(JSON.stringify(output));
      `,
    ],
    {cwd: repoRoot, encoding: 'utf8'},
  );
  if (child.status !== 0) throw new Error(child.stderr || child.stdout);
  return JSON.parse(child.stdout.trim());
}

test('selects only the newest published successful evidence-complete release', () => {
  const incompleteTag = '@pkg-nec/jest-v30.4.4';
  const incompleteAssets = completedAssets({
    commit: laterCommit,
    packages: [packageEntry('@pkg-nec/jest', '30.4.4')],
    tag: incompleteTag,
  }).filter(asset => asset.name !== 'provenance-evidence.json');
  const releases = [
    release(),
    release({
      assets: incompleteAssets,
      createdAt: '2026-08-02T00:00:00.000Z',
      publishedAt: '2026-08-02T01:00:00.000Z',
      runs: [
        releaseRun({
          headSha: laterCommit,
          tag: incompleteTag,
          url: 'https://github.com/pkg-nec/jest/actions/runs/200',
        }),
      ],
      tag: incompleteTag,
      tagCommit: laterCommit,
    }),
    release({
      createdAt: '2026-08-03T00:00:00.000Z',
      draft: true,
      publishedAt: null,
      runs: [],
      tag: '@pkg-nec/jest-v30.4.5',
      tagCommit: '3333333333333333333333333333333333333333',
    }),
    release({
      createdAt: '2026-08-04T00:00:00.000Z',
      prerelease: true,
      publishedAt: '2026-08-04T01:00:00.000Z',
      tag: '@pkg-nec/jest-v30.4.6',
    }),
  ];
  const result = runStateProgram({
    releaseRuns: releases.flatMap(item => item.releaseRuns),
    releases,
  });

  expect(result.baseline).toEqual({
    commit: completedCommit,
    ledgerSchemaVersion: 1,
    packages: [packageEntry()],
    publishedAt: '2026-08-01T01:00:00.000Z',
    releaseUrl:
      'https://github.com/pkg-nec/jest/releases/tag/@pkg-nec/jest-v30.4.3',
    runUrl: 'https://github.com/pkg-nec/jest/actions/runs/100',
    tag: completedTag,
  });
});

test.each([
  ['failed', 'completed', 'failure', 'failed-run'],
  ['cancelled', 'completed', 'cancelled', 'failed-run'],
  ['queued', 'queued', null, 'in-progress-run'],
  ['in-progress', 'in_progress', null, 'in-progress-run'],
])(
  'reports a newer %s run for a schema-1 baseline without a local plan',
  (_, status, conclusion, kind) => {
    const laterRun = releaseRun({
      conclusion,
      status,
      url: 'https://github.com/pkg-nec/jest/actions/runs/101',
    });
    const candidate = release({runs: [releaseRun(), laterRun]});
    const result = runStateProgram({
      releaseRuns: candidate.releaseRuns,
      releases: [candidate],
    });

    expect(result.unresolved).toEqual([
      expect.objectContaining({
        kind,
        runUrl: laterRun.html_url,
        tag: completedTag,
      }),
    ]);
  },
);

test('does not report the evidence-complete schema-1 baseline run without a local plan', () => {
  const candidate = release();
  const result = runStateProgram({
    releaseRuns: candidate.releaseRuns,
    releases: [candidate],
  });

  expect(result.unresolved).toEqual([]);
});

test('rejects internally inconsistent durable evidence as a baseline', () => {
  const assets = completedAssets();
  const journal = assets.find(
    asset => asset.name === 'publication-journal.json',
  );
  journal.content = {
    ...journal.content,
    packages: [packageEntry('@pkg-nec/jest', '30.4.2')],
  };
  const candidate = release({assets});
  const result = runStateProgram({
    releaseRuns: candidate.releaseRuns,
    releases: [candidate],
  });

  expect(result.baselineError).toMatch(/completed published release/iu);
});

test('reports every later unresolved plan, release, tag, and workflow run', () => {
  const incompleteTag = '@pkg-nec/jest-v30.4.4';
  const planTag = '@pkg-nec/jest-v30.5.0';
  const draftTag = planTag;
  const incomplete = release({
    assets: completedAssets({
      commit: laterCommit,
      packages: [packageEntry('@pkg-nec/jest', '30.4.4')],
      tag: incompleteTag,
    }).filter(asset => asset.name !== 'provenance-evidence.json'),
    createdAt: '2026-08-02T00:00:00.000Z',
    publishedAt: '2026-08-02T01:00:00.000Z',
    runs: [
      releaseRun({
        conclusion: 'failure',
        headSha: laterCommit,
        tag: incompleteTag,
        url: 'https://github.com/pkg-nec/jest/actions/runs/201',
      }),
      releaseRun({
        conclusion: null,
        headSha: laterCommit,
        status: 'in_progress',
        tag: incompleteTag,
        url: 'https://github.com/pkg-nec/jest/actions/runs/202',
      }),
    ],
    tag: incompleteTag,
    tagCommit: laterCommit,
  });
  const draft = release({
    createdAt: '2026-08-03T00:00:00.000Z',
    draft: true,
    publishedAt: null,
    runs: [],
    tag: draftTag,
    tagCommit: '3333333333333333333333333333333333333333',
    url: 'https://github.com/pkg-nec/jest/releases/tag/draft-300',
  });
  const localPlans = [
    {
      path: 'docs/releases/pkg-nec-jest-v30.5.0-plan.json',
      plan: unpublishedPlan(),
    },
  ];
  const releases = [release(), incomplete, draft];
  const result = runStateProgram({
    localPlans,
    releaseRuns: releases.flatMap(item => item.releaseRuns),
    releases,
    tags: [
      {
        commit: completedCommit,
        createdAt: '2026-08-01T00:00:00.000Z',
        name: completedTag,
      },
      {
        commit: '4444444444444444444444444444444444444444',
        createdAt: '2026-08-04T00:00:00.000Z',
        name: '@pkg-nec/jest-v30.4.7',
        relationToBaseline: 'descendant',
      },
    ],
  });

  expect(result.unresolved.map(item => item.kind)).toEqual([
    'local-plan',
    'incomplete-release',
    'draft-release',
    'unmatched-tag',
    'failed-run',
    'in-progress-run',
  ]);
  expect(result.unresolved).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        draftUrl: 'https://github.com/pkg-nec/jest/releases/tag/draft-300',
        message: expect.stringMatching(/manual investigation/iu),
        planPath: localPlans[0].path,
        tag: planTag,
        versions: [
          {
            fromVersion: '30.4.3',
            name: '@pkg-nec/jest',
            toVersion: '30.5.0',
          },
        ],
      }),
      expect.objectContaining({
        draftUrl: 'https://github.com/pkg-nec/jest/releases/tag/draft-300',
        kind: 'draft-release',
        tag: draftTag,
      }),
      expect.objectContaining({
        kind: 'failed-run',
        runUrl: 'https://github.com/pkg-nec/jest/actions/runs/201',
      }),
    ]),
  );
});

test('reports a plan whose versions disagree with its published state', () => {
  const plan = completedPlan();
  plan.changedFiles.packages.unshift({
    files: ['packages/expect/src/index.ts'],
    name: '@pkg-nec/expect',
  });
  plan.packages = [
    {
      bump: 'minor',
      fromVersion: '30.4.2',
      name: '@pkg-nec/expect',
      order: 1,
      path: 'packages/expect',
      reasons: [{files: ['packages/expect/src/index.ts'], kind: 'changed'}],
      toVersion: '30.5.0',
    },
    {...plan.packages[0], order: 2},
  ];
  const localPlans = [
    {
      path: 'docs/releases/pkg-nec-jest-v30.4.3-plan.json',
      plan,
    },
  ];
  const candidate = release();
  const result = runStateProgram({
    localPlans,
    releaseRuns: candidate.releaseRuns,
    releases: [candidate],
  });

  expect(result.unresolved).toEqual([
    expect.objectContaining({
      kind: 'plan-publication-mismatch',
      message: expect.stringMatching(/manual investigation/iu),
      planPath: localPlans[0].path,
      tag: completedTag,
      versions: [
        {
          name: '@pkg-nec/expect',
          plannedVersion: '30.5.0',
          publishedVersion: null,
        },
      ],
    }),
  ]);
});

test.each([
  [
    'path alias',
    {
      path: 'docs/releases/aliased-plan.json',
      plan: completedPlan(),
    },
  ],
  [
    'non-exact schema',
    {
      path: 'docs/releases/pkg-nec-jest-v30.4.3-plan.json',
      plan: {...completedPlan(), unexpected: true},
    },
  ],
  [
    'malformed JSON marker',
    {
      path: 'docs/releases/pkg-nec-jest-v30.4.3-plan.json',
      plan: {parseError: 'Invalid JSON'},
    },
  ],
])('reports a tracked local plan with a %s as unresolved', (_, localPlan) => {
  const candidate = release();
  const result = runStateProgram({
    localPlans: [localPlan],
    releaseRuns: candidate.releaseRuns,
    releases: [candidate],
  });

  expect(result.unresolved).toEqual([
    expect.objectContaining({
      kind: 'invalid-local-plan',
      message: expect.stringMatching(/manual investigation/iu),
      planPath: localPlan.path,
    }),
  ]);
});

test('reports a failed release workflow run whose tag has no Release', () => {
  const candidate = release();
  const orphanTag = '@pkg-nec/jest-v30.4.4';
  const orphanRun = releaseRun({
    conclusion: 'failure',
    headBranch: 'main',
    headSha: laterCommit,
    tag: orphanTag,
    url: 'https://github.com/pkg-nec/jest/actions/runs/400',
  });
  const result = runStateProgram({
    releaseRuns: [...candidate.releaseRuns, orphanRun],
    releases: [candidate],
    tags: [
      {
        commit: laterCommit,
        createdAt: '2026-08-02T00:00:00.000Z',
        name: orphanTag,
        relationToBaseline: 'descendant',
      },
    ],
  });

  expect(result.unresolved).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: 'failed-run',
        runUrl: 'https://github.com/pkg-nec/jest/actions/runs/400',
        tag: orphanTag,
      }),
    ]),
  );
});

test.each(['failure', 'cancelled'])(
  'ignores a historical %s run after the same tag has evidence-complete success',
  conclusion => {
    const successful = releaseRun();
    const historical = releaseRun({
      conclusion,
      url: 'https://github.com/pkg-nec/jest/actions/runs/99',
    });
    const candidate = release({runs: [historical, successful]});
    const result = runStateProgram({
      releaseRuns: candidate.releaseRuns,
      releases: [candidate],
    });

    expect(result.unresolved).toEqual([]);
  },
);

test.each([
  ['failed', 'failure'],
  ['cancelled', 'cancelled'],
])(
  'keeps a historical %s run unresolved when the completed tag moved to another commit',
  (_, conclusion) => {
    const historical = releaseRun({
      conclusion,
      headSha: laterCommit,
      url: 'https://github.com/pkg-nec/jest/actions/runs/99',
    });
    const candidate = release({runs: [historical, releaseRun()]});
    const result = runStateProgram({
      releaseRuns: candidate.releaseRuns,
      releases: [candidate],
    });

    expect(result.unresolved).toEqual([
      expect.objectContaining({
        kind: 'failed-run',
        runUrl: historical.html_url,
        tag: completedTag,
      }),
    ]);
  },
);

test('keeps a lower-id non-release event unresolved after same-tag completion', () => {
  const historical = releaseRun({
    conclusion: 'failure',
    event: 'workflow_dispatch',
    url: 'https://github.com/pkg-nec/jest/actions/runs/99',
  });
  const candidate = release({runs: [historical, releaseRun()]});
  const result = runStateProgram({
    releaseRuns: candidate.releaseRuns,
    releases: [candidate],
  });

  expect(result.unresolved).toEqual([
    expect.objectContaining({
      kind: 'failed-run',
      runUrl: historical.html_url,
      tag: completedTag,
    }),
  ]);
});

test.each([
  ['wrong', '.github/workflows/other.yml', 'failure'],
  ['missing', null, 'cancelled'],
  ['suffixed', '.github/workflows/release.yml@refs/tags/pkg-nec', 'success'],
])(
  'keeps a correlated run with a %s workflow path unresolved',
  (_, workflowPath, conclusion) => {
    const correlated = releaseRun({
      conclusion,
      url: 'https://github.com/pkg-nec/jest/actions/runs/99',
      workflowPath,
    });
    const candidate = release({runs: [correlated, releaseRun()]});
    const result = runStateProgram({
      releaseRuns: candidate.releaseRuns,
      releases: [candidate],
    });

    expect(result.unresolved).toEqual([
      expect.objectContaining({
        kind: 'failed-run',
        runUrl: correlated.html_url,
        tag: completedTag,
      }),
    ]);
  },
);

test('ignores a wrong-workflow run unrelated to every release tag and commit', () => {
  const unrelated = releaseRun({
    conclusion: 'failure',
    headBranch: 'main',
    headSha: laterCommit,
    url: 'https://github.com/pkg-nec/jest/actions/runs/99',
    workflowPath: '.github/workflows/other.yml',
  });
  const candidate = release();
  const result = runStateProgram({
    releaseRuns: [...candidate.releaseRuns, unrelated],
    releases: [candidate],
  });

  expect(result.unresolved).toEqual([]);
});

test.each([
  ['missing', null, 'failure'],
  ['wrong', 'main', 'success'],
])(
  'keeps a correlated run with a %s baseline branch unresolved',
  (_, headBranch, conclusion) => {
    const correlated = releaseRun({
      conclusion,
      headBranch,
      url: 'https://github.com/pkg-nec/jest/actions/runs/99',
    });
    const candidate = release({runs: [correlated, releaseRun()]});
    const result = runStateProgram({
      releaseRuns: candidate.releaseRuns,
      releases: [candidate],
    });

    expect(result.unresolved).toEqual([
      expect.objectContaining({
        kind: 'failed-run',
        runUrl: correlated.html_url,
        tag: completedTag,
      }),
    ]);
  },
);

test.each([
  ['wrong', laterCommit],
  ['missing', null],
])(
  'keeps a successful correlated run with a %s source commit unresolved',
  (_, headSha) => {
    const correlated = releaseRun({
      headSha,
      url: 'https://github.com/pkg-nec/jest/actions/runs/99',
    });
    const candidate = release({runs: [correlated, releaseRun()]});
    const result = runStateProgram({
      releaseRuns: candidate.releaseRuns,
      releases: [candidate],
    });

    expect(result.unresolved).toEqual([
      expect.objectContaining({
        kind: 'failed-run',
        runUrl: correlated.html_url,
        tag: completedTag,
      }),
    ]);
  },
);

test('keeps a shared-commit run unresolved without choosing a release tag', () => {
  const otherTag = '@pkg-nec/jest-v30.4.4';
  const otherRun = releaseRun({
    tag: otherTag,
    url: 'https://github.com/pkg-nec/jest/actions/runs/200',
  });
  const otherRelease = release({
    assets: completedAssets({
      packages: [packageEntry('@pkg-nec/jest', '30.4.4')],
      runUrl: otherRun.html_url,
      tag: otherTag,
    }),
    createdAt: '2026-08-02T00:00:00.000Z',
    publishedAt: '2026-08-02T01:00:00.000Z',
    runs: [otherRun],
    tag: otherTag,
  });
  const ambiguous = releaseRun({
    conclusion: 'failure',
    headBranch: 'main',
    url: 'https://github.com/pkg-nec/jest/actions/runs/99',
  });
  const originalRelease = release();
  const result = runStateProgram({
    releaseRuns: [
      ...originalRelease.releaseRuns,
      ...otherRelease.releaseRuns,
      ambiguous,
    ],
    releases: [originalRelease, otherRelease],
  });

  expect(result.unresolved).toEqual([
    expect.objectContaining({
      kind: 'failed-run',
      runUrl: ambiguous.html_url,
      tag: null,
    }),
  ]);
});

test('ignores an exact-workflow run unrelated to every release tag and commit', () => {
  const unrelated = releaseRun({
    conclusion: 'failure',
    headBranch: 'main',
    headSha: laterCommit,
    url: 'https://github.com/pkg-nec/jest/actions/runs/99',
  });
  const candidate = release();
  const result = runStateProgram({
    releaseRuns: [...candidate.releaseRuns, unrelated],
    releases: [candidate],
  });

  expect(result.unresolved).toEqual([]);
});

test.each(['queued', 'in_progress'])(
  'keeps an active %s run unresolved after a completed retry',
  status => {
    const active = releaseRun({
      conclusion: null,
      status,
      url: 'https://github.com/pkg-nec/jest/actions/runs/101',
    });
    const candidate = release({runs: [releaseRun(), active]});
    const result = runStateProgram({
      localPlans: [
        {
          path: 'docs/releases/pkg-nec-jest-v30.4.3-plan.json',
          plan: completedPlan(),
        },
      ],
      releaseRuns: candidate.releaseRuns,
      releases: [candidate],
    });

    expect(result.unresolved).toEqual([
      expect.objectContaining({
        kind: 'in-progress-run',
        runUrl: active.html_url,
        tag: completedTag,
      }),
    ]);
  },
);

test('ignores superseded failures attached to older completed plan tags', () => {
  const newerTag = '@pkg-nec/jest-v30.4.4';
  const newerRunUrl = 'https://github.com/pkg-nec/jest/actions/runs/200';
  const older = release({
    runs: [
      releaseRun({
        conclusion: 'failure',
        url: 'https://github.com/pkg-nec/jest/actions/runs/99',
      }),
      releaseRun(),
    ],
  });
  const newerRun = releaseRun({
    headSha: laterCommit,
    tag: newerTag,
    url: newerRunUrl,
  });
  const newer = release({
    assets: completedAssets({
      commit: laterCommit,
      packages: [packageEntry('@pkg-nec/jest', '30.4.4')],
      runUrl: newerRunUrl,
      tag: newerTag,
    }),
    createdAt: '2026-08-02T00:00:00.000Z',
    publishedAt: '2026-08-02T01:00:00.000Z',
    runs: [newerRun],
    tag: newerTag,
    tagCommit: laterCommit,
  });
  const result = runStateProgram({
    localPlans: [
      {
        path: 'docs/releases/pkg-nec-jest-v30.4.3-plan.json',
        plan: completedPlan(),
      },
    ],
    releaseRuns: [...older.releaseRuns, newerRun],
    releases: [older, newer],
  });

  expect(result.baseline).toEqual(
    expect.objectContaining({commit: laterCommit, tag: newerTag}),
  );
  expect(result.unresolved).toEqual([]);
});

test.each([
  ['strict ancestor', 'ancestor', '2099-01-01T00:00:00.000Z', false],
  ['equal', 'equal', '2000-01-01T00:00:00.000Z', true],
  ['descendant', 'descendant', '2000-01-01T00:00:00.000Z', true],
  ['unrelated', 'unrelated', '2000-01-01T00:00:00.000Z', true],
])(
  'classifies an unmatched tag on a %s commit by topology, not date',
  (_, relationToBaseline, createdAt, blocked) => {
    const candidate = release();
    const tag = {
      commit:
        relationToBaseline === 'equal'
          ? completedCommit
          : '8888888888888888888888888888888888888888',
      createdAt,
      name: '@pkg-nec/jest-v99.0.0',
      relationToBaseline,
    };
    const result = runStateProgram({
      releaseRuns: candidate.releaseRuns,
      releases: [candidate],
      tags: [tag],
    });

    expect(result.unresolved.some(item => item.kind === 'unmatched-tag')).toBe(
      blocked,
    );
  },
);

test('accepts the selective schema-2 ledger as completed evidence', () => {
  const candidate = release({
    assets: completedAssets({ledgerSchemaVersion: 2}),
  });
  const result = runStateProgram({
    releaseRuns: candidate.releaseRuns,
    releases: [candidate],
  });

  expect(result.baseline).toEqual(
    expect.objectContaining({commit: completedCommit, tag: completedTag}),
  );
});

test.each([
  [
    'missing',
    assets =>
      assets.filter(asset => asset.name !== 'pkg-nec-jest-v30.4.3-plan.json'),
  ],
  [
    'altered',
    assets => {
      assets.find(
        asset => asset.name === 'pkg-nec-jest-v30.4.3-plan.json',
      ).content += '\n';
      return assets;
    },
  ],
  [
    'malformed',
    assets => {
      const planAsset = assets.find(
        asset => asset.name === 'pkg-nec-jest-v30.4.3-plan.json',
      );
      planAsset.content = '{';
      assets.find(
        asset => asset.name === 'release-ledger.json',
      ).content.releasePlan.digest = digest(planAsset.content);
      return assets;
    },
  ],
  [
    'path-aliased',
    assets => {
      assets.find(
        asset => asset.name === 'release-ledger.json',
      ).content.releasePlan.path = 'docs/releases/aliased-plan.json';
      return assets;
    },
  ],
  [
    'wrong-tag',
    assets =>
      replacePlanContent(assets, plan => ({
        ...plan,
        anchor: {
          ...plan.anchor,
          tag: '@pkg-nec/jest-v30.4.4',
          version: '30.4.4',
        },
        packages: [
          {...plan.packages[0], fromVersion: '30.4.3', toVersion: '30.4.4'},
        ],
        planPath: 'docs/releases/pkg-nec-jest-v30.4.4-plan.json',
      })),
  ],
  [
    'wrong-package-set',
    assets =>
      replacePlanContent(assets, plan => ({
        ...plan,
        changedFiles: {
          ...plan.changedFiles,
          packages: [
            {
              files: ['packages/expect/src/index.ts'],
              name: '@pkg-nec/expect',
            },
            ...plan.changedFiles.packages,
          ],
        },
        packages: [
          {
            bump: 'patch',
            fromVersion: '30.4.2',
            name: '@pkg-nec/expect',
            order: 1,
            path: 'packages/expect',
            reasons: [
              {files: ['packages/expect/src/index.ts'], kind: 'changed'},
            ],
            toVersion: '30.4.3',
          },
          {...plan.packages[0], order: 2},
        ],
      })),
  ],
  [
    'wrong-source',
    assets => {
      assets.find(
        asset => asset.name === 'release-ledger.json',
      ).content.sourceCommit = laterCommit;
      return assets;
    },
  ],
])(
  'rejects a schema-2 baseline with a %s committed plan asset',
  (_, mutate) => {
    const candidate = release({
      assets: mutate(completedAssets({ledgerSchemaVersion: 2})),
    });
    const result = runStateProgram({
      releaseRuns: candidate.releaseRuns,
      releases: [candidate],
    });

    expect(result.baselineError).toMatch(/completed published release/iu);
  },
);

test('rejects a release workflow whose branch is not the exact release tag', () => {
  const candidate = release({runs: [releaseRun({headBranch: 'main'})]});
  const result = runStateProgram({
    releaseRuns: candidate.releaseRuns,
    releases: [candidate],
  });

  expect(result.baselineError).toMatch(/completed published release/iu);
});

test('selects the exact summary-linked run among candidates on one commit', () => {
  const selected = releaseRun();
  const unrelated = releaseRun({
    url: 'https://github.com/pkg-nec/jest/actions/runs/999',
  });
  const candidate = release({runs: [unrelated, selected]});
  const result = runStateProgram({
    releaseRuns: candidate.releaseRuns,
    releases: [candidate],
  });

  expect(result.baseline).toEqual(
    expect.objectContaining({runUrl: selected.html_url}),
  );
});

test.each([
  [
    'tag prefix',
    workflowSummary({tag: `${completedTag}-forged`}),
    releaseRun(),
  ],
  [
    'run URL prefix',
    workflowSummary({
      runUrl: 'https://github.com/pkg-nec/jest/actions/runs/100/attempts/1',
    }),
    releaseRun(),
  ],
  [
    'non-release event',
    workflowSummary(),
    releaseRun({event: 'workflow_dispatch'}),
  ],
])('rejects workflow evidence with a %s mismatch', (_, summary, run) => {
  const assets = completedAssets();
  assets.find(asset => asset.name === 'workflow-summary.md').content = summary;
  const candidate = release({assets, runs: [run]});
  const result = runStateProgram({
    releaseRuns: candidate.releaseRuns,
    releases: [candidate],
  });

  expect(result.baselineError).toMatch(/completed published release/iu);
});
