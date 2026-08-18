/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {spawnSync} from 'node:child_process';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

import policy from '../pkgNec/packageIdentityPolicy.json';

const repoRoot = process.cwd();
const identityModuleUrl = pathToFileURL(
  join(repoRoot, 'scripts/pkgNecPackageIdentity.mjs'),
).href;

function runIdentityRequest(request) {
  const program = `
    import * as identity from ${JSON.stringify(identityModuleUrl)};
    const request = ${JSON.stringify(request)};
    const readFile = file =>
      JSON.stringify(
        request.manifests?.[file] ?? request.defaultManifest ?? {
          name: 'test-package',
          version: '1.0.0',
        },
      );

    try {
      const inventory = identity.createPackageInventory({
        policy: request.policy,
        readFile,
        repoRoot: request.repoRoot,
      });
      let result;

      if (request.action === 'rewrite') {
        result = identity.rewritePackageSpecifier(request.specifier, inventory);
      } else {
        result = {
          packages: inventory.packages,
          root: inventory.root,
        };
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

function createTestPolicy({packageCount = 55} = {}) {
  return {
    packages: [
      {
        manifestPath: 'package.json',
        newName: '@pkg-nec/monorepo',
        oldName: '@jest/monorepo',
        publishable: false,
      },
      ...Array.from({length: packageCount}, (_, index) => ({
        manifestPath: `packages/package-${index}/package.json`,
        newName: `@pkg-nec/package-${index}`,
        oldName: `package-${index}`,
        publishable: true,
      })),
    ],
    schemaVersion: 1,
  };
}

describe('pkg-nec package identities', () => {
  test('stores only durable identity facts for root plus 55 packages', () => {
    expect(policy.schemaVersion).toBe(1);
    expect(policy.packages).toHaveLength(56);
    expect(
      policy.packages.filter(item => item.manifestPath !== 'package.json'),
    ).toHaveLength(55);
    for (const item of policy.packages) {
      expect(Object.keys(item).sort()).toEqual([
        'manifestPath',
        'newName',
        'oldName',
        'publishable',
      ]);
    }
    expect(
      policy.packages.find(item => item.manifestPath === 'package.json'),
    ).toEqual({
      manifestPath: 'package.json',
      newName: '@pkg-nec/monorepo',
      oldName: '@jest/monorepo',
      publishable: false,
    });
    expect(
      policy.packages.find(item => item.oldName === '@jest/test-globals')
        .publishable,
    ).toBe(true);
    expect(
      policy.packages.find(item => item.oldName === '@jest/test-utils')
        .publishable,
    ).toBe(true);
  });

  test('reads the version from the current manifest', () => {
    const currentManifestPolicy = createTestPolicy();
    currentManifestPolicy.packages[1] = {
      manifestPath: 'packages/example/package.json',
      newName: '@pkg-nec/example',
      oldName: 'example',
      publishable: true,
    };
    const inventory = runIdentityRequest({
      action: 'inventory',
      manifests: {
        [resolve('/repo', 'package.json')]: {
          name: '@pkg-nec/monorepo',
          private: true,
          version: '0.0.0',
        },
        [resolve('/repo', 'packages/example/package.json')]: {
          dependencies: {third_party: '^9.0.0'},
          name: '@pkg-nec/example',
          version: '31.0.0-security.1',
        },
      },
      policy: currentManifestPolicy,
      repoRoot: '/repo',
    });
    expect(inventory.packages[0].version).toBe('31.0.0-security.1');
  });

  test('rewrites known package names and deep imports from the policy', () => {
    expect(
      runIdentityRequest({
        action: 'rewrite',
        policy,
        repoRoot,
        specifier: '@jest/globals/build/index.js',
      }),
    ).toBe('@pkg-nec/jest-globals/build/index.js');
    expect(
      runIdentityRequest({
        action: 'rewrite',
        policy,
        repoRoot,
        specifier: '@fast-check/jest',
      }),
    ).toBeNull();
    expect(
      runIdentityRequest({
        action: 'rewrite',
        policy,
        repoRoot,
        specifier: '@jest/globals-extra',
      }),
    ).toBeNull();
  });

  test('rejects an unsupported package identity policy schema', () => {
    expect(() =>
      runIdentityRequest({
        policy: {packages: [], schemaVersion: 2},
        repoRoot: '/repo',
      }),
    ).toThrow('Unsupported pkg-nec package identity policy');
  });

  test('rejects duplicate manifest paths', () => {
    const duplicateManifestPath = createTestPolicy();
    duplicateManifestPath.packages[1].manifestPath = 'package.json';

    expect(() =>
      runIdentityRequest({
        policy: duplicateManifestPath,
        repoRoot: '/repo',
      }),
    ).toThrow(`Duplicate manifest path: ${resolve('/repo', 'package.json')}`);
  });

  test('rejects duplicate old package names', () => {
    const duplicateOldName = createTestPolicy();
    duplicateOldName.packages[1].oldName = '@jest/monorepo';

    expect(() =>
      runIdentityRequest({
        policy: duplicateOldName,
        repoRoot: '/repo',
      }),
    ).toThrow('Duplicate old package name: @jest/monorepo');
  });

  test('rejects duplicate new package names', () => {
    const duplicateNewName = createTestPolicy();
    duplicateNewName.packages[1].newName = '@pkg-nec/monorepo';

    expect(() =>
      runIdentityRequest({
        policy: duplicateNewName,
        repoRoot: '/repo',
      }),
    ).toThrow('Duplicate new package name: @pkg-nec/monorepo');
  });

  test('rejects a policy without the root manifest', () => {
    const missingRoot = createTestPolicy();
    missingRoot.packages[0].manifestPath = 'packages/root/package.json';

    expect(() =>
      runIdentityRequest({
        policy: missingRoot,
        repoRoot: '/repo',
      }),
    ).toThrow('Package identity policy is missing package.json');
  });

  test('rejects a package count other than 55', () => {
    expect(() =>
      runIdentityRequest({
        policy: createTestPolicy({packageCount: 54}),
        repoRoot: '/repo',
      }),
    ).toThrow('Expected 55 package identities, found 54');
  });
});
