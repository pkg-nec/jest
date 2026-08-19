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

Prepare a release candidate explicitly; this is not a pull-request gate:

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

`yarn build:js` alone is not a release build. Preparation contacts no registry, compares against no upstream release, requires no npm credentials, and performs no registry mutation. If preparation fails, it does not promote a partial candidate and attempts to preserve the previous completed release directory.

The command currently prepares all 55 packages. That was appropriate when every scoped name was new. For a later live release, calculate the affected dependency closure and release anchor using the policy below, and publish only the selected affected set. Do not feed unchanged existing `name@version` entries to a publisher or assume a freshly rebuilt unchanged artifact will reproduce historical registry bytes.

## Release identity and version anchor

Every release has one anchor package. The anchor package's new version determines both the Git tag and the GitHub Release name:

```text
<anchor-package>-v<new-version>
```

For example, a release anchored by `@pkg-nec/jest` at version `30.5.0` is named `@pkg-nec/jest-v30.5.0`. A release anchored by `@pkg-nec/jest-phabricator` at version `30.5.0` is named `@pkg-nec/jest-phabricator-v30.5.0`.

Determine the anchor after calculating the complete affected package set:

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

If several fallback packages are affected, their order above selects the anchor; the release name uses that anchor's new version. Do not bump `@pkg-nec/jest` solely to name a release when it is outside the affected set. If no package is affected, do not create a release.

Create the tag on the exact source commit used to build the published artifacts. The tag and GitHub Release name must match exactly.

## Release notes

Every GitHub Release must identify the anchor package and source commit and list every affected package with its new version. Unchanged packages do not need to appear. For a bootstrap release that publishes the complete package set, list every published package and version.

Use an explicit package-version section such as:

```markdown
## Affected package versions

- `@pkg-nec/jest@30.5.0`
- `@pkg-nec/jest-core@30.5.0`
- `@pkg-nec/jest-runtime@30.5.0`
```

## Schema-v1 release ledger contract

Preparation writes:

- `.pkg-nec-release/release-ledger.json`, the machine-readable handoff contract;
- `.pkg-nec-release/release-ledger.md`, the human-readable review report;
- 55 final `.tgz` artifacts referenced by the ledger.

The schema-v1 ledger records generation time, source commit, Node version, package-manager version, and an ordered entry for each artifact. Each package entry contains its canonical name, current version, repository-relative tarball path, SHA-512 integrity, internal runtime prerequisites, one-based release order, and packed file inventory.

Treat a ledger and its tarballs as one immutable candidate. Do not edit the ledger to change a release. Re-run preparation after a source, version, dependency, build, or artifact-policy change. Archive the accepted ledger and publication evidence outside the ignored working directory according to the release process; `.pkg-nec-release/` is disposable local output, not durable provenance storage.

## Publication, verification, and provenance boundary

This repository intentionally has no live publish command or trusted-publishing workflow. The first release's manual direct-to-`latest` procedure is historical evidence, not the current release runbook.

Before the next npm release, a separately reviewed publisher must implement and enforce:

- the affected package selection and version-bump policy defined above;
- a clean source commit matching the ledger;
- artifact and ledger integrity before publication;
- rejection or verified resumption of an already existing exact version;
- dependency-first publication of the selected set;
- npm trusted publishing, OIDC permissions, and provenance generation;
- package `repository` metadata matching the public `pkg-nec` publishing repository;
- post-publish visibility and integrity checks;
- durable release evidence and failure/resumption handling.

Post-publish verification uses a selected schema-v1 ledger entry:

```bash
yarn check:pkg-nec-registry <ledger-path> <package-name>
```

The verifier pins queries to `https://registry.npmjs.org/`, checks the exact name, version, and SHA-512 integrity, and has a 480-second overall deadline. It retries eligible not-found, network, timeout, rate-limit, and retryable server failures. Authentication, authorization, malformed metadata, name/version mismatch, and integrity mismatch are terminal. This command contacts npm and belongs after publication, not in pull-request CI or release preparation.
