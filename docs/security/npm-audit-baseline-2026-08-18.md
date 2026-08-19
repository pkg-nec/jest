# npm Audit Baseline — 2026-08-18

## Recorded command and environment

Run from the repository root after enabling Corepack and installing the workspace:

```bash
yarn npm audit --all --recursive --severity high
```

The baseline was recorded and reconfirmed on 2026-08-18 with Node 22.23.1 and Yarn 4.18.0. The command exited with status 1, as expected while matching findings remain.

## Result summary

Yarn reported 45 package/advisory/range entries: 42 high and 3 critical. The entries named 20 distinct affected packages:

- `@angular/common`
- `@angular/compiler`
- `@angular/core`
- `brace-expansion`
- `deepmerge-ts`
- `fast-uri`
- `image-size`
- `immutable`
- `ip-address`
- `js-yaml`
- `nanoid`
- `postcss`
- `serialize-javascript`
- `shell-quote`
- `sigstore`
- `svgo`
- `tar`
- `undici`
- `websocket-driver`
- `ws`

An entry is one affected package, advisory, and vulnerable range observed in the resolved graph. The 45 entries are not 45 unique packages, are not necessarily 45 unique vulnerability causes, and do not mean that all findings ship in the 55 published packages.

## Exposure interpretation

The recursive audit covers the entire monorepo: published package workspaces, the private root, build and release tooling, tests, the documentation website, examples, and transitive dependencies.

Direct observations from the reconfirmed output include:

- `immutable@5.1.5` through the published `@pkg-nec/expect` workspace;
- `js-yaml@4.1.1` through the private root `@pkg-nec/monorepo` workspace;
- Angular findings through the unpublished `examples/angular` workspace;
- website/example/tooling paths for findings such as `image-size`, `postcss`, `shell-quote`, `tar`, and `websocket-driver`.

Each remediation must inspect the complete dependency path and classify it as published runtime, optional/peer behavior, build or release tooling, test/CI tooling, website, or example-only before choosing urgency and verification depth.

## Baseline policy

This document is evidence, not a waiver and not a blocking audit gate. The tooling-cleanup work that created it made no dependency or lockfile change.

Future security work should:

1. record the before and after audit output and affected dependency paths;
2. remediate published-runtime exposure before lower-risk development-only exposure when fixes cannot land together;
3. document findings that remain and why;
4. follow the seven-day `npmMinimalAgeGate` or record a narrow reviewed emergency exception; and
5. choose a zero-high/critical or explicit no-regression policy before enabling a machine gate.

Because advisory databases change independently of this repository, later runs may differ without a lockfile change. Preserve this file as the dated baseline and create a new dated record for a materially different result rather than rewriting history.
