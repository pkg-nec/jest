# Maintaining the `@pkg-nec` Jest Fork

This is the canonical guide for the independently maintained `@pkg-nec/jest` fork. It records the completed namespace migration and first npm publication, then defines the durable identity, security-maintenance, release-preparation, and publication boundaries. Historical plans and the one-time migration procedure are not operational runbooks.

## Source-of-truth hierarchy

Use the following sources in this order:

1. Current package manifests define versions and dependency specifications.
2. `scripts/pkgNec/packageIdentityPolicy.json` defines durable workspace paths, historical upstream names, canonical `@pkg-nec` names, and publishability.
3. `yarn check:pkg-nec-identity` enforces current structural identity rules and exact exceptions.
4. A freshly generated schema-v1 release ledger describes one prepared release candidate.
5. Git history preserves the removed one-time migration implementation and its design decisions.

Do not restore or rerun the original migration machinery. Do not use an old design document, an ignored local artifact, or upstream `latest` as an operational source of truth.

## Completed rebrand and first release

### Canonical package identities

The migration created 56 canonical identities: the private root plus 55 public package workspaces.

- The root policy entry maps its historical `oldName` to private `@pkg-nec/monorepo`.
- An upstream `@jest/<name>` workspace maps to `@pkg-nec/jest-<name>`.
- An unscoped package workspace maps to `@pkg-nec/<original-name>`.
- Deep package paths retain their suffix after the package-name mapping.
- `@pkg-nec/jest-test-globals` and `@pkg-nec/jest-test-utils` are intentionally public members of the 55-package release set.
- The root, website, examples, and E2E fixtures remain unpublished.

The first release preserved the upstream package versions and dependency values so that the namespace migration could be reviewed independently from dependency-security changes. That was a one-time migration invariant. Ongoing security maintenance may change versions, dependencies, ranges, and the lockfile through normal review.

The first release contained the following version distribution:

| Version  | Packages |
| -------- | -------: |
| `30.0.1` |        1 |
| `30.1.0` |        1 |
| `30.4.0` |        6 |
| `30.4.1` |       37 |
| `30.4.2` |       10 |

### Runtime identity decisions

Internal defaults resolve to the scoped fork implementations:

- runner: `@pkg-nec/jest-runner`;
- test runner: `@pkg-nec/jest-circus/runner`;
- Node environment: `@pkg-nec/jest-environment-node`;
- jsdom environment: `@pkg-nec/jest-environment-jsdom`.

Established user-facing configuration shorthands such as `node`, `jsdom`, Circus, and Jasmine remain API values. They are not package identities and must not be mechanically rebranded. Custom third-party runners and environments retain normal resolver behavior. Do not add an unscoped upstream fallback or a published legacy-name alias; mixing independently resolved upstream and fork packages can combine incompatible runtimes.

The only active legacy globals compatibility literals are exact test and compiler boundaries:

- the legacy globals mapper key in `jest.config.mjs`;
- the legacy globals compiler path in `tsconfig.test.json`.

Their exact spellings are enforced by `scripts/pkgNec/audit.mjs` and are intentionally not duplicated in this audited guide.

The mapper target `packages/jest-runtime/src/__tests__/test_root/MappedGlobals.js` must export `require('@pkg-nec/jest-globals')`. This bridge exists only for development tests and is not published compatibility behavior.

### Repository-only fixture links

Exactly six local links are allowed, all in unpublished E2E fixture manifests:

| Fixture manifest | Field and dependency | Required value |
| --- | --- | --- |
| `e2e/global-setup/package.json` | `devDependencies.@pkg-nec/jest-util` | `link:../../packages/jest-util` |
| `e2e/global-teardown/package.json` | `devDependencies.@pkg-nec/jest-util` | `link:../../packages/jest-util` |
| `e2e/transform/transform-environment/package.json` | `dependencies.@pkg-nec/jest-environment-node` | `link:../../../packages/jest-environment-node` |
| `e2e/transform/transform-runner/package.json` | `dependencies.@pkg-nec/jest-environment-node` | `link:../../../packages/jest-environment-node` |
| `e2e/transform/transform-esm-testrunner/package.json` | `dependencies.@pkg-nec/jest-test-result` | `link:../../../packages/jest-test-result` |
| `e2e/transform/transform-testrunner/package.json` | `dependencies.@pkg-nec/jest-test-result` | `link:../../../packages/jest-test-result` |

Do not add another `file:` or `link:` dependency without changing the reviewed identity policy and its tests. Published manifests must contain no repository-local dependency protocol.

### First publication record

The 55 first versions were published publicly to npm in deterministic dependency-first order from `2026-08-17T06:01:22.387Z` through `2026-08-17T12:51:26.867Z`. Publication was manual, one package at a time, with `--access public` and no explicit distribution tag, so npm selected `latest`. This exposed a temporarily incomplete package family; dependency ordering reduced installation risk but did not make the release atomic.

The initial preparation process required a clean complete build, a root `LICENSE` in every artifact, strict release-file policies, exact normalized filename parity for 53 matching upstream packages, and dedicated allowlists for the two public test-helper packages. Upstream parity was evidence for the namespace-only first release. It was deliberately removed as an ongoing invariant because a security-maintained fork must be able to diverge from upstream versions and artifacts.

`docs/releases/pkg-nec-initial-release-registry-evidence-2026-08-18.json` records the exact published name, version, registry timestamp, publication order, and npm SHA-512 integrity observed for all 55 packages on 2026-08-18. All 55 exact versions were still their packages' `latest` tags when that evidence was captured.

The ignored `.pkg-nec-release/release-ledger.json` present during this documentation review is not the publication ledger. It was generated after publication using the old schema-less format, records no source commit or runtime metadata, and only 27 of its 55 artifact integrities match the published registry bytes. Preserve it only as local preparation history; do not use it for registry verification, resumption, or provenance claims.

## Development environment setup

Use a supported shell and operating system that can run the repository toolchain. Follow the Node versions allowed by the root `engines` field and the package-manager version declared by the root manifest. Node `22.23.1` and Yarn `4.18.0` were used for the initial release evidence.

Prepare a new development session before other Yarn commands:

```bash
node --version
corepack enable
yarn install
yarn --version
```

For release-candidate work, also prove that the checked-in lock and cache are sufficient:

```bash
yarn install --immutable --immutable-cache
```

Start release preparation from the intended source commit with a clean worktree. The current preparer records `HEAD`, but it does not prove that uncommitted files are absent; maintainers must verify that boundary explicitly.

```bash
git status --short
git rev-parse HEAD
```

## Pull-request checks

Run the focused fork guardrails from the repository root:

```bash
yarn check:pkg-nec-identity
yarn test:pkg-nec-tooling
```

`check:pkg-nec-identity` validates the current manifests against the permanent identity policy, rejects stale or double-prefixed internal names, requires public publish metadata, validates exact exceptions, and rejects unapproved local dependency links. It is read-only.

`test:pkg-nec-tooling` covers identity auditing, candidate scanning, release-graph ordering, artifact construction and policy, ledger creation, registry retry and integrity behavior, package packing regressions, and declaration compatibility helpers. Neither command publishes packages or contacts the npm registry.

Run other focused build, lint, type, package, or E2E checks appropriate to the dependency change. Do not treat a broad snapshot update as a security fix, and do not infer cross-platform coverage from one local operating system. Use the CI platform matrix as release evidence.

## Dependency security maintenance

The dated baseline is `docs/security/npm-audit-baseline-2026-08-18.md`. The audit covers the complete Yarn workspace graph, including publishable packages, root development tooling, the website, examples, and transitive dependencies. An audit entry is not automatically a vulnerability in shipped Jest runtime code.

For each remediation:

1. Identify every affected locked version and dependency path.
2. Classify exposure as published runtime, published optional or peer behavior, build/release tooling, test/CI tooling, website, or example-only.
3. Prefer the smallest supported upgrade that removes the advisory without changing package identity.
4. Review release notes, engine changes, peer requirements, and lockfile changes.
5. Add or run focused tests at each affected runtime or tool boundary.
6. Re-run the audit and record remaining high or critical findings with an explicit rationale.
7. Bump every npm package whose published contents or metadata change. Never attempt to overwrite an existing exact npm version.

Yarn's `npmMinimalAgeGate` remains seven days. A newly published dependency normally must age for seven days before adoption. An urgent security release may use a narrow, reviewed exception that identifies the dependency and version, explains why waiting is riskier, limits the exception to the remediation, and restores the gate afterward.

Do not make the existing nonzero audit a merge gate without first choosing and documenting either a zero-high/critical policy or a reviewed no-regression policy with machine-readable exceptions.

## Release preparation

This workflow version is intentionally strict for the one-time full 55-package npm provenance release. It prepares, validates, publishes, and verifies the complete public package set. It is not a pull-request gate.

Run Node, npm, Corepack, and Yarn commands in Git Bash. In each fresh shell session, enable Corepack and install dependencies before running Yarn:

```bash
corepack enable
yarn install
```

Prepare the immutable local candidate explicitly:

```bash
yarn prepare:pkg-nec-release
```

The command:

1. removes generated build output;
2. runs `build:js`, `build:ts`, and `bundle:ts` through the complete `yarn build` pipeline;
3. audits current identities and publishability;
4. derives deterministic dependency-first order from current internal runtime dependencies;
5. packs every one of the 55 public workspaces without publishing;
6. validates each packed manifest against the current source manifest;
7. stages the root license and repacks without lifecycle scripts;
8. rejects prohibited source, configuration, cache, and unreachable declaration files;
9. calculates SHA-512 integrity from the final tarball bytes; and
10. atomically promotes the artifacts and schema-v1 ledgers into `.pkg-nec-release/`.

`yarn build:js` alone is not a release build. Preparation contacts no registry, compares against no upstream release, requires no npm credentials, and performs no registry mutation. If preparation fails, it does not promote a partial candidate and attempts to preserve the previous completed release directory. `.pkg-nec-release/` is ignored, disposable output: never commit its ledger, artifacts, journal, or registry evidence.

Do not hand-edit a partial ledger, and do not trigger this strict workflow with a partial GitHub Release. For a later release with only a few changed packages, first land a reviewed selective-release enhancement. That enhancement must compute the changed packages and their affected transitive internal dependents, show the resulting set, patch-bump only that set, choose its anchor, and prepare and validate that subset. Until it exists, a partial attempt is unsafe or validator-rejected; using the current workflow could instead over-release all 55 packages.

## Release identity and version anchor

Every release has one anchor package. The anchor package's new version determines both the Git tag and the GitHub Release name:

```text
<anchor-package>-v<new-version>
```

For example, a release anchored by `@pkg-nec/jest` at version `30.5.0` is named `@pkg-nec/jest-v30.5.0`. A release anchored by `@pkg-nec/jest-phabricator` at version `30.5.0` is named `@pkg-nec/jest-phabricator-v30.5.0`.

For the current one-time full release, the complete package set contains `@pkg-nec/jest`, so the anchor and exact Release tag/name are `@pkg-nec/jest-v30.4.3`. The validator requires all 55 entries and selects that anchor.

The following anchor rules are requirements for the later reviewed selective-release enhancement, not instructions to manually select a subset for the current workflow. Determine the anchor only after that enhancement calculates and displays the complete affected package set:

1. Start with every package changed since the previous release.
2. Propagate a version bump to every direct and transitive internal dependent of those packages. Continue until no additional internal dependent is affected. Use the internal `workspace:` relationships that participate in workspace versioning, including development dependencies.
3. If `@pkg-nec/jest` is affected directly or through propagation, use `@pkg-nec/jest` as the anchor.
4. Otherwise, use the first affected package in this fallback order:
   1. `@pkg-nec/create-jest`
   2. `@pkg-nec/jest-create-cache-key-function`
   3. `@pkg-nec/jest-environment-jsdom`
   4. `@pkg-nec/jest-environment-jsdom-abstract`
   5. `@pkg-nec/jest-phabricator`
   6. `@pkg-nec/jest-test-globals`

If several fallback packages are affected, their order above selects the anchor; the release name uses that anchor's new version. Do not bump `@pkg-nec/jest` solely to name a release when it is outside the affected set. If no package is affected, do not create a release. Those rules become operational only with the reviewed implementation that computes the changed package closure, patch-bumps exactly that closure, and prepares and validates its ledger.

Create the tag on the exact source commit used to build the published artifacts. The tag and GitHub Release name must match exactly.

## Release body and publication prerequisites

Before creating or publishing the GitHub Release, complete these external prerequisites. They are not performed by this code change or by local preparation:

1. Configure npm trusted publishing for each of the 55 `@pkg-nec` packages. Each trusted-publisher binding must use exactly:

   ```text
   GitHub organization: pkg-nec
   GitHub repository: jest
   Workflow filename: release.yml
   GitHub environment: npm-publish
   Allowed npm action: npm publish
   ```

2. Configure the protected GitHub environment named `npm-publish` in `pkg-nec/jest` with the required approval protection before publication. The workflow's `publish` job uses this environment and OIDC (`id-token: write`); approval must occur before it can use the trusted-publisher identity.

3. Confirm successful Node CI for the exact source commit on `main`, then create the tag and GitHub Release on that same commit. The validator checks both the `main` ancestry and that successful Node CI run.

For this full release, create a published GitHub Release with exact tag and Release name `@pkg-nec/jest-v30.4.3`. Its body must include the full source commit SHA and all 55 package/version lines. At the tagged source commit, generate the lines in Git Bash with:

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

For example, put the commit on its own line and then paste the command's complete output under a package-version heading:

```markdown
Source commit: `<full-40-character-SHA>`

## Published package versions

- `@pkg-nec/jest@30.4.3` ...all 55 generated lines...
```

Do not create a partial Release body as a workaround for a later selective release. The current workflow rejects a ledger that is not the full public inventory.

## Schema-v1 release ledger contract

Preparation writes:

- `.pkg-nec-release/release-ledger.json`, the machine-readable handoff contract;
- `.pkg-nec-release/release-ledger.md`, the human-readable review report;
- 55 final `.tgz` artifacts referenced by the ledger.

The schema-v1 ledger records generation time, source commit, Node version, package-manager version, and an ordered entry for each artifact. Each package entry contains its canonical name, current version, repository-relative tarball path, SHA-512 integrity, internal runtime prerequisites, one-based release order, and packed file inventory.

Treat a ledger and its tarballs as one immutable candidate. Do not edit the ledger to change a release. Re-run preparation after a source, version, dependency, build, or artifact-policy change. Archive the accepted ledger and publication evidence outside the ignored working directory according to the release process; `.pkg-nec-release/` is disposable local output, not durable provenance storage.

## Publication, verification, and provenance boundary

Publishing is performed only by `.github/workflows/release.yml`, after the GitHub Release is published. It has four jobs:

1. `validate` checks the tag, exact Release name and body, source commit, successful Node CI, all 55 patch transitions, and the complete candidate ledger; it uploads the immutable candidate.
2. `publish` waits for `npm-publish` approval, downloads that candidate, and runs `npm publish --provenance` in dependency-first ledger order.
3. `verify` checks the complete published batch against the exact ledger SHA-512 integrities.
4. `evidence` runs after successful validation even if publish or verify fails, and attaches the workflow summary, ledger, publication journal, and available registry evidence to the GitHub Release.

There are no serial post-publish waits between packages. A resumed publish first inspects the exact `name@version`: it can continue only when an already-present version has the ledger's exact SHA-512 integrity, recording it as `verified-existing`; any differing integrity is terminal and requires investigation. After publication, verification queries the public npm registry fairly in batches of at most eight under one shared 480-second deadline for the whole 55-package batch. It retries eligible visibility failures, writes per-package evidence on either success or failure, and treats authentication, authorization, malformed metadata, identity mismatch, and integrity mismatch as terminal.

If a job fails, do not publish tarballs manually and do not edit the ignored candidate or ledger. Review the GitHub Release attachments and job logs, resolve the cause, and re-run the Release workflow for the same tag only when every pre-existing package still matches its ledger integrity. The evidence attachment is the durable review record; local `.pkg-nec-release/` output is not. Do not add a new tag, create a second Release, or use a partial Release to resume the current strict full-release workflow.
