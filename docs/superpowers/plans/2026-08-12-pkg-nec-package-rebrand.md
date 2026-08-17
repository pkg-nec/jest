# `@pkg-nec` Package Rebrand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebrand the root and all 55 Jest package workspaces to canonical `@pkg-nec` identities, prove that versions and dependency specifications were preserved, and produce safe dry-run artifacts plus a manual npm publishing runbook.

**Architecture:** A canonical identity module and committed upstream-manifest baseline feed syntax-aware candidate collectors, a guarded one-time migration applicator, a repeatable category-aware auditor, and a publish-readiness tool. Live publication is excluded; the dry run packs and hashes artifacts in runtime dependency order, while a separate read-only visibility command supports the user's manual direct-to-`latest` release.

**Tech Stack:** Node.js 22.23.1, ECMAScript modules, Yarn 4.18.0, `@babel/core` parsing, TypeScript JSONC parsing, Jest, npm registry CLI, Git Bash.

## Global Constraints

- Run every `node`, `npm`, `corepack`, and `yarn` command in Git Bash, never PowerShell.
- Select Node `22.23.1` with the installed Node manager; do not hardcode a user-specific NVM directory.
- Before the first Yarn command, run `corepack enable`, then `yarn install`.
- Keep every package's current upstream version.
- Preserve every dependency value exactly, including protocol and range, except the four approved repository-only E2E fixture links.
- Do not add, remove, upgrade, downgrade, or substitute a third-party dependency.
- Publish exactly the 55 direct `packages/*` workspaces; keep root, website, examples, and fixtures unpublished.
- Make `@pkg-nec/jest-test-globals` and `@pkg-nec/jest-test-utils` public packages.
- Preserve Jest product branding, upstream URLs, copyright, attribution, CLI names, directory names, and configuration shorthands.
- Do not add a published legacy-name compatibility layer.
- Retain `@jest/globals` only at the explicit `@fast-check/jest` test bridge and in committed historical/baseline documentation.
- Never run the one-time migration applicator twice on the migrated tree.
- Never update a lockfile during validation.
- Publish-readiness tooling must never invoke a live npm publish operation.
- The manual release uses npm's default `latest` tag and `--access public`.
- Require Linux CI evidence; do not describe a Windows run as a universal full-suite pass.

## File Structure

### New files

- `scripts/pkgNecPackageIdentity.mjs` — discover 56 identities, generate the sole name map, resolve deep specifiers, and validate the baseline.
- `scripts/pkgNec/captureBaseline.mjs` and `scripts/pkgNec/upstreamManifestBaseline.json` — capture immutable upstream manifest evidence before migration.
- `scripts/pkgNec/repositoryFiles.mjs`, `moduleCandidates.mjs`, and `structuredCandidates.mjs` — enumerate semantic surfaces and return exact edits.
- `scripts/pkgNec/migrationPlan.mjs` and `scripts/rebrandPackages.mjs` — validate and apply the all-or-nothing one-time migration.
- `scripts/pkgNec/audit.mjs` and `scripts/checkPkgNecIdentity.mjs` — repeatable category-aware audit.
- `scripts/pkgNec/releaseGraph.mjs`, `registryVisibility.mjs`, `scripts/publishPkgNecDry.mjs`, and `scripts/waitForPkgNecRegistry.mjs` — dependency order, registry polling, packing, and ledger generation.
- `scripts/__tests__/pkgNecPackageIdentity.test.js`, `rebrandPackages.test.js`, `checkPkgNecIdentity.test.js`, and `publishPkgNecDry.test.js` — focused tooling tests.
- `packages/jest-runtime/src/__tests__/test_root/MappedGlobals.js` — exact test-only bridge.
- `docs/pkg-nec-publishing-runbook.md` — manual direct-to-`latest` release procedure.

### Existing files with deliberate review

- `package.json` and `.gitignore` — canonical root identity, four safe scripts, and ignored `/.pkg-nec-release/` output.
- All 55 `packages/*/package.json` files and `yarn.lock` — canonical names/keys with preserved values.
- `jest.config.mjs` — the single old-name test mapper.
- `scripts/buildUtils.mjs`, `scripts/buildTs.mjs`, and `scripts/bundleTs.mjs` — package-name comparisons change; paths and directory labels do not.
- `packages/babel-plugin-jest-hoist/src/index.ts`, `packages/jest-runtime/src/index.ts`, and their tests/snapshots — canonical globals/singleton identities.
- `packages/test-globals/package.json` and `packages/test-utils/package.json` — become public with neighboring-package metadata conventions.
- The four approved fixture manifests and the two approved nested locks.
- Semantic package-identity references under `packages/`, `e2e/`, `examples/`, `website/`, `docs/`, `.github/`, and root configuration.

---

### Task 1: Canonical Identity Map and Preservation Baseline

**Files:**

- Create: `scripts/pkgNecPackageIdentity.mjs`
- Create: `scripts/pkgNec/captureBaseline.mjs`
- Create: `scripts/pkgNec/upstreamManifestBaseline.json`
- Create: `scripts/__tests__/pkgNecPackageIdentity.test.js`

**Interfaces:**

- Produces: `discoverPackageIdentities({repoRoot, expectedPackageCount = 55}) -> IdentityInventory`.
- Produces: `rewritePackageSpecifier(specifier, inventory) -> string | null`.
- Produces: `createManifestBaseline(inventory) -> Baseline` and `assertManifestBaseline({baseline, inventory}) -> void`.
- `IdentityInventory` is `{root, packages, byOldName, byNewName}`; entries are `{directory, manifestPath, oldName, newName, publishable, version}`.

- [ ] **Step 1: Prepare the required Git Bash runtime**

After selecting Node `22.23.1` with the installed manager, run:

```bash
node --version
corepack enable
yarn install
yarn --version
```

Expected: `v22.23.1`, Yarn `4.18.0`, and exit 0.

- [ ] **Step 2: Write failing identity tests**

Assert 56 unique identities, 55 release workspaces, collision/count failures, third-party rejection, and exact mappings:

```js
expect(inventory.byOldName.get('@jest/monorepo').newName).toBe(
  '@pkg-nec/monorepo',
);
expect(inventory.byOldName.get('@jest/globals').newName).toBe(
  '@pkg-nec/jest-globals',
);
expect(inventory.byOldName.get('jest').newName).toBe('@pkg-nec/jest');
expect(inventory.byOldName.get('expect').newName).toBe('@pkg-nec/expect');
expect(inventory.packages).toHaveLength(55);
expect(new Set(inventory.packages.map(pkg => pkg.newName)).size).toBe(55);
expect(rewritePackageSpecifier('@jest/globals/build/index.js', inventory)).toBe(
  '@pkg-nec/jest-globals/build/index.js',
);
expect(rewritePackageSpecifier('@fast-check/jest', inventory)).toBeNull();
```

- [ ] **Step 3: Verify the red state**

```bash
yarn jest scripts/__tests__/pkgNecPackageIdentity.test.js --runInBand --color
```

Expected: FAIL because the identity module does not exist.

- [ ] **Step 4: Implement deterministic discovery and mapping**

Use `graceful-fs`; sort directories before reading. Derive names only here:

```js
export function canonicalName(oldName, {isRoot = false} = {}) {
  if (isRoot && oldName === '@jest/monorepo') return '@pkg-nec/monorepo';
  if (oldName.startsWith('@jest/')) return `@pkg-nec/jest-${oldName.slice(6)}`;
  return `@pkg-nec/${oldName}`;
}
```

Match deep imports longest-first on an exact or `/` boundary. Mark the two test helpers publishable by policy despite their upstream `private` flags.

- [ ] **Step 5: Implement and capture the baseline**

Key records by normalized manifest path. Store `name`, `version`, `private`, and present dependency-bearing fields: `dependencies`, `devDependencies`, `peerDependencies`, `optionalDependencies`, `peerDependenciesMeta`, and `resolutions`. Sort keys. Run once:

```bash
node scripts/pkgNec/captureBaseline.mjs
```

Expected: 56 records; a second invocation refuses to overwrite the file.

- [ ] **Step 6: Verify and commit**

```bash
yarn jest scripts/__tests__/pkgNecPackageIdentity.test.js --runInBand --color
git add scripts/pkgNecPackageIdentity.mjs scripts/pkgNec/captureBaseline.mjs scripts/pkgNec/upstreamManifestBaseline.json scripts/__tests__/pkgNecPackageIdentity.test.js
git commit -m "feat: define pkg-nec package identities"
```

### Task 2: Syntax-Aware Rewrite Candidates

**Files:**

- Create: `scripts/pkgNec/repositoryFiles.mjs`
- Create: `scripts/pkgNec/moduleCandidates.mjs`
- Create: `scripts/pkgNec/structuredCandidates.mjs`
- Create: `scripts/__tests__/rebrandPackages.test.js`

**Interfaces:**

- Consumes: `IdentityInventory` and `rewritePackageSpecifier`.
- Produces: `enumerateRepositoryFiles({repoRoot}) -> Array<{category, path}>`.
- Produces: `collectModuleCandidates({code, filePath, inventory}) -> TextEdit[]`.
- Produces: `collectStructuredCandidates({text, filePath, category, inventory}) -> TextEdit[]`.
- Produces: `applyTextEdits(text, edits) -> string` from `moduleCandidates.mjs`.
- `TextEdit` is `{start, end, replacement, oldValue, newValue, category}` using UTF-16 offsets.

- [ ] **Step 1: Write failing module syntax tests**

Cover static/type imports, exports, dynamic import, `require`, `require.resolve`, chained mock APIs, and spread `requireActual`:

```js
const source = `
  import type {Config} from '@jest/types';
  export {expect} from 'expect';
  const runtime = await import('jest-runtime/build/index.js');
  const util = require('jest-util');
  jest.disableAutomock().mock('@jest/globals', () => ({
    ...jest.requireActual('@jest/globals'),
  }));
`;
const result = applyTextEdits(
  source,
  collectModuleCandidates({code: source, filePath: 'fixture.ts', inventory}),
);
expect(result).toContain("from '@pkg-nec/jest-types'");
expect(result).toContain("from '@pkg-nec/expect'");
expect(result).toContain("import('@pkg-nec/jest-runtime/build/index.js')");
expect(result).toContain("require('@pkg-nec/jest-util')");
expect(result.match(/@pkg-nec\/jest-globals/g)).toHaveLength(2);
```

Negative cases: `@fast-check/jest`, `node:path`, relative paths, `testEnvironment: 'node'`, identifiers named `jest`, and ordinary prose.

- [ ] **Step 2: Verify the red state**

```bash
yarn jest scripts/__tests__/rebrandPackages.test.js --runInBand --color
```

Expected: FAIL because collectors do not exist.

- [ ] **Step 3: Implement JS/TS collection without new dependencies**

Use `@babel/core.parseSync` with `configFile: false`, `babelrc: false`, TypeScript parsing for `.ts/.tsx`, Flow parsing for JS, and JSX parsing for JSX/TSX. Walk the AST directly. Accept approved module-bearing nodes and Jest methods `mock`, `doMock`, `unmock`, `dontMock`, `setMock`, `requireActual`, `requireMock`, and `createMockFromModule` even when chained.

- [ ] **Step 4: Write failing structured-data tests**

```js
const rewriteStructured = (text, filePath, category) =>
  applyTextEdits(
    text,
    collectStructuredCandidates({category, filePath, inventory, text}),
  );
const manifest =
  '{"dependencies":{"@jest/globals":"workspace:*","@fast-check/jest":"^2.1.1"}}';
expect(
  JSON.parse(rewriteStructured(manifest, 'package.json', 'manifest'))
    .dependencies,
).toEqual({
  '@fast-check/jest': '^2.1.1',
  '@pkg-nec/jest-globals': 'workspace:*',
});
const jsonc = '{"compilerOptions":{"types":["@jest/globals","node"]}}';
expect(rewriteStructured(jsonc, 'tsconfig.json', 'jsonc')).toBe(
  '{"compilerOptions":{"types":["@pkg-nec/jest-globals","node"]}}',
);
const thirdPartyJest29Entry =
  '"@jest/types@npm:^29.6.3":\n  resolution: "@jest/types@npm:29.6.3"\n';
expect(
  rewriteStructured(
    thirdPartyJest29Entry,
    'e2e/global-setup/yarn.lock',
    'fixture-lock',
  ),
).toBe(thirdPartyJest29Entry);
```

- [ ] **Step 5: Implement structured collection and enumeration**

Use `typescript.parseJsonText` for JSONC. Rename manifest identity keys but never values. Restrict unscoped documentation matches to install tokens, code literals, module examples, npm badges/links, and explicit package tables. Exclude `.git`, `.yarn/cache`, `node_modules`, builds, coverage, the baseline JSON, technical guide, approved design, and this plan. Classify nested fixture locks so upstream Jest 29 npm entries remain unchanged.

- [ ] **Step 6: Verify, lint, and commit**

```bash
yarn jest scripts/__tests__/rebrandPackages.test.js --runInBand --color
yarn eslint --cache --fix scripts/pkgNec/repositoryFiles.mjs scripts/pkgNec/moduleCandidates.mjs scripts/pkgNec/structuredCandidates.mjs scripts/__tests__/rebrandPackages.test.js
git add scripts/pkgNec/repositoryFiles.mjs scripts/pkgNec/moduleCandidates.mjs scripts/pkgNec/structuredCandidates.mjs scripts/__tests__/rebrandPackages.test.js
git commit -m "feat: collect pkg-nec identity rewrites"
```

### Task 3: Guarded One-Time Migration Applicator

**Files:**

- Create: `scripts/pkgNec/migrationPlan.mjs`
- Create: `scripts/rebrandPackages.mjs`
- Modify: `scripts/__tests__/rebrandPackages.test.js`
- Modify: `package.json`

**Interfaces:**

- Consumes: `applyTextEdits(text, edits) -> string` from Task 2.
- Produces: `buildMigrationPlan({repoRoot, inventory, baseline}) -> MigrationPlan`.
- Produces: `validateMigrationPlan(plan) -> void` and `applyMigrationPlan(plan) -> MigrationReport`.
- `MigrationPlan` is `{files: Array<{path, before, after, edits}>, manifestComparisons: Array<{path, field, before, after}>}`; `MigrationReport` is `{changedPaths, countsByCategory}`.

- [ ] **Step 1: Write failing atomicity and second-run tests**

Create `overlappingPlan` with two edits covering the same offsets, `rangeChangingPlan` with a manifest comparison changing `@fast-check/jest` from `^2.1.1` to `^3.0.0`, and `validPlan` inside a temporary repository. Then assert:

```js
expect(() => applyMigrationPlan(overlappingPlan)).toThrow(/overlapping edits/);
expect(() => validateMigrationPlan(rangeChangingPlan)).toThrow(
  /dependency value changed/,
);
applyMigrationPlan(validPlan);
expect(() => buildMigrationPlan(validOptions)).toThrow(
  /already appears to be rebranded/,
);
```

Also prove no file is written when parsing, collision, double-prefix, or preservation preflight fails.

- [ ] **Step 2: Verify the red state**

```bash
yarn jest scripts/__tests__/rebrandPackages.test.js --runInBand --color
```

Expected: FAIL because planner and CLI do not exist.

- [ ] **Step 3: Implement all-in-memory preflight and guarded writes**

Sort edits descending, reject overlaps/mismatched `oldValue`, compare migrated manifests with the baseline by workspace path, and allow metadata/privacy policy changes only for the two helpers. Refuse when the root is already canonical or any `@pkg-nec/jest-jest-` value exists.

- [ ] **Step 4: Add the root command**

```json
"rebrand:pkg-nec": "node ./scripts/rebrandPackages.mjs"
```

The CLI prints a complete categorized plan before writes. `--check` validates without writing.

- [ ] **Step 5: Verify upstream check mode and commit**

```bash
yarn jest scripts/__tests__/rebrandPackages.test.js --runInBand --color
yarn rebrand:pkg-nec --check
git status --short
git add package.json scripts/pkgNec/migrationPlan.mjs scripts/rebrandPackages.mjs scripts/__tests__/rebrandPackages.test.js
git commit -m "feat: add guarded pkg-nec migration"
```

### Task 4: Repeatable Category-Aware Audit

**Files:**

- Create: `scripts/pkgNec/audit.mjs`
- Create: `scripts/checkPkgNecIdentity.mjs`
- Create: `scripts/__tests__/checkPkgNecIdentity.test.js`
- Modify: `package.json`

**Interfaces:**

- Consumes: identity inventory, baseline, file classifications, and semantic collectors.
- Produces: `auditRepository({repoRoot, inventory, baseline}) -> AuditFinding[]`.
- Produces: `auditText({text, filePath, category, inventory}) -> AuditFinding[]` for isolated tests.
- `AuditFinding` is `{filePath, literal, category, expected, exceptionId}`; `exceptionId` is `null` for a failure.

- [ ] **Step 1: Write failing audit tests**

Cover stale manifest keys/imports/compiler types, double prefixes, missing mappings, bad fixture links, published `link:`, protected shorthand/path values, historical documents, the bridge, and an unexpected old literal:

```js
const mappedGlobalsPath =
  'packages/jest-runtime/src/__tests__/test_root/MappedGlobals.js';
expect(
  auditText({
    text: "import '@jest/globals'",
    filePath: 'src/file.ts',
    category: 'source',
    inventory,
  }),
).toEqual([
  expect.objectContaining({
    category: 'module-specifier',
    expected: '@pkg-nec/jest-globals',
    literal: '@jest/globals',
  }),
]);
expect(
  auditText({
    text: "testEnvironment: 'node'",
    filePath: 'jest.config.js',
    category: 'config',
    inventory,
  }),
).toEqual([]);
expect(
  auditText({
    text: "require('@jest/globals')",
    filePath: mappedGlobalsPath,
    category: 'source',
    inventory,
  }),
).toEqual([]);
```

- [ ] **Step 2: Verify the red state**

```bash
yarn jest scripts/__tests__/checkPkgNecIdentity.test.js --runInBand --color
```

Expected: FAIL because the audit does not exist.

- [ ] **Step 3: Implement exact exceptions and diagnostics**

Allow only the mapper key in `jest.config.mjs`; historical literals in the technical guide, approved design/plan, and baseline; upstream npm Jest identities in nested fixture locks; and directory/CLI labels proven not to be package identities. Use exact file/category records, not blanket regex suppression. Print file, category, literal, expected mapping, and exception ID.

- [ ] **Step 4: Add the root command**

```json
"check:pkg-nec-identity": "node ./scripts/checkPkgNecIdentity.mjs"
```

- [ ] **Step 5: Verify green fixtures and the expected red upstream repository**

```bash
yarn jest scripts/__tests__/checkPkgNecIdentity.test.js --runInBand --color
yarn check:pkg-nec-identity
```

Expected: unit tests PASS; repository audit FAILS before Task 7 with actionable stale identities.

- [ ] **Step 6: Commit**

```bash
git add package.json scripts/pkgNec/audit.mjs scripts/checkPkgNecIdentity.mjs scripts/__tests__/checkPkgNecIdentity.test.js
git commit -m "feat: audit pkg-nec package identities"
```

### Task 5: Runtime Release Graph and Registry Visibility

**Files:**

- Create: `scripts/pkgNec/releaseGraph.mjs`
- Create: `scripts/pkgNec/registryVisibility.mjs`
- Create: `scripts/waitForPkgNecRegistry.mjs`
- Create: `scripts/__tests__/publishPkgNecDry.test.js`
- Modify: `package.json`

**Interfaces:**

- Produces: `buildRuntimeReleaseGraph(inventory) -> Map<string, Set<string>>` from internal runtime `dependencies` only.
- Produces: `topologicalReleaseOrder(graph) -> string[]` with lexical tie-breaking.
- Produces: `classifyRegistryError(error) -> 'retryable' | 'fatal'`.
- Produces: `waitForExactVersion({name, version, query, intervalMs = 5000, queryTimeoutMs = 10000, deadlineMs = 120000}) -> RegistryEvidence`.
- `RegistryEvidence` is `{attempts, elapsedMs, integrity, name, version}`.

- [ ] **Step 1: Write failing graph tests**

```js
const graph = new Map([
  ['@pkg-nec/jest', new Set(['@pkg-nec/jest-cli'])],
  ['@pkg-nec/jest-cli', new Set(['@pkg-nec/jest-core'])],
  ['@pkg-nec/jest-core', new Set()],
]);
const cyclicGraph = new Map([
  ['@pkg-nec/a', new Set(['@pkg-nec/b'])],
  ['@pkg-nec/b', new Set(['@pkg-nec/a'])],
]);
expect(topologicalReleaseOrder(graph)).toEqual([
  '@pkg-nec/jest-core',
  '@pkg-nec/jest-cli',
  '@pkg-nec/jest',
]);
expect(() => topologicalReleaseOrder(cyclicGraph)).toThrow(/runtime cycle/);
```

Prove dev-only cycles are ignored and unresolved internal runtime dependencies fail.

- [ ] **Step 2: Write failing fake-clock registry tests**

Inject `query`, `now`, and `sleep`. Cover retry for not-found, DNS, timeout, rate limit, connection, and retryable 5xx; fatal authentication/authorization; per-query abort; and deadline messages containing package, version, last error class, and attempt count.

- [ ] **Step 3: Verify the red state**

```bash
yarn jest scripts/__tests__/publishPkgNecDry.test.js --runInBand --color
```

Expected: FAIL because graph and visibility modules do not exist.

- [ ] **Step 4: Implement dependency-first order and bounded polling**

Store consumer-to-dependency edges, then emit packages whose dependencies are already emitted. Query with argument arrays equivalent to `npm view name@version --json`; never interpolate a shell command. Apply `AbortSignal.timeout(10000)` per query and a shared 120-second deadline with five-second intervals. Redact tokens and authorization headers from errors.

- [ ] **Step 5: Add the read-only registry command**

```json
"check:pkg-nec-registry": "node ./scripts/waitForPkgNecRegistry.mjs"
```

Accept exactly one `@pkg-nec/name@version` positional value. Print attempts, elapsed time, registry integrity, and terminal classification.

- [ ] **Step 6: Verify, lint, and commit**

```bash
yarn jest scripts/__tests__/publishPkgNecDry.test.js --runInBand --color
yarn eslint --cache --fix scripts/pkgNec/releaseGraph.mjs scripts/pkgNec/registryVisibility.mjs scripts/waitForPkgNecRegistry.mjs scripts/__tests__/publishPkgNecDry.test.js
git add package.json scripts/pkgNec/releaseGraph.mjs scripts/pkgNec/registryVisibility.mjs scripts/waitForPkgNecRegistry.mjs scripts/__tests__/publishPkgNecDry.test.js
git commit -m "feat: order pkg-nec releases safely"
```

### Task 6: Publish-Readiness Packing and Ledger

**Files:**

- Create: `scripts/publishPkgNecDry.mjs`
- Modify: `scripts/__tests__/publishPkgNecDry.test.js`
- Modify: `package.json`
- Modify: `.gitignore`

**Interfaces:**

- Produces: `inspectPackedManifest({workspace, manifest, baseline}) -> void`.
- Produces: `createReleaseLedger({artifacts, order}) -> ReleaseLedger`.
- `ReleaseLedger` is `{generatedAt, packages: Array<{name, version, prerequisites, order, tarball, integrity, files}>}`.
- Writes ignored `.pkg-nec-release/*.tgz`, `release-ledger.json`, and `release-ledger.md`.

- [ ] **Step 1: Write failing pack inspection tests**

Reject old names, unexpected versions, changed third-party ranges, unresolved internal dependencies, private helper packages, missing public access, and packed `link:` values. Prove stable ledger order and SHA-512 SRI:

```js
const workspace = inventory.byNewName.get('@pkg-nec/jest');
const packedManifest = {
  name: workspace.newName,
  publishConfig: {access: 'public'},
  version: workspace.version,
};
expect(() =>
  inspectPackedManifest({
    baseline,
    manifest: {...packedManifest, version: '99.0.0'},
    workspace,
  }),
).toThrow(/version changed/);
const releaseOrder = ['@pkg-nec/jest-core', '@pkg-nec/jest'];
const artifacts = releaseOrder.map((name, order) => ({
  files: ['package.json'],
  integrity: `sha512-test-${order}`,
  name,
  prerequisites: order === 0 ? [] : ['@pkg-nec/jest-core'],
  tarball: `${name.slice(1).replace('/', '-')}.tgz`,
  version: '30.4.2',
}));
const ledger = createReleaseLedger({artifacts, order: releaseOrder});
expect(ledger.packages.map(item => item.name)).toEqual(releaseOrder);
expect(ledger.packages[0].integrity).toMatch(/^sha512-/);
```

- [ ] **Step 2: Verify the red state**

```bash
yarn jest scripts/__tests__/publishPkgNecDry.test.js --runInBand --color
```

Expected: FAIL because the dry-run module does not exist.

- [ ] **Step 3: Implement safe deterministic output**

Ignore `/.pkg-nec-release/`. Resolve that exact repository child and reject root/outside paths before replacing its previous contents. For each ordered package, spawn Yarn with arguments equivalent to:

For the `@pkg-nec/jest@30.4.2` workspace, the spawned argument vector is equivalent to:

```bash
yarn workspace @pkg-nec/jest pack --out .pkg-nec-release/pkg-nec-jest-30.4.2.tgz
```

Inspect `package/package.json` in each tarball, calculate SRI, and record a sorted file list. Never call `yarn npm publish` or `npm publish`.

- [ ] **Step 4: Add the root dry-run command**

```json
"publish:pkg-nec:dry": "node ./scripts/publishPkgNecDry.mjs"
```

- [ ] **Step 5: Verify, lint, and commit**

```bash
yarn jest scripts/__tests__/publishPkgNecDry.test.js --runInBand --color
yarn eslint --cache --fix scripts/publishPkgNecDry.mjs scripts/__tests__/publishPkgNecDry.test.js
git add .gitignore package.json scripts/publishPkgNecDry.mjs scripts/__tests__/publishPkgNecDry.test.js
git commit -m "feat: dry run pkg-nec package release"
```

### Task 7: Apply and Review the Repository Migration

**Files:**

- Modify: `package.json`, `yarn.lock`, all 55 `packages/*/package.json`, and semantic identity-bearing files reported by check mode.
- Modify: `jest.config.mjs`
- Create: `packages/jest-runtime/src/__tests__/test_root/MappedGlobals.js`
- Modify: `packages/test-globals/package.json`, `packages/test-utils/package.json`
- Modify: `e2e/global-setup/package.json`, `e2e/global-setup/yarn.lock`
- Modify: `e2e/global-teardown/package.json`, `e2e/global-teardown/yarn.lock`
- Modify: `e2e/transform/transform-environment/package.json`, `e2e/transform/transform-runner/package.json`
- Modify: `scripts/buildUtils.mjs`, `scripts/buildTs.mjs`, `scripts/bundleTs.mjs`
- Modify: `packages/babel-plugin-jest-hoist/src/index.ts`, `packages/jest-runtime/src/index.ts`, and identity-bearing tests/snapshots.

**Interfaces:**

- Consumes: all commands and invariants from Tasks 1–6.
- Produces: one canonical repository tree for build, test, and release validation.

- [ ] **Step 1: Record the expected failing audit and reviewed plan**

```bash
yarn check:pkg-nec-identity
yarn rebrand:pkg-nec --check
```

Expected: audit FAILS on stale identities; check mode exits 0 with 56 identities, 55 release packages, and categorized candidates without writes.

- [ ] **Step 2: Apply the migration exactly once**

```bash
yarn rebrand:pkg-nec
```

Expected: exits 0 after complete preflight and writes the reviewed set. Never invoke it again after success.

- [ ] **Step 3: Add the exact test-only bridge**

Add to `jest.config.mjs`:

```js
const moduleNameMapper = {
  '^@jest/globals$':
    '<rootDir>/packages/jest-runtime/src/__tests__/test_root/MappedGlobals.js',
};
```

Create `MappedGlobals.js` with the repository copyright header and exact executable contract:

```js
module.exports = require('@pkg-nec/jest-globals');
```

Add no other old-name mapper.

- [ ] **Step 4: Make the two helper packages public**

Remove `private`. Add `repository` with `https://github.com/jestjs/jest.git` and the correct package directory, `homepage: https://jestjs.io/`, `license: MIT`, and `publishConfig.access: public`, matching neighboring manifests. Preserve versions and dependency values.

- [ ] **Step 5: Apply exactly four local links**

Use:

```json
"@pkg-nec/jest-util": "link:../../packages/jest-util"
```

in global setup/teardown, and:

```json
"@pkg-nec/jest-environment-node": "link:../../../packages/jest-environment-node"
```

in both transform fixtures. Remove the prior local dependency keys. Do not alter registry-based upstream Jest 29 transitive lock entries.

- [ ] **Step 6: Regenerate only the two approved nested locks**

```bash
(cd e2e/global-setup && yarn install --mode=update-lockfile)
(cd e2e/global-teardown && yarn install --mode=update-lockfile)
(cd e2e/global-setup && yarn install --immutable --immutable-cache)
(cd e2e/global-teardown && yarn install --immutable --immutable-cache)
```

Expected: local links resolve; immutable installs exit 0.

- [ ] **Step 7: Review special cases by meaning**

Confirm package-name comparisons in build scripts are canonical, while directory regexes, `packages/*` paths, `lintTs.mjs` directory lists, `bin: jest`, CLI strings, global identifier `jest`, and `testEnvironment: 'node'` remain unchanged. Confirm `JEST_GLOBALS_MODULE_NAME` is `@pkg-nec/jest-globals`; singleton names are `@pkg-nec/jest-expect` and `@pkg-nec/expect`; and the runtime globals intercept is canonical.

- [ ] **Step 8: Run the green audit and tooling suite**

```bash
yarn check:pkg-nec-identity
yarn jest scripts/__tests__/pkgNecPackageIdentity.test.js scripts/__tests__/rebrandPackages.test.js scripts/__tests__/checkPkgNecIdentity.test.js scripts/__tests__/publishPkgNecDry.test.js --runInBand --color
git diff --check
```

Expected: audit and tests PASS; diff check exits 0.

- [ ] **Step 9: Review and commit the migration**

Review every manifest, both nested locks, build special cases, bridge, identity snapshots, docs, and root lock. Confirm the baseline comparison reports no value changes beyond four links.

```bash
git add package.json yarn.lock jest.config.mjs scripts packages e2e examples website docs .github
git commit -m "refactor: rebrand Jest packages for pkg-nec"
```

### Task 8: Manual Publishing Runbook

**Files:**

- Create: `docs/pkg-nec-publishing-runbook.md`

**Interfaces:**

- Consumes: dry-run tarballs/ledger and the read-only visibility command.
- Produces: credential-free, resumable, one-package-at-a-time direct-to-`latest` instructions.

- [ ] **Step 1: Write an executable preflight and publish checklist**

Include these exact Git Bash commands:

```bash
node --version
corepack enable
yarn --version
yarn install --immutable --immutable-cache
yarn check:pkg-nec-identity
yarn publish:pkg-nec:dry
npm config get registry
npm whoami
npm access list packages @pkg-nec
npm publish ".pkg-nec-release/pkg-nec-jest-30.4.2.tgz" --access public
yarn check:pkg-nec-registry "@pkg-nec/jest@30.4.2"
npm view "@pkg-nec/jest@30.4.2" --json
```

Label the Jest commands as a concrete ledger example, not the first package in release order. State that omitting `--tag` intentionally selects `latest`.

- [ ] **Step 2: Document dependency gates and resumption**

Treat ledger order as authoritative. Before a consumer, run the visibility command for every listed runtime prerequisite. Record published time, npm response, and registry integrity. On restart, query an existing exact version and compare integrity; do not republish or overwrite it.

- [ ] **Step 3: Document fatal stops and smoke tests**

Stop on authentication/authorization failure, unexpected existing version, integrity mismatch, runtime cycle, or malformed metadata. Do not recommend automatic unpublish. Use a new temporary project:

```bash
mkdir pkg-nec-release-smoke
cd pkg-nec-release-smoke
npm init -y
npm install @pkg-nec/jest@latest
npx jest --version
node -e "console.log(require('@pkg-nec/jest/package.json').version)"
```

Also include CommonJS and ESM import checks for `@pkg-nec/jest-globals`, `@pkg-nec/expect`, and `@pkg-nec/pretty-format`.

- [ ] **Step 4: Format and commit**

```bash
yarn prettier docs/pkg-nec-publishing-runbook.md --check
git add docs/pkg-nec-publishing-runbook.md
git commit -m "docs: add pkg-nec publishing runbook"
```

### Task 9: Full Local and CI Readiness Verification

**Files:**

- Modify only files needed to correct a reproduced migration defect.
- Never update a snapshot before the required same-platform upstream comparison.

**Interfaces:**

- Consumes: canonical migrated tree and all gates.
- Produces: fresh local evidence, classified failures, clean worktree, and Linux CI evidence.

- [ ] **Step 1: Run immutable/static gates in Git Bash**

```bash
node --version
corepack enable
yarn --version
yarn install --immutable --immutable-cache
yarn check:pkg-nec-identity
yarn jest scripts/__tests__/rebrandPackages.test.js --runInBand --color
yarn constraints
yarn lint
yarn build:js
yarn typecheck:tests
yarn publish:pkg-nec:dry
```

Expected: Node `v22.23.1`; all exit 0; dry run emits 55 ordered artifacts and two ledgers without publishing.

- [ ] **Step 2: Prove and run `jest-core` discovery**

```bash
yarn jest --listTests --testPathPatterns="packages/jest-core/" --color
yarn jest --testPathPatterns="packages/jest-core/" --color
```

Expected: only intended `jest-core` tests are listed; tests pass.

- [ ] **Step 3: Prove and run VM `jest-runtime` discovery**

```bash
NODE_OPTIONS="--experimental-vm-modules --no-warnings" yarn jest --listTests --testPathPatterns="packages/jest-runtime/" --color
NODE_OPTIONS="--experimental-vm-modules --no-warnings" yarn jest --testPathPatterns="packages/jest-runtime/" --color
```

Expected: only intended runtime tests are listed; tests pass.

- [ ] **Step 4: Run E2E children after `build:js`**

```bash
(cd e2e/global-setup && yarn install --immutable --immutable-cache && node ../../packages/jest-cli/bin/jest.js --env=@pkg-nec/jest-environment-node --globalSetup=./setup.js --testPathPatterns=__tests__ --runInBand --no-cache)
(cd e2e/global-teardown && yarn install --immutable --immutable-cache && node ../../packages/jest-cli/bin/jest.js --env=@pkg-nec/jest-environment-node --globalTeardown=./teardown.js --testPathPatterns=__tests__ --runInBand --no-cache)
(cd e2e/transform/transform-environment && node ../../../packages/jest-cli/bin/jest.js --no-cache --runInBand)
(cd e2e/transform/transform-runner && node ../../../packages/jest-cli/bin/jest.js --no-cache --runInBand)
yarn workspace @pkg-nec/jest tstyche
```

Expected: all children and type tests exit 0.

- [ ] **Step 5: Classify only named Windows differences**

For the hidden-`.worktrees` glob result, watch code-frame snapshot, or either `jest-message-util` formatting snapshot, reproduce the exact test against upstream on Windows with Node `22.23.1` before changing a snapshot. Treat every other difference as a migration defect.

- [ ] **Step 6: Require Linux CI and verify final state**

Run Linux static, build, relevant test-shard, and type jobs. Record URLs and conclusions in the handoff. Then run:

```bash
git status --short
git log --oneline -9
```

Expected: required Linux jobs pass, worktree is clean, and task commits are present. After any fix, rerun the exposing command and affected downstream gates before committing.
