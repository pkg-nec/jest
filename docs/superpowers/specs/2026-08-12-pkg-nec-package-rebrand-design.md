# `@pkg-nec` Package Rebrand Design

**Date:** 2026-08-12  
**Status:** Approved for implementation planning  
**Input:** `docs/pkg-nec-rebrand-technical-guide.md`

## Objective

Rebrand the 55 publishable Jest package workspaces under the public npm scope `@pkg-nec`, while preserving their upstream versions, dependency specifications, behavior, Jest product identity, attribution, and upstream metadata. The repository will gain deterministic migration and audit tooling, publish-readiness automation, and a detailed manual publishing runbook. Live npm publication remains a manual user action.

## Scope

### Included

- Generate one canonical identity map for the root workspace and all 55 package workspaces.
- Rename internal package identities and all semantic references to them.
- Migrate manifests, source module strings, configuration identity fields, compiler type references, documentation examples, fixtures, generated metadata, scripts, and locks where those values represent package identities.
- Add category-aware stale-identity auditing.
- Add tests for mapping, rewriting, preservation, auditing, dependency ordering, and registry visibility behavior.
- Add a safe publish-readiness dry run that generates reviewed tarballs and a dependency-ordered release ledger without publishing.
- Add a manual npm publishing runbook that publishes directly to npm's default `latest` tag.
- Validate locally in Git Bash with Node `22.23.1` and require Linux CI evidence.

### Excluded

- Dependency vulnerability upgrades, dependency substitutions, and dependency range changes.
- Live npm publication or any bulk live-publish script.
- Published compatibility wrappers, aliases, or resolver mappings for upstream Jest package names.
- Renaming the Jest product, changing upstream repository/homepage/bugs URLs, changing copyright or attribution, or broadly replacing the word `jest` in prose.
- Publishing the root workspace, website, examples, or E2E fixtures.

## Release Invariants

The migration must preserve the following properties:

1. Each package keeps its current upstream version.
2. Every dependency value remains exactly unchanged, including protocols and ranges such as `workspace:*`, except for the four approved repository-only E2E fixture links.
3. Third-party dependency identities remain unchanged.
4. Exactly 55 package workspaces are public release candidates. The root, website, examples, and fixtures remain unpublished.
5. `@pkg-nec/jest-test-globals` and `@pkg-nec/jest-test-utils` are public release packages.
6. No published manifest contains a `link:` dependency.
7. No published package provides a compatibility layer for old package names.
8. Jest branding, upstream metadata, copyright, and attribution remain intact.
9. The one-time migration applicator and the repeatable audit are separate commands.
10. A validation run never updates a lockfile.

## Canonical Identity Model

### Discovery

The identity module discovers identities from the root `package.json` and the 55 direct `packages/*/package.json` manifests. Discovery must fail if the root is missing, the package-workspace count differs from 55, a manifest lacks a name, or the canonical output is not 56 unique identities.

Website and example workspaces are not part of the canonical release set, although identity references within their content are eligible rewrite and audit surfaces.

### Mapping Rules

- Root exception: `@jest/monorepo` maps to `@pkg-nec/monorepo`.
- Scoped package: `@jest/<name>` maps to `@pkg-nec/jest-<name>`.
- Unscoped package: `<name>` maps to `@pkg-nec/<name>`.
- Deep module paths retain their suffix after the longest matching package identity.

The generated map is the only naming authority. Rewriters, auditors, tests, build special cases, and release tools consume it instead of deriving names independently.

The identity module also exposes explicit exception data for reserved aliases, singleton/module maps, Babel hoist globals, and approved old-name compatibility literals. Exceptions must be narrow, categorized, and associated with specific files or semantic contexts.

## Components

### Canonical identity module

`scripts/pkgNecPackageIdentity.mjs` will:

- Discover and validate the 56 canonical identities.
- Return old-to-new and new-to-old maps.
- Identify the root and the 55 release workspaces.
- Resolve exact and deep module identities.
- Expose reviewed exception tables.
- Provide preservation snapshots for manifest names, versions, privacy, and dependency fields.

### One-time migration applicator

`scripts/rebrandPackages.mjs` will:

- Complete a repository-wide preflight before writing any file.
- Generate typed rewrite candidates from supported surfaces.
- Apply each approved candidate once through the canonical map.
- Refuse to operate when the root or a threshold of package manifests already use canonical names.
- Detect double-prefix outcomes such as `@pkg-nec/jest-jest-*`.
- Emit a categorized change report for review.
- Write nothing if discovery, mapping, parsing, or preservation preflight fails.

This command is intentionally not the routine verification command. After initial application, only the audit is run unless a reviewed mapping change requires a controlled fresh application.

### Repeatable identity audit

`scripts/checkPkgNecIdentity.mjs` will be read-only and safe to run repeatedly. It will:

- Validate canonical manifest names and publishability.
- Validate that every internal dependency key resolves to a canonical identity.
- Reject unexpected upstream package identities on eligible surfaces.
- Validate approved old-name literals by file and category.
- Validate configuration shorthands and reserved aliases remain unchanged.
- Detect double prefixes and unresolved internal references.
- Report file, literal, category, expected identity, and applicable exception.

The root script `check:pkg-nec-identity` will invoke this audit.

### Publish-readiness dry run

`scripts/publishPkgNecDry.mjs` will not call a live publish operation. It will:

- Re-run identity and preservation checks.
- Derive a directed graph from canonical internal runtime `dependencies` only.
- Fail on unresolved runtime dependencies or runtime cycles.
- Produce a stable dependency-first topological order, using a deterministic name sort when multiple nodes are eligible.
- Pack each release workspace into a temporary or ignored output directory.
- Inspect packed manifests and file lists for identity, version, range, access, and local-link violations.
- Calculate tarball integrity hashes.
- Emit a human-readable report and machine-readable release ledger containing name, version, prerequisites, order, tarball, hash, and packed-file summary.

The root script `publish:pkg-nec:dry` will invoke this command.

### Manual publishing runbook

`docs/pkg-nec-publishing-runbook.md` will document live release steps but will not contain credentials or a live bulk-publish script. It will use the exact reviewed tarballs from the dry run and publish directly to npm's default `latest` tag.

## Rewrite Model

### Manifest and structured data rewrites

Manifest handling changes canonical package names and internal dependency keys while retaining values byte-for-byte. It covers `dependencies`, `devDependencies`, `peerDependencies`, `optionalDependencies`, `resolutions`, and other dependency-bearing fields found during inventory.

Before applying changes, the migration stores a normalized preservation snapshot. After rewriting, it compares every version and dependency value to the snapshot, accounting only for renamed internal keys and the four fixture exceptions. A missing, added, or changed third-party entry is a hard failure.

JSON and JSONC handling targets compiler `types` arrays and other known package-identity fields. It preserves comments and formatting where required; it does not broadly replace quoted values containing `jest`.

### JavaScript and TypeScript rewrites

Candidate generation covers string literals used by:

- Static imports and exports.
- Dynamic imports.
- CommonJS `require` calls.
- Type-only imports and exports.
- Jest mock and unmock APIs, including chained calls.
- `jest.requireActual` and spread patterns using its result.
- Known configuration, resolver, preset, build, and serialized-metadata fields that semantically contain package identities.

Deep imports are rewritten by matching the longest canonical old package name and preserving the remaining path suffix. Unrelated strings and user-facing prose are not rewritten automatically.

### Documentation, examples, fixtures, locks, and generated metadata

Documentation and sample rewrites target package installation commands, imports, configuration package identities, badges or links that encode npm package identity, and explicit package-name tables. Jest product branding and upstream project URLs remain unchanged.

E2E fixture source and manifests are migrated when they consume an internal package. Root and nested locks, workspace links, build scripts, release scripts, and generated package metadata are included in the candidate inventory and stale audit.

Generated artifacts are regenerated through their owning command where practical. Hand edits to generated files are avoided when a deterministic generator exists.

## Approved Special Cases

### Test-only `@jest/globals` bridge

Only the `@fast-check/jest` development-test boundary retains an old identity. Its `moduleNameMapper` entry is exactly:

```js
const moduleNameMapper = {
  '^@jest/globals$':
    '<rootDir>/packages/jest-runtime/src/__tests__/test_root/MappedGlobals.js',
};
```

`packages/jest-runtime/src/__tests__/test_root/MappedGlobals.js` contains the bridge contract:

```js
module.exports = require('@pkg-nec/jest-globals');
```

The mapper is test-only. It is not a published compatibility feature and cannot be used to repair manifests, Node resolution, TypeScript resolution, or runtime configuration outside Jest's test resolver.

### Repository-only fixture links

The only allowed dependency-value changes are:

| Fixture | Canonical dependency | Required value |
| --- | --- | --- |
| `e2e/global-setup` | `@pkg-nec/jest-util` | `link:../../packages/jest-util` |
| `e2e/global-teardown` | `@pkg-nec/jest-util` | `link:../../packages/jest-util` |
| `e2e/transform/transform-environment` | `@pkg-nec/jest-environment-node` | `link:../../../packages/jest-environment-node` |
| `e2e/transform/transform-runner` | `@pkg-nec/jest-environment-node` | `link:../../../packages/jest-environment-node` |

Only `e2e/global-setup` and `e2e/global-teardown` have nested locks to regenerate. Each is updated once after its manifest conversion with `yarn install --mode=update-lockfile`. Validation later uses only `yarn install --immutable --immutable-cache`.

### API shorthands and reserved values

Values such as `testEnvironment: 'node'`, command-line options, short environment names, singleton identifiers, and reserved Jest aliases are classified by meaning. They remain unchanged unless an explicit reviewed rule identifies them as package identities.

## Failure Handling

All commands fail closed with actionable diagnostics.

The migration applicator stops before writing on:

- Unexpected workspace inventory or identity collisions.
- Parsing or candidate-classification failures.
- Evidence that migration was already applied.
- A candidate without a canonical mapping.
- A planned change to a protected version, range, protocol, third-party identity, or product-branding field.

The audit and dry run stop on:

- Missing, stale, double-prefixed, or unresolved identities.
- Unapproved old-name literals.
- Published local links or incorrect privacy/access metadata.
- Runtime dependency cycles or unresolved graph edges.
- Packed-manifest differences from the reviewed workspace manifest.

Registry visibility checks classify not-found, DNS, timeout, rate-limit, connection, and retryable 5xx failures as retryable. Authentication, authorization, malformed responses, integrity mismatches, and other errors are fatal. Each exact dependency query has a per-query timeout and shares a two-minute overall deadline with five-second intervals. Deadline errors include package, version, last error class, and attempt count.

## Verification Strategy

### Automated tests

`scripts/__tests__/rebrandPackages.test.js` and focused supporting tests cover:

- All 56 generated identities and uniqueness.
- Scoped, unscoped, root, helper-package, and deep-import mapping.
- Manifest-key migration with exact value preservation.
- JS/TS module strings, chained Jest mocks, and `jest.requireActual` spread patterns.
- JSONC type arrays and known configuration identity fields.
- Protected prose, shorthands, third-party strings, and approved exceptions.
- One-time application guards and repeatable audits.
- Fixture-link policy and published-manifest rejection of `link:`.
- Stable topological ordering, unresolved dependencies, and cycles.
- Registry visibility retry, fatal-error, timeout, and deadline behavior.

Tests use isolated fixture content rather than modifying the live repository.

### Local command gates

All Node, Corepack, Yarn, and npm commands run in Git Bash. The local Node manager selects `22.23.1` without a hardcoded user-specific NVM path. Setup begins with:

```bash
node --version
corepack enable
yarn install
```

After the migration and approved nested-lock regeneration, validation uses:

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

Targeted package validation lists tests before executing them and uses a trailing slash in the package pattern. `jest-runtime` validation uses `NODE_OPTIONS="--experimental-vm-modules --no-warnings"`. `--passWithNoTests` is allowed only when the preceding list operation proves there are zero tests.

The four specified E2E children run after `yarn build:js`, using their own supported commands. The final type-package check is `yarn workspace @pkg-nec/jest tstyche`.

### Baseline and platform policy

No snapshot is updated merely to make a test pass. If the named `jest-core` hidden-`.worktrees` glob result, `jest-core` watch code-frame snapshot, or either `jest-message-util` formatting snapshot differs, it is reproduced against upstream on the same Windows and Node version before classification. Other differences are migration regressions unless evidence establishes otherwise.

Linux CI is mandatory release evidence. The completion report distinguishes local Windows results from CI results and does not claim a universal full-suite pass.

## Manual Release Flow

The runbook will define these steps:

1. Confirm the exact reviewed commit and a clean worktree.
2. Select Node `22.23.1` in Git Bash, enable Corepack, and complete immutable readiness gates.
3. Confirm npm uses the intended public registry and the authenticated identity can publish public packages under `@pkg-nec`; prepare MFA/OTP as required.
4. Generate fresh tarballs and the dependency-ordered release ledger with `yarn publish:pkg-nec:dry`.
5. Review every packed manifest, file list, version, dependency range, and integrity hash.
6. For each ledger entry, run `npm publish <reviewed-tarball> --access public`. Omitting `--tag` intentionally publishes to npm's default `latest` tag.
7. Before publishing a consumer, poll each internal runtime prerequisite's exact `name@version` until visible, subject to the documented timeout and failure policy.
8. Record publication time, registry result, and observed integrity in the ledger.
9. On resume, verify any existing exact version and integrity; never attempt to overwrite it.
10. After all 55 packages are visible, perform clean-project install smoke tests, representative CommonJS and ESM imports, package entrypoint checks, and Jest CLI execution.
11. Archive the completed ledger as release evidence.

Publishing directly to `latest` exposes a temporarily incomplete package family during the manual release window. Dependency-first ordering and visibility checks reduce consumer installation failures but do not make the 55-package release atomic. This trade-off is explicitly accepted.

A bad artifact, integrity mismatch, unexpected existing version, authentication failure, or authorization failure stops the release. The runbook does not advise overwriting, silently skipping, or immediately unpublishing a package.

## Acceptance Criteria

The implementation is ready for user review when:

- The generated identity map contains exactly 56 unique mappings and exactly 55 release packages.
- All 55 package manifests have canonical public names, including the two test-helper packages.
- Versions and dependency values match the pre-migration inventory except for the four approved fixture links.
- The stale-identity audit passes with only named, categorized exceptions.
- No published manifest contains a local link or old-name compatibility mechanism.
- Migration, audit, graph, registry, and preservation tests pass.
- Required builds, targeted tests, E2E fixtures, type checks, immutable installs, and dry-run packaging pass or have explicitly classified evidence.
- Linux CI supplies required platform evidence.
- The dry run emits dependency-first tarballs and a complete release ledger without publishing.
- The manual publishing runbook is complete, uses the default `latest` tag, and contains no credentials or bulk live-publish command.
- The final diff preserves Jest branding, upstream metadata, copyright, and attribution.
