/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {IHasteFS, IModuleMap} from '@pkg-nec/jest-haste-map';
import Runtime from '@pkg-nec/jest-runtime';
import type {TestContext} from '@pkg-nec/jest-test-result';
import type {Config} from '@pkg-nec/jest-types';

type HasteContext = {hasteFS: IHasteFS; moduleMap: IModuleMap};

export default function createContext(
  config: Config.ProjectConfig,
  {hasteFS, moduleMap}: HasteContext,
): TestContext {
  return {
    config,
    hasteFS,
    moduleMap,
    resolver: Runtime.createResolver(config, moduleMap),
  };
}
