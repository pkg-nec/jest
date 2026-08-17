/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {MatcherFunction} from '@pkg-nec/expect';
import {expect} from '@pkg-nec/jest-globals';

const toBeWithinRange: MatcherFunction<[floor: unknown, ceiling: unknown]> =
  function (actual, floor, ceiling) {
    if (
      typeof actual !== 'number' ||
      typeof floor !== 'number' ||
      typeof ceiling !== 'number'
    ) {
      throw new TypeError('These must be of type number!');
    }

    const pass = actual >= floor && actual <= ceiling;
    if (pass) {
      return {
        message: () =>
          `expected ${this.utils.printReceived(
            actual,
          )} not to be within range ${this.utils.printExpected(
            `${floor} - ${ceiling}`,
          )}`,
        pass: true,
      };
    } else {
      return {
        message: () =>
          `expected ${this.utils.printReceived(
            actual,
          )} to be within range ${this.utils.printExpected(
            `${floor} - ${ceiling}`,
          )}`,
        pass: false,
      };
    }
  };

expect.extend({
  toBeWithinRange,
});

declare module '@pkg-nec/expect' {
  interface AsymmetricMatchers {
    toBeWithinRange(floor: number, ceiling: number): void;
  }
  interface Matchers<R> {
    toBeWithinRange(floor: number, ceiling: number): R;
  }
}
