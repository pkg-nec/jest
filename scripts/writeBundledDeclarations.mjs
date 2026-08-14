/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import * as path from 'node:path';
import fs from 'graceful-fs';

const getTypeCompatibilityPackage = '@pkg-nec/jest-get-type@30.1.0';

export async function writeBundledDeclarations({
  content,
  declarationPath,
  packageName,
  packageVersion,
  writeFile = fs.promises.writeFile,
}) {
  const needsCompatibilityDeclaration =
    `${packageName}@${packageVersion}` === getTypeCompatibilityPackage;

  if (
    needsCompatibilityDeclaration &&
    path.basename(declarationPath) !== 'index.d.ts'
  ) {
    throw new Error(
      `Compatibility declaration source must be index.d.ts: ${declarationPath}`,
    );
  }

  await writeFile(declarationPath, content);

  if (needsCompatibilityDeclaration) {
    await writeFile(declarationPath.replace(/\.d\.ts$/u, '.d.mts'), content);
  }
}
