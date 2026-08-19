/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {AggregatedResult, TestContext} from '@pkg-nec/jest-test-result';
import {makeGlobalConfig} from '@pkg-nec/jest-test-utils';
import type {Config} from '@pkg-nec/jest-types';
import Resolver from '@pkg-nec/jest-resolve';
import NotifyReporter from '../NotifyReporter';
import type {ReporterContext} from '../types';

jest.mock('../DefaultReporter');
jest.mock('node-notifier', () => ({
  notify: jest.fn(
    (
      _options: unknown,
      callback?: (error: Error | null, response: string) => void,
    ) => callback?.(null, ''),
  ),
}));

const initialContext: ReporterContext = {
  firstRun: true,
  previousSuccess: false,
  startRun: () => {},
};

const aggregatedResultsSuccess = {
  numFailedTestSuites: 0,
  numFailedTests: 0,
  numPassedTestSuites: 1,
  numPassedTests: 3,
  numRuntimeErrorTestSuites: 0,
  numTotalTestSuites: 1,
  numTotalTests: 3,
  success: true,
} as AggregatedResult;

const aggregatedResultsFailure = {
  numFailedTestSuites: 1,
  numFailedTests: 3,
  numPassedTestSuites: 0,
  numPassedTests: 9,
  numRuntimeErrorTestSuites: 0,
  numTotalTestSuites: 1,
  numTotalTests: 3,
  success: false,
} as AggregatedResult;

const aggregatedResultsNoTests = {
  numFailedTestSuites: 0,
  numFailedTests: 0,
  numPassedTestSuites: 0,
  numPassedTests: 0,
  numPendingTestSuites: 0,
  numPendingTests: 0,
  numRuntimeErrorTestSuites: 0,
  numTotalTestSuites: 0,
  numTotalTests: 0,
} as AggregatedResult;

// Simulated sequence of events for NotifyReporter
const notifyEvents = [
  aggregatedResultsNoTests,
  aggregatedResultsSuccess,
  aggregatedResultsFailure,
  aggregatedResultsSuccess,
  aggregatedResultsSuccess,
  aggregatedResultsFailure,
  aggregatedResultsFailure,
];

const testModes = ({
  notifyMode,
  arl,
  rootDir,
  moduleName,
}: {arl: Array<AggregatedResult>; moduleName?: string} & Pick<
  Config.GlobalConfig,
  'notifyMode'
> &
  Partial<Pick<Config.ProjectConfig, 'rootDir'>>) => {
  const notify = require('node-notifier');

  const globalConfig = makeGlobalConfig({notify: true, notifyMode, rootDir});

  let previousContext = initialContext;
  for (const [i, ar] of arl.entries()) {
    const newContext: ReporterContext = Object.assign(previousContext, {
      firstRun: i === 0,
      previousSuccess: previousContext.previousSuccess,
    });
    const reporter = new NotifyReporter(globalConfig, newContext);
    previousContext = newContext;
    const testContexts = new Set<TestContext>();

    if (moduleName != null) {
      testContexts.add({
        hasteFS: {
          getModuleName() {
            return moduleName;
          },

          matchFiles() {
            return ['package.json'];
          },
        },
      } as unknown as TestContext);
    }

    reporter.onRunComplete(testContexts, ar);

    if (ar.numTotalTests === 0) {
      expect(notify.notify).not.toHaveBeenCalled();
    }
  }

  const calls: Array<any> = notify.notify.mock.calls;
  expect(
    calls.map(([{message, title}]) => ({
      message: message.replace('\u26D4\uFE0F ', '').replace('\u2705 ', ''),
      title,
    })),
  ).toMatchSnapshot();
};

test('test always', () => {
  testModes({arl: notifyEvents, notifyMode: 'always'});
});

test('test success', () => {
  testModes({arl: notifyEvents, notifyMode: 'success'});
});

test('test change', () => {
  testModes({arl: notifyEvents, notifyMode: 'change'});
});

test('test success-change', () => {
  testModes({arl: notifyEvents, notifyMode: 'success-change'});
});

test('test failure-change', () => {
  testModes({arl: notifyEvents, notifyMode: 'failure-change'});
});

test('test always with rootDir', () => {
  testModes({arl: notifyEvents, notifyMode: 'always', rootDir: 'some-test'});
});

test('test success with rootDir', () => {
  testModes({arl: notifyEvents, notifyMode: 'success', rootDir: 'some-test'});
});

test('test change with rootDir', () => {
  testModes({arl: notifyEvents, notifyMode: 'change', rootDir: 'some-test'});
});

test('test success-change with rootDir', () => {
  testModes({
    arl: notifyEvents,
    notifyMode: 'success-change',
    rootDir: 'some-test',
  });
});

test('test failure-change with rootDir', () => {
  testModes({
    arl: notifyEvents,
    notifyMode: 'failure-change',
    rootDir: 'some-test',
  });
});

test('test always with moduleName', () => {
  testModes({
    arl: notifyEvents,
    moduleName: 'some-module',
    notifyMode: 'always',
  });
});

test('test success with moduleName', () => {
  testModes({
    arl: notifyEvents,
    moduleName: 'some-module',
    notifyMode: 'success',
  });
});

test('test change with moduleName', () => {
  testModes({
    arl: notifyEvents,
    moduleName: 'some-module',
    notifyMode: 'change',
  });
});

test('test success-change with moduleName', () => {
  testModes({
    arl: notifyEvents,
    moduleName: 'some-module',
    notifyMode: 'success-change',
  });
});

test('test failure-change with moduleName', () => {
  testModes({
    arl: notifyEvents,
    moduleName: 'some-module',
    notifyMode: 'failure-change',
  });
});

test.each([
  ['successful', aggregatedResultsSuccess],
  ['failed', aggregatedResultsFailure],
])('waits for a %s notification to complete', async (_, results) => {
  const notify = require('node-notifier');
  let completeNotification!: () => void;
  notify.notify.mockImplementationOnce(
    (
      _options: unknown,
      callback: (error: Error | null, response: string) => void,
    ) => {
      completeNotification = () => callback(null, '');
    },
  );

  const context = {...initialContext};
  const reporter = new NotifyReporter(
    makeGlobalConfig({notify: true, notifyMode: 'always'}),
    context,
  );
  let completed = false;
  const completion = reporter.onRunComplete(new Set(), results);
  void Promise.resolve(completion).then(() => {
    completed = true;
  });

  await Promise.resolve();

  expect(completed).toBe(false);
  expect(context).toEqual({
    ...initialContext,
    firstRun: false,
    previousSuccess: results.success,
  });

  completeNotification();
  await completion;

  expect(completed).toBe(true);
});

test('completes when the notifier reports an error', async () => {
  const notify = require('node-notifier');
  notify.notify.mockImplementationOnce(
    (
      _options: unknown,
      callback: (error: Error | null, response: string) => void,
    ) => callback(new Error('notification failed'), ''),
  );

  const reporter = new NotifyReporter(
    makeGlobalConfig({notify: true, notifyMode: 'always'}),
    {...initialContext},
  );

  await expect(
    reporter.onRunComplete(new Set(), aggregatedResultsSuccess),
  ).resolves.toBeUndefined();
});

test('does not wait for an interactive watch-mode notification', () => {
  const notify = require('node-notifier');
  notify.notify.mockImplementationOnce(() => {});

  const reporter = new NotifyReporter(
    makeGlobalConfig({notify: true, notifyMode: 'always', watch: true}),
    {...initialContext},
  );

  expect(
    reporter.onRunComplete(new Set(), aggregatedResultsFailure),
  ).toBeUndefined();
  expect(notify.notify).toHaveBeenCalledTimes(1);
});

describe('node-notifier is an optional dependency', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  const ctor = () => {
    const globalConfig = makeGlobalConfig({
      notify: true,
      notifyMode: 'success',
      rootDir: 'some-test',
    });
    return new NotifyReporter(globalConfig, initialContext);
  };

  test('without node-notifier uses mock function that throws an error', () => {
    jest.doMock('node-notifier', () => {
      throw new Resolver.ModuleNotFoundError(
        "Cannot find module 'node-notifier'",
      );
    });

    expect(ctor).toThrow(
      'notify reporter requires optional peer dependency "node-notifier" but it was not found',
    );
  });

  test('throws the error when require throws an unexpected error', () => {
    const error = new Error('unexpected require error');
    jest.doMock('node-notifier', () => {
      throw error;
    });
    expect(ctor).toThrow(error);
  });

  test('uses node-notifier when it is available', () => {
    const mockNodeNotifier = {notify: jest.fn()};
    jest.doMock('node-notifier', () => mockNodeNotifier);
    const result = ctor();
    expect(result._notifier).toBe(mockNodeNotifier);
  });
});

afterEach(() => {
  jest.clearAllMocks();
});
