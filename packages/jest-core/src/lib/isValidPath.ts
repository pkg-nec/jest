/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {isSnapshotPath} from '@pkg-nec/jest-snapshot';
import type {Config} from '@pkg-nec/jest-types';

export default function isValidPath(
  globalConfig: Config.GlobalConfig,
  filePath: string,
): boolean {
  return (
    !filePath.includes(globalConfig.coverageDirectory) &&
    !isSnapshotPath(filePath)
  );
}
