/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {Config as ConfigTypes} from '@pkg-nec/jest-types';

export {
  SearchSource,
  createTestScheduler,
  getVersion,
  runCLI,
} from '@pkg-nec/jest-core';

export {run, buildArgv} from '@pkg-nec/jest-cli';

export {defineConfig, mergeConfig} from '@pkg-nec/jest-config';

export type Config = ConfigTypes.InitialOptions;
export type GlobalConfig = ConfigTypes.GlobalConfig;
export type ProjectConfig = ConfigTypes.ProjectConfig;
