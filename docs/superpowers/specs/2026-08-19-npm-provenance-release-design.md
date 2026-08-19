# npm Provenance Release Workflow Design

**Date:** 2026-08-19  
**Status:** Approved for implementation planning

## Purpose

Add the first npm trusted-publishing workflow for the 55 public `@pkg-nec` Jest packages. The release will publish from a GitHub-hosted runner with npm provenance, give every public package exactly one patch-version bump, safely resume a partially completed publication, and avoid waiting for registry visibility between individual publishes.

This design adapts the proven single-package release workflow from [`pkg-nec/babel-plugin-istanbul`](https://github.com/pkg-nec/babel-plugin-istanbul/commit/29a23ba143fb6f5b989f54a878629e842fe639e4) to a dependency-ordered monorepo release. It preserves that workflow's GitHub Release trigger, protected environment, OIDC permission, immutable install, and explicit provenance publish while replacing its single-package tag/version logic.

## Current repository state

- The previous release tag is `@pkg-nec/jest-v30.4.2`.
- There are 55 public package workspaces and one private root workspace.
- `scripts/preparePkgNecRelease.mjs` already builds and packs all public workspaces in deterministic runtime-dependency order and produces schema-v1 JSON and Markdown ledgers.
- `scripts/waitForPkgNecRegistry.mjs` verifies one exact package version and SHA-512 integrity, but its per-package 480-second retry loop is unsuitable inside a 55-package publishing loop.
- There is no live publisher or trusted-publishing workflow.
- The public package manifests still identify `https://github.com/jestjs/jest.git`, which does not match the publishing repository required by npm trusted publishing.

## Commit review and version decision

The range `@pkg-nec/jest-v30.4.2..main` contains one runtime package change:

- `@pkg-nec/jest-reporters` now waits for non-watch desktop notification completion. Reporter hooks already allow `Promise<void> | void`, and the reporter dispatcher already awaits the hook. The change corrects the implementation to honor the existing contract, adds no public option, and requires no consumer migration. It is therefore a patch fix.

Two other packages have packaging-only changes:

- `@pkg-nec/jest-pattern` adds an `.npmignore`.
- `@pkg-nec/jest-snapshot-utils` adds an `.npmignore`.

All other changes in the range affect CI, documentation, identity/release tooling, tests of that tooling, or repository maintenance. They do not introduce package runtime features.

For the first provenance release, every public package receives exactly one patch bump regardless of whether its runtime changed. This makes every `name@version` new on npm and gives every package a provenance-backed release.

| Previous version | New version | Package count |
| --- | --- | ---: |
| `30.0.1` | `30.0.2` | 1 |
| `30.1.0` | `30.1.1` | 1 |
| `30.4.0` | `30.4.1` | 6 |
| `30.4.1` | `30.4.2` | 37 |
| `30.4.2` | `30.4.3` | 10 |

`@pkg-nec/jest` becomes `30.4.3`, so the anchor tag and GitHub Release name are `@pkg-nec/jest-v30.4.3`. The private root remains `0.0.0`. `lerna.json` moves to the anchor version `30.4.3`.

The version changes, internal dependency resolutions, repository metadata, and resulting `yarn.lock` changes are committed before the tag is created. The workflow never calculates, writes, commits, or tags versions.

## Trusted-publishing prerequisites

Before publishing the GitHub Release, an npm administrator must configure each of the 55 existing packages with the same trusted publisher:

- provider: GitHub Actions;
- organization: `pkg-nec`;
- repository: `jest`;
- workflow filename: `release.yml`;
- environment: `npm-publish`;
- allowed action: `npm publish`.

Every public manifest must use the repository URL `https://github.com/pkg-nec/jest.git` and retain its package-specific repository directory. The repository and packages are public, so npm trusted publishing can automatically create provenance attestations. The workflow will still pass `--provenance` explicitly to make the release intent auditable.

The GitHub repository must have an `npm-publish` environment with the desired reviewer protection. No long-lived npm publishing token is stored or passed to the workflow.

Current npm documentation requires npm CLI 11.5.1 or newer and Node 22.14.0 or newer for trusted publishing. The workflow uses a supported Node 24 release on a GitHub-hosted Ubuntu runner and asserts the npm CLI minimum before publication.

## Workflow trigger and concurrency

`.github/workflows/release.yml` runs for:

```yaml
on:
  release:
    types: [published]
```

The release tag from the event is the only source ref. The workflow does not publish from the moving `main` checkout.

Concurrency is keyed by the release tag, and `cancel-in-progress` is false. A duplicate invocation for the same tag waits instead of canceling a job that may already have mutated npm.

## Workflow architecture

### 1. Validate candidate

The validation job has `contents: read` and `actions: read`, but no OIDC or contents-write permission. It:

1. checks out the release tag with `persist-credentials: false` and sufficient history to validate ancestry;
2. resolves the tag to one immutable commit;
3. confirms the tagged commit is contained in `main`;
4. confirms the repository's Node CI workflow completed successfully for that commit;
5. parses the general `<anchor-package>-v<anchor-version>` tag format and confirms the anchor manifest has that exact version;
6. enables Corepack and performs an immutable install without a release dependency cache;
7. runs the permanent package-identity check, the focused pkg-nec tooling tests, and the complete release build;
8. prepares the release tarballs and schema-v1 ledgers;
9. confirms the ledger source commit equals the tag commit;
10. confirms all 55 public packages appear exactly once and each ledger name, version, tarball path, dependency order, manifest, repository URL, and SHA-512 integrity is valid;
11. confirms the GitHub Release body lists every ledger `name@version`; and
12. uploads the candidate tarballs and ledgers as one workflow artifact.

Validation performs no npm write. A validation failure ends the workflow before the protected environment is reached.

The first implementation is intentionally strict about the complete 55-package set because this is the all-package provenance release. The publisher and verifier consume the ledger generically, so a later reviewed change can teach preparation to select only an affected dependency closure without redesigning publication.

### 2. Publish candidate

The publishing job depends on candidate validation and uses the protected `npm-publish` environment. Its only permissions are `contents: read` and `id-token: write`.

The job downloads the candidate, re-resolves the release tag, and independently verifies:

- the tag commit;
- the ledger source commit;
- every tarball's SHA-512 integrity;
- every packed name, version, public access setting, and repository URL; and
- the dependency-first order.

It then processes ledger entries sequentially. For each entry:

1. Query `https://registry.npmjs.org/` for the exact `name@version`.
2. If the exact version exists and its name, version, and integrity equal the ledger, record `verified-existing` and continue.
3. If the exact version exists with different metadata or integrity, fail without publishing another package.
4. If the registry authoritatively returns not found, execute `npm publish <tarball> --access public --provenance --registry=https://registry.npmjs.org/` and record `published` when it succeeds.
5. If the preflight query fails for an indeterminate network, authentication, authorization, rate-limit, or server reason, fail rather than treating uncertainty as absence.
6. If publish reports that the exact version already exists, switch to exact-version verification. Continue only if the eventual registry integrity matches the ledger; otherwise fail.

The normal successful publish path never waits for public read visibility. As soon as one `npm publish` succeeds, the next ledger entry starts. npm does not require internal dependencies to be publicly retrievable before accepting the dependent package, while the dependency-first order still minimizes the incomplete-family window.

The publisher atomically updates a local JSON journal after every decision. An `if: always()` step uploads the journal even when a later package fails.

### 3. Verify complete release

The verification job begins only after the publishing loop succeeds. It has no OIDC permission.

It verifies every ledger entry against the public npm registry within one global 480-second deadline. The verifier maintains a bounded pool of concurrent registry queries, but schedules unresolved packages in fair rounds:

- every unresolved package receives one query opportunity per round;
- at most eight requests are active concurrently;
- retryable absence, network, timeout, rate-limit, and server responses remain unresolved until the next round;
- authentication, authorization, malformed metadata, name/version mismatch, and integrity mismatch fail immediately; and
- the deadline applies to the batch, not separately and serially to each package.

The result is a schema-versioned JSON evidence file with the source commit, release tag, package name, version, expected and observed integrity, publication disposition, attempts, elapsed time, and final classification for all 55 packages. A Markdown summary is generated for human review.

### 4. Record durable evidence

The final evidence job has `contents: write` but no OIDC permission. It runs with `if: always()` and obtains the available validation report, publication journal, and verification evidence.

On success, it attaches the machine ledger, human ledger, publication journal, registry evidence, and verification summary to the GitHub Release. On a partial publication failure, it attaches the partial journal and failure summary instead. The workflow remains failed until a rerun completes verification.

The ignored `.pkg-nec-release/` directory remains disposable local output. GitHub Release attachments are the durable evidence boundary for this workflow.

## Resumption semantics

npm publication is not atomic, so rerunning the same workflow run or the same release event must be safe.

- The tag, versions, candidate contents, and source commit never change during resumption.
- The candidate is rebuilt from the tag and must reproduce the same ledger contract before publication resumes.
- A matching existing exact version is skipped only after its registry integrity equals the rebuilt ledger.
- An existing exact version with different bytes is terminal and requires investigation; the workflow never increments versions automatically.
- A package that is absent is published in its original ledger position.
- Verification failures do not trigger duplicate publication on rerun because all matching exact versions are verified and skipped.
- Operators rerun the existing workflow. They do not create a replacement tag or edit package versions to mask a partial release.

## Release validation and notes

The single-package check `release tag == v<package.version>` is replaced with anchor validation:

1. Parse the release tag into an anchor package and anchor version.
2. Confirm the anchor is a public workspace and its manifest version matches.
3. Calculate the expected anchor from the complete selected set using the repository policy.
4. Confirm the parsed anchor is the expected anchor.
5. Confirm the Release name exactly equals the tag.

For this release, those rules produce `@pkg-nec/jest-v30.4.3`.

The GitHub Release body must identify the source commit and anchor and list every ledger `name@version`. Validation compares the generated ledger list to the Release body before the publish job can start. The release body may contain additional narrative, including the `jest-reporters` notification fix and packaging-only changes.

## Component boundaries

Implementation should keep the following responsibilities isolated:

- **Release validation module:** parses release/tag input, validates anchor and versions, checks the release body, and validates the candidate-to-source relationship. It has no registry-write capability.
- **Publisher module:** consumes a validated ledger plus injected registry-query and publish functions, applies strict resume decisions, and emits a journal. It does not build artifacts or mutate versions.
- **Batch verification module:** consumes a ledger and injected query/scheduling functions, applies the global deadline and fair bounded retries, and emits evidence. It has no publish capability.
- **CLI wrappers:** translate environment variables and command-line arguments into module calls and stable exit classifications.
- **Workflow:** supplies GitHub event data, permissions, environment protection, job ordering, and durable artifact transport. Release policy remains testable in JavaScript rather than embedded in large shell blocks.

Existing `scripts/pkgNec/registryVisibility.mjs`, `scripts/pkgNec/releaseGraph.mjs`, and `scripts/preparePkgNecRelease.mjs` remain the sources for registry classification, dependency order, and artifact preparation. Shared behavior should be extracted or extended rather than duplicated.

## Security controls

- Pin every third-party GitHub Action to a full commit SHA.
- Set `persist-credentials: false` for checkout.
- Disable package-manager caching in the release workflow.
- Use a GitHub-hosted runner; self-hosted runners are not eligible for this trusted-publishing design.
- Never set `NODE_AUTH_TOKEN` or write an npm publishing token.
- Scope `id-token: write` to the protected publish job only.
- Scope `contents: write` to the evidence job only.
- Reject a tag whose commit is not contained in `main` or whose Node CI did not pass.
- Revalidate candidate bytes after every workflow-artifact transport boundary.
- Treat malformed registry responses and integrity mismatches as fatal.
- Redact credentials and authorization-like values from errors and evidence.
- Never cancel an in-progress publication for a duplicate workflow invocation.

## Failure behavior

| Failure point | Registry effect | Recovery |
| --- | --- | --- |
| Tag, CI, release-body, version, build, or ledger validation | None | Correct the release metadata when allowed, or create a new reviewed source commit and release if source changes are required. |
| Protected-environment approval rejected or timed out | None | Rerun and obtain approval. |
| Preflight registry query indeterminate | None for the current package | Rerun after the registry or network recovers. |
| Publish fails before npm accepts the package | Earlier packages may exist | Rerun; matching earlier versions are verified and skipped. |
| Publish response is ambiguous or reports an existing version | Unknown until verified | Verify the exact version and accept only matching integrity. |
| Post-publish verification times out | All publish commands completed | Rerun; the publish job verifies and skips existing versions, then verification repeats. |
| Registry integrity mismatch | Potential supply-chain incident | Stop and investigate. Do not republish or bump automatically. |
| Evidence attachment fails | Packages may be fully published | Rerun to reconstruct, verify, and attach evidence. |

## Testing strategy

Development follows focused test-driven changes. Tests will cover:

- general anchor tag parsing and malformed tags;
- the `@pkg-nec/jest-v30.4.3` first-release anchor;
- exact one-patch version transitions for all four current version groups;
- root/private-workspace exclusion;
- repository URL and packed-manifest validation;
- release-body package-list validation;
- source/tag/ledger commit mismatch rejection;
- dependency-first iteration;
- absent version leading to publish;
- matching existing version leading to `verified-existing`;
- mismatched existing integrity rejection;
- indeterminate preflight failure never leading to publish;
- publish success moving immediately to the next package without a visibility wait;
- version-conflict recovery through exact verification;
- atomic journal updates and partial journal recovery;
- a global batch deadline rather than 55 serial deadlines;
- fair round-robin retries with at most eight concurrent registry requests;
- immediate fatal handling for authentication and integrity errors;
- complete success and partial-failure evidence formats; and
- workflow permissions, trigger, environment, concurrency, action pinning, and job dependencies.

Verification will use the repository's focused build, pkg-nec tooling tests, identity check, workflow/YAML validation, and formatting/lint commands appropriate to changed files. The monolithic `yarn test` command will not be run by Codex. All local Node, npm, Corepack, and Yarn commands will run through Git Bash; before any Yarn command, the session will run `corepack enable` and `yarn install` as requested.

## Expected file scope

- `.github/workflows/release.yml`
- `package.json`
- `lerna.json`
- `yarn.lock`
- all 55 public `packages/*/package.json` manifests
- `scripts/validatePkgNecRelease.mjs`
- `scripts/publishPkgNecRelease.mjs`
- `scripts/verifyPkgNecRelease.mjs`
- `scripts/pkgNec/releaseValidation.mjs`
- `scripts/pkgNec/releasePublisher.mjs`
- `scripts/pkgNec/releaseVerification.mjs`
- `scripts/__tests__/validatePkgNecRelease.test.js`
- `scripts/__tests__/publishPkgNecRelease.test.js`
- `scripts/__tests__/verifyPkgNecRelease.test.js`
- `docs/pkg-nec-maintenance.md`
- `CONTRIBUTING.md`

## Operator runbook

1. Merge the reviewed workflow, tooling, manifest, lockfile, and documentation changes into `main`.
2. Wait for Node CI to succeed on that exact commit.
3. Configure all 55 npm trusted publishers with the exact workflow and environment identity.
4. Create a GitHub Release named `@pkg-nec/jest-v30.4.3`, targeting that exact commit and using the same tag name.
5. Include the anchor, source commit, all 55 `name@version` entries, and release narrative in the body.
6. Publish the GitHub Release.
7. Review the validation job and approve the `npm-publish` environment.
8. Monitor sequential publication, batch verification, and evidence attachment.
9. If the run fails after any registry mutation, rerun it unchanged and allow strict resumption to reconcile npm state.
10. Treat the workflow as complete only when all packages verify and the final evidence is attached to the GitHub Release.

## References

- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
- [npm provenance statements](https://docs.npmjs.com/generating-provenance-statements/)
- [GitHub Actions: publishing Node.js packages](https://docs.github.com/en/actions/tutorials/publish-packages/publish-nodejs-packages)
- [`pkg-nec/babel-plugin-istanbul` provenance workflow commit](https://github.com/pkg-nec/babel-plugin-istanbul/commit/29a23ba143fb6f5b989f54a878629e842fe639e4)
