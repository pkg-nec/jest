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
const validatorModuleUrl = pathToFileURL(
  path.join(repoRoot, 'scripts/validatePkgNecReleasePlan.mjs'),
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
const artifactBuildInputs = [
  'eslint.config.mjs',
  'scripts/babel-plugin-jest-native-globals.js',
  'scripts/bundleTs.mjs',
  'scripts/removeBuildDeclarations.mjs',
  'scripts/writeBundledDeclarations.mjs',
];

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

function formatFailure({
  circularDetails = false,
  cleanupErrors = [],
  details = null,
  hostileMetadata = null,
  primary = 'planning failed',
  recoveryPaths = [],
} = {}) {
  const scenario = {
    circularDetails,
    cleanupErrors,
    details,
    hostileMetadata,
    primary,
    recoveryPaths,
  };
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
        import {formatPlanReleaseError} from ${JSON.stringify(moduleUrl)};
        const scenario = ${JSON.stringify(scenario)};
        const error = new Error(scenario.primary);
        error.cleanupErrors = scenario.cleanupErrors.map(
          value => new Error(value),
        );
        error.details = scenario.circularDetails
          ? Object.assign({}, {self: null})
          : scenario.details;
        if (scenario.circularDetails) error.details.self = error.details;
        error.recoveryPaths = scenario.recoveryPaths;
        if (scenario.hostileMetadata === 'revoked-proxies') {
          const cleanup = Proxy.revocable([], {});
          const recovery = Proxy.revocable([], {});
          cleanup.revoke();
          recovery.revoke();
          error.cleanupErrors = cleanup.proxy;
          error.recoveryPaths = recovery.proxy;
        }
        if (scenario.hostileMetadata === 'throwing-access') {
          error.cleanupErrors = [];
          Object.defineProperty(error.cleanupErrors, 0, {
            get() {
              throw new Error('cleanup element trap');
            },
          });
          error.recoveryPaths = new Proxy(['recovery'], {
            get(target, key, receiver) {
              if (key === 'length') throw new Error('recovery length trap');
              return Reflect.get(target, key, receiver);
            },
          });
        }
        if (scenario.hostileMetadata === 'hostile-values') {
          error.cleanupErrors = [
            {
              get message() {
                throw new Error('cleanup message trap');
              },
              toString() {
                throw new Error('cleanup string trap');
              },
            },
          ];
          error.recoveryPaths = [
            {
              toJSON() {
                throw new Error('recovery value trap');
              },
            },
          ];
        }
        if (scenario.hostileMetadata === 'throwing-iterators') {
          const withoutIteration = values =>
            new Proxy(values, {
              get(target, key, receiver) {
                if (key === Symbol.iterator) {
                  throw new Error('iterator trap');
                }
                return Reflect.get(target, key, receiver);
              },
            });
          error.cleanupErrors = withoutIteration([
            new Error('cleanup survived'),
          ]);
          error.recoveryPaths = withoutIteration(['recovery survived']);
        }
        process.stdout.write(formatPlanReleaseError(error));
      `,
    ],
    {cwd: repoRoot, encoding: 'utf8'},
  );
  if (child.status !== 0) throw new Error(child.stderr || child.stdout);
  return child.stdout;
}

function runCommand({
  args = [],
  assetContents = {},
  changedFiles = ['packages/create-jest/src/index.ts'],
  dirty = false,
  existingFiles = {},
  finalDirty = false,
  head = headCommit,
  finalHead = head,
  lernaContent = null,
  localPlans = [],
  manifestOverrides = {},
  originMain = headCommit,
  finalOriginMain = originMain,
  planArrivalPath = null,
  realFileSystem = false,
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
  workingDirectory = repoRoot,
} = {}) {
  const scenario = {
    args,
    assetContents,
    changedFiles,
    dirty,
    existingFiles,
    finalDirty,
    finalHead,
    finalOriginMain,
    head,
    lernaContent,
    localPlans,
    manifestOverrides,
    originMain,
    planArrivalPath,
    realFileSystem,
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

        const repoRoot = process.cwd();
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
        const virtualEntries = new Map();
        const virtualMissing = new Set();
        let headReads = 0;
        let nextVirtualIno = 1n;
        let originMainReads = 0;
        let statusReads = 0;
        const virtualPath = file => path.resolve(String(file));
        const virtualLstat = async (file, options) => {
          const normalized = virtualPath(file);
          const entry = virtualEntries.get(normalized);
          if (entry) {
            return {
              dev: entry.dev,
              ino: entry.ino,
              isFile: () => true,
            };
          }
          if (virtualMissing.has(normalized)) {
            throw Object.assign(new Error('missing'), {code: 'ENOENT'});
          }
          return fs.promises.lstat(file, options);
        };
        const requireVirtualAbsence = async file => {
          try {
            await virtualLstat(file, {bigint: true});
          } catch (error) {
            if (error?.code === 'ENOENT') return;
            throw error;
          }
          throw Object.assign(new Error('already exists'), {code: 'EEXIST'});
        };

        const runGit = async args => {
          events.push({args, kind: 'git'});
          if (args[0] === 'status') {
            statusReads++;
            return (statusReads === 1 ? scenario.dirty : scenario.finalDirty)
              ? ' M package.json\\n'
              : '';
          }
          if (args[0] === 'fetch') return '';
          if (args.join(' ') === 'rev-parse HEAD') {
            headReads++;
            return headReads === 1 ? scenario.head : scenario.finalHead;
          }
          if (args.join(' ') === 'rev-parse origin/main') {
            originMainReads++;
            return originMainReads === 1
              ? scenario.originMain
              : scenario.finalOriginMain;
          }
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
            if (
              left === baselineCommit &&
              ['HEAD', scenario.head].includes(right)
            ) {
              return '';
            }
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
          const virtualEntry = virtualEntries.get(virtualPath(file));
          if (virtualEntry?.content) {
            return encoding
              ? virtualEntry.content.toString(encoding)
              : Buffer.from(virtualEntry.content);
          }
          if (virtualMissing.has(virtualPath(file))) {
            throw Object.assign(new Error('missing'), {code: 'ENOENT'});
          }
          if (planFiles.has(normalized)) return planFiles.get(normalized);
          const relative = path.relative(repoRoot, String(file)).replaceAll('\\\\', '/');
          if (Object.hasOwn(scenario.existingFiles, relative)) {
            return scenario.existingFiles[relative];
          }
          if (relative === 'lerna.json' && scenario.lernaContent !== null) {
            return scenario.lernaContent;
          }
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
        let planArrived = false;
        const raceAdapters = scenario.planArrivalPath
          ? {
              link: fs.promises.link,
              lstat: fs.promises.lstat,
              realpath: fs.promises.realpath,
              rename: async (from, to) => {
                const planPath = path.join(repoRoot, scenario.planArrivalPath);
                if (path.resolve(to) === planPath) {
                  await fs.promises.rm(to, {force: true});
                }
                return fs.promises.rename(from, to);
              },
              rm: fs.promises.rm,
              writeFile: async (file, text, options) => {
                if (!planArrived) {
                  await fs.promises.writeFile(
                    path.join(repoRoot, scenario.planArrivalPath),
                    'foreign-plan',
                    {flag: 'wx'},
                  );
                  planArrived = true;
                }
                return fs.promises.writeFile(file, text, options);
              },
            }
          : {};
        const mutationAdapters = scenario.realFileSystem
          ? raceAdapters
          : {
              link: async (from, to) => {
                await requireVirtualAbsence(to);
                const source = await virtualLstat(from, {bigint: true});
                const sourceEntry = virtualEntries.get(virtualPath(from));
                const normalized = virtualPath(to);
                virtualEntries.set(normalized, {
                  content: sourceEntry?.content
                    ? Buffer.from(sourceEntry.content)
                    : Buffer.from(await readFile(from)),
                  dev: source.dev,
                  ino: source.ino,
                });
                virtualMissing.delete(normalized);
                events.push({
                  from: String(from).replaceAll('\\\\', '/'),
                  kind: 'file-link',
                  to: String(to).replaceAll('\\\\', '/'),
                });
              },
              lstat: virtualLstat,
              realpath: fs.promises.realpath,
              rename: async (from, to) => {
                events.push({
                  from: String(from).replaceAll('\\\\', '/'),
                  kind: 'file-rename',
                  to: String(to).replaceAll('\\\\', '/'),
                });
              },
              rm: async (file, options) => {
                const normalized = virtualPath(file);
                virtualEntries.delete(normalized);
                virtualMissing.add(normalized);
                events.push({
                  file: String(file).replaceAll('\\\\', '/'),
                  kind: 'file-rm',
                  options,
                });
              },
              writeFile: async (file, text, options) => {
                await requireVirtualAbsence(file);
                const normalized = virtualPath(file);
                virtualEntries.set(normalized, {
                  content: Buffer.from(text, options.encoding ?? 'utf8'),
                  dev: 8675309n,
                  ino: nextVirtualIno++,
                });
                virtualMissing.delete(normalized);
                events.push({
                  file: String(file).replaceAll('\\\\', '/'),
                  kind: 'file-write',
                  options,
                  text,
                });
              },
            };

        let value;
        try {
          value = await runPlanReleaseCommand({
            args: scenario.args,
            readFile,
            runGh,
            runGit,
            ...mutationAdapters,
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
    {
      cwd: workingDirectory,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  if (child.status !== 0) throw new Error(child.stderr || child.stdout);
  return JSON.parse(child.stdout.trim());
}

function mutationEvents(result) {
  return result.events.filter(event => event.kind.startsWith('file-'));
}

function runFixtureGit(directory, args) {
  const result = spawnSync('git', args, {cwd: directory, encoding: 'utf8'});
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout;
}

function createApplyFixture() {
  const directory = fs.mkdtempSync(
    path.join(repoRoot, '.plan-pkg-nec-release-test-'),
  );
  const files = new Set([
    'lerna.json',
    'package.json',
    'scripts/pkgNec/packageIdentityPolicy.json',
    'scripts/pkgNec/releaseImpactPolicy.json',
    ...identityPolicy.packages.map(item => item.manifestPath),
  ]);
  for (const file of files) {
    const destination = path.join(directory, file);
    fs.mkdirSync(path.dirname(destination), {recursive: true});
    fs.copyFileSync(path.join(repoRoot, file), destination);
  }
  const fixtureLernaPath = path.join(directory, 'lerna.json');
  const fixtureLerna = JSON.parse(fs.readFileSync(fixtureLernaPath, 'utf8'));
  fs.writeFileSync(
    fixtureLernaPath,
    `${JSON.stringify({...fixtureLerna, version: '30.4.3'}, null, 2)}\n`,
  );
  fs.mkdirSync(path.join(directory, 'docs/releases'), {recursive: true});
  const manifestPath = 'packages/create-jest/package.json';
  const originalManifest = JSON.parse(
    fs.readFileSync(path.join(directory, manifestPath), 'utf8'),
  );
  const originalLerna = JSON.parse(
    fs.readFileSync(path.join(directory, 'lerna.json'), 'utf8'),
  );
  runFixtureGit(directory, ['init', '--quiet']);
  runFixtureGit(directory, ['config', 'user.email', 'fixture@example.invalid']);
  runFixtureGit(directory, ['config', 'user.name', 'Fixture']);
  runFixtureGit(directory, ['add', '.']);
  runFixtureGit(directory, ['commit', '--quiet', '-m', 'fixture']);
  return {directory, manifestPath, originalLerna, originalManifest};
}

function runRenameParityFixture() {
  const directory = fs.mkdtempSync(
    path.join(repoRoot, '.plan-pkg-nec-release-rename-test-'),
  );
  try {
    const files = new Set([
      'lerna.json',
      'scripts/pkgNec/packageIdentityPolicy.json',
      'scripts/pkgNec/releaseImpactPolicy.json',
      ...identityPolicy.packages.map(item => item.manifestPath),
    ]);
    for (const file of files) {
      const destination = path.join(directory, file);
      fs.mkdirSync(path.dirname(destination), {recursive: true});
      fs.copyFileSync(path.join(repoRoot, file), destination);
    }
    const renamedFrom = 'packages/create-jest/renamed-source.ts';
    const renamedTo = 'docs/renamed-source.ts';
    fs.writeFileSync(path.join(directory, renamedFrom), 'renamed source\n');
    runFixtureGit(directory, ['init', '--quiet']);
    runFixtureGit(directory, [
      'config',
      'user.email',
      'fixture@example.invalid',
    ]);
    runFixtureGit(directory, ['config', 'user.name', 'Fixture']);
    runFixtureGit(directory, ['config', 'diff.renames', 'true']);
    runFixtureGit(directory, ['add', '.']);
    runFixtureGit(directory, ['commit', '--quiet', '-m', 'baseline']);
    const baseline = runFixtureGit(directory, ['rev-parse', 'HEAD']).trim();
    runFixtureGit(directory, ['tag', baselineTag]);
    fs.mkdirSync(path.join(directory, 'docs'), {recursive: true});
    fs.renameSync(
      path.join(directory, renamedFrom),
      path.join(directory, renamedTo),
    );
    runFixtureGit(directory, ['add', '-A']);
    runFixtureGit(directory, ['commit', '--quiet', '-m', 'prepared']);
    const prepared = runFixtureGit(directory, ['rev-parse', 'HEAD']).trim();
    fs.mkdirSync(path.join(directory, 'docs/releases'), {recursive: true});

    const release = completedRelease();
    for (const asset of release.assets) {
      if (asset.content && typeof asset.content === 'object') {
        asset.content.sourceCommit = baseline;
      }
    }
    const releaseRun = workflowRun({head_sha: baseline});
    const program = `
      import {execFileSync} from 'node:child_process';
      import {runPlanReleaseCommand} from ${JSON.stringify(moduleUrl)};
      import {runValidateReleasePlanCommand} from ${JSON.stringify(validatorModuleUrl)};
      const directory = ${JSON.stringify(directory)};
      const prepared = ${JSON.stringify(prepared)};
      const release = ${JSON.stringify(release)};
      const releaseRun = ${JSON.stringify(releaseRun)};
      const git = args => execFileSync('git', args, {
        cwd: directory,
        encoding: 'utf8',
      });
      const gitEvents = [];
      const runGit = async args => {
        gitEvents.push(args);
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
          console.log(JSON.stringify({gitEvents, planner}));
        } else {
          git(['add', '-A']);
          git(['commit', '--quiet', '-m', 'release preparation']);
          const head = git(['rev-parse', 'HEAD']).trim();
          const validation = await runValidateReleasePlanCommand({
            args: [prepared],
            expectedHead: head,
            write: () => {},
          });
          console.log(JSON.stringify({gitEvents, planner, validation}));
        }
      } catch (error) {
        console.log(JSON.stringify({error: error.message, gitEvents}));
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

function changedKeys(left, right) {
  return [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .filter(key => JSON.stringify(left[key]) !== JSON.stringify(right[key]))
    .sort();
}

function generatedArtifacts(directory) {
  const found = [];
  const visit = current => {
    for (const item of fs.readdirSync(current, {withFileTypes: true})) {
      if (item.name === '.git') continue;
      const itemPath = path.join(current, item.name);
      if (item.isDirectory()) visit(itemPath);
      else if (/\.pkg-nec-release-(?:tmp|backup)-/u.test(item.name)) {
        found.push(path.relative(directory, itemPath).replaceAll('\\', '/'));
      }
    }
  };
  visit(directory);
  return found.sort();
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
    '--no-renames',
    '--name-only',
    '-z',
    `${baselineCommit}..${headCommit}`,
  ]);
  expect(
    commandEvents
      .slice(diffIndex + 1)
      .filter(event => event.kind === 'git' && event.args[0] === 'show')
      .every(event => event.args[1].startsWith(`${baselineCommit}:`)),
  ).toBe(true);
});

test('keeps real rename classification identical between planning and validation', () => {
  const result = runRenameParityFixture();

  expect(result.error).toBeUndefined();
  expect(result.planner.kind).toBe('release');
  expect(result.planner.plan.changedFiles).toEqual({
    packages: [
      {
        files: ['packages/create-jest/renamed-source.ts'],
        name: '@pkg-nec/create-jest',
      },
    ],
    root: {
      allPackages: [],
      ambiguous: [],
      noImpact: ['docs/renamed-source.ts'],
    },
  });
  expect(result.validation).toEqual({
    classification: 'release-preparation',
    packageCount: result.planner.plan.packages.length,
    planPath: result.planner.plan.planPath,
  });
});

test('stops a dirty worktree before fetch and produces no output', () => {
  const result = runCommand({args: ['--apply'], dirty: true});

  expect(result.value.error).toMatch(/clean worktree/iu);
  expect(result.events).toEqual([
    {args: ['status', '--porcelain'], kind: 'git'},
  ]);
  expect(result.output).toEqual([]);
  expect(mutationEvents(result)).toEqual([]);
});

test('stops stale main after the fetched comparison and produces no output', () => {
  const result = runCommand({args: ['--apply'], originMain: baselineCommit});

  expect(result.value.error).toMatch(/HEAD.*origin\/main/iu);
  expect(result.events).toEqual(expectedPreflight.slice(0, 4));
  expect(result.output).toEqual([]);
  expect(mutationEvents(result)).toEqual([]);
});

test.each([
  ['tracked worktree', {finalDirty: true}, /clean|changed/iu],
  ['HEAD', {finalHead: baselineCommit}, /HEAD|identity|changed/iu],
  [
    'origin/main',
    {finalOriginMain: baselineCommit},
    /origin\/main|identity|changed/iu,
  ],
])(
  'aborts apply when final %s identity drifts without output or mutation',
  (_label, input, message) => {
    const result = runCommand({args: ['--apply'], ...input});

    expect(result.value.error).toMatch(message);
    expect(result.output).toEqual([]);
    expect(mutationEvents(result)).toEqual([]);
    expect(
      result.events.filter(
        event => event.kind === 'git' && event.args[0] === 'fetch',
      ),
    ).toHaveLength(1);
  },
);

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
  const result = runCommand({
    args: ['--apply'],
    localPlans: [{path: planPath, plan}],
  });

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
  expect(mutationEvents(result)).toEqual([]);
});

test('blocks malformed tracked plan JSON without output or mutation', () => {
  const planPath = 'docs/releases/pkg-nec-jest-v30.4.3-plan.json';
  const result = runCommand({
    args: ['--apply'],
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
  expect(mutationEvents(result)).toEqual([]);
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

test('formats guarded recovery diagnostics without losing messages or paths', () => {
  expect(
    formatFailure({
      cleanupErrors: ['first cleanup failed', 'second cleanup failed'],
      details: [{kind: 'guarded-write', path: 'manifest.json'}],
      recoveryPaths: [
        'packages/example/package.json.pkg-nec-release-backup-a b\\c\nnext',
      ],
    }),
  ).toBe(
    'planning failed\n' +
      '[\n' +
      '  {\n' +
      '    "kind": "guarded-write",\n' +
      '    "path": "manifest.json"\n' +
      '  }\n' +
      ']\n' +
      'Cleanup errors:\n' +
      '[\n' +
      '  "first cleanup failed",\n' +
      '  "second cleanup failed"\n' +
      ']\n' +
      'Recovery backup paths:\n' +
      '[\n' +
      '  "packages/example/package.json.pkg-nec-release-backup-a b\\\\c\\nnext"\n' +
      ']\n',
  );
});

test('keeps the primary failure printable when attached details are circular', () => {
  const output = formatFailure({circularDetails: true});

  expect(output).toMatch(/^planning failed\n/u);
  expect(output).toMatch(/unable to format|circular/iu);
});

test('contains revoked cleanup and recovery proxy failures independently', () => {
  const output = formatFailure({
    details: [{kind: 'guarded-write'}],
    hostileMetadata: 'revoked-proxies',
  });

  expect(output).toMatch(/^planning failed\n/iu);
  expect(output).toContain('"kind": "guarded-write"');
  expect(output).toMatch(
    /Cleanup errors:\n<unable to format cleanup errors:/iu,
  );
  expect(output).toMatch(
    /Recovery backup paths:\n<unable to format recovery backup paths:/iu,
  );
});

test('contains throwing cleanup elements and recovery array access', () => {
  const output = formatFailure({hostileMetadata: 'throwing-access'});

  expect(output).toMatch(/^planning failed\n/iu);
  expect(output).toContain('cleanup element trap');
  expect(output).toContain('recovery length trap');
});

test('contains hostile diagnostic values without masking the primary failure', () => {
  const output = formatFailure({hostileMetadata: 'hostile-values'});

  expect(output).toMatch(/^planning failed\n/iu);
  expect(output).toContain('"<unprintable error>"');
  expect(output).toMatch(/recovery value trap/iu);
});

test('does not iterate cleanup errors or recovery paths', () => {
  const output = formatFailure({hostileMetadata: 'throwing-iterators'});

  expect(output).toContain('"cleanup survived"');
  expect(output).toContain('"recovery survived"');
  expect(output).not.toContain('iterator trap');
});

test.each(artifactBuildInputs)(
  'does not let --root-impact=none suppress known artifact input %s',
  changedFile => {
    const result = runCommand({
      args: ['--root-impact=none'],
      changedFiles: [changedFile],
    });

    expect(result.value.kind).toBe('release');
    expect(result.value.plan.packages).toHaveLength(publishedPackages.length);
    expect(result.value.plan.changedFiles.root).toEqual({
      allPackages: [changedFile],
      ambiguous: [],
      noImpact: [],
    });
    expect(result.value.plan.rootImpact).toEqual({
      applied: 'all',
      requested: 'none',
    });
  },
);

test('allows reviewed preparation orchestration changes to have no package impact', () => {
  const result = runCommand({
    args: ['--root-impact=none'],
    changedFiles: ['scripts/preparePkgNecRelease.mjs'],
  });

  expect(result.value).toEqual({
    apply: false,
    kind: 'no-changes',
    message: 'no releasable package changes',
  });
  expect(result.output).toEqual(['no releasable package changes\n']);
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
  expect(
    mutationEvents(result).some(
      event =>
        event.kind === 'file-write' &&
        event.file
          .replaceAll('\\', '/')
          .includes('/lerna.json.pkg-nec-release-'),
    ),
  ).toBe(false);
});

test('keeps read-only and non-release outcomes free of filesystem mutations', () => {
  const results = [
    runCommand(),
    runCommand({args: ['--apply'], changedFiles: ['docs/maintenance.md']}),
    runCommand({args: ['--apply'], changedFiles: ['yarn.lock']}),
  ];

  for (const result of results) expect(mutationEvents(result)).toEqual([]);
});

test('reads and validates the complete apply set before the first temporary write', () => {
  const result = runCommand({
    args: ['--bump', '@pkg-nec/create-jest=minor', '--apply'],
    lernaContent: '{"version":"30.4.3"}\n',
  });
  const firstWrite = result.events.findIndex(
    event => event.kind === 'file-write',
  );
  const beforeWrite = result.events.slice(0, firstWrite);

  expect(result.value.kind).toBe('release');
  expect(firstWrite).toBeGreaterThan(-1);
  expect(result.value.plan.packages.map(item => item.name)).toEqual([
    '@pkg-nec/create-jest',
  ]);
  for (const expectedPath of [
    'packages/create-jest/package.json',
    'lerna.json',
    result.value.plan.planPath,
  ]) {
    expect(
      beforeWrite.some(
        event =>
          event.kind === 'read' &&
          event.file.replaceAll('\\', '/').endsWith(expectedPath),
      ),
    ).toBe(true);
  }
  const fileWrites = mutationEvents(result).filter(
    event => event.kind === 'file-write',
  );
  expect(fileWrites).toHaveLength(3);
  for (const event of fileWrites)
    expect(() => JSON.parse(event.text)).not.toThrow();
});

test.each([
  ['invalid Lerna JSON', {args: ['--apply'], lernaContent: '{'}, /lerna/iu],
  [
    'an existing untracked plan path',
    {
      args: ['--bump', '@pkg-nec/create-jest=minor', '--apply'],
      existingFiles: {
        'docs/releases/pkg-nec-create-jest-v30.5.0-plan.json': 'foreign\n',
      },
    },
    /plan.*exist/iu,
  ],
])('rejects %s with zero filesystem mutations', (_label, input, message) => {
  const result = runCommand(input);

  expect(result.value.error).toMatch(message);
  expect(mutationEvents(result)).toEqual([]);
});

test.each([
  ['null', 'null'],
  ['an array', '[]'],
  ['a string', '"independent"'],
  ['a number', '1'],
])('rejects %s Lerna JSON before mutation', (_label, lernaContent) => {
  const result = runCommand({args: ['--apply'], lernaContent});

  expect(result.value.error).toMatch(/lerna.*plain.*object/iu);
  expect(mutationEvents(result)).toEqual([]);
});

test('applies only the selected version, canonical plan, and Lerna mode in a Git fixture', () => {
  const fixture = createApplyFixture();
  try {
    const result = runCommand({
      args: ['--bump', '@pkg-nec/create-jest=minor', '--apply'],
      realFileSystem: true,
      workingDirectory: fixture.directory,
    });
    expect(result.value.kind).toBe('release');
    expect(result.value.plan.packages.map(item => item.name)).toEqual([
      '@pkg-nec/create-jest',
    ]);

    runFixtureGit(fixture.directory, [
      'add',
      '--intent-to-add',
      '--',
      result.value.plan.planPath,
    ]);
    const diffNames = runFixtureGit(fixture.directory, ['diff', '--name-only'])
      .split(/\r?\n/u)
      .filter(Boolean)
      .sort();
    expect(diffNames).toEqual(
      [result.value.plan.planPath, fixture.manifestPath, 'lerna.json'].sort(),
    );

    const updatedManifest = JSON.parse(
      fs.readFileSync(
        path.join(fixture.directory, fixture.manifestPath),
        'utf8',
      ),
    );
    expect(changedKeys(fixture.originalManifest, updatedManifest)).toEqual([
      'version',
    ]);
    expect(updatedManifest.version).toBe('30.5.0');

    const updatedLerna = JSON.parse(
      fs.readFileSync(path.join(fixture.directory, 'lerna.json'), 'utf8'),
    );
    expect(changedKeys(fixture.originalLerna, updatedLerna)).toEqual([
      'version',
    ]);
    expect(updatedLerna.version).toBe('independent');
    expect(
      fs.readFileSync(
        path.join(fixture.directory, result.value.plan.planPath),
        'utf8',
      ),
    ).toBe(`${JSON.stringify(result.value.plan, null, 2)}\n`);
    expect(generatedArtifacts(fixture.directory)).toEqual([]);
  } finally {
    fs.rmSync(fixture.directory, {force: true, recursive: true});
  }
});

test('does not clobber a plan that appears after validation in a Git fixture', () => {
  const fixture = createApplyFixture();
  const planPath = 'docs/releases/pkg-nec-create-jest-v30.5.0-plan.json';
  try {
    const originalManifest = fs.readFileSync(
      path.join(fixture.directory, fixture.manifestPath),
    );
    const originalLerna = fs.readFileSync(
      path.join(fixture.directory, 'lerna.json'),
    );
    const result = runCommand({
      args: ['--bump', '@pkg-nec/create-jest=minor', '--apply'],
      planArrivalPath: planPath,
      realFileSystem: true,
      workingDirectory: fixture.directory,
    });

    expect(result.value.error).toMatch(/exist/iu);
    expect(
      fs.readFileSync(path.join(fixture.directory, planPath), 'utf8'),
    ).toBe('foreign-plan');
    expect(
      fs.readFileSync(path.join(fixture.directory, fixture.manifestPath)),
    ).toEqual(originalManifest);
    expect(fs.readFileSync(path.join(fixture.directory, 'lerna.json'))).toEqual(
      originalLerna,
    );
    expect(generatedArtifacts(fixture.directory)).toEqual([]);
  } finally {
    fs.rmSync(fixture.directory, {force: true, recursive: true});
  }
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
  expect(mutationEvents(result)).toEqual([]);
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
