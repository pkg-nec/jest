/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {bind as bindEach} from '@pkg-nec/jest-each';
import type {JestEnvironment} from '@pkg-nec/jest-environment';

export default function each(environment: JestEnvironment): void {
  environment.global.it.each = bindEach(environment.global.it);
  environment.global.fit.each = bindEach(environment.global.fit);
  environment.global.xit.each = bindEach(environment.global.xit);
  environment.global.describe.each = bindEach(
    environment.global.describe,
    false,
  );
  environment.global.xdescribe.each = bindEach(
    environment.global.xdescribe,
    false,
  );
  environment.global.fdescribe.each = bindEach(
    environment.global.fdescribe,
    false,
  );
  environment.global.it.concurrent.each = bindEach(
    environment.global.it.concurrent,
    false,
  );
  environment.global.it.concurrent.only.each = bindEach(
    environment.global.it.concurrent.only,
    false,
  );
  environment.global.it.concurrent.skip.each = bindEach(
    environment.global.it.concurrent.skip,
    false,
  );
}
