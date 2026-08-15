/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import Resolver from '../resolver';
import {resolveTestEnvironment} from '../utils';

describe('resolveTestEnvironment', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('names the scoped jsdom package when both resolution paths fail', () => {
    const findNodeModule = jest
      .spyOn(Resolver, 'findNodeModule')
      .mockReturnValue(null);
    const requireResolveFunction = jest.fn(() => {
      throw new Error('module not found');
    });

    expect(() =>
      resolveTestEnvironment({
        requireResolveFunction,
        rootDir: __dirname,
        testEnvironment: 'jsdom',
      }),
    ).toThrow(
      'As of Jest 28 "@pkg-nec/jest-environment-jsdom" is no longer shipped by default, make sure to install it separately.',
    );

    expect(findNodeModule).toHaveBeenCalledTimes(2);
    expect(requireResolveFunction).toHaveBeenCalledTimes(2);
  });
});
