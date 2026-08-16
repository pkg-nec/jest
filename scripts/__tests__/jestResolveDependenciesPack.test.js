/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {spawnSync} from 'node:child_process';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const repoRoot = process.cwd();
const packageName = '@pkg-nec/jest-resolve-dependencies';

function run(command, args, {cwd = repoRoot} = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout);
  }

  return result.stdout;
}

test('excludes the package-root manual mock from the Yarn release pack', async () => {
  const manifest = JSON.parse(
    await readFile(join(repoRoot, 'package.json'), 'utf8'),
  );
  const yarnVersion = manifest.packageManager.replace(/^yarn@/u, '');
  const yarnCli = join(
    repoRoot,
    '.yarn',
    'releases',
    `yarn-${yarnVersion}.cjs`,
  );
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), 'pkg-nec-jest-resolve-dependencies-pack-'),
  );

  try {
    const tarball = join(temporaryDirectory, 'package.tgz');
    run(process.execPath, [
      yarnCli,
      'workspace',
      packageName,
      'pack',
      '--out',
      tarball,
    ]);

    const files = run('tar', ['-tzf', 'package.tgz'], {
      cwd: temporaryDirectory,
    })
      .trim()
      .split(/\r?\n/u);

    expect(files).toContain('package/package.json');
    expect(files).not.toContain('package/__mocks__/fake-node-module.js');
  } finally {
    await rm(temporaryDirectory, {force: true, recursive: true});
  }
});
