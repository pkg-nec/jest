/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const repoRoot = process.cwd();
const declarationModuleUrl = pathToFileURL(
  join(repoRoot, 'scripts/writeBundledDeclarations.mjs'),
).href;

async function writeBundledDeclarations(options) {
  const program = `
    import {writeBundledDeclarations} from ${JSON.stringify(declarationModuleUrl)};
    const options = ${JSON.stringify(options)};
    const writes = [];
    try {
      await writeBundledDeclarations({
        ...options,
        writeFile: async (file, content) => writes.push([file, content]),
      });
      console.log(JSON.stringify({ok: true, writes}));
    } catch (error) {
      console.log(JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        ok: false,
        writes,
      }));
    }
  `;
  const child = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', program],
    {cwd: repoRoot, encoding: 'utf8'},
  );
  if (child.status !== 0) throw new Error(child.stderr);
  const response = JSON.parse(child.stdout);
  if (!response.ok) {
    const error = new Error(response.error);
    error.writes = response.writes;
    throw error;
  }
  return response.writes;
}

test('writes the get-type 30.1.0 compatibility declaration with identical bytes', async () => {
  await expect(
    writeBundledDeclarations({
      content: 'export declare const getType: unknown;\n',
      declarationPath: '/repo/packages/jest-get-type/build/index.d.ts',
      packageName: '@pkg-nec/jest-get-type',
      packageVersion: '30.1.0',
    }),
  ).resolves.toEqual([
    [
      '/repo/packages/jest-get-type/build/index.d.ts',
      'export declare const getType: unknown;\n',
    ],
    [
      '/repo/packages/jest-get-type/build/index.d.mts',
      'export declare const getType: unknown;\n',
    ],
  ]);
});

test.each([
  ['@pkg-nec/jest-get-type', '30.1.1'],
  ['@pkg-nec/jest-regex-util', '30.1.0'],
])(
  'does not create a compatibility declaration for %s@%s',
  async (packageName, packageVersion) => {
    await expect(
      writeBundledDeclarations({
        content: 'declaration\n',
        declarationPath: '/repo/build/index.d.ts',
        packageName,
        packageVersion,
      }),
    ).resolves.toEqual([['/repo/build/index.d.ts', 'declaration\n']]);
  },
);

test('rejects a compatibility declaration outside index.d.ts before writing', async () => {
  const request = writeBundledDeclarations({
    content: 'declaration\n',
    declarationPath: '/repo/build/other.d.ts',
    packageName: '@pkg-nec/jest-get-type',
    packageVersion: '30.1.0',
  });

  await expect(request).rejects.toMatchObject({
    message:
      'Compatibility declaration source must be index.d.ts: /repo/build/other.d.ts',
    writes: [],
  });
});
