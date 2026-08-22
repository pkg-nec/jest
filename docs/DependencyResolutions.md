# Dependency resolutions

The root `resolutions` field is a last resort. Prefer a dependency or dev dependency in the workspace that imports a package. Use a resolution only when an ordinary manifest range cannot express the repository requirement, and keep the override as narrow as possible.

Before adding a resolution, document:

- the exact selector;
- the commit, issue, or dependency change that required it;
- the packages affected and the failure prevented;
- why an ordinary dependency declaration is insufficient; and
- the condition under which the resolution can be removed.

Review resolutions after dependency, TypeScript, or minimum-Node-version upgrades. Remove one logical group at a time, run `yarn install`, inspect `yarn why` and the lockfile diff, reproduce the original failure surface, and finish with the repository validation commands.

## Current resolutions

### `@types/node: 18.x`

Commit `4f1d199ae` added the resolution while introducing the Yarn dedupe check. Commits `71441df25` and `33747908c` subsequently moved it from Node 12 to 14 and then 16. Commit `57a0ef180` moved it from Node 16 to 18, and commit `3e87145f1` later widened the Node 18 range from `~18.14` to `18.x`. The current target is Node 18.

The private root workspace develops and builds against `@types/node@18`, matching the oldest supported Node major. Many published packages intentionally depend on `@types/node: "*"` so consumers can select a type version compatible with any supported Node release. The root resolution keeps those broad development descriptors on Node 18 inside this monorepo without narrowing the dependency ranges published to consumers.

A root dev dependency alone does not constrain the wildcard descriptors used by other workspaces and transitive packages. Converting every wildcard to `^18.14` would also change the published dependency contracts, so it is not an equivalent replacement. `yarn.config.cjs` therefore exempts `@types/node` from the otherwise uniform workspace-range constraint.

Update this resolution when the minimum supported Node major changes. Remove it only when the packages can stop publishing broad `@types/node` ranges without reducing consumer compatibility, or when those broad ranges no longer require centralized control during repository development. Re-run the declaration build, type tests, examples, and full test suite after changing it.

### `ansi-escapes/type-fest: ^2.0.0`

Commit `132e815f9` added this scoped override during the TypeScript 4.8 upgrade. `ansi-escapes@4.3.2` declares `type-fest@^0.21.3`; without the resolution, Yarn correctly selects `type-fest@0.21.3`, but the declaration build fails in `type-fest/ts41/get.d.ts` with `TS2344` constraint errors. Restoring the override selects `type-fest@2.19.0`, and `yarn build:ts` succeeds.

Adding `type-fest` as a root dev dependency would not change the nested descriptor requested by `ansi-escapes`, so it is not a replacement for this scoped resolution.

Remove this resolution when `ansi-escapes` no longer requests the incompatible range, or when the requested `type-fest` release works with the repository's TypeScript version. Verify by removing only this entry, running `yarn install`, and running `yarn build:ts`.

### `lru-cache` declaration patch

The following selectors intentionally share one patch:

- `lru-cache@^10.0.1`
- `lru-cache@^10.2.0`
- `lru-cache@^10.2.2`

Commit `95f21e4f8` added these selectors during a TypeScript upgrade. They cover the three transitive ranges currently requested in the dependency graph and select `lru-cache@10.4.3` with `.yarn/patches/lru-cache-npm-10.4.3-30c10b861a.patch`. The patch removes `implements Map<K, V>` from the CommonJS and ES module declarations.

Without the patch, `yarn build:ts` succeeds, but the repository-wide `yarn typecheck` fails with `TS2416` errors because `lru-cache`'s `entries`, `keys`, `values`, iterator, and `forEach` declarations do not satisfy the TypeScript library's `Map` interface. This is why the narrower declaration build is not sufficient removal evidence.

`lru-cache` is transitive, and adding it as a root dev dependency would not alter its requesters' descriptors or repair the incompatible declarations. Each selector is retained because each matching range must receive the same declaration patch.

Remove a selector when no dependency requests its matching range. Remove the patch and all remaining selectors when an unpatched `lru-cache` release satisfies `yarn typecheck`; verify the declaration build, full typecheck, and full test suite after changing them.

## 2026-08-22 audit removals

| Removed selector | History | Removal evidence |
| --- | --- | --- |
| `@pkg-nec/babel-jest: workspace:*` | Commit `2fdee5816` originally forced the package's workspace implementation after the Yarn Berry migration; commit `f0bb7fa04` renamed it to the `@pkg-nec` scope. | Every current requester already uses `workspace:*`. Removal leaves `yarn.lock` unchanged and `yarn why` resolves every requester to `packages/babel-jest`. |
| `@pkg-nec/jest: workspace:*` | Commit `2fdee5816` originally forced the package's workspace implementation; commit `f0bb7fa04` renamed it to the `@pkg-nec` scope. | Every current requester already uses `workspace:*`. Removal leaves `yarn.lock` unchanged and all requesters resolve to `packages/jest`. |
| `@pkg-nec/jest-environment-node: workspace:*` | Commit `b8810f668` added the rule to ensure a single environment package; commit `f0bb7fa04` renamed it to the `@pkg-nec` scope. | All requesters in the root Yarn project use `workspace:*`. Removal leaves `yarn.lock` unchanged and those requesters resolve to `packages/jest-environment-node`. The separately managed transform e2e fixtures already use explicit `link:` declarations. |
| `@types/react: ^18.2.21` | Commit `917108533` added the pin during the Docusaurus v3 and React 18 website migration. | The website and `@pkg-nec/pretty-format` now declare React 18 types directly. Without the global pin, those consumers resolve to `@types/react@18.3.31`, wildcard transitive consumers resolve independently to v19, the website typecheck passes, and the declaration build passes. |
| `ts-node@^10.5.0` patch | Commit `fb9712f35` patched the `ModuleKind.Node16` declaration in `ts-node@10.9.1`. | The current range resolves to unpatched `ts-node@10.9.2`, and the complete declaration build and validation pass. |

The obsolete `ts-node` patch file was removed with its selector. No replacement dependency was added because `ts-node` is already a direct root dev dependency and an optional `@pkg-nec/jest-config` dependency.
