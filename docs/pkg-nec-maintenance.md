# Maintaining the `@pkg-nec` Jest Fork

This guide describes the durable maintenance and release-preparation boundaries for the fork. It replaces the completed one-time rebrand procedure.

## Permanent package identity rules

Keep package identities canonical to the `@pkg-nec` namespace. The current package manifests and the identity policy are the source of truth; do not rerun completed rebrand automation or restore upstream package identities. Preserve internal workspace relationships and published package metadata unless a reviewed maintenance change requires an update.

Package versions and dependency ranges are not frozen: reviewed security work may update them. Any such change must retain canonical `@pkg-nec` identities and pass the identity and tooling checks below.

## Git Bash and Node setup

Run repository Node, Corepack, and Yarn commands from Git Bash with the project's supported Node version selected. Then enable Corepack and install dependencies:

```bash
corepack enable
yarn install
```

## Pull-request checks

Pull requests run the retained, deterministic checks from the repository root:

```bash
yarn check:pkg-nec-identity
yarn test:pkg-nec-tooling
```

`check:pkg-nec-identity` verifies the durable identity policy. `test:pkg-nec-tooling` covers the retained identity, audit, release-ledger, artifact, and registry-verification tooling. Neither command publishes packages or contacts the npm registry.

## Release preparation

Prepare a release candidate explicitly; this is not a pull-request gate:

```bash
yarn prepare:pkg-nec-release
```

Preparation cleans generated output, performs the complete build, packs and validates the release artifacts, and derives deterministic dependency-first release order. It contacts no registry and publishes nothing. It does not require credentials or mutate registry state.

## Release ledger contract

Release preparation writes two schema-v1 ledger outputs: the machine-readable `.pkg-nec-release/release-ledger.json` and the human-readable `.pkg-nec-release/release-ledger.md`. The ledger records the prepared source commit, runtime and package-manager metadata, and each package's ordered artifact, version, integrity, prerequisites, and file list.

Treat the schema-v1 ledger as the handoff contract for a future publisher: publish only the prepared artifacts in its order, and use its expected integrity when checking registry visibility. Do not edit a generated ledger to change a release.

## Registry verification boundary

Registry visibility verification is post-publish behavior, not a pull-request or preparation check. A future publisher uses `yarn check:pkg-nec-registry <ledger-path> <package-name>` for the selected ledger entry after publishing it.

The verifier has a 480-second deadline. It retries eligible transient failures while checking the exact package name, version, and integrity from the ledger; a mismatch or terminal failure stops the release flow.

## Deferred npm trusted publishing and provenance

This repository retains the preparation and verification foundation for future publishing, but this cleanup creates no publishing workflow, trusted-publishing/OIDC configuration, or provenance workflow. Those capabilities require a later, separately reviewed implementation.

Before enabling trusted publishing, that later provenance plan must review package repository URLs against the eventual `pkg-nec` publishing repository. It must also define the publisher that consumes the prepared ledger, verifies the source commit and artifact integrity, publishes the exact tarballs in ledger order, and invokes post-publish registry verification.

## Dependency security policy

Yarn's `npmMinimalAgeGate` remains set to seven days. A newly published dependency normally must age for seven days before adoption. If an urgent security release cannot wait, the dependency upgrade requires a specific, reviewed exception that documents why the seven-day gate is being bypassed and limits the exception to that release.
