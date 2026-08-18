# npm Audit Baseline — 2026-08-18

## Recorded command and environment

```bash
yarn npm audit --all --recursive --severity high
```

This baseline was recorded on 2026-08-18 with Node 22.23.1 and Yarn 4.18.0.

## Result summary

The command exited with status 1 and reported 45 entries: 42 high and 3 critical. The findings named 20 distinct affected packages:

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

Direct inspection observed `immutable` through `@pkg-nec/expect` and `js-yaml` through the root `@pkg-nec/monorepo` workspace.

## Policy for this cleanup

This is evidence only. This cleanup makes no package upgrade and adds no blocking audit gate. Future dependency-security work should evaluate the recorded findings under the repository's normal review process and its seven-day `npmMinimalAgeGate` policy.
