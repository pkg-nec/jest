/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {expect, test} from 'tstyche';
import type {Options} from 'yargs';
import {yargsOptions} from '@pkg-nec/jest-cli';

test('yargsOptions', () => {
  expect(yargsOptions).type.toBe<{[key: string]: Options}>();
});
