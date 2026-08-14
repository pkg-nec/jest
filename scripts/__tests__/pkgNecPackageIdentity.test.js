/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

import upstreamManifestBaseline from '../pkgNec/upstreamManifestBaseline.json';

const repoRoot = process.cwd();
const identityModuleUrl = pathToFileURL(
  join(repoRoot, 'scripts/pkgNecPackageIdentity.mjs'),
).href;

function runIdentityRequest(request) {
  const program = `
    import * as identity from ${JSON.stringify(identityModuleUrl)};
    const request = ${JSON.stringify(request)};

    try {
      const inventory = identity.discoverPackageIdentities({
        repoRoot: request.repoRoot,
        expectedPackageCount: request.expectedPackageCount,
      });
      let result;

      if (request.action === 'inventory') {
        result = {
          byOldName: Object.fromEntries(inventory.byOldName),
          byNewNameSize: inventory.byNewName.size,
          packageCount: inventory.packages.length,
        };
      } else if (request.action === 'rewrite') {
        result = identity.rewritePackageSpecifier(request.specifier, inventory);
      } else if (request.action === 'baseline') {
        result = identity.createManifestBaseline(inventory);
      } else if (request.action === 'assert-modified-version') {
        const baseline = identity.createManifestBaseline(inventory);
        const modifiedInventory = {
          ...inventory,
          packages: inventory.packages.map(pkg =>
            pkg.oldName === 'jest' ? {...pkg, version: '0.0.0'} : pkg,
          ),
        };
        identity.assertManifestBaseline({
          baseline,
          inventory: modifiedInventory,
        });
        result = 'asserted';
      } else if (request.action === 'assert-baseline') {
        identity.assertManifestBaseline({
          baseline: request.baseline,
          inventory,
        });
        result = 'asserted';
      } else {
        identity.assertManifestBaseline({
          baseline: identity.createManifestBaseline(inventory),
          inventory,
        });
        result = 'asserted';
      }

      console.log(JSON.stringify({result}));
    } catch (error) {
      console.log(JSON.stringify({error: error.message}));
      process.exitCode = 1;
    }
  `;
  const child = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', program],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    },
  );
  const output = JSON.parse(child.stdout);

  if (child.status !== 0) throw new Error(output.error ?? child.stderr);
  return output.result;
}

async function writeManifest(repo, directory, manifest) {
  const manifestDirectory = join(repo, directory);
  await mkdir(manifestDirectory, {recursive: true});
  await writeFile(
    join(manifestDirectory, 'package.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

describe('pkg-nec package identities', () => {
  test('discovers the complete release inventory and canonical names', () => {
    const inventory = runIdentityRequest({action: 'inventory', repoRoot});

    expect(Object.keys(inventory.byOldName)).toHaveLength(56);
    expect(inventory.byNewNameSize).toBe(56);
    expect(inventory.byOldName['@jest/monorepo'].newName).toBe(
      '@pkg-nec/monorepo',
    );
    expect(inventory.byOldName['@jest/globals'].newName).toBe(
      '@pkg-nec/jest-globals',
    );
    expect(inventory.byOldName.jest.newName).toBe('@pkg-nec/jest');
    expect(inventory.byOldName.expect.newName).toBe('@pkg-nec/expect');
    expect(inventory.packageCount).toBe(55);
    expect(
      new Set(Object.values(inventory.byOldName).map(pkg => pkg.newName)).size,
    ).toBe(56);
    expect(inventory.byOldName['@jest/test-globals'].publishable).toBe(true);
    expect(inventory.byOldName['@jest/test-utils'].publishable).toBe(true);
  });

  test('rewrites first-party package names and deep imports only', () => {
    expect(
      runIdentityRequest({
        action: 'rewrite',
        repoRoot,
        specifier: '@jest/globals/build/index.js',
      }),
    ).toBe('@pkg-nec/jest-globals/build/index.js');
    expect(
      runIdentityRequest({
        action: 'rewrite',
        repoRoot,
        specifier: '@fast-check/jest',
      }),
    ).toBeNull();
    expect(
      runIdentityRequest({
        action: 'rewrite',
        repoRoot,
        specifier: '@jest/globals-extra',
      }),
    ).toBeNull();
  });

  test('rejects inventories with an unexpected release workspace count', async () => {
    const temporaryRepo = await mkdtemp(join(tmpdir(), 'pkg-nec-identity-'));

    try {
      await writeManifest(temporaryRepo, '.', {
        name: '@jest/monorepo',
        private: true,
        version: '0.0.0',
      });
      await writeManifest(temporaryRepo, 'packages/jest', {
        name: 'jest',
        version: '1.0.0',
      });

      expect(() =>
        runIdentityRequest({
          action: 'inventory',
          expectedPackageCount: 2,
          repoRoot: temporaryRepo,
        }),
      ).toThrow('Expected 2 release workspaces, found 1');
    } finally {
      await rm(temporaryRepo, {force: true, recursive: true});
    }
  });

  test('rejects inventories whose canonical package names collide', async () => {
    const temporaryRepo = await mkdtemp(join(tmpdir(), 'pkg-nec-identity-'));

    try {
      await writeManifest(temporaryRepo, '.', {
        name: '@jest/monorepo',
        private: true,
        version: '0.0.0',
      });
      await writeManifest(temporaryRepo, 'packages/scoped', {
        name: '@jest/foo',
        version: '1.0.0',
      });
      await writeManifest(temporaryRepo, 'packages/unscoped', {
        name: 'jest-foo',
        version: '1.0.0',
      });

      expect(() =>
        runIdentityRequest({
          action: 'inventory',
          expectedPackageCount: 2,
          repoRoot: temporaryRepo,
        }),
      ).toThrow('Canonical package name collision: @pkg-nec/jest-foo');
    } finally {
      await rm(temporaryRepo, {force: true, recursive: true});
    }
  });

  test('captures normalized manifest data and detects later changes', () => {
    const baseline = runIdentityRequest({action: 'baseline', repoRoot});

    expect(Object.keys(baseline)).toHaveLength(56);
    expect(baseline['package.json']).toEqual(
      expect.objectContaining({
        name: '@jest/monorepo',
        private: true,
        version: '0.0.0',
      }),
    );
    expect(baseline['packages/jest/package.json']).toEqual(
      expect.objectContaining({
        name: 'jest',
        private: false,
        version: '30.4.2',
      }),
    );
    expect(runIdentityRequest({action: 'assert', repoRoot})).toBe('asserted');
    expect(() =>
      runIdentityRequest({action: 'assert-modified-version', repoRoot}),
    ).toThrow('Manifest baseline does not match current inventory');
  });

  test('asserts the committed baseline and preserves dependency protocols', () => {
    expect(
      upstreamManifestBaseline['package.json'].devDependencies['@jest/globals'],
    ).toBe('workspace:*');
    expect(
      upstreamManifestBaseline['package.json'].resolutions['lru-cache@^10.0.1'],
    ).toBe(
      'patch:lru-cache@npm:10.4.3#./.yarn/patches/lru-cache-npm-10.4.3-30c10b861a.patch',
    );
    expect(
      upstreamManifestBaseline['packages/jest/package.json'].peerDependencies[
        'node-notifier'
      ],
    ).toBe('^8.0.1 || ^9.0.0 || ^10.0.0');
    expect(
      runIdentityRequest({
        action: 'assert-baseline',
        baseline: upstreamManifestBaseline,
        repoRoot,
      }),
    ).toBe('asserted');

    const corruptedBaseline = {
      ...upstreamManifestBaseline,
      'packages/jest/package.json': {
        ...upstreamManifestBaseline['packages/jest/package.json'],
        dependencies: {
          ...upstreamManifestBaseline['packages/jest/package.json']
            .dependencies,
          '@jest/core': 'workspace:^',
        },
      },
    };

    expect(() =>
      runIdentityRequest({
        action: 'assert-baseline',
        baseline: corruptedBaseline,
        repoRoot,
      }),
    ).toThrow('Manifest baseline does not match current inventory');
  });
});
