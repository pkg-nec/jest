/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const repoRoot = process.cwd();
const verificationModuleUrl = pathToFileURL(
  join(repoRoot, 'scripts/pkgNec/releaseVerification.mjs'),
).href;
const verificationCommandModuleUrl = pathToFileURL(
  join(repoRoot, 'scripts/verifyPkgNecRelease.mjs'),
).href;
const sourceCommit = '0123456789abcdef0123456789abcdef01234567';
const releaseTag = '@pkg-nec/jest-v30.4.3';

function integrity(byte) {
  return `sha512-${Buffer.alloc(64, byte).toString('base64')}`;
}

function releaseFixture(count = 1) {
  const packages = Array.from({length: count}, (_, index) => ({
    files: ['package.json'],
    integrity: integrity(index + 1),
    name: `@pkg-nec/package-${index + 1}`,
    order: index + 1,
    prerequisites: [],
    tarball: `.pkg-nec-release/package-${index + 1}.tgz`,
    version: `1.0.${index}`,
  }));
  return {
    journal: {
      packages: packages.map((entry, index) => ({
        completedAt: '2026-08-19T12:34:56.000Z',
        disposition: index % 2 === 0 ? 'published' : 'verified-existing',
        integrity: entry.integrity,
        name: entry.name,
        order: entry.order,
        version: entry.version,
      })),
      releaseTag,
      schemaVersion: 1,
      sourceCommit,
    },
    ledger: {packages, schemaVersion: 1, sourceCommit},
  };
}

function runModuleProgram(program) {
  const child = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', program],
    {cwd: repoRoot, encoding: 'utf8'},
  );

  if (child.status !== 0) {
    throw new Error(child.stderr || child.stdout);
  }

  return JSON.parse(child.stdout.trim());
}

test('verifies twelve packages in fair rounds with at most eight active queries', () => {
  const fixture = releaseFixture(12);
  const result = runModuleProgram(`
    import {verifyReleaseBatch} from ${JSON.stringify(verificationModuleUrl)};
    const fixture = ${JSON.stringify(fixture)};
    const attempts = new Map();
    const calls = [];
    let active = 0;
    let current = 0;
    let maximumObservedConcurrency = 0;
    const evidence = await verifyReleaseBatch({
      intervalMs: 25,
      journal: fixture.journal,
      ledger: fixture.ledger,
      maxConcurrency: 99,
      now: () => current,
      query: async (entry, {signal}) => {
        if (!(signal instanceof AbortSignal)) throw new Error('missing signal');
        const attempt = (attempts.get(entry.name) ?? 0) + 1;
        attempts.set(entry.name, attempt);
        calls.push(entry.name);
        active += 1;
        maximumObservedConcurrency = Math.max(maximumObservedConcurrency, active);
        await Promise.resolve();
        active -= 1;
        if (attempt === 1) throw Object.assign(new Error('not found'), {code: 'E404'});
        return {
          stdout: JSON.stringify({
            dist: {integrity: entry.integrity},
            name: entry.name,
            version: entry.version,
          }),
        };
      },
      sleep: async milliseconds => { current += milliseconds; },
    });
    console.log(JSON.stringify({calls, evidence, maximumObservedConcurrency}));
  `);

  expect(result.maximumObservedConcurrency).toBeLessThanOrEqual(8);
  expect(result.calls.slice(0, 12)).toEqual(
    fixture.ledger.packages.map(item => item.name),
  );
  expect(result.evidence.packages).toHaveLength(12);
  expect(result.evidence.schemaVersion).toBe(1);
  expect(result.evidence.sourceCommit).toBe(fixture.ledger.sourceCommit);
  expect(result.evidence.releaseTag).toBe(releaseTag);
  expect(result.evidence.packages.map(item => item.disposition)).toEqual(
    fixture.journal.packages.map(item => item.disposition),
  );
  expect(result.evidence.packages[0]).toEqual({
    attempts: 2,
    classification: 'verified',
    disposition: 'published',
    elapsedMs: 25,
    expectedIntegrity: fixture.ledger.packages[0].integrity,
    integrity: fixture.ledger.packages[0].integrity,
    name: '@pkg-nec/package-1',
    observedIntegrity: fixture.ledger.packages[0].integrity,
    order: 1,
    version: '1.0.0',
  });
});

test('uses one 480-second deadline and caps every query timer by remaining batch time', () => {
  const fixture = releaseFixture(2);
  const result = runModuleProgram(`
    import {verifyReleaseBatch} from ${JSON.stringify(verificationModuleUrl)};
    const fixture = ${JSON.stringify(fixture)};
    const calls = [];
    const cleared = [];
    const timers = [];
    let current = 0;
    let timerId = 0;
    globalThis.setTimeout = (_callback, milliseconds) => {
      timers.push(milliseconds);
      return ++timerId;
    };
    globalThis.clearTimeout = id => { cleared.push(id); };
    try {
      await verifyReleaseBatch({
        deadlineMs: 480_000,
        intervalMs: 300_000,
        journal: fixture.journal,
        ledger: fixture.ledger,
        now: () => current,
        query: async entry => {
          calls.push(entry.name);
          throw Object.assign(new Error('still absent'), {code: 'E404'});
        },
        queryTimeoutMs: 200_000,
        sleep: async milliseconds => { current += milliseconds; },
      });
    } catch (error) {
      console.log(JSON.stringify({
        calls,
        classification: error.classification,
        cleared,
        evidence: error.evidence,
        timers,
      }));
    }
  `);

  expect(result.classification).toBe('retryable');
  expect(result.calls).toEqual([
    '@pkg-nec/package-1',
    '@pkg-nec/package-2',
    '@pkg-nec/package-1',
    '@pkg-nec/package-2',
  ]);
  expect(result.timers).toEqual([200_000, 200_000, 180_000, 180_000]);
  expect(result.cleared).toEqual([1, 2, 3, 4]);
  expect(result.evidence.completedAt).toBe('1970-01-01T00:08:00.000Z');
  expect(result.evidence.elapsedMs).toBe(480_000);
  expect(result.evidence.packages.map(item => item.attempts)).toEqual([2, 2]);
  expect(result.evidence.packages.map(item => item.classification)).toEqual([
    'retryable',
    'retryable',
  ]);
  expect(result.evidence.packages.every(item => item.integrity === null)).toBe(
    true,
  );
});

test('accepts a match before the deadline but not at the deadline boundary', () => {
  const fixture = releaseFixture();
  const result = runModuleProgram(`
    import {verifyReleaseBatch} from ${JSON.stringify(verificationModuleUrl)};
    const fixture = ${JSON.stringify(fixture)};
    const entry = fixture.ledger.packages[0];
    const outcomes = [];
    for (const completedAt of [479_999, 480_000]) {
      let current = 0;
      try {
        const evidence = await verifyReleaseBatch({
          deadlineMs: 480_000,
          journal: fixture.journal,
          ledger: fixture.ledger,
          now: () => current,
          query: async () => {
            current = completedAt;
            return {
              dist: {integrity: entry.integrity},
              name: entry.name,
              version: entry.version,
            };
          },
          sleep: async milliseconds => { current += milliseconds; },
        });
        outcomes.push({classification: evidence.packages[0].classification});
      } catch (error) {
        outcomes.push({
          classification: error.classification,
          evidenceClassification: error.evidence.packages[0].classification,
        });
      }
    }
    console.log(JSON.stringify(outcomes));
  `);

  expect(result).toEqual([
    {classification: 'verified'},
    {classification: 'retryable', evidenceClassification: 'retryable'},
  ]);
});

test('settles timed-out non-cooperative queries and ignores late resolution or rejection', () => {
  const fixture = releaseFixture();
  const result = runModuleProgram(`
    import {verifyReleaseBatch} from ${JSON.stringify(verificationModuleUrl)};
    const fixture = ${JSON.stringify(fixture)};
    const entry = fixture.ledger.packages[0];
    const outcomes = [];
    const unhandled = [];
    process.on('unhandledRejection', error => { unhandled.push(error.message); });
    const cases = [
      {deadlineMs: 100, lateOutcome: 'resolve', lateAt: 20, queryTimeoutMs: 10},
      {deadlineMs: 100, lateOutcome: 'reject', lateAt: 20, queryTimeoutMs: 10},
      {deadlineMs: 75, lateOutcome: 'pending', lateAt: null, queryTimeoutMs: 200},
    ];
    for (const scenario of cases) {
      const cleared = [];
      const signals = [];
      const timers = [];
      let lateReject;
      let current = 0;
      let timerId = 0;
      globalThis.setTimeout = (callback, milliseconds) => {
        const id = ++timerId;
        timers.push(milliseconds);
        queueMicrotask(() => {
          current = Math.max(current, milliseconds);
          callback();
        });
        return id;
      };
      globalThis.clearTimeout = id => { cleared.push(id); };
      try {
        await verifyReleaseBatch({
          deadlineMs: scenario.deadlineMs,
          intervalMs: 100,
          journal: fixture.journal,
          ledger: fixture.ledger,
          now: () => current,
          query: async (_entry, {signal}) => {
            signals.push(signal);
            return new Promise((resolve, reject) => {
              if (scenario.lateOutcome === 'pending') {
                lateReject = reject;
                return;
              }
              setTimeout(() => {
                if (scenario.lateOutcome === 'resolve') {
                  resolve({
                    dist: {integrity: entry.integrity},
                    name: entry.name,
                    version: entry.version,
                  });
                } else {
                  reject(new Error('late query rejection'));
                }
              }, scenario.lateAt);
            });
          },
          queryTimeoutMs: scenario.queryTimeoutMs,
          sleep: async milliseconds => { current += milliseconds; },
        });
      } catch (error) {
        outcomes.push({
          attempts: error.evidence.packages[0].attempts,
          classification: error.classification,
          cleared,
          evidenceClassification: error.evidence.packages[0].classification,
          signalAborted: signals[0].aborted,
          timers,
        });
      }
      lateReject?.(new Error('late global-deadline rejection'));
      await new Promise(resolve => setImmediate(resolve));
    }
    console.log(JSON.stringify({outcomes, unhandled}));
  `);

  expect(result).toEqual({
    outcomes: [
      {
        attempts: 1,
        classification: 'retryable',
        cleared: [1],
        evidenceClassification: 'retryable',
        signalAborted: true,
        timers: [10, 20],
      },
      {
        attempts: 1,
        classification: 'retryable',
        cleared: [1],
        evidenceClassification: 'retryable',
        signalAborted: true,
        timers: [10, 20],
      },
      {
        attempts: 1,
        classification: 'retryable',
        cleared: [1],
        evidenceClassification: 'retryable',
        signalAborted: true,
        timers: [75],
      },
    ],
    unhandled: [],
  });
});

test('fatal failure settles a concurrent non-cooperative peer and cleans both timers', () => {
  const fixture = releaseFixture(2);
  const result = runModuleProgram(`
    import {verifyReleaseBatch} from ${JSON.stringify(verificationModuleUrl)};
    const fixture = ${JSON.stringify(fixture)};
    const cleared = [];
    const timers = [];
    const unhandled = [];
    let lateReject;
    let timerId = 0;
    process.on('unhandledRejection', error => { unhandled.push(error.message); });
    globalThis.setTimeout = (_callback, milliseconds) => {
      timers.push(milliseconds);
      return ++timerId;
    };
    globalThis.clearTimeout = id => { cleared.push(id); };
    try {
      await verifyReleaseBatch({
        journal: fixture.journal,
        ledger: fixture.ledger,
        now: () => 0,
        query: async entry => {
          if (entry.order === 1) {
            await Promise.resolve();
            throw Object.assign(new Error('authorization denied'), {code: 'E401'});
          }
          return new Promise((_resolve, reject) => { lateReject = reject; });
        },
        sleep: async () => { throw new Error('must not sleep'); },
      });
    } catch (error) {
      lateReject(new Error('late peer rejection'));
      await new Promise(resolve => setImmediate(resolve));
      console.log(JSON.stringify({
        classifications: error.evidence.packages.map(item => item.classification),
        cleared,
        errorClassification: error.classification,
        timers,
        unhandled,
      }));
    }
  `);

  expect(result).toEqual({
    classifications: ['fatal', 'cancelled'],
    cleared: [1, 2],
    errorClassification: 'fatal',
    timers: [10_000, 10_000],
    unhandled: [],
  });
});

test('early fatal failure cancels every queued package without starting extra queries', () => {
  const fixture = releaseFixture(12);
  const result = runModuleProgram(`
    import {verifyReleaseBatch} from ${JSON.stringify(verificationModuleUrl)};
    const fixture = ${JSON.stringify(fixture)};
    const calls = [];
    try {
      await verifyReleaseBatch({
        journal: fixture.journal,
        ledger: fixture.ledger,
        now: () => 100,
        query: async entry => {
          calls.push(entry.name);
          if (entry.order === 1) {
            throw Object.assign(new Error('authorization denied'), {code: 'E401'});
          }
          return new Promise(() => {});
        },
        sleep: async () => { throw new Error('must not sleep'); },
      });
    } catch (error) {
      console.log(JSON.stringify({
        attempts: error.evidence.packages.map(item => item.attempts),
        calls,
        classifications: error.evidence.packages.map(item => item.classification),
        elapsed: error.evidence.packages.map(item => item.elapsedMs),
        evidenceCount: error.evidence.packages.length,
        errorClassification: error.classification,
      }));
    }
  `);

  expect(result).toEqual({
    attempts: [1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0],
    calls: fixture.ledger.packages.slice(0, 8).map(item => item.name),
    classifications: [
      'fatal',
      'cancelled',
      'cancelled',
      'cancelled',
      'cancelled',
      'cancelled',
      'cancelled',
      'cancelled',
      'cancelled',
      'cancelled',
      'cancelled',
      'cancelled',
    ],
    elapsed: Array.from({length: 12}, () => 0),
    errorClassification: 'fatal',
    evidenceCount: 12,
  });
});

test('does not sleep after a successful final round near the deadline', () => {
  const fixture = releaseFixture();
  const result = runModuleProgram(`
    import {verifyReleaseBatch} from ${JSON.stringify(verificationModuleUrl)};
    const fixture = ${JSON.stringify(fixture)};
    const entry = fixture.ledger.packages[0];
    let current = 0;
    const sleeps = [];
    const evidence = await verifyReleaseBatch({
      deadlineMs: 480_000,
      journal: fixture.journal,
      ledger: fixture.ledger,
      now: () => current,
      query: async () => {
        current = 479_999;
        return {
          dist: {integrity: entry.integrity},
          name: entry.name,
          version: entry.version,
        };
      },
      sleep: async milliseconds => {
        sleeps.push(milliseconds);
        current += milliseconds;
      },
    });
    console.log(JSON.stringify({evidence, sleeps}));
  `);

  expect(result.sleeps).toEqual([]);
  expect(result.evidence.elapsedMs).toBe(479_999);
  expect(result.evidence.packages[0].elapsedMs).toBe(479_999);
  expect(result.evidence.packages[0].classification).toBe('verified');
});

test('retries only absence, timeout, rate-limit, and server failures', () => {
  const fixture = releaseFixture();
  const result = runModuleProgram(`
    import {verifyReleaseBatch} from ${JSON.stringify(verificationModuleUrl)};
    const fixture = ${JSON.stringify(fixture)};
    const entry = fixture.ledger.packages[0];
    const failures = [
      Object.assign(new Error('absent'), {code: 'E404'}),
      Object.assign(new Error('timed out'), {name: 'TimeoutError'}),
      Object.assign(new Error('rate limited'), {statusCode: 429}),
      Object.assign(new Error('unavailable'), {statusCode: 503}),
    ];
    let current = 0;
    let attempts = 0;
    const evidence = await verifyReleaseBatch({
      intervalMs: 10,
      journal: fixture.journal,
      ledger: fixture.ledger,
      now: () => current,
      query: async () => {
        const failure = failures[attempts];
        attempts += 1;
        if (failure) throw failure;
        return {dist: {integrity: entry.integrity}, name: entry.name, version: entry.version};
      },
      sleep: async milliseconds => { current += milliseconds; },
    });
    console.log(JSON.stringify({attempts, evidence}));
  `);

  expect(result.attempts).toBe(5);
  expect(result.evidence.packages[0].classification).toBe('verified');
  expect(result.evidence.packages[0].attempts).toBe(5);
});

test('authentication and authorization failures stop without retry and redact evidence errors', () => {
  const fixture = releaseFixture();
  const result = runModuleProgram(`
    import {verifyReleaseBatch} from ${JSON.stringify(verificationModuleUrl)};
    const fixture = ${JSON.stringify(fixture)};
    let sleeps = 0;
    try {
      await verifyReleaseBatch({
        journal: fixture.journal,
        ledger: fixture.ledger,
        now: () => 0,
        query: async () => {
          throw Object.assign(new Error('authorization: Bearer npm_secret'), {code: 'E401'});
        },
        sleep: async () => { sleeps += 1; },
      });
    } catch (error) {
      console.log(JSON.stringify({
        attempts: error.evidence.packages[0].attempts,
        classification: error.classification,
        evidenceClassification: error.evidence.packages[0].classification,
        message: error.message,
        sleeps,
      }));
    }
  `);

  expect(result).toEqual({
    attempts: 1,
    classification: 'fatal',
    evidenceClassification: 'fatal',
    message: expect.not.stringContaining('npm_secret'),
    sleeps: 0,
  });
});

test('identity, version, integrity, and malformed registry results fail immediately', () => {
  const fixture = releaseFixture();
  const entry = fixture.ledger.packages[0];
  const results = runModuleProgram(`
    import {verifyReleaseBatch} from ${JSON.stringify(verificationModuleUrl)};
    const fixture = ${JSON.stringify(fixture)};
    const entry = fixture.ledger.packages[0];
    const responses = [
      {dist: {integrity: entry.integrity}, name: '@pkg-nec/wrong', version: entry.version},
      {dist: {integrity: entry.integrity}, name: entry.name, version: '9.9.9'},
      {dist: {integrity: 'sha512-different'}, name: entry.name, version: entry.version},
      {name: entry.name, version: entry.version},
    ];
    const results = [];
    for (const response of responses) {
      let attempts = 0;
      try {
        await verifyReleaseBatch({
          journal: fixture.journal,
          ledger: fixture.ledger,
          now: () => 0,
          query: async () => { attempts += 1; return response; },
          sleep: async () => { throw new Error('must not sleep'); },
        });
      } catch (error) {
        results.push({
          attempts,
          classification: error.classification,
          observedIntegrity: error.evidence.packages[0].observedIntegrity,
        });
      }
    }
    console.log(JSON.stringify(results));
  `);

  expect(results).toEqual([
    {attempts: 1, classification: 'fatal', observedIntegrity: entry.integrity},
    {attempts: 1, classification: 'fatal', observedIntegrity: entry.integrity},
    {
      attempts: 1,
      classification: 'fatal',
      observedIntegrity: 'sha512-different',
    },
    {attempts: 1, classification: 'fatal', observedIntegrity: null},
  ]);
});

test('command queries exact public npm identities and writes deterministic evidence', () => {
  const fixture = releaseFixture();
  const result = runModuleProgram(`
    import {runVerifyReleaseCommand} from ${JSON.stringify(verificationCommandModuleUrl)};
    const fixture = ${JSON.stringify(fixture)};
    const calls = [];
    const writes = [];
    const evidence = await runVerifyReleaseCommand({
      args: ['ledger.json', 'journal.json', 'evidence.json', 'evidence.md'],
      now: () => 0,
      readFile: async file => JSON.stringify(file === 'ledger.json' ? fixture.ledger : fixture.journal),
      runNpm: async (command, args, options) => {
        calls.push({args, command, hasSignal: options.signal instanceof AbortSignal});
        const entry = fixture.ledger.packages[0];
        return {stdout: JSON.stringify({
          dist: {integrity: entry.integrity},
          name: entry.name,
          version: entry.version,
        })};
      },
      sleep: async () => {},
      write: value => calls.push({write: value}),
      writeFile: async (file, value) => { writes.push({file, value: String(value)}); },
    });
    console.log(JSON.stringify({calls, evidence, writes}));
  `);

  expect(result.calls[0]).toEqual({
    args: [
      'view',
      '@pkg-nec/package-1@1.0.0',
      '--json',
      '--registry=https://registry.npmjs.org/',
    ],
    command: 'npm',
    hasSignal: true,
  });
  expect(result.writes[0]).toEqual({
    file: 'evidence.json',
    value: `${JSON.stringify(result.evidence, null, 2)}\n`,
  });
  expect(result.writes[1]).toEqual({
    file: 'evidence.md',
    value:
      '# pkg-nec registry verification\n\n' +
      '| Order | Package | Version | Disposition | Attempts | Elapsed milliseconds | Expected integrity | Observed integrity | Classification |\n' +
      '| ---: | --- | --- | --- | ---: | ---: | --- | --- | --- |\n' +
      `| 1 | @pkg-nec/package-1 | 1.0.0 | published | 1 | 0 | ${fixture.ledger.packages[0].integrity} | ${fixture.ledger.packages[0].integrity} | verified |\n`,
  });
});

test('Markdown escapes every table cell and contains malicious registry metadata literally', () => {
  const result = runModuleProgram(`
    import {registryEvidenceMarkdown} from ${JSON.stringify(verificationCommandModuleUrl)};
    const markdown = registryEvidenceMarkdown({
      packages: [{
        attempts: '1*2',
        classification: '_fatal_',
        disposition: '*published*',
        elapsedMs: '0\\n1',
        expectedIntegrity: 'sha512-good|x',
        name: '<pkg>\\nname',
        observedIntegrity: 'sha512-bad|cell\\n<img src=x onerror=alert(1)>[link](javascript:alert(1))*bold*',
        order: '1|x',
        version: '[1.0.0]',
      }],
    });
    console.log(JSON.stringify({markdown}));
  `);

  expect(result.markdown).toBe(
    '# pkg-nec registry verification\n\n' +
      '| Order | Package | Version | Disposition | Attempts | Elapsed milliseconds | Expected integrity | Observed integrity | Classification |\n' +
      '| ---: | --- | --- | --- | ---: | ---: | --- | --- | --- |\n' +
      '| 1\\|x | &lt;pkg&gt;\\\\nname | \\[1.0.0\\] | \\*published\\* | 1\\*2 | 0\\\\n1 | sha512-good\\|x | sha512-bad\\|cell\\\\n&lt;img src=x onerror=alert\\(1\\)&gt;\\[link\\]\\(javascript:alert\\(1\\)\\)\\*bold\\* | \\_fatal\\_ |\n',
  );
  expect(result.markdown).not.toContain('<img');
  expect(result.markdown.split('\n')).toHaveLength(6);
});

test('command persists stable partial JSON and Markdown before rejecting', () => {
  const fixture = releaseFixture();
  const result = runModuleProgram(`
    import {runVerifyReleaseCommand} from ${JSON.stringify(verificationCommandModuleUrl)};
    const fixture = ${JSON.stringify(fixture)};
    const events = [];
    try {
      await runVerifyReleaseCommand({
        args: ['ledger.json', 'journal.json', 'evidence.json', 'evidence.md'],
        now: () => 0,
        readFile: async file => JSON.stringify(file === 'ledger.json' ? fixture.ledger : fixture.journal),
        runNpm: async () => {
          throw Object.assign(new Error('_authToken=npm_secret'), {code: 'E403'});
        },
        sleep: async () => {},
        writeFile: async (file, value) => events.push({file, value: String(value)}),
      });
    } catch (error) {
      events.push({classification: error.classification, message: error.message});
    }
    console.log(JSON.stringify(events));
  `);

  expect(result.map(event => event.file ?? event.classification)).toEqual([
    'evidence.json',
    'evidence.md',
    'fatal',
  ]);
  const partial = JSON.parse(result[0].value);
  expect(partial.packages[0]).toEqual({
    attempts: 1,
    classification: 'fatal',
    disposition: 'published',
    elapsedMs: 0,
    expectedIntegrity: fixture.ledger.packages[0].integrity,
    integrity: null,
    name: '@pkg-nec/package-1',
    observedIntegrity: null,
    order: 1,
    version: '1.0.0',
  });
  expect(result[0].value).toBe(`${JSON.stringify(partial, null, 2)}\n`);
  expect(result[1].value).toContain('| 1 | @pkg-nec/package-1 |');
  expect(JSON.stringify(result)).not.toContain('npm_secret');
});
