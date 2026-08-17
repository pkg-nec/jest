/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import fs from 'graceful-fs';

const repoRoot = process.cwd();
const cleanupModuleUrl = pathToFileURL(
  join(repoRoot, 'scripts/removeBuildDeclarations.mjs'),
).href;

function removeBuildDeclarations(buildDirectory) {
  const program = `
    import {removeBuildDeclarations} from ${JSON.stringify(cleanupModuleUrl)};
    await removeBuildDeclarations(${JSON.stringify(buildDirectory)});
  `;
  const child = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', program],
    {cwd: repoRoot, encoding: 'utf8'},
  );
  if (child.status !== 0) throw new Error(child.stderr);
}

test('removes generated declarations while preserving runtime files', () => {
  const temporaryRoot = fs.mkdtempSync(join(tmpdir(), 'jest-bundle-types-'));
  const buildDirectory = join(temporaryRoot, 'build');
  const nestedDirectory = join(buildDirectory, 'nested');
  fs.mkdirSync(nestedDirectory, {recursive: true});
  fs.writeFileSync(join(buildDirectory, 'index.d.ts'), 'export {};');
  fs.writeFileSync(join(buildDirectory, 'index.js'), 'module.exports = {};');
  fs.writeFileSync(join(nestedDirectory, 'internal.d.ts'), 'export {};');
  fs.writeFileSync(
    join(nestedDirectory, 'internal.js'),
    'module.exports = {};',
  );

  try {
    removeBuildDeclarations(buildDirectory);

    expect(fs.existsSync(join(buildDirectory, 'index.d.ts'))).toBe(false);
    expect(fs.existsSync(join(nestedDirectory, 'internal.d.ts'))).toBe(false);
    expect(fs.existsSync(join(buildDirectory, 'index.js'))).toBe(true);
    expect(fs.existsSync(join(nestedDirectory, 'internal.js'))).toBe(true);
  } finally {
    fs.rmSync(temporaryRoot, {force: true, recursive: true});
  }
});
