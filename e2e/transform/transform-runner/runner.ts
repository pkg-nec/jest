/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import pLimit from 'p-limit';
import {
  type Test,
  type TestResult,
  createEmptyTestResult,
} from '@pkg-nec/jest-test-result';
import type {Config} from '@pkg-nec/jest-types';
import type {
  OnTestFailure,
  OnTestStart,
  OnTestSuccess,
  TestRunnerContext,
} from '@pkg-nec/jest-runner';
import type {TestWatcher} from '@pkg-nec/jest-watcher';

export default class BaseTestRunner {
  private _globalConfig: Config.GlobalConfig;
  private _context: TestRunnerContext;

  constructor(globalConfig: Config.GlobalConfig, context?: TestRunnerContext) {
    this._globalConfig = globalConfig;
    this._context = context || {};
  }

  async runTests(
    tests: Array<Test>,
    watcher: TestWatcher,
    onStart: OnTestStart,
    onResult: OnTestSuccess,
    onFailure: OnTestFailure,
  ): Promise<void> {
    const mutex = pLimit(1);
    return tests.reduce(
      (promise, test) =>
        mutex(() =>
          promise
            .then(async (): Promise<TestResult> => {
              await onStart(test);
              return {
                ...createEmptyTestResult(),
                numPassingTests: 1,
                testFilePath: test.path,
                testResults: [
                  {
                    ancestorTitles: [],
                    duration: 2,
                    failureDetails: [],
                    failureMessages: [],
                    fullName: 'sample test',
                    location: null,
                    numPassingAsserts: 1,
                    status: 'passed',
                    title: 'sample test',
                  },
                ],
              };
            })
            .then(result => onResult(test, result))
            .catch(error => onFailure(test, error)),
        ),
      Promise.resolve(),
    );
  }
}
