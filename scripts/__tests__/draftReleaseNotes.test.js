/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

const {spawnSync} = require('node:child_process');
const path = require('node:path');
const {pathToFileURL} = require('node:url');

const rendererUrl = pathToFileURL(
  path.join(process.cwd(), 'scripts/pkgNec/draftReleaseNotes.mjs'),
).href;
const schemaUrl = pathToFileURL(
  path.join(process.cwd(), 'scripts/pkgNec/releasePlanSchema.mjs'),
).href;

function runModule({operation, plan, sourceCommit}) {
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
        import {renderDraftRelease} from ${JSON.stringify(rendererUrl)};
        import {validateReleasePlan} from ${JSON.stringify(schemaUrl)};
        try {
          const value = ${JSON.stringify(operation)} === 'render'
            ? renderDraftRelease({
                plan: ${JSON.stringify(plan)},
                sourceCommit: ${JSON.stringify(sourceCommit)},
              })
            : validateReleasePlan(${JSON.stringify(plan)});
          console.log(JSON.stringify({ok: true, value}));
        } catch (error) {
          console.log(JSON.stringify({error: error.message, ok: false}));
        }
      `,
    ],
    {cwd: process.cwd(), encoding: 'utf8'},
  );
  if (child.status !== 0) throw new Error(child.stderr || child.stdout);
  const result = JSON.parse(child.stdout.trim());
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

function renderDraftRelease({plan, sourceCommit}) {
  return runModule({operation: 'render', plan, sourceCommit});
}

function validateReleasePlan(plan) {
  return runModule({operation: 'validate', plan});
}

const sourceCommit = 'abcdef0123456789abcdef0123456789abcdef01';

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
    preparedFrom: '0123456789abcdef0123456789abcdef01234567',
    previousRelease: {
      commit: 'd8ba8b4b36a84ee019c9f8cdfc99d0fc598b61fb',
      tag: '@pkg-nec/jest-v30.4.3',
    },
    rootImpact: {applied: 'all', requested: 'all'},
    schemaVersion: 1,
  };
}

test('renders deterministic draft metadata in plan order', () => {
  const result = renderDraftRelease({plan: validPlan(), sourceCommit});

  expect(result.title).toBe('@pkg-nec/jest-v30.5.0');
  expect(result.notes).toBe(
    '# @pkg-nec/jest-v30.5.0\n\n' +
      `- Source commit: \`${sourceCommit}\`\n` +
      '- Release plan: `docs/releases/pkg-nec-jest-v30.5.0-plan.json`\n' +
      '- Previous published release: `@pkg-nec/jest-v30.4.3`\n\n' +
      '## Packages\n\n' +
      '- `@pkg-nec/jest-reporters@30.5.0`\n' +
      '- `@pkg-nec/jest@30.5.0`\n\n' +
      '## Root impact\n\n' +
      '- Requested: `all`\n' +
      '- Applied: `all`\n' +
      '- Ambiguous files: `1`\n' +
      '- All-package files: `0`\n\n' +
      '## Maintainer notes\n\n' +
      '<!-- Add release narrative here before publishing this draft. Keep the source commit and package list unchanged. -->\n',
  );
  expect(result.notes).not.toMatch(
    /timestamp|draft URL|local path|preparedFrom|yarn\.lock/u,
  );
  expect(result.notes.match(/## Packages/g) ?? []).toHaveLength(1);
});

test('uses not provided for a null root request and counts validator root files', () => {
  const plan = validPlan();
  plan.rootImpact = {applied: 'not-needed', requested: null};
  plan.changedFiles.root.ambiguous = [];
  plan.changedFiles.root.allPackages = ['.github/workflows/release.yml'];
  const {notes} = renderDraftRelease({plan, sourceCommit});

  expect(notes).toContain('- Requested: `not provided`');
  expect(notes).toContain('- Ambiguous files: `0`');
  expect(notes).toContain('- All-package files: `1`');
  expect(notes).not.toContain('.github/workflows/release.yml');
});

test.each([
  [
    'hostile package name',
    plan => (plan.packages[0].name = '@pkg-nec/bad`name'),
  ],
  ['hostile package path', plan => (plan.packages[0].path = '../outside')],
  ['hostile plan path', plan => (plan.planPath = 'C:/outside.json')],
])('rejects %s before Markdown rendering', (_label, mutate) => {
  const plan = validPlan();
  mutate(plan);
  expect(() => renderDraftRelease({plan, sourceCommit})).toThrow(
    /invalid release plan/u,
  );
  expect(() => validateReleasePlan(plan)).toThrow(/invalid release plan/u);
});

test('rejects a source commit that cannot be safely placed in Markdown code', () => {
  expect(() =>
    renderDraftRelease({plan: validPlan(), sourceCommit: 'abc`def'}),
  ).toThrow(/sourceCommit/u);
});
