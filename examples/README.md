# Jest Examples

This directory is an independent Yarn project that hosts all fourteen example workspaces:

- `angular`
- `async`
- `automatic-mocks`
- `expect-extend`
- `getting-started`
- `jquery`
- `manual-mocks`
- `module-mock`
- `react-native`
- `react-testing-library`
- `react`
- `snapshot`
- `timer`
- `typescript`

It is intentionally outside the repository root workspace. Root dependency installation, typechecking, and Jest commands do not install or execute the child example workspaces.

The child manifests pin `@pkg-nec/*` dependencies to exact published versions instead of using `workspace:` links. The examples therefore exercise the packages consumers receive from npm rather than unpublished packages built in the repository root. Preserve those exact pins when changing unrelated dependencies.

## Setup

Run setup from this directory:

```bash
corepack enable
yarn install --immutable
```

When intentionally changing example dependencies, run `yarn install` here to update `examples/yarn.lock`. Do not update the root `yarn.lock` for example dependency changes.

## Validation

Run the aggregate checks used by the [Examples CI workflow](../.github/workflows/examples.yml):

```bash
yarn typecheck
yarn test
```

`yarn typecheck` checks the `expect-extend` and `typescript` TypeScript examples. `yarn test` runs every child workspace's existing test script.

For focused iteration, run one child workspace by its package name. For example:

```bash
yarn workspace example-async test
```

Run `yarn workspace <workspace-name> test` for any of the other child workspaces.
