# npm Provenance Release Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish all 55 public `@pkg-nec` Jest packages at new patch versions through a resumable GitHub Actions/npm trusted-publishing workflow with provenance and batch registry verification.

**Architecture:** A GitHub Release event first builds and validates one immutable schema-v1 candidate, then a protected OIDC job publishes its tarballs sequentially in ledger order. A separate fair, bounded verifier checks the complete package family within one global deadline, and a least-privilege evidence job attaches success or partial-failure records to the GitHub Release.

**Tech Stack:** Node.js 24.18.0, npm CLI 11.19.0, Yarn 4.18.0, JavaScript ES modules, Jest, Lerna-lite workspaces, GitHub Actions, npm trusted publishing/OIDC.

**Spec:** `docs/superpowers/specs/2026-08-19-npm-provenance-release-design.md`

## Global Constraints

- Run every local `node`, `npm`, `corepack`, and `yarn` command in Git Bash.
- At the start of each fresh Git Bash session, run `corepack enable` and then `yarn install` before any other Yarn command.
- Do not run the monolithic `yarn test`; use the focused commands named in each task.
- Give every one of the 55 public workspaces exactly one patch bump; keep the private root at `0.0.0`.
- Use `@pkg-nec/jest-v30.4.3` as this release's tag, GitHub Release name, and anchor identity.
- Preserve `workspace:*` in source manifests; Yarn pack resolves those ranges to the newly committed workspace versions.
- Require `https://github.com/pkg-nec/jest.git` in every public package manifest and packed artifact.
- Run `yarn install` after manifest edits; commit `yarn.lock` only if Yarn produces a semantic diff. Current workspace lock entries use `0.0.0-use.local`, so no lockfile change is expected.
- Pin every third-party GitHub Action to a full commit SHA.
- Never supply `NODE_AUTH_TOKEN` or another long-lived npm publishing credential.
- Keep `id-token: write` exclusive to the protected `npm-publish` job.
- Publish tarballs sequentially in ledger order without a visibility wait after successful `npm publish` calls.
- Apply one 480-second deadline to batch verification, with no more than eight active npm queries and fair rounds across all unresolved packages.
- Commit after every task only when its focused tests pass.

## Scope Check

This is one release subsystem rather than independent projects: validation produces the immutable contract consumed by publication, publication produces the journal consumed by verification, and evidence recording consumes all three outputs. Splitting those components into separate plans would prevent any plan from producing a usable end-to-end publisher.

## File Structure

### New files

- `.github/workflows/release.yml` — GitHub Release trigger, permissions, candidate transport, protected publication, verification, and evidence upload.
- `scripts/pkgNec/releaseValidation.mjs` — pure tag, anchor, patch-transition, release-body, and candidate validation.
- `scripts/validatePkgNecRelease.mjs` — Git/GitHub/release-event CLI adapter.
- `scripts/pkgNec/releasePublisher.mjs` — pure sequential publication/resumption state machine.
- `scripts/publishPkgNecRelease.mjs` — npm adapter and atomic journal writer.
- `scripts/pkgNec/releaseVerification.mjs` — pure fair-round batch verifier.
- `scripts/verifyPkgNecRelease.mjs` — npm adapter and evidence writer.
- `scripts/__tests__/validatePkgNecRelease.test.js` — validation, adapter, and workflow tests.
- `scripts/__tests__/publishPkgNecRelease.test.js` — publisher, npm adapter, redaction, and journal tests.
- `scripts/__tests__/verifyPkgNecRelease.test.js` — fairness, deadlines, fatal errors, and evidence tests.

### Modified files

- `scripts/pkgNec/audit.mjs` — enforce the canonical repository URL.
- `scripts/pkgNec/registryVisibility.mjs` — expose shared exact-result, not-found, matching, and redaction helpers.
- `scripts/pkgNec/releaseArtifactPolicy.mjs` — make the `jest-get-type` declaration exception version-independent.
- `scripts/__tests__/checkPkgNecIdentity.test.js`
- `scripts/__tests__/registryVisibility.test.js`
- `scripts/__tests__/releaseArtifactPolicy.test.js`
- `scripts/__tests__/preparePkgNecRelease.test.js`
- `scripts/preparePkgNecRelease.mjs` — validate packed repository metadata.
- `package.json` — register three release CLIs and focused tests.
- `lerna.json` — move the anchor to `30.4.3`.
- `packages/*/package.json` — patch all versions and repository URLs.
- `yarn.lock` — retain unchanged unless install emits a semantic update.
- `docs/pkg-nec-maintenance.md`
- `CONTRIBUTING.md`
- `docs/superpowers/specs/2026-08-19-npm-provenance-release-design.md`

---

### Task 1: Patch package identities and artifact policy

**Files:**
- Modify: `scripts/pkgNec/audit.mjs:425-477`
- Modify: `scripts/pkgNec/releaseArtifactPolicy.mjs:29-35,85-91`
- Modify: `scripts/__tests__/checkPkgNecIdentity.test.js`
- Modify: `scripts/__tests__/releaseArtifactPolicy.test.js`
- Modify: `packages/*/package.json`
- Modify: `lerna.json`
- Inspect/modify if generated: `yarn.lock`

**Interfaces:**
- Consumes: existing `auditRepository()` and `validateReleaseFiles()`.
- Produces: canonical repository URL and package-directory enforcement; 55 public manifests at their next patch versions; `lerna.json` at `30.4.3`.

- [ ] **Step 1: Add failing repository and declaration-policy tests**

Add beside the existing `publish-access` test:

```javascript
expect(
  auditText({
    category: 'manifest',
    filePath: 'packages/jest/package.json',
    inventory,
    text: JSON.stringify({
      name: '@pkg-nec/jest',
      publishConfig: {access: 'public'},
      repository: {
        directory: 'packages/jest',
        type: 'git',
        url: 'https://github.com/jestjs/jest.git',
      },
      version: '30.4.2',
    }),
  }),
).toEqual(
  expect.arrayContaining([
    expect.objectContaining({
      category: 'repository-url',
      expected: 'https://github.com/pkg-nec/jest.git',
      literal: 'https://github.com/jestjs/jest.git',
    }),
  ]),
);

expect(
  auditText({
    category: 'manifest',
    filePath: 'packages/jest/package.json',
    inventory,
    text: JSON.stringify({
      name: '@pkg-nec/jest',
      publishConfig: {access: 'public'},
      repository: {
        directory: 'packages/wrong',
        type: 'git',
        url: 'https://github.com/pkg-nec/jest.git',
      },
      version: '30.4.2',
    }),
  }),
).toEqual(
  expect.arrayContaining([
    expect.objectContaining({
      category: 'repository-directory',
      expected: 'packages/jest',
      literal: 'packages/wrong',
    }),
  ]),
);
```

Add to `releaseArtifactPolicy.test.js`:

```javascript
expect(
  validateReleaseFiles({
    files: ['LICENSE', 'build/index.d.mts', 'build/index.js', 'package.json'],
    helper: false,
    manifest: {
      exports: './build/index.js',
      name: '@pkg-nec/jest-get-type',
      version: '30.1.1',
    },
    packageName: '@pkg-nec/jest-get-type',
  }),
).toContain('build/index.d.mts');
```

- [ ] **Step 2: Run the focused tests and verify they fail**

```bash
corepack enable
yarn install
yarn build:js
yarn jest scripts/__tests__/checkPkgNecIdentity.test.js scripts/__tests__/releaseArtifactPolicy.test.js --runInBand
```

Expected: FAIL because `repository-url` is absent and `30.1.1` is not allowlisted.

- [ ] **Step 3: Implement repository enforcement and version-independent declaration policy**

Add to `audit.mjs`:

```javascript
export const EXPECTED_PUBLISH_REPOSITORY_URL =
  'https://github.com/pkg-nec/jest.git';

if (
  identity?.publishable &&
  manifest.repository?.url !== EXPECTED_PUBLISH_REPOSITORY_URL
) {
  findings.push(
    finding({
      category: 'repository-url',
      expected: EXPECTED_PUBLISH_REPOSITORY_URL,
      filePath,
      literal: manifest.repository?.url ?? null,
    }),
  );
}

const expectedRepositoryDirectory = filePath.replace(/\/package\.json$/u, '');
if (
  identity?.publishable &&
  manifest.repository?.directory !== expectedRepositoryDirectory
) {
  findings.push(
    finding({
      category: 'repository-directory',
      expected: expectedRepositoryDirectory,
      filePath,
      literal: manifest.repository?.directory ?? null,
    }),
  );
}
```

Replace the version-keyed map in `releaseArtifactPolicy.mjs` with:

```javascript
const additionallyPublishedDeclarations = new Map([
  ['@pkg-nec/jest-get-type', new Set(['build/index.d.mts'])],
]);
```

Read it with `additionallyPublishedDeclarations.get(packageName) ?? new Set()`.

- [ ] **Step 4: Run the focused tests and verify they pass**

```bash
yarn jest scripts/__tests__/checkPkgNecIdentity.test.js scripts/__tests__/releaseArtifactPolicy.test.js --runInBand
```

Expected: PASS.

- [ ] **Step 5: Patch the 55 workspace versions and repository URLs**

```bash
yarn workspaces foreach --all --no-private version patch
node --input-type=module <<'NODE'
import {readdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
for (const entry of await readdir('packages', {withFileTypes: true})) {
  if (!entry.isDirectory()) continue;
  const manifestPath = path.join('packages', entry.name, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.private === true) continue;
  manifest.repository.url = 'https://github.com/pkg-nec/jest.git';
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}
NODE
```

Change `lerna.json` from `"version": "30.4.2"` to `"version": "30.4.3"`.

- [ ] **Step 6: Reinstall and verify exact distribution**

```bash
yarn install
node --input-type=module <<'NODE'
import {readdir, readFile} from 'node:fs/promises';
import path from 'node:path';
const counts = new Map();
let publicCount = 0;
for (const entry of await readdir('packages', {withFileTypes: true})) {
  if (!entry.isDirectory()) continue;
  const manifest = JSON.parse(await readFile(path.join('packages', entry.name, 'package.json'), 'utf8'));
  if (manifest.private === true) continue;
  publicCount += 1;
  counts.set(manifest.version, (counts.get(manifest.version) ?? 0) + 1);
  if (manifest.repository?.url !== 'https://github.com/pkg-nec/jest.git') throw new Error(manifest.name);
}
const actual = Object.fromEntries([...counts].sort());
const expected = {'30.0.2': 1, '30.1.1': 1, '30.4.1': 6, '30.4.2': 37, '30.4.3': 10};
if (publicCount !== 55 || JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(JSON.stringify({actual, publicCount}));
console.log(JSON.stringify({counts: actual, publicCount}, null, 2));
NODE
git diff -- yarn.lock
```

Expected: 55 public packages, the exact four version groups, canonical URLs, and no lockfile diff unless Yarn emits a semantic update.

- [ ] **Step 7: Run identity checks and commit**

```bash
yarn check:pkg-nec-identity
yarn jest scripts/__tests__/checkPkgNecIdentity.test.js scripts/__tests__/releaseArtifactPolicy.test.js --runInBand
git add lerna.json packages scripts/pkgNec/audit.mjs scripts/pkgNec/releaseArtifactPolicy.mjs scripts/__tests__/checkPkgNecIdentity.test.js scripts/__tests__/releaseArtifactPolicy.test.js yarn.lock
git commit -m "chore: bump packages for provenance release"
```

Expected: checks pass; unchanged `yarn.lock` is a harmless `git add` no-op.

---

### Task 2: Implement pure release validation

**Files:**
- Create: `scripts/pkgNec/releaseValidation.mjs`
- Create: `scripts/__tests__/validatePkgNecRelease.test.js`
- Modify: `scripts/preparePkgNecRelease.mjs:70-136`
- Modify: `scripts/__tests__/preparePkgNecRelease.test.js`

**Interfaces:**
- Consumes: inventory, schema-v1 ledger, current/previous version maps, GitHub release event, packed manifests.
- Produces: `parseReleaseTag(tagName)`, `selectReleaseAnchor(packageNames)`, `validatePatchTransitions({currentPackages, previousPackages})`, and `validateReleaseMetadata({event, inventory, ledger, tagCommit})`.

- [ ] **Step 1: Write failing validation tests**

```javascript
expect(parseReleaseTag('@pkg-nec/jest-v30.4.3')).toEqual({
  anchorName: '@pkg-nec/jest',
  anchorVersion: '30.4.3',
});
expect(() => parseReleaseTag('v30.4.3')).toThrow(/release tag/);
expect(selectReleaseAnchor(['@pkg-nec/jest-reporters', '@pkg-nec/jest'])).toBe('@pkg-nec/jest');
expect(
  validatePatchTransitions({
    currentPackages: new Map([['@pkg-nec/jest', '30.4.3']]),
    previousPackages: new Map([['@pkg-nec/jest', '30.4.2']]),
  }),
).toEqual(['@pkg-nec/jest']);
expect(() =>
  validatePatchTransitions({
    currentPackages: new Map([['@pkg-nec/jest', '30.5.0']]),
    previousPackages: new Map([['@pkg-nec/jest', '30.4.2']]),
  }),
).toThrow(/one patch/);
```

Add 55-entry fixtures that reject wrong source commit, duplicate/missing package, missing body entry, wrong Release name, wrong anchor/version, wrong package count, wrong manifest version, and a private workspace.

- [ ] **Step 2: Run the test and verify it fails**

```bash
corepack enable
yarn install
yarn build:js
yarn jest scripts/__tests__/validatePkgNecRelease.test.js --runInBand
```

Expected: FAIL because `releaseValidation.mjs` is absent.

- [ ] **Step 3: Implement tag, anchor, and patch validation**

```javascript
import semver from 'semver';

const fallbackAnchors = [
  '@pkg-nec/create-jest',
  '@pkg-nec/jest-create-cache-key-function',
  '@pkg-nec/jest-environment-jsdom',
  '@pkg-nec/jest-environment-jsdom-abstract',
  '@pkg-nec/jest-phabricator',
  '@pkg-nec/jest-test-globals',
];

export function parseReleaseTag(tagName) {
  const separator = tagName.lastIndexOf('-v');
  const anchorName = tagName.slice(0, separator);
  const anchorVersion = tagName.slice(separator + 2);
  if (separator < 1 || !anchorName.startsWith('@pkg-nec/') || semver.valid(anchorVersion) === null) {
    throw new Error(`Invalid pkg-nec release tag: ${tagName}`);
  }
  return {anchorName, anchorVersion};
}

export function selectReleaseAnchor(packageNames) {
  const selected = new Set(packageNames);
  if (selected.has('@pkg-nec/jest')) return '@pkg-nec/jest';
  const fallback = fallbackAnchors.find(name => selected.has(name));
  if (fallback === undefined) throw new Error('Selected release set has no valid anchor package');
  return fallback;
}

export function validatePatchTransitions({currentPackages, previousPackages}) {
  const changed = [];
  for (const [name, previousVersion] of previousPackages) {
    const currentVersion = currentPackages.get(name);
    if (currentVersion !== semver.inc(previousVersion, 'patch')) throw new Error(`${name} must advance by exactly one patch from ${previousVersion}`);
    changed.push(name);
  }
  if (currentPackages.size !== previousPackages.size) throw new Error('Current and previous public package sets differ');
  return changed.sort((left, right) => left.localeCompare(right));
}
```

- [ ] **Step 4: Implement release metadata validation**

Require schema version 1; 55 unique packages with contiguous order; ledger/tag source equality; publishable inventory identities; manifest/ledger version equality; calculated anchor/tag equality; Release name/tag equality; the full source commit in the body; and every backticked `` `name@version` `` in the body. Return `{anchorName, anchorVersion, packageCount: 55, sourceCommit, tagName}`.

- [ ] **Step 5: Enforce canonical packed repository metadata**

Add to `inspectPackedManifest()`:

```javascript
if (
  manifest.repository?.url !== 'https://github.com/pkg-nec/jest.git' ||
  manifest.repository?.directory !== workspaceManifest.repository?.directory
) {
  throw new Error(`Packed manifest repository changed for ${workspace.newName}: ${manifest.repository?.url}`);
}
```

Add a fixture that changes only the packed URL and expects that error.

- [ ] **Step 6: Run tests and commit**

```bash
yarn jest scripts/__tests__/validatePkgNecRelease.test.js scripts/__tests__/preparePkgNecRelease.test.js --runInBand
git add scripts/pkgNec/releaseValidation.mjs scripts/preparePkgNecRelease.mjs scripts/__tests__/validatePkgNecRelease.test.js scripts/__tests__/preparePkgNecRelease.test.js
git commit -m "feat: validate pkg-nec release candidates"
```

Expected: PASS, then one validation commit.

---

### Task 3: Add the validation CLI and CI gate

**Files:**
- Create: `scripts/validatePkgNecRelease.mjs`
- Modify: `scripts/__tests__/validatePkgNecRelease.test.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 2 validation exports; `GITHUB_EVENT_PATH`, `GITHUB_REPOSITORY`, `GITHUB_TOKEN`; ledger path; Git history; GitHub Actions runs.
- Produces: `runValidateReleaseCommand({args, env, fetchImpl, readFile, runGit, write})`; `yarn validate:pkg-nec-release <ledger-path>`.

- [ ] **Step 1: Write failing CLI adapter tests**

Test argument rejection, previous-tag discovery, tag SHA resolution, `origin/main` ancestry, previous manifest loading, and Node CI lookup. Assert:

```javascript
expect(fetchCalls).toEqual([{
  headers: {
    accept: 'application/vnd.github+json',
    authorization: 'Bearer github-test-token',
    'x-github-api-version': '2022-11-28',
  },
  url: 'https://api.github.com/repos/pkg-nec/jest/actions/workflows/nodejs.yml/runs?head_sha=abc123&status=completed&per_page=100',
}]);
```

Accept only `{conclusion: 'success', event: 'push', head_branch: 'main', head_sha: 'abc123'}`; otherwise throw `Node CI did not succeed for abc123`.

- [ ] **Step 2: Run the test and verify it fails**

```bash
corepack enable
yarn install
yarn build:js
yarn jest scripts/__tests__/validatePkgNecRelease.test.js --runInBand
```

Expected: FAIL because the CLI is absent.

- [ ] **Step 3: Implement context collection**

The default injected Git runner executes:

```javascript
await runGit(['rev-list', '-n', '1', releaseTag], {cwd: repoRoot});
await runGit(['merge-base', '--is-ancestor', tagCommit, 'origin/main'], {cwd: repoRoot});
await runGit(['describe', '--tags', '--abbrev=0', `${releaseTag}^`], {cwd: repoRoot});
await runGit(['show', `${previousTag}:${manifestRelativePath}`], {cwd: repoRoot});
```

Fetch the Step 1 endpoint with the exact headers and require a matching successful run. Redact the token from errors.

- [ ] **Step 4: Implement the command contract**

```text
Usage: yarn validate:pkg-nec-release <ledger-path>
Required environment: GITHUB_EVENT_PATH, GITHUB_REPOSITORY, GITHUB_TOKEN
```

Read the event/ledger, build current inventory, load previous versions from Git, call both Task 2 validators, and print:

```text
classification=valid
tag=@pkg-nec/jest-v30.4.3
sourceCommit=<full-tag-sha>
packageCount=55
```

The main block prints one redacted message and sets exit code 1 on failure.

- [ ] **Step 5: Register, test, and commit**

Add to `package.json`:

```json
"validate:pkg-nec-release": "node ./scripts/validatePkgNecRelease.mjs"
```

Append the validation test to `test:pkg-nec-tooling`, then run:

```bash
yarn jest scripts/__tests__/validatePkgNecRelease.test.js --runInBand
yarn check:pkg-nec-identity
git add package.json scripts/validatePkgNecRelease.mjs scripts/__tests__/validatePkgNecRelease.test.js
git commit -m "feat: gate pkg-nec releases on tagged CI"
```

Expected: PASS and one CLI commit.

---

### Task 4: Implement the sequential resumable publisher

**Files:**
- Create: `scripts/pkgNec/releasePublisher.mjs`
- Create: `scripts/__tests__/publishPkgNecRelease.test.js`

**Interfaces:**
- Consumes: schema-v1 ledger entries and injected `inspect`, `publish`, `verifyConflict`, and `persistJournal` functions.
- Produces: `publishRelease({inspect, ledger, now, persistJournal, publish, releaseTag, verifyConflict})`; schema-v1 dispositions `published` and `verified-existing`.

- [ ] **Step 1: Write failing state-machine tests**

Create a three-package ledger and assert the no-wait path:

```javascript
expect(events).toEqual([
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
```

Add cases for matching existing integrity, mismatched existing integrity, indeterminate inspection, publish conflict accepted only after matching verification, and journal persistence after each entry.

- [ ] **Step 2: Run the test and verify it fails**

```bash
corepack enable
yarn install
yarn build:js
yarn jest scripts/__tests__/publishPkgNecRelease.test.js --runInBand
```

Expected: FAIL because `releasePublisher.mjs` is absent.

- [ ] **Step 3: Implement ledger validation and journal creation**

```javascript
function matchingIntegrity(entry, observed) {
  return observed.name === entry.name &&
    observed.version === entry.version &&
    observed.integrity === entry.integrity;
}

function initialJournal({ledger, releaseTag}) {
  return {
    packages: [],
    releaseTag,
    schemaVersion: 1,
    sourceCommit: ledger.sourceCommit,
  };
}
```

Reject unsupported schema, non-array packages, non-contiguous order, duplicate names, missing SHA-512 integrity, and empty release tag before an adapter runs.

- [ ] **Step 4: Implement sequential publication and strict resumption**

```javascript
for (const entry of ledger.packages) {
  const observed = await inspect(entry);
  let disposition;
  if (observed.kind === 'present') {
    if (!matchingIntegrity(entry, observed)) throw new Error(`Registry integrity mismatch for ${entry.name}@${entry.version}`);
    disposition = 'verified-existing';
  } else if (observed.kind === 'absent') {
    try {
      await publish(entry);
      disposition = 'published';
    } catch (error) {
      if (error.classification !== 'version-conflict') throw error;
      const conflictResult = await verifyConflict(entry);
      if (!matchingIntegrity(entry, conflictResult)) throw new Error(`Registry integrity mismatch for ${entry.name}@${entry.version}`);
      disposition = 'verified-existing';
    }
  } else {
    throw new Error(`Indeterminate registry state for ${entry.name}@${entry.version}`);
  }
  journal.packages.push({
    completedAt: new Date(now()).toISOString(),
    disposition,
    integrity: entry.integrity,
    name: entry.name,
    order: entry.order,
    version: entry.version,
  });
  await persistJournal(journal);
}
```

Initialize and persist the empty journal before inspecting the first entry. Return the final journal and never call `verifyConflict()` after a successful publish.

- [ ] **Step 5: Run tests and commit**

```bash
yarn jest scripts/__tests__/publishPkgNecRelease.test.js --runInBand
git add scripts/pkgNec/releasePublisher.mjs scripts/__tests__/publishPkgNecRelease.test.js
git commit -m "feat: add resumable release publisher"
```

Expected: PASS and one publisher-core commit.

---

### Task 5: Add npm adapters and atomic journals

**Files:**
- Create: `scripts/publishPkgNecRelease.mjs`
- Modify: `scripts/pkgNec/registryVisibility.mjs`
- Modify: `scripts/__tests__/registryVisibility.test.js`
- Modify: `scripts/__tests__/publishPkgNecRelease.test.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: `publishRelease()` and existing registry classification/wait behavior.
- Produces: `isRegistryNotFound(error)`, `exactRegistryResult(result)`, `redactRegistryFailure(error)`, and `runPublishReleaseCommand({args, inspect, now, publish, readFile, rename, runGit, verifyConflict, write, writeFile})`; `yarn publish:pkg-nec-release <ledger-path> <journal-path> <release-tag>`.

- [ ] **Step 1: Write failing registry and adapter tests**

```javascript
expect(isRegistryNotFound({code: 'E404'})).toBe(true);
expect(isRegistryNotFound({statusCode: 404})).toBe(true);
expect(isRegistryNotFound({code: 'E503'})).toBe(false);
expect(exactRegistryResult({stdout: JSON.stringify({
  dist: {integrity: 'sha512-registry'},
  name: '@pkg-nec/jest',
  version: '30.4.3',
})})).toEqual({
  integrity: 'sha512-registry',
  name: '@pkg-nec/jest',
  version: '30.4.3',
});
```

Assert `npm view` uses the exact registry, only E404 becomes absent, `npm publish` includes the tarball, public access, provenance, and registry arguments, and credentials are redacted.

- [ ] **Step 2: Run tests and verify they fail**

```bash
corepack enable
yarn install
yarn build:js
yarn jest scripts/__tests__/registryVisibility.test.js scripts/__tests__/publishPkgNecRelease.test.js --runInBand
```

Expected: FAIL because the exports and CLI are absent.

- [ ] **Step 3: Export safe registry helpers**

```javascript
export function isRegistryNotFound(error) {
  return String(error?.code ?? '').toUpperCase() === 'E404' || statusCode(error) === 404;
}

export function exactRegistryResult(result) {
  const parsed = parseRegistryResult(result);
  return {
    integrity: parsed?.dist?.integrity,
    name: parsed?.name,
    version: parsed?.version,
  };
}

export function redactRegistryFailure(error) {
  return redactRegistryError(errorText(error));
}
```

Make `waitForExactVersion()` call `exactRegistryResult()` without changing its existing behavior.

- [ ] **Step 4: Implement npm inspection and publish adapters**

Inspection runs:

```javascript
await execa('npm', [
  'view',
  `${entry.name}@${entry.version}`,
  '--json',
  '--registry=https://registry.npmjs.org/',
]);
```

Return `{kind: 'present', ...exactRegistryResult(result)}` on success, `{kind: 'absent'}` only for `isRegistryNotFound(error)`, and a redacted fatal error otherwise.

Publishing runs:

```javascript
await execa('npm', [
  'publish',
  entry.tarball,
  '--access',
  'public',
  '--provenance',
  '--registry=https://registry.npmjs.org/',
]);
```

Mark only npm's explicit existing-version code/text as `classification = 'version-conflict'`. Call `waitForExactVersion()` only to recover that conflict.

- [ ] **Step 5: Revalidate source and tarball bytes in the publisher CLI**

Resolve the supplied tag with `git rev-list -n 1 <release-tag>` and require it to equal `ledger.sourceCommit`. For each entry, resolve its tarball beneath `.pkg-nec-release/`, read its bytes, and require:

```javascript
const actualIntegrity = `sha512-${createHash('sha512')
  .update(tarballBytes)
  .digest('base64')}`;
if (actualIntegrity !== entry.integrity) {
  throw new Error(`Prepared artifact integrity mismatch for ${entry.name}`);
}
```

Perform these checks before initializing the journal or calling npm. Add tests for a wrong tag commit, path traversal in `entry.tarball`, a missing tarball, and mismatched bytes.

- [ ] **Step 6: Implement atomic journal CLI**

Use:

```text
Usage: yarn publish:pkg-nec-release <ledger-path> <journal-path> <release-tag>
```

Write `${journalPath}.tmp` with two-space JSON and a trailing newline, then rename over `journalPath`. Reject ledger, tarball, and journal paths outside `.pkg-nec-release/` using the resolved-path safety pattern in `preparePkgNecRelease.mjs`.

- [ ] **Step 7: Register, test, and commit**

Add to `package.json` and `test:pkg-nec-tooling`:

```json
"publish:pkg-nec-release": "node ./scripts/publishPkgNecRelease.mjs"
```

Run:

```bash
yarn jest scripts/__tests__/registryVisibility.test.js scripts/__tests__/publishPkgNecRelease.test.js --runInBand
git add package.json scripts/pkgNec/registryVisibility.mjs scripts/publishPkgNecRelease.mjs scripts/__tests__/registryVisibility.test.js scripts/__tests__/publishPkgNecRelease.test.js
git commit -m "feat: publish pkg-nec artifacts with provenance"
```

Expected: PASS and one npm-adapter commit.

---

### Task 6: Implement fair batch verification

**Files:**
- Create: `scripts/pkgNec/releaseVerification.mjs`
- Create: `scripts/verifyPkgNecRelease.mjs`
- Create: `scripts/__tests__/verifyPkgNecRelease.test.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: schema-v1 ledger, schema-v1 journal, injected `query(entry, {signal})`.
- Produces: `verifyReleaseBatch({deadlineMs, intervalMs, journal, ledger, maxConcurrency, now, query, queryTimeoutMs, sleep})`; JSON/Markdown evidence; `yarn verify:pkg-nec-release <ledger> <journal> <evidence-json> <evidence-markdown>`.

- [ ] **Step 1: Write failing fairness and evidence tests**

With a 12-package ledger, assert:

```javascript
expect(maximumObservedConcurrency).toBeLessThanOrEqual(8);
expect(firstRoundNames).toEqual(ledger.packages.map(item => item.name));
expect(evidence.packages).toHaveLength(12);
expect(evidence.schemaVersion).toBe(1);
expect(evidence.sourceCommit).toBe(ledger.sourceCommit);
```

Add cases proving one 480-second deadline, every unresolved package gets one attempt before any second attempt, E404/timeout/429/503 retry, authentication fails immediately, integrity mismatch fails immediately, and journal dispositions enter evidence.

- [ ] **Step 2: Run the test and verify it fails**

```bash
corepack enable
yarn install
yarn build:js
yarn jest scripts/__tests__/verifyPkgNecRelease.test.js --runInBand
```

Expected: FAIL because verifier files are absent.

- [ ] **Step 3: Implement bounded fair rounds**

```javascript
async function mapWithConcurrency(items, limit, operation) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await operation(items[index], index);
    }
  }
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, () => worker()));
  return results;
}
```

Maintain unresolved state for every entry. Each round queries every unresolved entry once through `mapWithConcurrency()`. Remove matches, fail fatal results, and sleep only when unresolved entries remain. Cap each query timeout at `Math.min(queryTimeoutMs, remainingGlobalMs)`.

- [ ] **Step 4: Implement evidence and global-timeout results**

```javascript
{
  completedAt: new Date(now()).toISOString(),
  elapsedMs: now() - startedAt,
  packages: ledger.packages.map(entry => ({
    attempts: state.attempts,
    disposition: journalEntry.disposition,
    elapsedMs: state.elapsedMs,
    integrity: state.integrity,
    name: entry.name,
    order: entry.order,
    version: entry.version,
  })),
  releaseTag: journal.releaseTag,
  schemaVersion: 1,
  sourceCommit: ledger.sourceCommit,
}
```

On deadline, throw with `classification = 'retryable'` and attach partial evidence as `error.evidence`.

- [ ] **Step 5: Implement the CLI and Markdown writer**

Use the exact four-path interface, the same `npm view` arguments as Task 5, two-space JSON with a trailing newline, and a Markdown table containing order, package, version, disposition, attempts, elapsed milliseconds, and integrity. Persist partial evidence before setting a nonzero exit code.

- [ ] **Step 6: Register, test, and commit**

Add to `package.json` and `test:pkg-nec-tooling`:

```json
"verify:pkg-nec-release": "node ./scripts/verifyPkgNecRelease.mjs"
```

Run:

```bash
yarn jest scripts/__tests__/verifyPkgNecRelease.test.js scripts/__tests__/registryVisibility.test.js --runInBand
git add package.json scripts/pkgNec/releaseVerification.mjs scripts/verifyPkgNecRelease.mjs scripts/__tests__/verifyPkgNecRelease.test.js
git commit -m "feat: verify pkg-nec releases in fair batches"
```

Expected: PASS and one verification commit.

---

### Task 7: Build the least-privilege GitHub Actions workflow

**Files:**
- Create: `.github/workflows/release.yml`
- Modify: `scripts/__tests__/validatePkgNecRelease.test.js`

**Interfaces:**
- Consumes: Tasks 3, 5, and 6 commands; GitHub Release event; `npm-publish` environment; npm trusted identity `pkg-nec/jest` + `release.yml` + `npm-publish`.
- Produces: `pkg-nec-release-candidate`, `pkg-nec-publication-evidence`, and `pkg-nec-registry-evidence` workflow artifacts; durable GitHub Release assets.

- [ ] **Step 1: Write a failing workflow structure test**

Read `.github/workflows/release.yml` with `js-yaml` and assert:

```javascript
expect(workflow.on.release.types).toEqual(['published']);
expect(workflow.permissions).toEqual({});
expect(workflow.concurrency['cancel-in-progress']).toBe(false);
expect(workflow.jobs.publish.environment).toBe('npm-publish');
expect(workflow.jobs.publish.permissions).toEqual({
  contents: 'read',
  'id-token': 'write',
});
expect(workflow.jobs.evidence.permissions).toEqual({contents: 'write'});
expect(workflow.jobs.validate.permissions).not.toHaveProperty('id-token');
expect(workflow.jobs.verify.permissions).not.toHaveProperty('id-token');
```

Assert raw YAML contains full-SHA pins, `npm@11.19.0`, Node `24.18.0`, `publish:pkg-nec-release`, and `cancel-in-progress: false`; and excludes `NODE_AUTH_TOKEN`, `check:pkg-nec-registry`, `cache: yarn`, and `yarn test`. Assert `scripts/publishPkgNecRelease.mjs` contains the exact `--provenance` argument.

- [ ] **Step 2: Run the workflow test and verify it fails**

```bash
corepack enable
yarn install
yarn build:js
yarn jest scripts/__tests__/validatePkgNecRelease.test.js --runInBand
```

Expected: FAIL because the workflow is absent.

- [ ] **Step 3: Create trigger, concurrency, and validation job**

Use these exact pins:

```yaml
actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1
actions/download-artifact@70fc10c6e5e1ce46ad2ea6f2b72d43f7d47b13c3 # v8.0.0
```

Start with:

```yaml
name: Publish to npm

on:
  release:
    types: [published]

permissions: {}

concurrency:
  group: npm-release-${{ github.event.release.tag_name }}
  cancel-in-progress: false
```

The `validate` job grants `actions: read` and `contents: read`; checks out the release tag with `fetch-depth: 0` and `persist-credentials: false`; fetches `origin main`; sets up Node 24.18.0 with `registry-url: 'https://registry.npmjs.org'` and no cache input; runs Corepack/install, `yarn build:js`, identity checks, focused tooling tests, and candidate preparation; then runs:

```yaml
- name: Validate release candidate
  env:
    GITHUB_TOKEN: ${{ github.token }}
  run: yarn validate:pkg-nec-release .pkg-nec-release/release-ledger.json
```

Upload `.pkg-nec-release/` as `pkg-nec-release-candidate` with 30-day retention.

- [ ] **Step 4: Add the protected publisher job**

The `publish` job needs `validate`, uses `environment: npm-publish`, and grants only:

```yaml
permissions:
  contents: read
  id-token: write
```

Check out the tag, set up Node with `registry-url: 'https://registry.npmjs.org'` and no cache input, run Corepack/install, install `npm@11.19.0`, download the candidate into `.pkg-nec-release`, and execute the publisher. The publisher's Task 5 preflight re-resolves the tag and verifies every tarball locally; it does not query the Actions API and therefore does not need `actions: read`.

```yaml
- name: Publish in ledger order with strict resumption
  run: >-
    yarn publish:pkg-nec-release
    .pkg-nec-release/release-ledger.json
    .pkg-nec-release/publication-journal.json
    '${{ github.event.release.tag_name }}'
```

Add an `if: always()` upload for the journal named `pkg-nec-publication-evidence`. Do not call the single-package registry waiter.

- [ ] **Step 5: Add batch verification and durable evidence jobs**

The `verify` job needs `publish`, grants only `contents: read`, checks out and installs from the tag, downloads candidate/journal, and runs:

```bash
yarn verify:pkg-nec-release \
  .pkg-nec-release/release-ledger.json \
  .pkg-nec-release/publication-journal.json \
  .pkg-nec-release/registry-evidence.json \
  .pkg-nec-release/registry-evidence.md
```

Upload both evidence files with `if: always()` as `pkg-nec-registry-evidence`.

The `evidence` job needs all prior jobs, uses `if: ${{ always() && needs.validate.result == 'success' }}`, and grants only `contents: write`. Download each available artifact with `continue-on-error: true`. Write `workflow-summary.md` containing the release tag, source workflow run URL, and the `validate`, `publish`, and `verify` job results. Build an array of that summary plus existing ledger/journal/evidence files, and run:

```bash
gh release upload "$RELEASE_TAG" "${assets[@]}" --clobber
```

Set `GH_TOKEN` and `RELEASE_TAG` only on that step. The summary is the durable partial-failure explanation when publication or verification fails. Never attach the 55 tarballs.

- [ ] **Step 6: Run workflow and YAML tests**

```bash
yarn jest scripts/__tests__/validatePkgNecRelease.test.js --runInBand
node --input-type=module <<'NODE'
import {readFile} from 'node:fs/promises';
import yaml from 'js-yaml';
const workflow = yaml.load(await readFile('.github/workflows/release.yml', 'utf8'));
if (workflow.on.release.types[0] !== 'published') throw new Error('bad trigger');
console.log('release workflow YAML OK');
NODE
```

Expected: PASS and `release workflow YAML OK`.

- [ ] **Step 7: Commit the workflow**

```bash
git add .github/workflows/release.yml scripts/__tests__/validatePkgNecRelease.test.js
git commit -m "ci: publish pkg-nec packages with provenance"
```

---

### Task 8: Update runbooks and perform release-focused verification

**Files:**
- Modify: `docs/pkg-nec-maintenance.md:146-246`
- Modify: `CONTRIBUTING.md:222-232`

**Interfaces:**
- Consumes: completed workflow and commands.
- Produces: trusted-publisher setup, Release body, protected approval, resumption, and evidence-review instructions.

- [ ] **Step 1: Replace obsolete publishing documentation**

Document these exact settings:

```text
GitHub organization: pkg-nec
GitHub repository: jest
Workflow filename: release.yml
GitHub environment: npm-publish
Allowed npm action: npm publish
```

Document the four jobs, `@pkg-nec/jest-v30.4.3`, no serial post-publish waits, exact-integrity resumption, one 480-second fair batch deadline, and GitHub Release attachments. Remove the statement that no workflow exists.

- [ ] **Step 2: Document Release-body generation**

Add this Git Bash command:

```bash
node --input-type=module <<'NODE'
import {readdir, readFile} from 'node:fs/promises';
import path from 'node:path';
const rows = [];
for (const entry of await readdir('packages', {withFileTypes: true})) {
  if (!entry.isDirectory()) continue;
  const manifest = JSON.parse(await readFile(path.join('packages', entry.name, 'package.json'), 'utf8'));
  if (manifest.private !== true) rows.push(`- \`${manifest.name}@${manifest.version}\``);
}
console.log(rows.sort().join('\n'));
NODE
```

Update `CONTRIBUTING.md` to require successful Node CI, exact tag/Release name, all 55 lines, and `npm-publish` approval.

- [ ] **Step 3: Format and lint changed files**

```bash
corepack enable
yarn install
yarn prettier --write .github/workflows/release.yml CONTRIBUTING.md docs/pkg-nec-maintenance.md package.json lerna.json packages/*/package.json scripts/pkgNec/*.mjs scripts/*.mjs scripts/__tests__/*.test.js
yarn eslint --cache --fix scripts/pkgNec/releaseValidation.mjs scripts/pkgNec/releasePublisher.mjs scripts/pkgNec/releaseVerification.mjs scripts/validatePkgNecRelease.mjs scripts/publishPkgNecRelease.mjs scripts/verifyPkgNecRelease.mjs scripts/__tests__/validatePkgNecRelease.test.js scripts/__tests__/publishPkgNecRelease.test.js scripts/__tests__/verifyPkgNecRelease.test.js
```

Expected: no errors and only formatting changes in named files.

- [ ] **Step 4: Run focused release checks**

```bash
yarn build:js
yarn check:pkg-nec-identity
yarn test:pkg-nec-tooling
yarn lint:prettier:ci
```

Expected: all pass. Do not substitute `yarn test`.

- [ ] **Step 5: Build and inspect the immutable candidate**

```bash
yarn prepare:pkg-nec-release
node --input-type=module <<'NODE'
import {readFile} from 'node:fs/promises';
const ledger = JSON.parse(await readFile('.pkg-nec-release/release-ledger.json', 'utf8'));
if (ledger.schemaVersion !== 1) throw new Error('wrong ledger schema');
if (ledger.packages.length !== 55) throw new Error('wrong package count');
if (ledger.packages.at(-1).name !== '@pkg-nec/jest') throw new Error('anchor is not last');
if (ledger.packages.at(-1).version !== '30.4.3') throw new Error('wrong anchor version');
console.log(JSON.stringify({
  anchor: ledger.packages.at(-1).name,
  packageCount: ledger.packages.length,
  sourceCommit: ledger.sourceCommit,
  version: ledger.packages.at(-1).version,
}, null, 2));
NODE
git diff --check
git status --short
```

Expected: 55 entries, final dependency-ordered entry `@pkg-nec/jest@30.4.3`, silent diff check, and ignored `.pkg-nec-release/`.

- [ ] **Step 6: Commit documentation and final formatting**

```bash
git add CONTRIBUTING.md docs/pkg-nec-maintenance.md package.json lerna.json packages scripts .github/workflows/release.yml yarn.lock
git commit -m "docs: document npm provenance releases"
```

If only documentation remains, stage only the two documentation files. An unchanged `yarn.lock` is a no-op.

- [ ] **Step 7: Review commit series and prerequisites**

```bash
git status --short
git log --oneline --decorate -8
git diff @pkg-nec/jest-v30.4.2..HEAD --stat
```

Expected: clean worktree; task commits visible; final diff contains workflow, release scripts/tests, 55 patch bumps, repository URLs, policy updates, and docs. Before publishing, configure all 55 npm trusted publishers and the protected `npm-publish` environment.
