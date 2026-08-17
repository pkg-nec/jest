# Rebrand an Upstream Jest Monorepo for `@pkg-nec`

Use this guide to produce the initial public `@pkg-nec` release from an upstream Jest monorepo. Treat package identity as one system: source text, manifests, generated artifacts, fixtures, locks, configuration, and release order must agree.

## Release invariants

Keep the upstream version of every package. Retain every published-manifest and third-party dependency, peer, optional-dependency, devDependency, resolution, engine, and lockfile range exactly. Rewrite only internal package identity names and identity keys; preserve every protocol and range, including `workspace:*`. The only exception is the four repository-only, unpublished E2E fixture local-link declarations in the fixture table below. Never place those local links in published package metadata. Do not combine this identity migration with security upgrades, substitutions, or range changes; perform them in a later release.

Publish the 55 release workspaces, including public `@pkg-nec/jest-test-globals` and `@pkg-nec/jest-test-utils`. Keep the root workspace, website, and examples unpublished.

## Establish the package-identity map

Build one deterministic map of 56 identities before rewriting: the root plus 55 package workspaces. For an external package `@jest/foo`, map it to `@pkg-nec/jest-foo`. For every unscoped package in the 55-workspace release set, map it to `@pkg-nec/<original-name>`. Apply the sole root exception: map `@jest/monorepo` to `@pkg-nec/monorepo`, not `@pkg-nec/jest-monorepo`. Preserve third-party identities. Record reserved aliases and singleton modules as explicit exceptions.

Generate 56 unique canonical names from these rules and fail the identity audit if a mapped identity has no canonical name. Publish exactly the 55 package workspaces; keep root, website, and examples unpublished. Make the generated map the only authority; do not derive names ad hoc at individual call sites.

## Apply the migration in stages

Use an inventory, rewrite, audit, build/test, and publish-readiness sequence. Keep the rewrite operation separate from the audit operation.

| Stage | Required gate |
| --- | --- |
| Inventory and map | Enumerate every surface and generate the unique 56-identity map (root plus 55 package workspaces) and exception list; publish only the 55 package workspaces. |
| Rewrite | Apply the approved map once to each eligible candidate. |
| Audit | Require a clean stale-identity audit apart from named compatibility literals. |
| Build and test | Require the commands below and classify every failure before proceeding. |
| Publish readiness | Require preserved ranges, valid locks, and dependency-first registry visibility. |

Do not run a non-idempotent migration application a second time on an already rebranded tree. A second pass can double-prefix names or corrupt reserved inputs. After the initial application, run only the check/audit command until a deliberately reviewed mapping change requires a fresh, controlled application.

### Rewrite surfaces

Rewrite all of the following with the canonical map:

- JavaScript and TypeScript import, export-from, dynamic import, `require`, mock, unmock, deep-module, and type-only module strings.
- Jest mock call chains, including chained calls and patterns that spread `jest.requireActual(...)` into a mock result.
- `dependencies`, `devDependencies`, `peerDependencies`, optional dependencies, resolutions, and any other manifest dependency fields, while retaining their version ranges.
- JSON and JSONC compiler `types` entries and other type-reference arrays.
- Configuration defaults, presets, resolver defaults, and serialized configuration values that represent a package identity.
- Documentation, snippets, README text, examples, sample applications, and E2E fixture sources.
- Root and nested lockfiles, workspace link metadata, build scripts, release scripts, and generated package metadata.
- Package-name exceptions, singleton/module maps, and Babel hoist globals.

Review quoted strings by meaning, not spelling. `testEnvironment: 'node'`, an environment short name, a CLI option, and a package identity are different categories even when they appear near each other.

## Use automation as a candidate generator and auditor

Automate lexical JS/TS module-string candidates, including chained Jest mock calls and spread `jest.requireActual` expressions. Automate JSONC compiler type entries, selected fixture-manifest consistency checks, documentation/sample string candidates, and a stale-identity audit that fails on disallowed upstream package literals.

Make the audit category-aware: it should identify the file, the literal, and the applicable mapping or approved exception. It must not rewrite broad prose or configuration values merely because they contain `jest`.

Automation does not replace engineering review for these areas:

| Area | Why a human review is required |
| --- | --- |
| Defaults and reserved aliases | A string such as `testEnvironment: 'node'` is an API value, not a package name. Changing it can alter default resolution. |
| Older third-party environments | Compatibility depends on the external adapter's runtime API assumptions, not just its dependency text. |
| Build special cases | Build tooling may consume names as paths, entrypoint labels, generated metadata, or external module declarations. |
| Test snapshots | Snapshots encode user-visible names and platform formatting; update only after verifying the intended observable behavior. |
| Locks and links | The root and fixture dependency graphs have different policies; a mechanical replacement can publish an invalid range or leave an unusable fixture. |

## Bridge legacy `@jest/globals` inside the test runner

Use `moduleNameMapper` only at the `@fast-check/jest` development-test boundary. Configure exactly:

```js
const moduleNameMapper = {
  '^@jest/globals$':
    '<rootDir>/packages/jest-runtime/src/__tests__/test_root/MappedGlobals.js',
};
```

Make `packages/jest-runtime/src/__tests__/test_root/MappedGlobals.js` contain exactly this bridge contract: `module.exports = require('@pkg-nec/jest-globals');`. A bare `require` is insufficient because the adapter must receive the exported globals object. This is not a compatibility package and is not published behavior.

Do not map the old literal directly to a physical `@pkg-nec/jest-globals` entrypoint. Direct entrypoint mapping bypasses the bridge boundary where the runtime installs and shapes synthetic globals, so it can produce the wrong behavior for an adapter that expects Jest's globals contract.

`moduleNameMapper` runs only while Jest resolves modules for a test. It cannot redirect Node's resolver, npm or Yarn installation/link resolution, TypeScript compilation, published package dependency resolution, or runtime configuration resolution outside that test-runner lookup. Keep manifests, type references, locks, and runtime configuration canonical; never rely on the mapper to repair them.

## Fixture policy before the initial packages are available from the registry

Use local `link:` only in an E2E fixture manifest for a canonical package unavailable from the registry. Do not put `link:` in a published package manifest and do not change a published package range.

| Fixture | Required manifest entry | Lock action |
| --- | --- | --- |
| `e2e/global-setup` | `@pkg-nec/jest-util: link:../../packages/jest-util` | Regenerate its nested lock with `yarn install --mode=update-lockfile`, then run `yarn install --immutable --immutable-cache`. |
| `e2e/global-teardown` | `@pkg-nec/jest-util: link:../../packages/jest-util` | Regenerate its nested lock with `yarn install --mode=update-lockfile`, then run `yarn install --immutable --immutable-cache`. |
| `e2e/transform/transform-environment` | `@pkg-nec/jest-environment-node: link:../../../packages/jest-environment-node` | Manifest only; this fixture has no nested lock. |
| `e2e/transform/transform-runner` | `@pkg-nec/jest-environment-node: link:../../../packages/jest-environment-node` | Manifest only; this fixture has no nested lock. |

During migration, run `yarn install --mode=update-lockfile` only from `e2e/global-setup` and `e2e/global-teardown`, after converting their manifests. Do not regenerate a lock during validation. During validation, run only `yarn install --immutable --immutable-cache` against each checked-in nested lock.

## Validate with Git Bash and Node 22

Run the following from the monorepo root in Git Bash. Use the installed Node manager to select local Node `22.23.1`; do not hardcode a user-specific NVM directory. Confirm the selected version before enabling Corepack or Yarn.

```bash
# Select Node 22.23.1 with the local Node manager, then:
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

Use a package directory pattern with a trailing slash. `jest` can prefix-match `jest-*`; `packages/$pkg/` selects the intended package directory.

```bash
test_package() {
  local pkg="$1"
  yarn jest --listTests --testPathPatterns="packages/$pkg/" --color
  yarn jest --testPathPatterns="packages/$pkg/" --color
}
test_package jest-core

test_package_vm() {
  local pkg="$1"
  NODE_OPTIONS="--experimental-vm-modules --no-warnings" yarn jest --listTests --testPathPatterns="packages/$pkg/" --color
  NODE_OPTIONS="--experimental-vm-modules --no-warnings" yarn jest --testPathPatterns="packages/$pkg/" --color
}
test_package_vm jest-runtime
```

Add `--passWithNoTests` only after the `--listTests` invocation proves that the selected package has zero tests. Never use it to hide a pattern error or unexpected test discovery failure.

Build JavaScript before running E2E children, because those children consume built package output:

```bash
(cd e2e/global-setup && yarn install --immutable --immutable-cache && node ../../packages/jest-cli/bin/jest.js --env=@pkg-nec/jest-environment-node --globalSetup=./setup.js --testPathPatterns=__tests__ --runInBand --no-cache)
(cd e2e/global-teardown && yarn install --immutable --immutable-cache && node ../../packages/jest-cli/bin/jest.js --env=@pkg-nec/jest-environment-node --globalTeardown=./teardown.js --testPathPatterns=__tests__ --runInBand --no-cache)
(cd e2e/transform/transform-environment && node ../../../packages/jest-cli/bin/jest.js --no-cache --runInBand)
(cd e2e/transform/transform-runner && node ../../../packages/jest-cli/bin/jest.js --no-cache --runInBand)
yarn workspace @pkg-nec/jest tstyche
```

Run the relevant E2E children only after `yarn build:js`; use each child's supported command rather than assuming a shared entrypoint.

## Classify local baseline differences before changing snapshots

Use an upstream checkout with the same Node version and operating system to decide whether a local difference belongs to the rebrand. Do not update a snapshot until that comparison establishes that the output is attributable to the identity migration.

Classify only the following after reproducing each result against upstream on the same Node/platform pair:

- the `jest-core` SearchSource hidden-`.worktrees` glob result;
- the `jest-core` watch code-frame snapshot;
- the two `jest-message-util` formatting snapshots.

Otherwise, treat the difference as a rebrand regression and investigate it. Require Linux CI; a Windows baseline does not demonstrate Linux behavior. Do not claim a universal full-suite pass.

## Prepare releases in dependency order

Derive a directed graph from canonical runtime `dependencies` only: an edge points from a consumer to each internal runtime dependency. Ignore dev-only cycles. Release in topological dependency-first order; stop on a runtime cycle or unresolved internal runtime reference.

Before releasing a dependent, use a two-minute overall visibility deadline. Start a query for the exact `name@version` every five seconds while the dependency remains eligible, and apply a per-query timeout so one slow lookup cannot overrun the deadline. Retry not-found, DNS, timeout, rate-limit, connection, and retryable 5xx query failures. Surface authentication and all other fatal failures immediately. On deadline exhaustion, return the package name, version, error class, and attempt count. Keep credentials and the actual publishing procedure in the separate release runbook.

| Readiness check | Evidence |
| --- | --- |
| Identity | Canonical manifest map and stale-identity audit are clean except approved compatibility literals. |
| Metadata | Versions equal upstream; public ranges are unchanged; the two public test helper packages are publishable. |
| Build and tests | JavaScript build, targeted tests, E2E children, VM coverage, type checks, and fixture immutable checks have been run as applicable. |
| Platform | Windows baselines were compared against upstream with the same Node/platform pair; Linux CI is required. |
| Registry order | Topological order exists; each dependency has bounded visibility evidence before its consumer proceeds. |
