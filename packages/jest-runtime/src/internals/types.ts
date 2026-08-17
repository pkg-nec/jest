/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {expect, jest} from '@pkg-nec/jest-globals';
import type {Global} from '@pkg-nec/jest-types';

export interface EnvironmentGlobals extends Global.TestFrameworkGlobals {
  expect: typeof expect;
}

export interface JestGlobalsWithJest extends EnvironmentGlobals {
  jest: typeof jest;
}
