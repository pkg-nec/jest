/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

const {spawnSync} = require('node:child_process');
const fs = require('graceful-fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');

const repoRoot = process.cwd();
const moduleUrl = pathToFileURL(
  path.join(repoRoot, 'scripts/validatePkgNecReleasePlan.mjs'),
).href;
const plannerModuleUrl = pathToFileURL(
  path.join(repoRoot, 'scripts/planPkgNecRelease.mjs'),
).href;
const baseCommit = '2222222222222222222222222222222222222222';
const headCommit = '3333333333333333333333333333333333333333';
const previousCommit = '1111111111111111111111111111111111111111';
const fixtureBaselineTag = '@pkg-nec/jest-v30.4.3';
const fixtureRunUrl = 'https://github.com/pkg-nec/jest/actions/runs/100';
const fixtureIdentityPolicy = JSON.parse(
  fs.readFileSync(
    path.join(repoRoot, 'scripts/pkgNec/packageIdentityPolicy.json'),
    'utf8',
  ),
);
const fixturePublishedPackages = fixtureIdentityPolicy.packages
  .filter(item => item.publishable)
  .map((item, index) => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(repoRoot, item.manifestPath), 'utf8'),
    );
    return {name: item.newName, order: index + 1, version: manifest.version};
  });

function completedFixtureRelease(sourceCommit) {
  const publication = {
    packages: fixturePublishedPackages,
    releaseTag: fixtureBaselineTag,
    schemaVersion: 1,
    sourceCommit,
  };
  return {
    assets: [
      {
        content:
          '# pkg-nec release workflow evidence\n\n' +
          `- Release tag: \`${fixtureBaselineTag}\`\n` +
          `- Source workflow run: ${fixtureRunUrl}\n` +
          '- Validate job: `success`\n' +
          '- Publish job: `success`\n' +
          '- Verify job: `success`\n',
        name: 'workflow-summary.md',
      },
      {
        content: {
          packages: fixturePublishedPackages,
          schemaVersion: 1,
          sourceCommit,
        },
        name: 'release-ledger.json',
      },
      {content: publication, name: 'publication-journal.json'},
      {content: publication, name: 'registry-evidence.json'},
      {content: publication, name: 'provenance-evidence.json'},
    ],
    created_at: '2026-08-01T00:00:00.000Z',
    draft: false,
    html_url: `https://github.com/pkg-nec/jest/releases/tag/${fixtureBaselineTag}`,
    prerelease: false,
    published_at: '2026-08-01T01:00:00.000Z',
    tag_name: fixtureBaselineTag,
  };
}

function runFixtureGit(directory, args) {
  const result = spawnSync('git', args, {cwd: directory, encoding: 'utf8'});
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

function stageExecutableFixtureFile(directory, relativePath) {
  fs.chmodSync(path.join(directory, relativePath), 0o755);
  runFixtureGit(directory, ['add', '--', relativePath]);
  runFixtureGit(directory, ['update-index', '--chmod=+x', relativePath]);
}

function rawFixturePlan(preparedFrom) {
  return {
    anchor: {
      name: '@pkg-nec/create-jest',
      tag: '@pkg-nec/create-jest-v30.4.1',
      version: '30.4.1',
    },
    changedFiles: {
      packages: [
        {
          files: ['packages/create-jest/source.ts'],
          name: '@pkg-nec/create-jest',
        },
      ],
      root: {allPackages: [], ambiguous: [], noImpact: []},
    },
    packages: [
      {
        bump: 'patch',
        fromVersion: '30.4.0',
        name: '@pkg-nec/create-jest',
        order: 1,
        path: 'packages/create-jest',
        reasons: [{files: ['packages/create-jest/source.ts'], kind: 'changed'}],
        toVersion: '30.4.1',
      },
    ],
    planPath: 'docs/releases/pkg-nec-create-jest-v30.4.1-plan.json',
    preparedFrom,
    previousRelease: {
      commit: '1111111111111111111111111111111111111111',
      tag: '@pkg-nec/create-jest-v30.4.0',
    },
    rootImpact: {applied: 'not-needed', requested: null},
    schemaVersion: 1,
  };
}

function runRealRawFixture(kind) {
  const directory = fs.mkdtempSync(
    path.join(repoRoot, '.validate-release-plan-raw-test-'),
  );
  try {
    runFixtureGit(directory, ['init', '--quiet']);
    runFixtureGit(directory, ['config', 'user.email', 'fixture@example.com']);
    runFixtureGit(directory, ['config', 'user.name', 'Fixture']);
    runFixtureGit(directory, ['config', 'diff.renames', 'true']);
    fs.mkdirSync(path.join(directory, 'packages/a'), {recursive: true});
    fs.writeFileSync(path.join(directory, 'packages/a/source.ts'), 'source\n');
    if (kind === 'delete-similar-plan') {
      fs.mkdirSync(path.join(directory, 'docs/releases'), {recursive: true});
      fs.writeFileSync(
        path.join(
          directory,
          'docs/releases/pkg-nec-create-jest-v30.4.0-plan.json',
        ),
        `${JSON.stringify(rawFixturePlan('2222222222222222222222222222222222222222'), null, 2)}\n`,
      );
    }
    runFixtureGit(directory, ['add', '.']);
    runFixtureGit(directory, ['commit', '--quiet', '-m', 'base']);
    const base = runFixtureGit(directory, ['rev-parse', 'HEAD']);

    const planPath = 'docs/releases/pkg-nec-create-jest-v30.4.1-plan.json';
    fs.mkdirSync(path.join(directory, 'docs/releases'), {recursive: true});
    fs.writeFileSync(
      path.join(directory, planPath),
      `${JSON.stringify(rawFixturePlan(base), null, 2)}\n`,
    );
    if (kind === 'package-move') {
      fs.mkdirSync(path.join(directory, 'packages/b'), {recursive: true});
      fs.renameSync(
        path.join(directory, 'packages/a/source.ts'),
        path.join(directory, 'packages/b/source.ts'),
      );
    }
    if (kind === 'delete-similar-plan') {
      fs.rmSync(
        path.join(
          directory,
          'docs/releases/pkg-nec-create-jest-v30.4.0-plan.json',
        ),
      );
    }
    runFixtureGit(directory, ['add', '-A']);
    if (kind === 'file-mode') {
      stageExecutableFixtureFile(directory, 'packages/a/source.ts');
    }
    if (kind === 'plan-mode') {
      stageExecutableFixtureFile(directory, planPath);
    }
    runFixtureGit(directory, ['commit', '--quiet', '-m', 'head']);
    const head = runFixtureGit(directory, ['rev-parse', 'HEAD']);
    const program = `
      import {runValidateReleasePlanCommand} from ${JSON.stringify(moduleUrl)};
      try {
        await runValidateReleasePlanCommand({
          args: [${JSON.stringify(base)}],
          expectedHead: ${JSON.stringify(head)},
        });
      } catch (error) {
        console.log(JSON.stringify({error: error.message}));
      }
    `;
    const child = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', program],
      {cwd: directory, encoding: 'utf8'},
    );
    if (child.status !== 0) throw new Error(child.stderr || child.stdout);
    return JSON.parse(child.stdout.trim());
  } finally {
    fs.rmSync(directory, {force: true, recursive: true});
  }
}

function runRealMovingHeadFixture() {
  const directory = fs.mkdtempSync(
    path.join(repoRoot, '.validate-release-plan-moving-head-test-'),
  );
  try {
    runFixtureGit(directory, ['init', '--quiet']);
    runFixtureGit(directory, ['config', 'user.email', 'fixture@example.com']);
    runFixtureGit(directory, ['config', 'user.name', 'Fixture']);
    fs.writeFileSync(path.join(directory, 'README.md'), 'base\n');
    runFixtureGit(directory, ['add', 'README.md']);
    runFixtureGit(directory, ['commit', '--quiet', '-m', 'base']);
    const base = runFixtureGit(directory, ['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(directory, 'ordinary.txt'), 'ordinary\n');
    runFixtureGit(directory, ['add', 'ordinary.txt']);
    runFixtureGit(directory, ['commit', '--quiet', '-m', 'head']);
    const head = runFixtureGit(directory, ['rev-parse', 'HEAD']);
    const program = `
      import {execFileSync} from 'node:child_process';
      import {runValidateReleasePlanCommand} from ${JSON.stringify(moduleUrl)};
      const directory = ${JSON.stringify(directory)};
      const base = ${JSON.stringify(base)};
      const head = ${JSON.stringify(head)};
      const events = [];
      let captured = false;
      const git = args => execFileSync('git', args, {
        cwd: directory,
        encoding: 'utf8',
      });
      const runGit = async args => {
        events.push(args);
        const output = git(args);
        if (!captured && args[0] === 'rev-parse') {
          captured = true;
          git(['update-ref', 'HEAD', base, head]);
        }
        return output;
      };
      try {
        const value = await runValidateReleasePlanCommand({
          args: [base],
          expectedHead: head,
          runGit,
        });
        console.log(JSON.stringify({events, value}));
      } catch (error) {
        console.log(JSON.stringify({error: error.message, events}));
      }
    `;
    const child = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', program],
      {cwd: directory, encoding: 'utf8'},
    );
    if (child.status !== 0) throw new Error(child.stderr || child.stdout);
    return JSON.parse(child.stdout.trim());
  } finally {
    fs.rmSync(directory, {force: true, recursive: true});
  }
}

function runRealHistoricalPlanFixture(kind) {
  const directory = fs.mkdtempSync(
    path.join(repoRoot, '.validate-release-plan-history-test-'),
  );
  try {
    runFixtureGit(directory, ['init', '--quiet']);
    runFixtureGit(directory, ['config', 'user.email', 'fixture@example.com']);
    runFixtureGit(directory, ['config', 'user.name', 'Fixture']);
    runFixtureGit(directory, ['config', 'diff.renames', 'true']);
    const oldPlan = 'docs/releases/pkg-nec-create-jest-v30.4.0-plan.json';
    fs.mkdirSync(path.join(directory, 'docs/releases'), {recursive: true});
    fs.writeFileSync(path.join(directory, oldPlan), '{"historical":true}\n');
    fs.writeFileSync(path.join(directory, 'README.md'), 'base\n');
    runFixtureGit(directory, ['add', '.']);
    runFixtureGit(directory, ['commit', '--quiet', '-m', 'base']);
    const base = runFixtureGit(directory, ['rev-parse', 'HEAD']);

    switch (kind) {
      case 'modify':
        fs.writeFileSync(
          path.join(directory, oldPlan),
          '{"historical":false}\n',
        );
        break;
      case 'delete':
        fs.rmSync(path.join(directory, oldPlan));
        break;
      case 'mode':
        break;
      case 'case-rename': {
        const temporary = 'docs/releases/temporary-plan.json';
        const renamed = 'docs/releases/PKG-nec-create-jest-v30.4.0-plan.json';
        runFixtureGit(directory, ['mv', oldPlan, temporary]);
        runFixtureGit(directory, ['mv', temporary, renamed]);
        break;
      }
      case 'rename-away':
        runFixtureGit(directory, [
          'mv',
          oldPlan,
          'docs/historical-release-plan.json',
        ]);
        break;
      case 'replace-similar':
        fs.rmSync(path.join(directory, oldPlan));
        fs.writeFileSync(
          path.join(
            directory,
            'docs/releases/pkg-nec-create-jest-v30.4.1-plan.json',
          ),
          '{"historical":true,"replacement":true}\n',
        );
        break;
      case 'ordinary-source':
        fs.writeFileSync(
          path.join(directory, 'README.md'),
          'ordinary source\n',
        );
        break;
      case 'ordinary-docs':
        fs.mkdirSync(path.join(directory, 'docs/guide'), {recursive: true});
        fs.writeFileSync(
          path.join(directory, 'docs/guide/release.md'),
          'guide\n',
        );
        break;
    }
    runFixtureGit(directory, ['add', '-A']);
    if (kind === 'mode') {
      stageExecutableFixtureFile(directory, oldPlan);
    }
    runFixtureGit(directory, ['commit', '--quiet', '-m', 'head']);
    const head = runFixtureGit(directory, ['rev-parse', 'HEAD']);
    const program = `
      import {runValidateReleasePlanCommand} from ${JSON.stringify(moduleUrl)};
      try {
        const value = await runValidateReleasePlanCommand({
          args: [${JSON.stringify(base)}],
          expectedHead: ${JSON.stringify(head)},
        });
        console.log(JSON.stringify(value));
      } catch (error) {
        console.log(JSON.stringify({error: error.message}));
      }
    `;
    const child = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', program],
      {cwd: directory, encoding: 'utf8'},
    );
    if (child.status !== 0) throw new Error(child.stderr || child.stdout);
    return JSON.parse(child.stdout.trim());
  } finally {
    fs.rmSync(directory, {force: true, recursive: true});
  }
}

function runRealAtomicPreparationFixture(kind) {
  const directory = fs.mkdtempSync(
    path.join(repoRoot, '.validate-release-plan-atomic-test-'),
  );
  try {
    const files = new Set([
      'lerna.json',
      'scripts/pkgNec/packageIdentityPolicy.json',
      'scripts/pkgNec/releaseImpactPolicy.json',
      ...fixtureIdentityPolicy.packages.map(item => item.manifestPath),
    ]);
    for (const file of files) {
      const destination = path.join(directory, file);
      fs.mkdirSync(path.dirname(destination), {recursive: true});
      fs.copyFileSync(path.join(repoRoot, file), destination);
    }
    const sourcePath = 'packages/create-jest/atomic-source.ts';
    fs.writeFileSync(path.join(directory, sourcePath), 'baseline\n');
    runFixtureGit(directory, ['init', '--quiet']);
    runFixtureGit(directory, ['config', 'user.email', 'fixture@example.com']);
    runFixtureGit(directory, ['config', 'user.name', 'Fixture']);
    runFixtureGit(directory, ['add', '.']);
    runFixtureGit(directory, ['commit', '--quiet', '-m', 'baseline']);
    const baseline = runFixtureGit(directory, ['rev-parse', 'HEAD']);
    runFixtureGit(directory, ['tag', fixtureBaselineTag]);
    fs.writeFileSync(path.join(directory, sourcePath), 'prepared\n');
    runFixtureGit(directory, ['add', sourcePath]);
    runFixtureGit(directory, ['commit', '--quiet', '-m', 'prepared base']);
    const prepared = runFixtureGit(directory, ['rev-parse', 'HEAD']);
    fs.mkdirSync(path.join(directory, 'docs/releases'), {recursive: true});

    const release = completedFixtureRelease(baseline);
    const releaseRun = {
      conclusion: 'success',
      event: 'release',
      head_branch: fixtureBaselineTag,
      head_sha: baseline,
      html_url: fixtureRunUrl,
      path: '.github/workflows/release.yml',
      status: 'completed',
    };
    const program = `
      import {execFileSync} from 'node:child_process';
      import fs from 'graceful-fs';
      import path from 'node:path';
      import {runPlanReleaseCommand} from ${JSON.stringify(plannerModuleUrl)};
      import {runValidateReleasePlanCommand} from ${JSON.stringify(moduleUrl)};
      const directory = ${JSON.stringify(directory)};
      const kind = ${JSON.stringify(kind)};
      const prepared = ${JSON.stringify(prepared)};
      const release = ${JSON.stringify(release)};
      const releaseRun = ${JSON.stringify(releaseRun)};
      const identityPolicy = ${JSON.stringify(fixtureIdentityPolicy)};
      const git = args => execFileSync('git', args, {
        cwd: directory,
        encoding: 'utf8',
      });
      const runGit = async args => {
        if (args[0] === 'fetch') return '';
        if (args.join(' ') === 'rev-parse origin/main') return prepared + '\\n';
        return git(args);
      };
      const runGh = async args => {
        if (args[0] === 'repo') {
          return JSON.stringify({nameWithOwner: 'pkg-nec/jest'});
        }
        const endpoint = args.at(-1);
        if (endpoint === 'repos/pkg-nec/jest/releases?per_page=100') {
          return JSON.stringify([[release]]);
        }
        if (
          endpoint ===
          'repos/pkg-nec/jest/actions/workflows/release.yml/runs?per_page=100'
        ) {
          return JSON.stringify([{workflow_runs: [releaseRun]}]);
        }
        throw new Error('Unexpected gh arguments: ' + JSON.stringify(args));
      };
      try {
        const planner = await runPlanReleaseCommand({
          args: ['--apply'],
          runGh,
          runGit,
          write: () => {},
        });
        if (planner.kind !== 'release') {
          throw new Error('Fixture planner did not produce a release');
        }
        const planPath = planner.plan.planPath;
        const manifestPaths = planner.plan.packages.map(item =>
          identityPolicy.packages.find(identity => identity.newName === item.name)
            .manifestPath,
        );
        const exactPlan = fs.readFileSync(path.join(directory, planPath), 'utf8');

        if (kind === 'split-plan-first') {
          git(['add', '--', planPath]);
          git(['commit', '--quiet', '-m', 'plan first']);
          git(['add', '-A']);
          git(['commit', '--quiet', '-m', 'versions later']);
        } else if (kind === 'split-versions-first') {
          git(['add', '--', ...manifestPaths]);
          git(['commit', '--quiet', '-m', 'versions first']);
          git(['add', '-A']);
          git(['commit', '--quiet', '-m', 'plan later']);
        } else if (kind === 'fixup') {
          fs.appendFileSync(path.join(directory, planPath), '\\n');
          git(['add', '-A']);
          git(['commit', '--quiet', '-m', 'generated set']);
          fs.writeFileSync(path.join(directory, planPath), exactPlan);
          git(['add', '--', planPath]);
          git(['commit', '--quiet', '-m', 'fix generated plan']);
        } else {
          if (kind === 'aggregate-mismatch') {
            fs.appendFileSync(path.join(directory, planPath), '\\n');
          }
          git(['add', '-A']);
          git(['commit', '--quiet', '-m', 'atomic generated set']);
          const introduction = git(['rev-parse', 'HEAD']).trim();
          if (kind === 'synthetic-merge' || kind === 'aggregate-mismatch') {
            git(['checkout', '--quiet', '-b', 'merge-target', prepared]);
            git([
              'merge',
              '--quiet',
              '--no-ff',
              '-m',
              'synthetic pull request merge',
              introduction,
            ]);
            if (kind === 'aggregate-mismatch') {
              fs.writeFileSync(path.join(directory, planPath), exactPlan);
              git(['add', '--', planPath]);
              git(['commit', '--quiet', '--amend', '--no-edit']);
            }
          } else if (kind === 'rebase') {
            git(['checkout', '--quiet', '-b', 'rebased', prepared]);
            git(['cherry-pick', '--quiet', introduction]);
          }
        }

        const head = git(['rev-parse', 'HEAD']).trim();
        const validation = await runValidateReleasePlanCommand({
          args: [prepared],
          expectedHead: head,
          write: () => {},
        });
        console.log(JSON.stringify({plan: planner.plan, validation}));
      } catch (error) {
        console.log(JSON.stringify({error: error.message}));
      }
    `;
    const child = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', program],
      {cwd: directory, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024},
    );
    if (child.status !== 0) throw new Error(child.stderr || child.stdout);
    return JSON.parse(child.stdout.trim());
  } finally {
    fs.rmSync(directory, {force: true, recursive: true});
  }
}

function runScenario(mutation = 'valid') {
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
        import fs from 'graceful-fs';
        import path from 'node:path';
        import {runValidateReleasePlanCommand} from ${JSON.stringify(moduleUrl)};

        const mutation = ${JSON.stringify(mutation)};
        const repoRoot = process.cwd();
        const baseCommit = ${JSON.stringify(baseCommit)};
        const headCommit = ${JSON.stringify(headCommit)};
        const previousCommit = ${JSON.stringify(previousCommit)};
        const introductionCommit = '5555555555555555555555555555555555555555';
        const introductionParent = baseCommit;
        const previousTag = '@pkg-nec/jest-v30.4.0';
        const direct = '@pkg-nec/babel-jest';
        const dependent = '@pkg-nec/babel-preset-jest';
        const transitive = '@pkg-nec/create-jest';
        const unselected = '@pkg-nec/jest-changed-files';
        const directPath = 'packages/babel-jest/package.json';
        const dependentPath = 'packages/babel-preset-jest/package.json';
        const transitivePath = 'packages/create-jest/package.json';
        const unselectedPath = 'packages/jest-changed-files/package.json';
        const changedSource = 'packages/babel-jest/src/index.ts';
        const changedSincePrevious = [
          'docs/guide.md',
          changedSource,
          'yarn.lock',
        ];
        const identityPolicy = JSON.parse(
          fs.readFileSync(
            path.join(repoRoot, 'scripts/pkgNec/packageIdentityPolicy.json'),
            'utf8',
          ),
        );
        const impactPolicy = fs.readFileSync(
          path.join(repoRoot, 'scripts/pkgNec/releaseImpactPolicy.json'),
          'utf8',
        );
        const identityPolicyText = JSON.stringify(identityPolicy);
        const manifests = Object.fromEntries(
          identityPolicy.packages.map(identity => [
            identity.manifestPath,
            {name: identity.oldName, version: '30.4.0'},
          ]),
        );
        manifests[dependentPath].dependencies = {[direct]: 'workspace:*'};
        manifests[transitivePath].devDependencies = {
          [dependent]: 'workspace:*',
        };
        const baselineManifests = structuredClone(manifests);
        const baseManifests = structuredClone(manifests);
        const headManifests = structuredClone(manifests);
        const headManifestTextOverrides = {};
        for (const manifestPath of [
          directPath,
          dependentPath,
          transitivePath,
        ]) {
          headManifests[manifestPath].version = '30.4.1';
        }

        const plan = {
          anchor: {
            name: transitive,
            tag: '@pkg-nec/create-jest-v30.4.1',
            version: '30.4.1',
          },
          changedFiles: {
            packages: [{files: [changedSource], name: direct}],
            root: {
              allPackages: [],
              ambiguous: ['yarn.lock'],
              noImpact: ['docs/guide.md'],
            },
          },
          packages: [
            {
              bump: 'patch',
              fromVersion: '30.4.0',
              name: direct,
              order: 1,
              path: 'packages/babel-jest',
              reasons: [{files: [changedSource], kind: 'changed'}],
              toVersion: '30.4.1',
            },
            {
              bump: 'patch',
              fromVersion: '30.4.0',
              name: dependent,
              order: 2,
              path: 'packages/babel-preset-jest',
              reasons: [
                {kind: 'dependent', paths: [[direct, dependent]]},
              ],
              toVersion: '30.4.1',
            },
            {
              bump: 'patch',
              fromVersion: '30.4.0',
              name: transitive,
              order: 3,
              path: 'packages/create-jest',
              reasons: [
                {
                  kind: 'dependent',
                  paths: [[direct, dependent, transitive]],
                },
              ],
              toVersion: '30.4.1',
            },
          ],
          planPath: 'docs/releases/pkg-nec-create-jest-v30.4.1-plan.json',
          preparedFrom: baseCommit,
          previousRelease: {commit: previousCommit, tag: previousTag},
          rootImpact: {applied: 'none', requested: 'none'},
          schemaVersion: 1,
        };
        let baseLerna = {npmClient: 'yarn', version: 'independent'};
        let headLerna = structuredClone(baseLerna);
        let headLernaTextOverride = null;
        let stagedTrackedChanges = '';
        let trackedStatus = '';
        let unstagedTrackedChanges = '';
        let expectedHead = headCommit;
        let useEnvironmentHead = false;
        let addedPlanPath = plan.planPath;
        let addedPlanPaths = [addedPlanPath];
        let extraPlanBytes = '';
        let prChanged = [
          addedPlanPath,
          directPath,
          dependentPath,
          transitivePath,
        ];
        let prEntries = [
          {newMode: '100644', oldMode: '000000', path: addedPlanPath, status: 'A'},
          {newMode: '100644', oldMode: '100644', path: directPath, status: 'M'},
          {newMode: '100644', oldMode: '100644', path: dependentPath, status: 'M'},
          {newMode: '100644', oldMode: '100644', path: transitivePath, status: 'M'},
        ];

        switch (mutation) {
          case 'ordinary':
            addedPlanPaths = [];
            prChanged = ['README.md'];
            prEntries = [
              {
                newMode: '100644',
                oldMode: '100644',
                path: 'README.md',
                status: 'M',
              },
            ];
            break;
          case 'dirty-index':
            stagedTrackedChanges = directPath + '\\0';
            trackedStatus = 'M  packages/babel-jest/package.json\\0';
            break;
          case 'dirty-worktree':
            trackedStatus = ' M packages/babel-jest/package.json\\0';
            unstagedTrackedChanges = directPath + '\\0';
            break;
          case 'expected-head-mismatch':
            expectedHead = '4444444444444444444444444444444444444444';
            break;
          case 'environment-head-mismatch':
            expectedHead = '4444444444444444444444444444444444444444';
            useEnvironmentHead = true;
            break;
          case 'multiple-plans':
            addedPlanPaths = [
              addedPlanPath,
              'docs/releases/pkg-nec-create-jest-v30.4.2-plan.json',
            ];
            prEntries.push({
              newMode: '100644',
              oldMode: '000000',
              path: addedPlanPaths[1],
              status: 'A',
            });
            break;
          case 'prepared-from':
            plan.preparedFrom = '4444444444444444444444444444444444444444';
            break;
          case 'extra-package': {
            plan.packages.push({
              bump: 'patch',
              fromVersion: '30.4.0',
              name: unselected,
              order: 4,
              path: 'packages/jest-changed-files',
              reasons: [
                {kind: 'dependent', paths: [[direct, unselected]]},
              ],
              toVersion: '30.4.1',
            });
            break;
          }
          case 'missing-transitive':
            plan.packages.pop();
            plan.anchor = {
              name: direct,
              tag: '@pkg-nec/babel-jest-v30.4.1',
              version: '30.4.1',
            };
            plan.planPath =
              'docs/releases/pkg-nec-babel-jest-v30.4.1-plan.json';
            addedPlanPath = plan.planPath;
            addedPlanPaths = [addedPlanPath];
            prChanged[0] = addedPlanPath;
            prEntries[0].path = addedPlanPath;
            break;
          case 'order':
            [plan.packages[1], plan.packages[2]] = [
              plan.packages[2],
              plan.packages[1],
            ];
            plan.packages[1].order = 2;
            plan.packages[2].order = 3;
            break;
          case 'bump':
            plan.packages[1].bump = 'minor';
            plan.packages[1].toVersion = '30.5.0';
            break;
          case 'from-version':
            plan.packages[1].fromVersion = '30.3.1';
            plan.packages[1].toVersion = '30.3.2';
            break;
          case 'to-version':
            plan.packages[1].toVersion = '30.4.2';
            break;
          case 'reason-path':
            plan.packages[2].reasons = [
              {kind: 'dependent', paths: [[direct, transitive]]},
            ];
            break;
          case 'root-classification':
            plan.changedFiles.root.noImpact = [];
            plan.changedFiles.root.ambiguous = ['docs/guide.md', 'yarn.lock'];
            break;
          case 'root-decision':
            plan.rootImpact.applied = 'not-needed';
            break;
          case 'anchor':
            plan.anchor = {
              name: direct,
              tag: '@pkg-nec/babel-jest-v30.4.1',
              version: '30.4.1',
            };
            plan.planPath =
              'docs/releases/pkg-nec-babel-jest-v30.4.1-plan.json';
            addedPlanPath = plan.planPath;
            addedPlanPaths = [addedPlanPath];
            prChanged[0] = addedPlanPath;
            prEntries[0].path = addedPlanPath;
            break;
          case 'tag':
            plan.anchor.tag = '@pkg-nec/create-jest-v30.4.2';
            break;
          case 'filename':
            addedPlanPath = 'docs/releases/pkg-nec-wrong-v1.0.0-plan.json';
            addedPlanPaths = [addedPlanPath];
            prChanged[0] = addedPlanPath;
            prEntries[0].path = addedPlanPath;
            break;
          case 'plan-bytes':
            extraPlanBytes = '\\n';
            break;
          case 'unselected-version':
            headManifests[unselectedPath].version = '30.4.1';
            prChanged.push(unselectedPath);
            prEntries.push({
              newMode: '100644',
              oldMode: '100644',
              path: unselectedPath,
              status: 'M',
            });
            break;
          case 'selected-dependency-field':
            headManifests[dependentPath].dependencies[unselected] =
              'workspace:*';
            break;
          case 'source-file':
            prChanged.push('packages/babel-jest/src/new.ts');
            prEntries.push({
              newMode: '100644',
              oldMode: '000000',
              path: 'packages/babel-jest/src/new.ts',
              status: 'A',
            });
            break;
          case 'documentation-file':
            prChanged.push('docs/release-note.md');
            prEntries.push({
              newMode: '100644',
              oldMode: '000000',
              path: 'docs/release-note.md',
              status: 'A',
            });
            break;
          case 'lerna-field':
            headLerna = {...headLerna, useWorkspaces: true};
            prChanged.push('lerna.json');
            prEntries.push({
              newMode: '100644',
              oldMode: '100644',
              path: 'lerna.json',
              status: 'M',
            });
            break;
          case 'valid-lerna':
            baseLerna = {npmClient: 'yarn', version: '30.4.0'};
            headLerna = {npmClient: 'yarn', version: 'independent'};
            prChanged.push('lerna.json');
            prEntries.push({
              newMode: '100644',
              oldMode: '100644',
              path: 'lerna.json',
              status: 'M',
            });
            break;
          case 'deleted-source':
            prChanged.push('packages/babel-jest/src/removed.ts');
            prEntries.push({
              newMode: '000000',
              oldMode: '100644',
              path: 'packages/babel-jest/src/removed.ts',
              status: 'D',
            });
            break;
          case 'deleted-similar-plan':
            prChanged.push(
              'docs/releases/pkg-nec-create-jest-v30.4.0-plan.json',
            );
            prEntries.push({
              newMode: '000000',
              oldMode: '100644',
              path: 'docs/releases/pkg-nec-create-jest-v30.4.0-plan.json',
              status: 'D',
            });
            break;
          case 'plan-mode':
            prEntries[0].newMode = '100755';
            break;
          case 'selected-manifest-mode':
            prEntries[1].newMode = '100755';
            break;
          case 'manifest-format':
            headManifestTextOverrides[directPath] = JSON.stringify(
              headManifests[directPath],
            );
            break;
          case 'manifest-reordered':
            headManifestTextOverrides[directPath] =
              JSON.stringify(
                {
                  version: headManifests[directPath].version,
                  name: headManifests[directPath].name,
                },
                null,
                2,
              ) + '\\n';
            break;
          case 'manifest-duplicate-version':
            headManifestTextOverrides[directPath] =
              '{\\n' +
              '  "name": "babel-jest",\\n' +
              '  "version": "30.4.0",\\n' +
              '  "\\u0076ersion": "30.4.1"\\n' +
              '}\\n';
            break;
          case 'manifest-duplicate-dependencies': {
            const dependencyValue = JSON.stringify(
              headManifests[dependentPath].dependencies,
            );
            headManifestTextOverrides[dependentPath] =
              '{\\n' +
              '  "name": "babel-preset-jest",\\n' +
              '  "version": "30.4.1",\\n' +
              '  "dependencies": ' +
              dependencyValue +
              ',\\n' +
              '  "\\u0064ependencies": ' +
              dependencyValue +
              '\\n' +
              '}\\n';
            break;
          }
          case 'lerna-format':
            baseLerna = {npmClient: 'yarn', version: '30.4.0'};
            headLerna = {npmClient: 'yarn', version: 'independent'};
            headLernaTextOverride = JSON.stringify(headLerna);
            prChanged.push('lerna.json');
            prEntries.push({
              newMode: '100644',
              oldMode: '100644',
              path: 'lerna.json',
              status: 'M',
            });
            break;
          case 'lerna-duplicate-version':
            baseLerna = {npmClient: 'yarn', version: '30.4.0'};
            headLerna = {npmClient: 'yarn', version: 'independent'};
            headLernaTextOverride =
              '{"npmClient":"yarn","version":"30.4.0","\\u0076ersion":"independent"}\\n';
            prChanged.push('lerna.json');
            prEntries.push({
              newMode: '100644',
              oldMode: '100644',
              path: 'lerna.json',
              status: 'M',
            });
            break;
        }

        const planText = JSON.stringify(plan, null, 2) + '\\n' + extraPlanBytes;
        const planTexts = new Map(
          addedPlanPaths.map(planPath => [planPath, planText]),
        );
        const events = [];
        const nulList = values => values.join('\\0') + (values.length ? '\\0' : '');
        const rawDiff = entries =>
          entries
            .map(entry => {
              const oldObject = entry.status === 'A' ? '0'.repeat(40) : 'a'.repeat(40);
              const newObject = entry.status === 'D' ? '0'.repeat(40) : 'b'.repeat(40);
              return (
                ':' +
                entry.oldMode +
                ' ' +
                entry.newMode +
                ' ' +
                oldObject +
                ' ' +
                newObject +
                ' ' +
                entry.status +
                '\\0' +
                entry.path +
                '\\0'
              );
            })
            .join('');
        const manifestText = (collection, manifestPath, commit) => {
          if (
            commit === headCommit ||
            commit === introductionCommit ||
            commit === 'HEAD'
          ) {
            if (headManifestTextOverrides[manifestPath]) {
              return headManifestTextOverrides[manifestPath];
            }
            if ([directPath, dependentPath, transitivePath].includes(manifestPath)) {
              return JSON.stringify(collection[manifestPath], null, 2) + '\\n';
            }
          }
          return JSON.stringify(collection[manifestPath]);
        };
        const runGit = async args => {
          events.push(args);
          if (args[0] === 'rev-parse') return headCommit;
          if (args[0] === 'status') return trackedStatus;
          if (args[0] === 'diff' && args.includes('--no-ext-diff')) {
            return args.includes('--cached')
              ? stagedTrackedChanges
              : unstagedTrackedChanges;
          }
          if (
            mutation === 'head-moved' &&
            args.some(value => String(value).includes('HEAD'))
          ) {
            throw new Error('Symbolic HEAD moved after capture');
          }
          if (args[0] === 'diff' && args.includes('--diff-filter=A')) {
            return nulList(addedPlanPaths);
          }
          if (args[0] === 'diff' && args.includes('--raw')) {
            return rawDiff(prEntries);
          }
          if (args[0] === 'rev-list' && args.includes('--no-merges')) {
            return introductionCommit + '\\n';
          }
          if (args[0] === 'rev-list' && args.includes('--parents')) {
            return introductionCommit + ' ' + introductionParent + '\\n';
          }
          if (args[0] === 'rev-list') return previousCommit;
          if (args[0] === 'merge-base') return '';
          if (args[0] === 'diff' && args.includes('--name-only')) {
            const range = args.find(value => value.includes('..'));
            if (range === previousCommit + '..' + baseCommit) {
              return nulList(changedSincePrevious);
            }
            if (range === baseCommit + '..' + headCommit) {
              return nulList(prChanged);
            }
            if (range === baseCommit + '..HEAD') return nulList(prChanged);
          }
          if (args[0] === 'show') {
            const specifier = args[1];
            const separator = specifier.indexOf(':');
            const commit = specifier.slice(0, separator);
            const file = specifier.slice(separator + 1);
            if (
              (commit === headCommit ||
                commit === introductionCommit ||
                commit === 'HEAD') &&
              planTexts.has(file)
            ) {
              return planTexts.get(file);
            }
            if (
              commit === baseCommit &&
              file === 'scripts/pkgNec/packageIdentityPolicy.json'
            ) {
              return identityPolicyText;
            }
            if (
              commit === baseCommit &&
              file === 'scripts/pkgNec/releaseImpactPolicy.json'
            ) {
              return impactPolicy;
            }
            if (file === 'lerna.json') {
              if (
                (commit === headCommit ||
                  commit === introductionCommit ||
                  commit === 'HEAD') &&
                headLernaTextOverride !== null
              ) {
                return headLernaTextOverride;
              }
              const value =
                commit === headCommit ||
                commit === introductionCommit ||
                commit === 'HEAD'
                  ? headLerna
                  : baseLerna;
              return commit === headCommit ||
                commit === introductionCommit ||
                commit === 'HEAD'
                ? JSON.stringify(value, null, 2) + '\\n'
                : JSON.stringify(value);
            }
            if (Object.hasOwn(baseManifests, file)) {
              if (commit === previousCommit) {
                return manifestText(baselineManifests, file, commit);
              }
              if (commit === baseCommit) {
                return manifestText(baseManifests, file, commit);
              }
              if (
                commit === headCommit ||
                commit === introductionCommit ||
                commit === 'HEAD'
              ) {
                return manifestText(headManifests, file, commit);
              }
            }
          }
          throw new Error('Unexpected git arguments: ' + JSON.stringify(args));
        };

        let value;
        try {
          const options = {
            args: mutation === 'bad-base' ? ['--upload=secret'] : [baseCommit],
            expectedHead,
            readFile: async () => {
              throw new Error('Validator must read repository state from Git objects');
            },
            runGit,
            write: () => {},
          };
          if (useEnvironmentHead) {
            process.env.GITHUB_SHA = expectedHead;
            delete options.expectedHead;
          }
          value = await runValidateReleasePlanCommand(options);
        } catch (error) {
          value = {error: error.message};
        }
        console.log(JSON.stringify({events, value}));
      `,
    ],
    {cwd: repoRoot, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024},
  );
  if (child.status !== 0) throw new Error(child.stderr || child.stdout);
  return JSON.parse(child.stdout.trim());
}

test('accepts a canonical release-preparation diff recalculated from Git objects', () => {
  expect(runScenario().value).toEqual({
    classification: 'release-preparation',
    packageCount: 3,
    planPath: 'docs/releases/pkg-nec-create-jest-v30.4.1-plan.json',
  });
});

test('bypasses recalculation for an ordinary pull request without an added plan', () => {
  const result = runScenario('ordinary');

  expect(result.value).toEqual({classification: 'not-release-preparation'});
  expect(result.events).toEqual([
    ['rev-parse', '--verify', 'HEAD^{commit}'],
    [
      'diff',
      '--no-ext-diff',
      '--no-renames',
      '--name-only',
      '-z',
      '--cached',
      headCommit,
      '--',
    ],
    [
      'diff',
      '--no-ext-diff',
      '--no-renames',
      '--name-only',
      '-z',
      headCommit,
      '--',
    ],
    [
      'diff',
      '--no-renames',
      '--raw',
      '--no-abbrev',
      '-z',
      `${baseCommit}..${headCommit}`,
      '--',
      'docs/releases',
    ],
  ]);
});

test.each([
  [
    'dirty-index',
    'Release-plan validation requires a clean tracked worktree and index',
  ],
  [
    'dirty-worktree',
    'Release-plan validation requires a clean tracked worktree and index',
  ],
  ['expected-head-mismatch', 'HEAD does not match the expected CI commit'],
  ['environment-head-mismatch', 'HEAD does not match the expected CI commit'],
])('binds validation state before diff discovery: %s', (mutation, error) => {
  const result = runScenario(mutation);
  expect(result.value).toEqual({error});
  if (mutation.startsWith('dirty-')) {
    expect(result.events.slice(1, 3)).toEqual([
      expect.arrayContaining(['--cached', headCommit]),
      expect.arrayContaining([headCommit]),
    ]);
  }
});

test('uses one captured full HEAD for every later Git operation', () => {
  const result = runScenario('valid');
  const serializedLaterCalls = JSON.stringify(result.events.slice(1));

  expect(result.events.filter(args => args[0] === 'rev-parse')).toEqual([
    ['rev-parse', '--verify', 'HEAD^{commit}'],
  ]);
  expect(serializedLaterCalls).not.toContain('HEAD');
  expect(serializedLaterCalls).toContain(headCommit);
});

test('disables rename detection for plan discovery and release classification', () => {
  const result = runScenario('valid');
  const discovery = result.events.find(args => args.includes('docs/releases'));
  const releaseChanges = result.events.find(
    args =>
      args[0] === 'diff' && args.includes(`${previousCommit}..${baseCommit}`),
  );
  const scope = result.events.find(
    args =>
      args.includes('--raw') &&
      args.includes(`${baseCommit}..${headCommit}`) &&
      !args.includes('docs/releases'),
  );

  expect(discovery).toContain('--no-renames');
  expect(releaseChanges).toContain('--no-renames');
  expect(scope).toEqual([
    'diff',
    '--no-renames',
    '--raw',
    '--no-abbrev',
    '-z',
    `${baseCommit}..${headCommit}`,
  ]);
});

test.each([
  [
    'deleted-source',
    'Release-preparation pull request contains deleted file: "packages/babel-jest/src/removed.ts"',
  ],
  [
    'deleted-similar-plan',
    'Historical release plan cannot be deleted or renamed: "docs/releases/pkg-nec-create-jest-v30.4.0-plan.json"',
  ],
  [
    'plan-mode',
    'Release plan must be added as a regular file with mode 100644',
  ],
  [
    'selected-manifest-mode',
    'Release-preparation pull request changes file type or mode: "packages/babel-jest/package.json"',
  ],
])('rejects raw diff status/mode mutation %s', (mutation, error) => {
  expect(runScenario(mutation).value).toEqual({error});
});

test.each([
  [
    'package-move',
    'Release-preparation pull request contains deleted file: "packages/a/source.ts"',
  ],
  [
    'delete-similar-plan',
    'Historical release plan cannot be deleted or renamed: "docs/releases/pkg-nec-create-jest-v30.4.0-plan.json"',
  ],
  [
    'file-mode',
    'Release-preparation pull request changes file type or mode: "packages/a/source.ts"',
  ],
  [
    'plan-mode',
    'Release plan must be added as a regular file with mode 100644',
  ],
])('rejects real Git raw-diff mutation %s', (kind, error) => {
  expect(runRealRawFixture(kind)).toEqual({error});
});

test.each([
  'manifest-format',
  'manifest-reordered',
  'manifest-duplicate-version',
])('rejects selected manifest bytes Task 4 cannot emit: %s', mutation => {
  expect(runScenario(mutation).value).toEqual({
    error:
      'Selected package @pkg-nec/babel-jest manifest bytes do not match Task 4 output',
  });
});

test('rejects duplicate dependency objects that parse to the expected manifest', () => {
  expect(runScenario('manifest-duplicate-dependencies').value).toEqual({
    error:
      'Selected package @pkg-nec/babel-preset-jest manifest bytes do not match Task 4 output',
  });
});

test.each(['lerna-format', 'lerna-duplicate-version'])(
  'rejects Lerna bytes Task 4 cannot emit: %s',
  mutation => {
    expect(runScenario(mutation).value).toEqual({
      error: 'lerna.json bytes do not match Task 4 output',
    });
  },
);

test('does not consult symbolic HEAD after capturing a moving ref', () => {
  const result = runScenario('head-moved');

  expect(result.value.classification).toBe('release-preparation');
  expect(
    result.events.slice(1).some(args => JSON.stringify(args).includes('HEAD')),
  ).toBe(false);
});

test('keeps real tracked cleanliness and discovery bound to the captured commit when HEAD moves', () => {
  const result = runRealMovingHeadFixture();

  expect(result.value).toEqual({classification: 'not-release-preparation'});
  expect(result.events).toEqual([
    ['rev-parse', '--verify', 'HEAD^{commit}'],
    [
      'diff',
      '--no-ext-diff',
      '--no-renames',
      '--name-only',
      '-z',
      '--cached',
      expect.stringMatching(/^[0-9a-f]{40}$/u),
      '--',
    ],
    [
      'diff',
      '--no-ext-diff',
      '--no-renames',
      '--name-only',
      '-z',
      expect.stringMatching(/^[0-9a-f]{40}$/u),
      '--',
    ],
    expect.arrayContaining(['diff', '--no-renames']),
  ]);
});

test.each([
  [
    'modify',
    'Historical release plan bytes are immutable: "docs/releases/pkg-nec-create-jest-v30.4.0-plan.json"',
  ],
  [
    'delete',
    'Historical release plan cannot be deleted or renamed: "docs/releases/pkg-nec-create-jest-v30.4.0-plan.json"',
  ],
  [
    'mode',
    'Historical release plan mode or type is immutable: "docs/releases/pkg-nec-create-jest-v30.4.0-plan.json"',
  ],
  [
    'case-rename',
    'Historical release plan cannot be deleted or renamed: "docs/releases/pkg-nec-create-jest-v30.4.0-plan.json"',
  ],
  [
    'rename-away',
    'Historical release plan cannot be deleted or renamed: "docs/releases/pkg-nec-create-jest-v30.4.0-plan.json"',
  ],
  [
    'replace-similar',
    'Historical release plan cannot be deleted or renamed: "docs/releases/pkg-nec-create-jest-v30.4.0-plan.json"',
  ],
])(
  'rejects real Git historical-plan mutation %s before classification',
  (kind, error) => {
    expect(runRealHistoricalPlanFixture(kind)).toEqual({error});
  },
);

test.each(['ordinary-source', 'ordinary-docs'])(
  'keeps %s changes on the ordinary pull-request path',
  kind => {
    expect(runRealHistoricalPlanFixture(kind)).toEqual({
      classification: 'not-release-preparation',
    });
  },
);

test.each(['atomic', 'rebase', 'synthetic-merge'])(
  'accepts a real Git %s complete generated-set introduction',
  kind => {
    const result = runRealAtomicPreparationFixture(kind);

    expect(result.error).toBeUndefined();
    expect(result.validation).toEqual({
      classification: 'release-preparation',
      packageCount: result.plan.packages.length,
      planPath: result.plan.planPath,
    });
  },
);

test.each(['split-plan-first', 'split-versions-first', 'fixup'])(
  'rejects real Git non-atomic generated history %s',
  kind => {
    expect(runRealAtomicPreparationFixture(kind)).toEqual({
      error: 'Release preparation must contain exactly one non-merge commit',
    });
  },
);

test('rejects a synthetic merge whose aggregate generated tree differs from its introduction', () => {
  expect(runRealAtomicPreparationFixture('aggregate-mismatch')).toEqual({
    error:
      'Release preparation generated files do not match the atomic introduction commit',
  });
});

test('default Git reads ignore local replacement objects', () => {
  const directory = fs.mkdtempSync(
    path.join(repoRoot, '.validate-release-plan-replace-test-'),
  );
  try {
    runFixtureGit(directory, ['init', '--quiet']);
    runFixtureGit(directory, ['config', 'user.email', 'fixture@example.com']);
    runFixtureGit(directory, ['config', 'user.name', 'Fixture']);
    fs.writeFileSync(path.join(directory, 'README.md'), 'base\n');
    runFixtureGit(directory, ['add', 'README.md']);
    runFixtureGit(directory, ['commit', '--quiet', '-m', 'base']);
    const base = runFixtureGit(directory, ['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(directory, 'ordinary.txt'), 'ordinary\n');
    runFixtureGit(directory, ['add', 'ordinary.txt']);
    runFixtureGit(directory, ['commit', '--quiet', '-m', 'ordinary']);
    const head = runFixtureGit(directory, ['rev-parse', 'HEAD']);

    runFixtureGit(directory, ['checkout', '--quiet', '--detach', base]);
    fs.mkdirSync(path.join(directory, 'docs/releases'), {recursive: true});
    fs.writeFileSync(
      path.join(directory, 'docs/releases/pkg-nec-secret-v1.0.0-plan.json'),
      '{"secret":"replacement-object"}\n',
    );
    runFixtureGit(directory, ['add', 'docs/releases']);
    runFixtureGit(directory, ['commit', '--quiet', '-m', 'replacement']);
    const replacement = runFixtureGit(directory, ['rev-parse', 'HEAD']);
    runFixtureGit(directory, ['checkout', '--quiet', '--detach', head]);
    runFixtureGit(directory, ['replace', head, replacement]);

    const program = `
      import {runValidateReleasePlanCommand} from ${JSON.stringify(moduleUrl)};
      const result = await runValidateReleasePlanCommand({
        args: [${JSON.stringify(base)}],
        expectedHead: ${JSON.stringify(head)},
      });
      console.log(JSON.stringify(result));
    `;
    const child = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', program],
      {cwd: directory, encoding: 'utf8'},
    );
    if (child.status !== 0) throw new Error(child.stderr || child.stdout);

    expect(JSON.parse(child.stdout.trim())).toEqual({
      classification: 'not-release-preparation',
    });
  } finally {
    fs.rmSync(directory, {force: true, recursive: true});
  }
});

test('accepts the one-time Lerna version-only transition', () => {
  expect(runScenario('valid-lerna').value.classification).toBe(
    'release-preparation',
  );
});

test.each([
  [
    'multiple-plans',
    'Release-preparation pull request must add exactly one canonical release plan',
  ],
  [
    'prepared-from',
    'Release plan preparedFrom must equal the pull request base commit',
  ],
  [
    'extra-package',
    'Release plan includes unselected package @pkg-nec/jest-changed-files',
  ],
  [
    'missing-transitive',
    'Release plan is missing recalculated package @pkg-nec/create-jest',
  ],
  ['order', 'Release plan package order does not match recalculation'],
  [
    'bump',
    'Release plan bump for @pkg-nec/babel-preset-jest does not match recalculation',
  ],
  [
    'from-version',
    'Release plan fromVersion for @pkg-nec/babel-preset-jest does not match the baseline',
  ],
  [
    'to-version',
    'invalid release plan: packages[].toVersion does not match bump',
  ],
  [
    'reason-path',
    'Release plan reasons for @pkg-nec/create-jest do not match recalculation',
  ],
  [
    'root-classification',
    'Release plan changed-file classifications do not match recalculation',
  ],
  [
    'root-decision',
    'Release plan root-impact decision does not match recalculation',
  ],
  ['anchor', 'Release plan anchor does not match recalculation'],
  ['tag', 'invalid release plan: anchor.tag does not match anchor'],
  ['filename', 'Added release plan path does not match its canonical planPath'],
  ['plan-bytes', 'Release plan bytes do not match the canonical recalculation'],
  [
    'unselected-version',
    'Unselected package @pkg-nec/jest-changed-files version changed in the release-preparation pull request',
  ],
  [
    'selected-dependency-field',
    'Selected package @pkg-nec/babel-preset-jest manifest may change only the version field',
  ],
  [
    'source-file',
    'Release-preparation pull request contains unrelated file: "packages/babel-jest/src/new.ts"',
  ],
  [
    'documentation-file',
    'Release-preparation pull request contains unrelated file: "docs/release-note.md"',
  ],
  [
    'lerna-field',
    'lerna.json may change only its version field to "independent"',
  ],
  ['bad-base', 'Base commit must be a full lowercase 40-hex commit'],
])('rejects the %s mutation with a safe specific error', (mutation, error) => {
  expect(runScenario(mutation).value).toEqual({error});
});

test('does not expose plan contents when Git returns invalid JSON', () => {
  const secret = 'registry-token-that-must-not-be-logged';
  const program = `
    import {runValidateReleasePlanCommand} from ${JSON.stringify(moduleUrl)};
    const base = ${JSON.stringify(baseCommit)};
    const introduction = '5555555555555555555555555555555555555555';
    const planPath = 'docs/releases/pkg-nec-secret-v1.0.0-plan.json';
    const runGit = async args => {
      if (args[0] === 'rev-parse') return ${JSON.stringify(headCommit)};
      if (args[0] === 'status') return '';
      if (args[0] === 'diff' && args.includes('--no-ext-diff')) return '';
      if (args[0] === 'diff' && args.includes('--raw')) {
        return (
          ':000000 100644 ' +
          '0'.repeat(40) +
          ' ' +
          '1'.repeat(40) +
          ' A\\0' +
          planPath +
          '\\0'
        );
      }
      if (args[0] === 'rev-list' && args.includes('--no-merges')) {
        return introduction + '\\n';
      }
      if (args[0] === 'rev-list' && args.includes('--parents')) {
        return introduction + ' ' + base + '\\n';
      }
      if (args[0] === 'show') return ${JSON.stringify(`{"secret":"${secret}"`)};
      throw new Error('unexpected');
    };
    try {
      await runValidateReleasePlanCommand({
        args: [base],
        expectedHead: ${JSON.stringify(headCommit)},
        runGit,
      });
    } catch (error) {
      console.log(JSON.stringify({error: error.message}));
    }
  `;
  const child = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', program],
    {cwd: repoRoot, encoding: 'utf8'},
  );
  if (child.status !== 0) throw new Error(child.stderr || child.stdout);
  const result = JSON.parse(child.stdout.trim());

  expect(result.error).toBe(
    'Release plan docs/releases/pkg-nec-secret-v1.0.0-plan.json is not valid JSON',
  );
  expect(result.error).not.toContain(secret);
});
