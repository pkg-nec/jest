/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {glob} from 'glob';
import {rimraf} from 'rimraf';

export async function removeBuildDeclarations(buildDirectory) {
  const declarationFiles = await glob('**/*.d.ts', {
    absolute: true,
    cwd: buildDirectory,
  });
  await Promise.all(declarationFiles.map(file => rimraf(file)));
}
