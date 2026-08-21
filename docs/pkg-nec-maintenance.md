# Maintaining the `@pkg-nec` Jest Fork

This is the canonical guide for the independently maintained `@pkg-nec/jest` fork. It records the completed namespace migration and first npm publication, then defines the durable identity, security-maintenance, release-preparation, and publication boundaries. Historical plans and the one-time migration procedure are not operational runbooks.

## Source-of-truth hierarchy

Use the following sources in this order:

1. Current package manifests define versions and dependency specifications.
2. `scripts/pkgNec/packageIdentityPolicy.json` defines durable workspace paths, historical upstream names, canonical `@pkg-nec` names, and publishability.
3. `scripts/pkgNec/releaseImpactPolicy.json` defines reviewed root-file impact classifications.
4. `yarn check:pkg-nec-identity` enforces current structural identity rules and exact exceptions.
5. A committed schema-v1 plan under `docs/releases/` defines one selective release and its exact package transitions.
6. A schema-v2 release ledger binds one prepared candidate to the committed plan's path and digest.
7. Git history preserves the removed one-time migration implementation and its design decisions.

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

Start release planning from a clean worktree synchronized with `origin/main`. The planner verifies this boundary itself after fetching `origin/main` and tags, but maintainers should also inspect it explicitly.

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

Selective release preparation is a reviewed two-stage operation. The planner is read-only by default; `--apply` writes the exact version transitions and permanent plan that a dedicated release-preparation pull request will carry. Planning and preparation have no npm credentials and cannot publish.

Run Node, npm, Corepack, and Yarn commands only in Git Bash. In each fresh Git Bash session, enable Corepack and install dependencies before any Yarn command:

```bash
corepack enable
yarn install
```

### Start from synchronized `main`

Begin with no tracked or untracked changes and synchronize `main` by fast-forward only:

```bash
git switch main
git pull --ff-only origin main
git status --short
```

`git status --short` must print nothing. Create a dedicated release-preparation branch at that commit. The branch name is not part of the release contract:

```bash
git switch -c release/pkg-nec-selective
```

The planner accepts only this interface:

```text
yarn plan:pkg-nec-release [--bump <name>=patch|minor|major] [--root-impact=all|none] [--apply]
```

It fetches `origin/main` and tags, then requires a clean worktree and requires `HEAD` to equal the freshly fetched `origin/main`. It identifies the newest non-draft, non-prerelease GitHub Release whose tag, successful `release.yml` run, ledger, journal, registry evidence, provenance evidence, and workflow summary agree. For a schema-v2 selective ledger, baseline discovery also derives the exact plan asset name from the tag, downloads that copied asset, verifies its SHA-256 against `ledger.releasePlan.digest`, validates its schema, path, and anchor tag, and requires its ordered package/version list to equal the ledger. Historical schema-v1 ledgers remain eligible without a plan asset. That completed Release is the change-detection baseline; the nearest Git tag is not a substitute.

### Preview and apply the plan

Preview first. This example requests a minor bump for a selected package and records that ambiguous root changes have no package impact:

```bash
yarn plan:pkg-nec-release --bump '@pkg-nec/jest-reporters=minor' --root-impact=none
```

Read-only mode prints canonical plan JSON followed by a dependency-first package table. Review the changed-file classifications, root-impact decision, direct and dependent reasons, versions, anchor, tag, and plan path. If the preview is correct, repeat exactly the same choices with `--apply`:

```bash
yarn plan:pkg-nec-release --bump '@pkg-nec/jest-reporters=minor' --root-impact=none --apply
```

`--apply` validates the complete result before one guarded promotion. It changes only:

- the `version` field in every selected package manifest;
- one new canonical `docs/releases/*-plan.json`; and
- the one-time `lerna.json` `version` change to `"independent"`, if it has not already occurred.

It does not change internal `workspace:*` dependency ranges, other manifest fields, source files, or `yarn.lock`. After a failed guarded promotion, the planner restores original files and removes owned temporary or backup siblings only when its ownership and preimage checks prove every rollback action safe. When safe rollback cannot be proved, it preserves foreign objects and may leave already promoted targets and still-identifiable recovery backup siblings in place rather than risk overwriting or deleting them. The command exits unsuccessfully and prints cleanup errors and the exact paths of any recovery backups it can still identify. Those paths are recovery candidates, not authoritative originals: stop, preserve and inspect the reported targets and backups, and resolve their state manually; do not blindly rerun the planner or delete or restore any reported path. `.pkg-nec-release/` is ignored disposable workflow output and is never created by the planner or committed.

### Selection and version rules

Any changed file inside a public package directory directly selects that package. Selection then includes every direct and transitive public internal dependent connected through a `workspace:` entry in `dependencies`, `optionalDependencies`, `peerDependencies`, or `devDependencies`. Private workspaces never enter the release set. The final package list is in deterministic dependency-first order, and dependent reasons include the propagation paths from direct selections.

Every selected package defaults to a patch bump. Repeat `--bump '<name>=patch|minor|major'` to override a directly selected or dependent-only package. Unknown, private, unselected, duplicate, or malformed overrides fail before writes. Minor and major overrides use standard SemVer increments; selected dependents remain patch unless explicitly overridden.

Root changes follow the reviewed policy in `scripts/pkgNec/releaseImpactPolicy.json`:

- known no-impact inputs do not select packages;
- known all-package inputs always select every public package and cannot be overridden; and
- unmatched or otherwise ambiguous inputs require `--root-impact=all` or `--root-impact=none`.

`all` makes ambiguous inputs select every public package. `none` ignores only those ambiguous inputs; package-directory changes still select their package and dependents. If no ambiguous input exists, a supplied root flag is informational and has no effect; when a release plan is produced, it records the request with an applied value of `not-needed`. After every supplied bump override has passed validation, no new commits, only no-impact changes, or ambiguous-only changes resolved to `none` make the command print exactly `no releasable package changes`, exit successfully, and write nothing even when `--apply` is present. An unknown, private, unselected, duplicate, or malformed override fails instead of producing the no-change outcome. Without a required root decision, the planner lists every ambiguous path and fails without writing.

### Permanent plan and release-preparation pull request

The schema-v1 plan permanently records the completed baseline tag and commit, the pre-apply `preparedFrom` commit, changed files and root decision, calculated anchor/tag/path, and the selected dependency-first package list with exact old/new versions, bump types, and reasons. `preparedFrom` is the synchronized `main` commit used for calculation; it is not the later release source commit that introduces the plan and bumped manifests on `main`.

The release-preparation pull request must contain only:

- exactly one newly added canonical plan named by `plan.planPath`;
- only the `version` field changes for every and only `plan.packages`; and
- only the one-time `lerna.json` `version: "independent"` transition when applicable.

Do not combine source, documentation, dependency, lockfile, workflow, or configuration changes with this pull request. Do not hand-edit generated selection, reasons, order, versions, anchor, tag, filename, or JSON formatting. Inspect the exact generated scope before committing:

```bash
git status --short
git diff --check
git diff --stat
git diff -- package.json lerna.json yarn.lock .github/workflows/nodejs.yml .github/workflows/release.yml
```

Stage and commit the entire generated set together: the one plan, every selected manifest version change, and the optional one-time Lerna transition must all be introduced by exactly one non-merge commit in the pull request range. Before review or merge, squash any plan-first, versions-first, or later fixup commits into that one generated commit. CI rejects split generated histories even when their aggregate diff is otherwise valid. With one atomic generated commit, GitHub's merge-commit, squash, and rebase merge strategies each leave a valid full-set plan-introduction source on `main`.

Node CI treats an ordinary pull request with no new plan normally. When it finds a new plan, `validate:pkg-nec-release-plan` captures one immutable `HEAD`, requires `plan.preparedFrom` to equal the pull request base commit, reads Git objects rather than trusting the working tree, independently recalculates classifications, dependent closure, order, SemVer transitions, anchor, tag, and filename, compares canonical plan bytes, and enforces the restricted diff and atomic history above. Existing `docs/releases/*-plan.json` files are permanent and immutable: any pull request, including an ordinary pull request, fails CI if it modifies the bytes, deletes or renames a plan, changes its file mode or type, or changes path casing.

If `origin/main` advances before the release-preparation pull request is ready, do not resolve conflicts by editing the plan or manifests. Recover according to whether the generated output has been committed.

If the `--apply` output is still uncommitted, take the exact plan path and selected manifest paths from the preview. If those files were staged, first unstage only those paths. Then delete only the generated plan and restore only the generated manifest and Lerna edits:

```bash
git restore --staged -- docs/releases/<tag>-plan.json packages/<selected>/package.json lerna.json # only if staged
rm -- docs/releases/<tag>-plan.json
git restore --worktree -- packages/<selected>/package.json lerna.json
git status --short
```

Repeat the selected manifest argument for every entry in `plan.packages`; restoring `lerna.json` is harmless when `--apply` did not change it. `git status --short` must print nothing. Only then update the base branch:

```bash
git fetch origin main:refs/remotes/origin/main --tags
git rebase origin/main
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
```

If the generated-only preparation was committed, preserve the stale branch rather than resetting it or rebasing a dirty worktree. Rename it as a backup, then create a fresh preparation branch at the fetched `origin/main`:

```bash
git fetch origin main:refs/remotes/origin/main --tags
git branch -m release/pkg-nec-selective-stale
git switch -c release/pkg-nec-selective origin/main
git status --short
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
```

Use branch names appropriate to the release, and retain the stale backup until the regenerated pull request is reviewed. In either path, `git status --short` must print nothing and the commit comparison must succeed before rerunning preview and `--apply` with the reviewed flags. After regeneration, inspect that the worktree diff contains exactly one plan, only selected manifest version edits, and the optional Lerna transition, then commit that complete set atomically. If the old branch contains anything beyond the allowed generated set, move that work to a separate pull request. CI will reject a stale `preparedFrom`, mixed diff, or split generated history.

After review and green CI, merge the release-preparation pull request. Synchronize local `main` again and identify the full commit on `main` that first introduced the plan. That plan-introduction commit contains the unchanged plan and bumped manifests while its first parent does not contain the plan. It is the only valid release source and tag target, even if later commits reach `main`; later changes belong to the next release.

The plan is immutable once merged into the release lineage. Correct a plan only by regenerating it before merge; never edit a merged plan in place or reuse its tag for different bytes.

## Release identity and manual GitHub Release creation

Every release has one calculated anchor. If selected, `@pkg-nec/jest` is the anchor. Otherwise, the planner uses the first selected entry from this fixed fallback order:

1. `@pkg-nec/create-jest`
2. `@pkg-nec/jest-create-cache-key-function`
3. `@pkg-nec/jest-environment-jsdom`
4. `@pkg-nec/jest-environment-jsdom-abstract`
5. `@pkg-nec/jest-phabricator`
6. `@pkg-nec/jest-test-globals`

The anchor's `toVersion` determines both `plan.anchor.tag` and `plan.planPath`. Do not bump `@pkg-nec/jest` only to name a release.

Draft-Release automation is not present yet; this pull request does not provide a `yarn draft:pkg-nec-release` command. Until automation lands, create and review the draft manually in GitHub using only the committed plan:

1. Confirm that Node CI from a `push` to `main` succeeded for the exact plan-introduction commit.
2. Choose `plan.anchor.tag` as the exact new tag, target it at the full plan-introduction commit, and use the same `plan.anchor.tag` as the exact Release title/name. Do not target `preparedFrom` or a later `main` commit, and do not mark the Release as a prerelease.
3. Build the body from the committed plan. Include the full plan-introduction commit and exactly one Markdown-code-spanned `<name>@<toVersion>` token for each entry in `plan.packages`, with no duplicate or extra complete package token:

   ```markdown
   Source commit: `<full-plan-introduction-commit>`

   ## Published package versions

   - `@pkg-nec/package-a@1.2.4`
   - `@pkg-nec/package-b@2.0.0`
   ```

   Replace the example rows with every and only planned package, preferably in plan order. Narrative prose is allowed, but it must not add another valid code-spanned `@pkg-nec/name@semver` token.

4. Save the Release as a draft, then independently recheck the tag, exact target commit, Release title, full source commit in the body, package/version set, and that prerelease remains false against the committed plan.
5. Keep it as a draft until a maintainer deliberately publishes the reviewed Release as stable, with `draft=false` and `prerelease=false`. Publishing triggers `.github/workflows/release.yml`; saving or editing the draft does not publish npm packages.

The workflow's first validation step rejects any draft or prerelease event before candidate preparation, release metadata or network validation, and npm publication. A prerelease cannot become a completed baseline, so never publish this Release as a prerelease and attempt to promote it later. The validator then requires the release event commit, resolved tag, checkout `HEAD`, ledger source commit, and plan-introduction commit to be the same full commit on `origin/main`. It also requires the committed plan bytes and digest, exact tag-derived plan path, exact Release title, exact package set, planned order and prerequisites, manifest transitions, and a successful Node CI run for that commit.

## Trusted publisher and protected environment prerequisites

All selected packages must already have an npm trusted-publisher binding with exactly:

```text
GitHub organization: pkg-nec
GitHub repository: jest
Workflow filename: release.yml
GitHub environment: npm-publish
Allowed npm action: npm publish
```

The protected GitHub environment must be named `npm-publish` and retain its required reviewers. Only the workflow's protected `publish` job has `id-token: write`; validation, planning, and draft creation have no npm write capability. After `validate` succeeds, an authorized reviewer approves the `npm-publish` deployment. The workflow then uses npm trusted publishing and `npm publish --provenance`; do not provide a long-lived npm token or publish manually.

## Selective candidate, publication, and evidence

The release workflow rebuilds the complete repository but packs only `plan.packages`, in dependency-first plan order. Preparation copies the exact committed plan bytes into ignored `.pkg-nec-release/` output and writes a schema-v2 ledger whose `releasePlan` contains that plan's path and SHA-256 digest. The ledger contains only selected artifacts and only selected internal prerequisites. Packed `workspace:*` dependencies must resolve to the planned version for another selected package or the existing published version for an unselected package.

The four workflow jobs are:

1. `validate` binds the event, tag, plan-introduction commit, plan, selected manifests, Release metadata, and successful Node CI; it builds and uploads the immutable candidate without npm mutation.
2. `publish` waits for protected-environment approval, then publishes selected tarballs sequentially in ledger order with provenance and a durable journal.
3. `verify` checks every ledger artifact's exact public npm integrity and provenance under one shared 480-second batch deadline with at most eight active registry queries.
4. `evidence` runs after successful validation even if publication or verification fails and attaches the workflow summary, committed plan, JSON and Markdown ledgers, journal, and available registry-integrity and provenance evidence to the GitHub Release.

The live log reports `published` only after a fresh publish is durably journaled and `verified-existing` only after an already-present exact version matches ledger integrity. The Actions summary derives totals from the selected ledger and durable journal rather than assuming a fixed package count.

Registry integrity and provenance are separate requirements. Every selected package must match the ledger's SHA-512 tarball integrity and must have a valid Sigstore bundle and transparency-log proof whose package artifact, public `pkg-nec/jest` repository, `release.yml` workflow, exact release tag ref, source commit, GitHub-hosted public build environment, SLSA provenance, and npm publish attestation all match. Package or attestation absence, timeouts, rate limits, and registry server failures retry only while the shared deadline remains. An invalid signature, malformed bundle, integrity or identity mismatch, or unexpected repository, workflow, tag, source, runner, public visibility, provenance, or publish-attestation claim is immediately fatal.

## Unresolved state and recovery

The planner refuses a new plan when it finds a tracked plan without a matching completed publication, an invalid or publication-mismatched plan, a later draft or prerelease, an unmatched non-historical tag, an incomplete published Release, a failed or in-progress release workflow, or any package version change not explained by a completed Release. It reports the available plan path, tag, versions, draft URL, and workflow URL and requires manual investigation. Do not delete or rewrite remote state merely to make planning pass.

Merging the atomic release preparation commits the repository to completing that exact planned release. Create and publish the stable GitHub Release at the exact plan-introduction commit through the manual draft/publish steps above. If publication or verification does not complete, keep the plan, versions, tag, Release, candidate, and journal, resolve the reported cause, and re-run the same Release workflow for the same tag. Existing package versions resume only when their exact ledger integrity matches; they are recorded as `verified-existing`, and the remaining planned packages continue in order.

If completion cannot proceed, manual investigation is required and later release preparation remains blocked while the state is unresolved. There is no supported abort, rollback, plan deletion, replacement plan/tag/Release, or emergency workflow. Never edit the plan/candidate/ledger/journal, manually publish tarballs, or substitute a manual publication for missing provenance. A permanent integrity or provenance inconsistency remains unresolved and blocks later release planning. The GitHub Release attachments and workflow logs are the durable review record; local `.pkg-nec-release/` output is disposable and must never be committed.
