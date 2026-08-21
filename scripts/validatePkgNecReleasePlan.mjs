/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import execa from 'execa';
import semver from 'semver';
import {classifyReleaseChanges} from './pkgNec/releaseChangePolicy.mjs';
import {
  canonicalReleasePlan,
  validateReleasePlan,
} from './pkgNec/releasePlanSchema.mjs';
import {createSelectiveReleasePlan} from './pkgNec/selectiveReleasePlanner.mjs';
import {createPackageInventory} from './pkgNecPackageIdentity.mjs';

const usage = 'Usage: yarn validate:pkg-nec-release-plan <base-commit>';
const identityPolicyPath = 'scripts/pkgNec/packageIdentityPolicy.json';
const impactPolicyPath = 'scripts/pkgNec/releaseImpactPolicy.json';
const canonicalPlanPath = /^docs\/releases\/[^/]+-plan\.json$/u;

function commandText(result) {
  if (typeof result === 'string') return result;
  if (typeof result?.stdout === 'string') return result.stdout;
  throw new TypeError('Git command adapter must return stdout text');
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function parsePlainObject(text, label) {
  const value = parseJson(text, label);
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new Error(`${label} must contain a JSON object`);
  }
  return value;
}

function fullCommit(value, label) {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/u.test(value)) {
    throw new Error(`${label} must be a full lowercase 40-hex commit`);
  }
  return value;
}

function safeRepositoryPath(value, label) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.includes(':') ||
    value.split('/').includes('..') ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new Error(`${label} contains an unsafe repository path`);
  }
  return value;
}

function nulPaths(text, label) {
  if (typeof text !== 'string') {
    throw new TypeError(`${label} must be text`);
  }
  if (text.length > 0 && !text.endsWith('\0')) {
    throw new Error(`${label} did not return NUL-delimited paths`);
  }
  const paths = text
    .split('\0')
    .filter(Boolean)
    .map(value => safeRepositoryPath(value, label));
  if (new Set(paths).size !== paths.length) {
    throw new Error(`${label} returned duplicate paths`);
  }
  return paths;
}

function rawDiffEntries(text, label) {
  if (typeof text !== 'string') {
    throw new TypeError(`${label} must be text`);
  }
  if (text.length > 0 && !text.endsWith('\0')) {
    throw new Error(`${label} did not return NUL-delimited records`);
  }
  const tokens = text.split('\0');
  tokens.pop();
  if (tokens.length % 2 !== 0) {
    throw new Error(`${label} returned malformed raw records`);
  }
  const entries = [];
  const paths = new Set();
  for (let index = 0; index < tokens.length; index += 2) {
    const match =
      /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([AMDTU])$/u.exec(
        tokens[index],
      );
    if (!match) throw new Error(`${label} returned a malformed raw header`);
    const file = safeRepositoryPath(tokens[index + 1], label);
    if (paths.has(file)) throw new Error(`${label} returned duplicate paths`);
    paths.add(file);
    entries.push({
      newMode: match[2],
      oldMode: match[1],
      path: file,
      status: match[5],
    });
  }
  return entries;
}

function commitLines(text, label) {
  if (typeof text !== 'string') throw new TypeError(`${label} must be text`);
  return text
    .split(/\r?\n/u)
    .filter(Boolean)
    .map(value => fullCommit(value, label));
}

function diffShape(entries) {
  return entries
    .map(({newMode, oldMode, path: file, status}) => ({
      newMode,
      oldMode,
      path: file,
      status,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function displayPath(value) {
  return JSON.stringify(value);
}

function jsonEqual(left, right) {
  return isDeepStrictEqual(left, right);
}

function withoutVersion(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([key]) => key !== 'version'),
  );
}

function validateIdentityPolicy(policy) {
  if (policy?.schemaVersion !== 1 || !Array.isArray(policy.packages)) {
    throw new Error('Package identity policy from the base commit is invalid');
  }
  const lowerPaths = new Set();
  for (const identity of policy.packages) {
    const manifestPath = safeRepositoryPath(
      identity?.manifestPath,
      'Package identity policy',
    );
    const lowerPath = manifestPath.toLowerCase();
    if (lowerPaths.has(lowerPath)) {
      throw new Error(
        'Package identity policy contains case-colliding manifest paths',
      );
    }
    lowerPaths.add(lowerPath);
  }
}

async function defaultRunGit(args, repoRoot) {
  const {stdout} = await execa('git', args, {
    cwd: repoRoot,
    env: {GIT_NO_REPLACE_OBJECTS: '1'},
    stripFinalNewline: false,
  });
  return stdout;
}

async function readObject({commit, file, runGit}) {
  return commandText(await runGit(['show', `${commit}:${file}`]));
}

async function readManifestSet({commit, identities, runGit}) {
  const values = new Map();
  for (const identity of identities) {
    const text = await readObject({
      commit,
      file: identity.manifestPath,
      runGit,
    });
    parsePlainObject(text, `Manifest ${identity.manifestPath} at ${commit}`);
    values.set(identity.manifestPath, text);
  }
  return values;
}

function inventoryFrom({manifests, policy, repoRoot}) {
  return createPackageInventory({
    policy,
    readFile: file =>
      manifests.get(path.relative(repoRoot, file).replaceAll('\\', '/')),
    repoRoot,
  });
}

function packageManifestPaths(policy) {
  return new Map(
    policy.packages.map(identity => [identity.newName, identity.manifestPath]),
  );
}

function publicPackageNames(inventory) {
  return inventory.packages
    .filter(identity => identity.publishable !== false)
    .map(identity => identity.newName)
    .sort((left, right) => left.localeCompare(right));
}

function inferBump({fromVersion, name, toVersion}) {
  for (const bump of ['patch', 'minor', 'major']) {
    if (semver.inc(fromVersion, bump) === toVersion) return bump;
  }
  throw new Error(
    `Package ${name} has unsupported release-preparation version transition ${fromVersion} -> ${toVersion}`,
  );
}

function compareSelections(actual, expected) {
  const actualNames = new Set(actual.packages.map(item => item.name));
  const expectedNames = new Set(expected.packages.map(item => item.name));
  for (const name of expectedNames) {
    if (!actualNames.has(name)) {
      throw new Error(`Release plan is missing recalculated package ${name}`);
    }
  }
  for (const name of actualNames) {
    if (!expectedNames.has(name)) {
      throw new Error(`Release plan includes unselected package ${name}`);
    }
  }
}

function comparePlan(actual, expected) {
  compareSelections(actual, expected);
  if (
    !jsonEqual(
      actual.packages.map(item => item.name),
      expected.packages.map(item => item.name),
    )
  ) {
    throw new Error('Release plan package order does not match recalculation');
  }
  if (!jsonEqual(actual.changedFiles, expected.changedFiles)) {
    throw new Error(
      'Release plan changed-file classifications do not match recalculation',
    );
  }
  if (!jsonEqual(actual.rootImpact, expected.rootImpact)) {
    throw new Error(
      'Release plan root-impact decision does not match recalculation',
    );
  }

  for (const expectedPackage of expected.packages) {
    const actualPackage = actual.packages.find(
      item => item.name === expectedPackage.name,
    );
    if (actualPackage.bump !== expectedPackage.bump) {
      throw new Error(
        `Release plan bump for ${expectedPackage.name} does not match recalculation`,
      );
    }
    if (actualPackage.fromVersion !== expectedPackage.fromVersion) {
      throw new Error(
        `Release plan fromVersion for ${expectedPackage.name} does not match the baseline`,
      );
    }
    if (actualPackage.toVersion !== expectedPackage.toVersion) {
      throw new Error(
        `Release plan toVersion for ${expectedPackage.name} does not match recalculation`,
      );
    }
    if (actualPackage.path !== expectedPackage.path) {
      throw new Error(
        `Release plan package path for ${expectedPackage.name} does not match recalculation`,
      );
    }
    if (!jsonEqual(actualPackage.reasons, expectedPackage.reasons)) {
      throw new Error(
        `Release plan reasons for ${expectedPackage.name} do not match recalculation`,
      );
    }
  }

  if (!jsonEqual(actual.anchor, expected.anchor)) {
    throw new Error('Release plan anchor does not match recalculation');
  }
  if (actual.planPath !== expected.planPath) {
    throw new Error('Release plan filename does not match recalculation');
  }
}

function validateManifestScope({
  baseManifestText,
  expectedPackage,
  headManifestText,
  manifestPath,
}) {
  const baseManifest = parsePlainObject(
    baseManifestText,
    `Manifest ${manifestPath} at the base commit`,
  );
  const headManifest = parsePlainObject(
    headManifestText,
    `Manifest ${manifestPath} at HEAD`,
  );
  if (!jsonEqual(withoutVersion(baseManifest), withoutVersion(headManifest))) {
    throw new Error(
      `Selected package ${expectedPackage.name} manifest may change only the version field`,
    );
  }
  if (
    baseManifest.version !== expectedPackage.fromVersion ||
    headManifest.version !== expectedPackage.toVersion
  ) {
    throw new Error(
      `Selected package ${expectedPackage.name} manifest versions do not match the recalculated transition`,
    );
  }
  const expectedText = `${JSON.stringify(
    {...baseManifest, version: expectedPackage.toVersion},
    null,
    2,
  )}\n`;
  if (headManifestText !== expectedText) {
    throw new Error(
      `Selected package ${expectedPackage.name} manifest bytes do not match Task 4 output`,
    );
  }
}

function validateLernaScope({baseLernaText, headLernaText}) {
  const baseLerna = parsePlainObject(
    baseLernaText,
    'lerna.json at the base commit',
  );
  const headLerna = parsePlainObject(headLernaText, 'lerna.json at HEAD');
  if (
    baseLerna.version === 'independent' ||
    headLerna.version !== 'independent' ||
    !jsonEqual(withoutVersion(baseLerna), withoutVersion(headLerna))
  ) {
    throw new Error(
      'lerna.json may change only its version field to "independent"',
    );
  }
  const expectedText = `${JSON.stringify(
    {...baseLerna, version: 'independent'},
    null,
    2,
  )}\n`;
  if (headLernaText !== expectedText) {
    throw new Error('lerna.json bytes do not match Task 4 output');
  }
}

export async function runValidateReleasePlanCommand({
  args = process.argv.slice(2),
  expectedHead = process.env.GITHUB_SHA,
  runGit,
  write = value => process.stdout.write(value),
} = {}) {
  if (!Array.isArray(args) || args.length !== 1) throw new Error(usage);
  const baseCommit = fullCommit(args[0], 'Base commit');
  const repoRoot = path.resolve(process.cwd());
  const invokeGit = runGit ?? (gitArgs => defaultRunGit(gitArgs, repoRoot));
  const headCommit = fullCommit(
    commandText(
      await invokeGit(['rev-parse', '--verify', 'HEAD^{commit}']),
    ).trim(),
    'HEAD',
  );
  if (
    expectedHead !== undefined &&
    fullCommit(expectedHead, 'Expected HEAD') !== headCommit
  ) {
    throw new Error('HEAD does not match the expected CI commit');
  }
  const stagedTrackedChanges = commandText(
    await invokeGit([
      'diff',
      '--no-ext-diff',
      '--no-renames',
      '--name-only',
      '-z',
      '--cached',
      headCommit,
      '--',
    ]),
  );
  const unstagedTrackedChanges = commandText(
    await invokeGit([
      'diff',
      '--no-ext-diff',
      '--no-renames',
      '--name-only',
      '-z',
      headCommit,
      '--',
    ]),
  );
  if (stagedTrackedChanges.length > 0 || unstagedTrackedChanges.length > 0) {
    throw new Error(
      'Release-plan validation requires a clean tracked worktree and index',
    );
  }

  const releasePlanEntries = rawDiffEntries(
    commandText(
      await invokeGit([
        'diff',
        '--no-renames',
        '--raw',
        '--no-abbrev',
        '-z',
        `${baseCommit}..${headCommit}`,
        '--',
        'docs/releases',
      ]),
    ),
    'Release-plan namespace diff',
  );
  for (const entry of releasePlanEntries) {
    if (!canonicalPlanPath.test(entry.path) || entry.status === 'A') continue;
    if (entry.status === 'D') {
      throw new Error(
        `Historical release plan cannot be deleted or renamed: ${displayPath(entry.path)}`,
      );
    }
    if (
      entry.status === 'T' ||
      entry.oldMode !== '100644' ||
      entry.newMode !== '100644'
    ) {
      throw new Error(
        `Historical release plan mode or type is immutable: ${displayPath(entry.path)}`,
      );
    }
    throw new Error(
      `Historical release plan bytes are immutable: ${displayPath(entry.path)}`,
    );
  }
  const addedEntries = releasePlanEntries.filter(
    entry => entry.status === 'A' && canonicalPlanPath.test(entry.path),
  );
  for (const entry of addedEntries) {
    if (entry.oldMode !== '000000' || entry.newMode !== '100644') {
      throw new Error(
        'Release plan must be added as a regular file with mode 100644',
      );
    }
  }
  const addedPaths = addedEntries.map(entry => entry.path);
  if (addedPaths.length === 0) {
    return {classification: 'not-release-preparation'};
  }
  if (addedPaths.length !== 1) {
    throw new Error(
      'Release-preparation pull request must add exactly one canonical release plan',
    );
  }

  const addedPlanPath = addedPaths[0];
  const nonMergeCommits = commitLines(
    commandText(
      await invokeGit([
        'rev-list',
        '--no-merges',
        '--reverse',
        `${baseCommit}..${headCommit}`,
      ]),
    ),
    'Release-preparation commit history',
  );
  if (nonMergeCommits.length !== 1) {
    throw new Error(
      'Release preparation must contain exactly one non-merge commit',
    );
  }
  const introductionCommit = nonMergeCommits[0];
  const introductionParentLine = commandText(
    await invokeGit(['rev-list', '--parents', '-n', '1', introductionCommit]),
  ).trim();
  const introductionFamily = introductionParentLine.split(/\s+/u);
  if (
    introductionFamily.length !== 2 ||
    fullCommit(
      introductionFamily[0],
      'Release-preparation introduction commit',
    ) !== introductionCommit
  ) {
    throw new Error(
      'Release preparation atomic introduction must have exactly one parent',
    );
  }
  const introductionParent = fullCommit(
    introductionFamily[1],
    'Release-preparation introduction parent',
  );
  const pullRequestEntries = rawDiffEntries(
    commandText(
      await invokeGit([
        'diff',
        '--no-renames',
        '--raw',
        '--no-abbrev',
        '-z',
        `${baseCommit}..${headCommit}`,
      ]),
    ),
    'Pull request diff',
  );
  const introductionEntries = rawDiffEntries(
    commandText(
      await invokeGit([
        'diff',
        '--no-renames',
        '--raw',
        '--no-abbrev',
        '-z',
        `${introductionParent}..${introductionCommit}`,
      ]),
    ),
    'Atomic introduction diff',
  );
  if (
    !jsonEqual(diffShape(introductionEntries), diffShape(pullRequestEntries))
  ) {
    throw new Error(
      'Release preparation generated files do not match the atomic introduction commit',
    );
  }
  const planText = await readObject({
    commit: introductionCommit,
    file: addedPlanPath,
    runGit: invokeGit,
  });
  const capturedPlanText = await readObject({
    commit: headCommit,
    file: addedPlanPath,
    runGit: invokeGit,
  });
  if (planText !== capturedPlanText) {
    throw new Error(
      'Release preparation generated files do not match the atomic introduction commit',
    );
  }
  const plan = parseJson(planText, `Release plan ${addedPlanPath}`);
  validateReleasePlan(plan);
  if (plan.preparedFrom !== baseCommit) {
    throw new Error(
      'Release plan preparedFrom must equal the pull request base commit',
    );
  }
  if (plan.planPath !== addedPlanPath) {
    throw new Error(
      'Added release plan path does not match its canonical planPath',
    );
  }

  const planEntry = pullRequestEntries.find(
    entry => entry.path === addedPlanPath,
  );
  if (
    planEntry?.status !== 'A' ||
    planEntry.oldMode !== '000000' ||
    planEntry.newMode !== '100644'
  ) {
    throw new Error(
      'Release plan must be added as a regular file with mode 100644',
    );
  }
  for (const entry of pullRequestEntries) {
    if (entry.path === addedPlanPath) continue;
    if (entry.status === 'D') {
      throw new Error(
        `Release-preparation pull request contains deleted file: ${displayPath(entry.path)}`,
      );
    }
    if (
      entry.status === 'T' ||
      (entry.oldMode !== '000000' && entry.oldMode !== '100644') ||
      entry.newMode !== '100644'
    ) {
      throw new Error(
        `Release-preparation pull request changes file type or mode: ${displayPath(entry.path)}`,
      );
    }
  }

  const previousCommit = fullCommit(
    plan.previousRelease.commit,
    'Previous release commit',
  );
  const resolvedPreviousCommit = commandText(
    await invokeGit([
      'rev-list',
      '-n',
      '1',
      `refs/tags/${plan.previousRelease.tag}`,
    ]),
  ).trim();
  if (resolvedPreviousCommit !== previousCommit) {
    throw new Error(
      'Release plan previousRelease tag does not resolve to its recorded commit',
    );
  }
  try {
    await invokeGit([
      'merge-base',
      '--is-ancestor',
      previousCommit,
      baseCommit,
    ]);
  } catch {
    throw new Error(
      'Release plan previousRelease commit must be an ancestor of preparedFrom',
    );
  }

  const identityPolicy = parsePlainObject(
    await readObject({
      commit: baseCommit,
      file: identityPolicyPath,
      runGit: invokeGit,
    }),
    'Package identity policy from the base commit',
  );
  validateIdentityPolicy(identityPolicy);
  const impactPolicy = parsePlainObject(
    await readObject({
      commit: baseCommit,
      file: impactPolicyPath,
      runGit: invokeGit,
    }),
    'Release impact policy from the base commit',
  );
  const identities = identityPolicy.packages;
  const baselineManifests = await readManifestSet({
    commit: previousCommit,
    identities,
    runGit: invokeGit,
  });
  const baseManifests = await readManifestSet({
    commit: baseCommit,
    identities,
    runGit: invokeGit,
  });
  const headManifests = await readManifestSet({
    commit: introductionCommit,
    identities,
    runGit: invokeGit,
  });
  const baselineInventory = inventoryFrom({
    manifests: baselineManifests,
    policy: identityPolicy,
    repoRoot,
  });
  const baseInventory = inventoryFrom({
    manifests: baseManifests,
    policy: identityPolicy,
    repoRoot,
  });
  const headInventory = inventoryFrom({
    manifests: headManifests,
    policy: identityPolicy,
    repoRoot,
  });

  const changedFiles = nulPaths(
    commandText(
      await invokeGit([
        'diff',
        '--no-renames',
        '--name-only',
        '-z',
        `${previousCommit}..${baseCommit}`,
      ]),
    ),
    'Release change diff',
  );
  const changes = classifyReleaseChanges({
    changedFiles,
    inventory: baseInventory,
    policy: impactPolicy,
  });
  const plannerInput = {
    baselineInventory,
    changes,
    commits: previousCommit === baseCommit ? [] : [baseCommit],
    currentInventory: baseInventory,
    preparedFrom: baseCommit,
    previousRelease: plan.previousRelease,
    readManifest: file =>
      baseManifests.get(path.relative(repoRoot, file).replaceAll('\\', '/')),
    rootImpactRequest: plan.rootImpact.requested,
  };
  const provisional = createSelectiveReleasePlan(plannerInput);
  if (provisional.kind !== 'release') {
    throw new Error(
      'Added release plan does not correspond to a releasable recalculation',
    );
  }
  compareSelections(plan, provisional.plan);

  const selectedNames = new Set(
    provisional.plan.packages.map(item => item.name),
  );
  const bumpOverrideValues = [];
  for (const name of publicPackageNames(baseInventory)) {
    const baselineVersion = baselineInventory.byNewName.get(name).version;
    const headVersion = headInventory.byNewName.get(name).version;
    if (!selectedNames.has(name)) {
      if (headVersion !== baselineVersion) {
        throw new Error(
          `Unselected package ${name} version changed in the release-preparation pull request`,
        );
      }
      continue;
    }
    const bump = inferBump({
      fromVersion: baselineVersion,
      name,
      toVersion: headVersion,
    });
    if (bump !== 'patch') bumpOverrideValues.push(`${name}=${bump}`);
  }

  const recalculated = createSelectiveReleasePlan({
    ...plannerInput,
    bumpOverrideValues,
  });
  if (recalculated.kind !== 'release') {
    throw new Error(
      'Added release plan does not correspond to a releasable recalculation',
    );
  }
  const expectedPlan = recalculated.plan;
  comparePlan(plan, expectedPlan);
  if (planText !== canonicalReleasePlan(expectedPlan)) {
    throw new Error(
      'Release plan bytes do not match the canonical recalculation',
    );
  }

  const manifestPaths = packageManifestPaths(identityPolicy);
  const manifestsByPath = new Map(
    [...manifestPaths].map(([name, manifestPath]) => [manifestPath, name]),
  );
  const expectedByName = new Map(
    expectedPlan.packages.map(item => [item.name, item]),
  );
  const expectedPaths = new Map(
    expectedPlan.packages.map(item => [manifestPaths.get(item.name), item]),
  );
  const canonicalPaths = new Map(
    [expectedPlan.planPath, ...expectedPaths.keys(), 'lerna.json'].map(file => [
      file.toLowerCase(),
      file,
    ]),
  );

  for (const entry of pullRequestEntries) {
    const file = entry.path;
    const canonical = canonicalPaths.get(file.toLowerCase());
    if (canonical !== undefined && canonical !== file) {
      throw new Error(
        `Release-preparation path case does not match canonical path: ${displayPath(file)}`,
      );
    }
    if (file === expectedPlan.planPath) continue;
    if (expectedPaths.has(file)) {
      const expectedPackage = expectedPaths.get(file);
      if (
        entry.status !== 'M' ||
        entry.oldMode !== '100644' ||
        entry.newMode !== '100644'
      ) {
        throw new Error(
          `Selected package ${expectedPackage.name} manifest must be modified in place with mode 100644`,
        );
      }
      continue;
    }
    if (file === 'lerna.json') {
      if (
        entry.status !== 'M' ||
        entry.oldMode !== '100644' ||
        entry.newMode !== '100644'
      ) {
        throw new Error(
          'lerna.json must be modified in place as a regular file with mode 100644',
        );
      }
      const baseLernaText = await readObject({
        commit: baseCommit,
        file,
        runGit: invokeGit,
      });
      const headLernaText = await readObject({
        commit: introductionCommit,
        file,
        runGit: invokeGit,
      });
      validateLernaScope({baseLernaText, headLernaText});
      continue;
    }
    const manifestName = manifestsByPath.get(file);
    if (manifestName !== undefined && !expectedByName.has(manifestName)) {
      const baselineVersion =
        baselineInventory.byNewName.get(manifestName).version;
      const headVersion = headInventory.byNewName.get(manifestName).version;
      if (baselineVersion !== headVersion) {
        throw new Error(
          `Unselected package ${manifestName} version changed in the release-preparation pull request`,
        );
      }
      throw new Error(
        `Unselected package manifest changed: ${displayPath(file)}`,
      );
    }
    throw new Error(
      `Release-preparation pull request contains unrelated file: ${displayPath(file)}`,
    );
  }

  const pullRequestPathSet = new Set(
    pullRequestEntries.map(entry => entry.path),
  );
  for (const [manifestPath, expectedPackage] of expectedPaths) {
    if (!pullRequestPathSet.has(manifestPath)) {
      throw new Error(
        `Selected package ${expectedPackage.name} manifest is missing from the release-preparation pull request`,
      );
    }
    validateManifestScope({
      baseManifestText: baseManifests.get(manifestPath),
      expectedPackage,
      headManifestText: headManifests.get(manifestPath),
      manifestPath,
    });
  }

  for (const {path: file} of pullRequestEntries) {
    const introductionText = await readObject({
      commit: introductionCommit,
      file,
      runGit: invokeGit,
    });
    const capturedHeadText = await readObject({
      commit: headCommit,
      file,
      runGit: invokeGit,
    });
    if (introductionText !== capturedHeadText) {
      throw new Error(
        'Release preparation generated files do not match the atomic introduction commit',
      );
    }
  }

  const result = {
    classification: 'release-preparation',
    packageCount: expectedPlan.packages.length,
    planPath: expectedPlan.planPath,
  };
  write(`Validated pkg-nec release plan ${expectedPlan.planPath}\n`);
  return result;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    await runValidateReleasePlanCommand();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
