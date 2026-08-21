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

function npmSubjectName({name, version}) {
  const [scope, packageName] = name.split('/');
  return `pkg:npm/${encodeURIComponent(scope)}/${encodeURIComponent(
    packageName,
  )}@${encodeURIComponent(version)}`;
}

function normalizedProvenance(entry) {
  return {
    buildType:
      'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1',
    bundleDigest: `sha256-${String(entry.order).padStart(64, '0')}`,
    predicateType: 'https://slsa.dev/provenance/v1',
    repository: 'https://github.com/pkg-nec/jest',
    runnerEnvironment: 'github-hosted',
    sourceCommit,
    sourceRef: `refs/tags/${releaseTag}`,
    subjectName: npmSubjectName(entry),
    subjectSha512: Buffer.from(
      entry.integrity.slice('sha512-'.length),
      'base64',
    ).toString('hex'),
    transparencyLogIds: [`rekor-${entry.order}`],
    workflowPath: '.github/workflows/release.yml',
  };
}

function releaseFixture(count = 1) {
  const names = Array.from(
    {length: count},
    (_, index) => `@pkg-nec/package-${index + 1}`,
  ).sort((left, right) => left.localeCompare(right));
  const packages = names.map((name, index) => ({
    files: ['package.json'],
    integrity: integrity(index + 1),
    name,
    order: index + 1,
    prerequisites: [],
    tarball: `.pkg-nec-release/${name.slice('@pkg-nec/'.length)}.tgz`,
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
    ledger: {
      generatedAt: '2026-08-19T12:34:56.000Z',
      nodeVersion: 'v22.23.1',
      packageManager: 'yarn@4.18.0',
      packages,
      releasePlan: {
        digest: `sha256-${'a'.repeat(64)}`,
        path: 'docs/releases/pkg-nec-jest-v30.4.3-plan.json',
      },
      schemaVersion: 2,
      sourceCommit,
    },
    provenance: packages.map(normalizedProvenance),
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
          integrity: entry.integrity,
          name: entry.name,
          provenance: fixture.provenance[entry.order - 1],
          version: entry.version,
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
  expect(result.calls).toEqual([
    ...fixture.ledger.packages.map(item => item.name),
    ...fixture.ledger.packages.map(item => item.name),
  ]);
  expect(result.evidence.registryEvidence.packages).toHaveLength(12);
  expect(result.evidence.registryEvidence.schemaVersion).toBe(1);
  expect(result.evidence.registryEvidence.sourceCommit).toBe(
    fixture.ledger.sourceCommit,
  );
  expect(result.evidence.registryEvidence.releaseTag).toBe(releaseTag);
  expect(
    result.evidence.registryEvidence.packages.map(item => item.disposition),
  ).toEqual(fixture.journal.packages.map(item => item.disposition));
  expect(result.evidence.registryEvidence.packages[0]).toEqual({
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
  expect(
    result.evidence.provenanceEvidence.packages.map(item => item.name),
  ).toEqual(fixture.ledger.packages.map(item => item.name));
  expect(result.evidence.provenanceEvidence.packages[0]).toEqual({
    ...fixture.provenance[0],
    attempts: 2,
    classification: 'verified',
    disposition: 'published',
    elapsedMs: 25,
    name: '@pkg-nec/package-1',
    order: 1,
    version: '1.0.0',
  });
  expect(
    result.evidence.provenanceEvidence.packages.map(item => item.disposition),
  ).toEqual(fixture.journal.packages.map(item => item.disposition));
});

test('prepares one query before all bounded retry rounds', () => {
  const fixture = releaseFixture(12);
  const result = runModuleProgram(`
    import {verifyReleaseBatch} from ${JSON.stringify(verificationModuleUrl)};
    const fixture = ${JSON.stringify(fixture)};
    const attempts = new Map();
    const calls = [];
    let active = 0;
    let current = 0;
    let maximumActive = 0;
    let preparationCalls = 0;
    const evidence = await verifyReleaseBatch({
      deadlineMs: 480_000,
      intervalMs: 25,
      journal: fixture.journal,
      ledger: fixture.ledger,
      maxConcurrency: 99,
      now: () => current,
      prepareQuery: async ({deadlineAt, signal, timeoutMs}) => {
        preparationCalls += 1;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Promise.resolve();
        active -= 1;
        calls.push({
          deadlineAt,
          preparationAborted: signal.aborted,
          preparationTimeoutMs: timeoutMs,
        });
        return async (entry, {signal: querySignal}) => {
          if (!(querySignal instanceof AbortSignal)) {
            throw new Error('missing query signal');
          }
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          const attempt = (attempts.get(entry.name) ?? 0) + 1;
          attempts.set(entry.name, attempt);
          await Promise.resolve();
          active -= 1;
          if (attempt === 1) {
            throw Object.assign(new Error('not found'), {code: 'E404'});
          }
          return {
            integrity: entry.integrity,
            name: entry.name,
            provenance: fixture.provenance[entry.order - 1],
            version: entry.version,
          };
        };
      },
      query: async () => {
        throw new Error('unprepared query must not run');
      },
      sleep: async milliseconds => { current += milliseconds; },
    });
    console.log(JSON.stringify({
      calls,
      maximumActive,
      packageAttempts: evidence.registryEvidence.packages.map(
        item => item.attempts,
      ),
      preparationCalls,
    }));
  `);

  expect(result).toEqual({
    calls: [
      {
        deadlineAt: 480_000,
        preparationAborted: false,
        preparationTimeoutMs: 480_000,
      },
    ],
    maximumActive: 8,
    packageAttempts: Array.from({length: 12}, () => 2),
    preparationCalls: 1,
  });
});

test('cancels deadline-bound preparation and handles its late rejection', () => {
  const fixture = releaseFixture();
  const result = runModuleProgram(`
    import {verifyReleaseBatch} from ${JSON.stringify(verificationModuleUrl)};
    const fixture = ${JSON.stringify(fixture)};
    const cleared = [];
    const timers = [];
    const unhandled = [];
    let current = 0;
    let lateReject;
    let preparationSignal;
    let queryCalls = 0;
    let timerId = 0;
    process.on('unhandledRejection', error => { unhandled.push(error.message); });
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
        deadlineMs: 75,
        journal: fixture.journal,
        ledger: fixture.ledger,
        now: () => current,
        prepareQuery: async ({signal}) => {
          preparationSignal = signal;
          return new Promise((_resolve, reject) => { lateReject = reject; });
        },
        query: async () => { queryCalls += 1; },
        sleep: async () => {},
      });
    } catch (error) {
      lateReject?.(new Error('late preparation rejection with npm-secret'));
      await new Promise(resolve => setImmediate(resolve));
      console.log(JSON.stringify({
        attempts: error.evidence.provenanceEvidence.packages[0].attempts,
        classification: error.classification,
        cleared,
        evidenceClassification:
          error.evidence.provenanceEvidence.packages[0].classification,
        preparationAborted: preparationSignal?.aborted ?? null,
        queryCalls,
        timers,
        unhandled,
      }));
    }
  `);

  expect(result).toEqual({
    attempts: 0,
    classification: 'retryable',
    cleared: [1],
    evidenceClassification: 'retryable',
    preparationAborted: true,
    queryCalls: 0,
    timers: [75],
    unhandled: [],
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
          throw Object.assign(new Error('attestation still absent'), {
            classification: 'retryable',
            code: 'EMISSINGATTESTATIONS',
          });
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
  for (const evidence of [
    result.evidence.provenanceEvidence,
    result.evidence.registryEvidence,
  ]) {
    expect(evidence.completedAt).toBe('1970-01-01T00:08:00.000Z');
    expect(evidence.elapsedMs).toBe(480_000);
    expect(evidence.packages.map(item => item.attempts)).toEqual([2, 2]);
    expect(evidence.packages.map(item => item.classification)).toEqual([
      'retryable',
      'retryable',
    ]);
  }
  expect(
    result.evidence.registryEvidence.packages.every(
      item => item.integrity === null,
    ),
  ).toBe(true);
  expect(
    result.evidence.provenanceEvidence.packages.every(
      item => item.bundleDigest === null,
    ),
  ).toBe(true);
});

test('accepts a match before the deadline but not at the deadline boundary', () => {
  const fixture = releaseFixture();
  const result = runModuleProgram(`
    import {verifyReleaseBatch} from ${JSON.stringify(verificationModuleUrl)};
    const fixture = ${JSON.stringify(fixture)};
    const entry = fixture.ledger.packages[0];
    const outcomes = [];
    for (const completedAt of [479_999, 480_000, 480_001]) {
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
              integrity: entry.integrity,
              name: entry.name,
              provenance: fixture.provenance[0],
              version: entry.version,
            };
          },
          sleep: async milliseconds => { current += milliseconds; },
        });
        outcomes.push({
          classification:
            evidence.provenanceEvidence.packages[0].classification,
        });
      } catch (error) {
        outcomes.push({
          classification: error.classification,
          evidenceClassification:
            error.evidence.provenanceEvidence.packages[0].classification,
        });
      }
    }
    console.log(JSON.stringify(outcomes));
  `);

  expect(result).toEqual([
    {classification: 'verified'},
    {classification: 'retryable', evidenceClassification: 'retryable'},
    {classification: 'retryable', evidenceClassification: 'retryable'},
  ]);
});

test('rejects fatal combined evidence received at or after the deadline', () => {
  const fixture = releaseFixture();
  const result = runModuleProgram(`
    import {verifyReleaseBatch} from ${JSON.stringify(verificationModuleUrl)};
    const fixture = ${JSON.stringify(fixture)};
    const entry = fixture.ledger.packages[0];
    const scenarios = [
      {
        completedAt: 480_000,
        kind: 'identity',
        response: {
          integrity: entry.integrity,
          name: '@pkg-nec/wrong',
          provenance: fixture.provenance[0],
          version: entry.version,
        },
      },
      {
        completedAt: 480_001,
        kind: 'integrity',
        response: {
          integrity: 'sha512-different',
          name: entry.name,
          provenance: fixture.provenance[0],
          version: entry.version,
        },
      },
      {
        completedAt: 480_000,
        kind: 'malformed-provenance',
        response: {
          integrity: entry.integrity,
          name: entry.name,
          provenance: null,
          version: entry.version,
        },
      },
      {
        completedAt: 480_001,
        error: Object.assign(new Error('invalid repository claim'), {
          classification: 'fatal',
          code: 'EPROVENANCECLAIM',
        }),
        kind: 'fatal-provenance-claim',
      },
    ];
    const outcomes = [];
    for (const scenario of scenarios) {
      let current = 0;
      let querySignal;
      let sleeps = 0;
      try {
        await verifyReleaseBatch({
          deadlineMs: 480_000,
          journal: fixture.journal,
          ledger: fixture.ledger,
          now: () => current,
          query: async (_entry, {signal}) => {
            querySignal = signal;
            current = scenario.completedAt;
            if (scenario.error) throw scenario.error;
            return scenario.response;
          },
          sleep: async () => { sleeps += 1; },
        });
      } catch (error) {
        outcomes.push({
          attempts: error.evidence.registryEvidence.packages[0].attempts,
          classification: error.classification,
          kind: scenario.kind,
          observedIntegrity:
            error.evidence.registryEvidence.packages[0].observedIntegrity,
          provenanceBundleDigest:
            error.evidence.provenanceEvidence.packages[0].bundleDigest,
          provenanceClassification:
            error.evidence.provenanceEvidence.packages[0].classification,
          registryClassification:
            error.evidence.registryEvidence.packages[0].classification,
          signalAborted: querySignal.aborted,
          sleeps,
        });
      }
    }
    console.log(JSON.stringify(outcomes));
  `);

  expect(result).toEqual([
    {
      attempts: 1,
      classification: 'fatal',
      kind: 'identity',
      observedIntegrity: fixture.ledger.packages[0].integrity,
      provenanceBundleDigest: fixture.provenance[0].bundleDigest,
      provenanceClassification: 'fatal',
      registryClassification: 'fatal',
      signalAborted: true,
      sleeps: 0,
    },
    {
      attempts: 1,
      classification: 'fatal',
      kind: 'integrity',
      observedIntegrity: 'sha512-different',
      provenanceBundleDigest: fixture.provenance[0].bundleDigest,
      provenanceClassification: 'fatal',
      registryClassification: 'fatal',
      signalAborted: true,
      sleeps: 0,
    },
    {
      attempts: 1,
      classification: 'fatal',
      kind: 'malformed-provenance',
      observedIntegrity: fixture.ledger.packages[0].integrity,
      provenanceBundleDigest: null,
      provenanceClassification: 'fatal',
      registryClassification: 'fatal',
      signalAborted: true,
      sleeps: 0,
    },
    {
      attempts: 1,
      classification: 'fatal',
      kind: 'fatal-provenance-claim',
      observedIntegrity: null,
      provenanceBundleDigest: null,
      provenanceClassification: 'fatal',
      registryClassification: 'fatal',
      signalAborted: true,
      sleeps: 0,
    },
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
                    integrity: entry.integrity,
                    name: entry.name,
                    provenance: fixture.provenance[0],
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
          attempts: error.evidence.provenanceEvidence.packages[0].attempts,
          classification: error.classification,
          cleared,
          evidenceClassification:
            error.evidence.provenanceEvidence.packages[0].classification,
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
            throw Object.assign(new Error('invalid source repository claim'), {
              classification: 'fatal',
              code: 'EPROVENANCECLAIM',
            });
          }
          return new Promise((_resolve, reject) => { lateReject = reject; });
        },
        sleep: async () => { throw new Error('must not sleep'); },
      });
    } catch (error) {
      lateReject(new Error('late peer rejection'));
      await new Promise(resolve => setImmediate(resolve));
      console.log(JSON.stringify({
        classifications: error.evidence.provenanceEvidence.packages.map(
          item => item.classification,
        ),
        registryClassifications: error.evidence.registryEvidence.packages.map(
          item => item.classification,
        ),
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
    registryClassifications: ['fatal', 'cancelled'],
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
            throw Object.assign(new Error('invalid signature'), {
              classification: 'fatal',
              code: 'EATTESTATIONVERIFY',
            });
          }
          return new Promise(() => {});
        },
        sleep: async () => { throw new Error('must not sleep'); },
      });
    } catch (error) {
      console.log(JSON.stringify({
        attempts: error.evidence.provenanceEvidence.packages.map(
          item => item.attempts,
        ),
        calls,
        classifications: error.evidence.provenanceEvidence.packages.map(
          item => item.classification,
        ),
        elapsed: error.evidence.provenanceEvidence.packages.map(
          item => item.elapsedMs,
        ),
        evidenceCount: error.evidence.provenanceEvidence.packages.length,
        registryEvidenceCount: error.evidence.registryEvidence.packages.length,
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
    registryEvidenceCount: 12,
  });
});

test('fatal failure cancels retryable packages queued from an earlier round', () => {
  const fixture = releaseFixture(2);
  const result = runModuleProgram(`
    import {verifyReleaseBatch} from ${JSON.stringify(verificationModuleUrl)};
    const fixture = ${JSON.stringify(fixture)};
    const attempts = new Map();
    const calls = [];
    let current = 0;
    try {
      await verifyReleaseBatch({
        intervalMs: 10,
        journal: fixture.journal,
        ledger: fixture.ledger,
        maxConcurrency: 1,
        now: () => current,
        query: async entry => {
          calls.push(entry.name);
          const attempt = (attempts.get(entry.name) ?? 0) + 1;
          attempts.set(entry.name, attempt);
          if (entry.order === 1 && attempt === 2) {
            throw Object.assign(new Error('invalid signature'), {
              classification: 'fatal',
              code: 'EATTESTATIONVERIFY',
            });
          }
          throw Object.assign(new Error('attestation absent'), {
            classification: 'retryable',
            code: 'EMISSINGATTESTATIONS',
          });
        },
        sleep: async milliseconds => { current += milliseconds; },
      });
    } catch (error) {
      console.log(JSON.stringify({
        calls,
        provenanceClassifications: error.evidence.provenanceEvidence.packages.map(
          item => item.classification,
        ),
        registryClassifications: error.evidence.registryEvidence.packages.map(
          item => item.classification,
        ),
      }));
    }
  `);

  expect(result).toEqual({
    calls: ['@pkg-nec/package-1', '@pkg-nec/package-2', '@pkg-nec/package-1'],
    provenanceClassifications: ['fatal', 'cancelled'],
    registryClassifications: ['fatal', 'cancelled'],
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
          integrity: entry.integrity,
          name: entry.name,
          provenance: fixture.provenance[0],
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
  expect(result.evidence.provenanceEvidence.elapsedMs).toBe(479_999);
  expect(result.evidence.registryEvidence.elapsedMs).toBe(479_999);
  expect(result.evidence.provenanceEvidence.packages[0].elapsedMs).toBe(
    479_999,
  );
  expect(result.evidence.registryEvidence.packages[0].elapsedMs).toBe(479_999);
  expect(result.evidence.provenanceEvidence.packages[0].classification).toBe(
    'verified',
  );
});

test('retries only absence, timeout, rate-limit, and server failures', () => {
  const fixture = releaseFixture();
  const result = runModuleProgram(`
    import {verifyReleaseBatch} from ${JSON.stringify(verificationModuleUrl)};
    const fixture = ${JSON.stringify(fixture)};
    const entry = fixture.ledger.packages[0];
    const failures = [
      Object.assign(new Error('attestation absent'), {
        classification: 'retryable',
        code: 'EMISSINGATTESTATIONS',
      }),
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
        return {
          integrity: entry.integrity,
          name: entry.name,
          provenance: fixture.provenance[0],
          version: entry.version,
        };
      },
      sleep: async milliseconds => { current += milliseconds; },
    });
    console.log(JSON.stringify({attempts, evidence}));
  `);

  expect(result.attempts).toBe(5);
  expect(result.evidence.provenanceEvidence.packages[0].classification).toBe(
    'verified',
  );
  expect(result.evidence.provenanceEvidence.packages[0].attempts).toBe(5);
  expect(result.evidence.registryEvidence.packages[0].attempts).toBe(5);
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
        attempts: error.evidence.provenanceEvidence.packages[0].attempts,
        classification: error.classification,
        evidenceClassification:
          error.evidence.provenanceEvidence.packages[0].classification,
        message: error.message,
        registryEvidenceClassification:
          error.evidence.registryEvidence.packages[0].classification,
        sleeps,
      }));
    }
  `);

  expect(result).toEqual({
    attempts: 1,
    classification: 'fatal',
    evidenceClassification: 'fatal',
    message: expect.not.stringContaining('npm_secret'),
    registryEvidenceClassification: 'fatal',
    sleeps: 0,
  });
});

test('identity, version, integrity, and malformed combined results fail immediately', () => {
  const fixture = releaseFixture();
  const entry = fixture.ledger.packages[0];
  const results = runModuleProgram(`
    import {verifyReleaseBatch} from ${JSON.stringify(verificationModuleUrl)};
    const fixture = ${JSON.stringify(fixture)};
    const entry = fixture.ledger.packages[0];
    const responses = [
      {
        integrity: entry.integrity,
        name: '@pkg-nec/wrong',
        provenance: fixture.provenance[0],
        version: entry.version,
      },
      {
        integrity: entry.integrity,
        name: entry.name,
        provenance: fixture.provenance[0],
        version: '9.9.9',
      },
      {
        integrity: 'sha512-different',
        name: entry.name,
        provenance: fixture.provenance[0],
        version: entry.version,
      },
      {name: entry.name, provenance: fixture.provenance[0], version: entry.version},
      {integrity: entry.integrity, name: entry.name, version: entry.version},
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
          observedIntegrity:
            error.evidence.registryEvidence.packages[0].observedIntegrity,
          provenanceClassification:
            error.evidence.provenanceEvidence.packages[0].classification,
        });
      }
    }
    console.log(JSON.stringify(results));
  `);

  expect(results).toEqual([
    {
      attempts: 1,
      classification: 'fatal',
      observedIntegrity: entry.integrity,
      provenanceClassification: 'fatal',
    },
    {
      attempts: 1,
      classification: 'fatal',
      observedIntegrity: entry.integrity,
      provenanceClassification: 'fatal',
    },
    {
      attempts: 1,
      classification: 'fatal',
      observedIntegrity: 'sha512-different',
      provenanceClassification: 'fatal',
    },
    {
      attempts: 1,
      classification: 'fatal',
      observedIntegrity: null,
      provenanceClassification: 'fatal',
    },
    {
      attempts: 1,
      classification: 'fatal',
      observedIntegrity: entry.integrity,
      provenanceClassification: 'fatal',
    },
  ]);
});

test('command queries combined npm evidence and atomically writes four deterministic files', () => {
  const fixture = releaseFixture();
  const result = runModuleProgram(`
    import {runVerifyReleaseCommand} from ${JSON.stringify(verificationCommandModuleUrl)};
    const fixture = ${JSON.stringify(fixture)};
    const calls = [];
    const foreignTemporary = new Map();
    const renames = [];
    const unlinks = [];
    const writes = [];
    const evidence = await runVerifyReleaseCommand({
      args: [
        'ledger.json',
        'journal.json',
        'registry.json',
        'registry.md',
        'provenance.json',
        'provenance.md',
      ],
      now: () => 0,
      readFile: async file => JSON.stringify(file === 'ledger.json' ? fixture.ledger : fixture.journal),
      queryNpmEvidence: async ({entry, releaseTag, signal, sourceCommit}) => {
        calls.push({
          entry,
          hasSignal: signal instanceof AbortSignal,
          releaseTag,
          sourceCommit,
        });
        return {
          integrity: entry.integrity,
          name: entry.name,
          provenance: {
            ...fixture.provenance[0],
            certificate: 'raw-certificate-secret',
            credential: 'npm_token_secret',
            rawBundle: {dsseEnvelope: 'raw-signature-secret'},
          },
          version: entry.version,
        };
      },
      rename: async (source, destination) => {
        renames.push({destination, source});
        foreignTemporary.set(source, 'foreign-after-' + destination);
      },
      sleep: async () => {},
      unlink: async file => {
        unlinks.push(file);
        foreignTemporary.delete(file);
      },
      write: value => calls.push({write: value}),
      writeFile: async (file, value, options) => {
        writes.push({file, options, value: String(value)});
      },
    });
    console.log(JSON.stringify({
      calls,
      evidence,
      foreignTemporary: Object.fromEntries(foreignTemporary),
      renames,
      unlinks,
      writes,
    }));
  `);

  expect(result.calls[0]).toEqual({
    entry: fixture.ledger.packages[0],
    hasSignal: true,
    releaseTag,
    sourceCommit,
  });
  const destinations = [
    'registry.json',
    'registry.md',
    'provenance.json',
    'provenance.md',
  ];
  expect(new Set(result.writes.map(item => item.file)).size).toBe(4);
  for (const [index, destination] of destinations.entries()) {
    expect(result.writes[index].file).toMatch(
      new RegExp(
        `^${destination.replace('.', '\\.')}\\.\\d+\\.[0-9a-f-]+\\.tmp$`,
        'u',
      ),
    );
    expect(result.writes[index].options).toEqual({flag: 'wx'});
    expect(result.renames[index]).toEqual({
      destination,
      source: result.writes[index].file,
    });
  }
  expect(result.unlinks).toEqual([]);
  for (const [index, destination] of destinations.entries()) {
    expect(result.foreignTemporary[result.writes[index].file]).toBe(
      `foreign-after-${destination}`,
    );
  }
  expect(result.writes[0]).toEqual({
    file: result.writes[0].file,
    options: {flag: 'wx'},
    value: `${JSON.stringify(result.evidence.registryEvidence, null, 2)}\n`,
  });
  expect(result.writes[1]).toEqual({
    file: result.writes[1].file,
    options: {flag: 'wx'},
    value:
      '# pkg-nec registry verification\n\n' +
      '| Order | Package | Version | Disposition | Attempts | Elapsed milliseconds | Expected integrity | Observed integrity | Classification |\n' +
      '| ---: | --- | --- | --- | ---: | ---: | --- | --- | --- |\n' +
      `| 1 | @pkg-nec/package-1 | 1.0.0 | published | 1 | 0 | ${fixture.ledger.packages[0].integrity} | ${fixture.ledger.packages[0].integrity} | verified |\n`,
  });
  expect(result.writes[2]).toEqual({
    file: result.writes[2].file,
    options: {flag: 'wx'},
    value: `${JSON.stringify(result.evidence.provenanceEvidence, null, 2)}\n`,
  });
  expect(result.writes[3]).toEqual({
    file: result.writes[3].file,
    options: {flag: 'wx'},
    value:
      '# pkg-nec provenance verification\n\n' +
      '| Order | Package | Version | Attempts | Elapsed milliseconds | Predicate type | Repository | Workflow | Ref | Source commit | Runner | Bundle digest | Transparency-log IDs | Classification |\n' +
      '| ---: | --- | --- | ---: | ---: | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n' +
      `| 1 | @pkg-nec/package-1 | 1.0.0 | 1 | 0 | https://slsa.dev/provenance/v1 | https://github.com/pkg-nec/jest | .github/workflows/release.yml | refs/tags/${releaseTag} | ${sourceCommit} | github-hosted | ${fixture.provenance[0].bundleDigest} | rekor-1 | verified |\n`,
  });
  expect(JSON.stringify(result)).not.toMatch(
    /raw-certificate-secret|npm_token_secret|raw-signature-secret/u,
  );
});

test('exclusive temp-file collisions preserve foreign files and later outputs', () => {
  const fixture = releaseFixture();
  const result = runModuleProgram(`
    import {runVerifyReleaseCommand} from ${JSON.stringify(verificationCommandModuleUrl)};
    const fixture = ${JSON.stringify(fixture)};
    const canonical = new Map([['registry.json', 'old-registry-json']]);
    const events = [];
    const temporary = new Map();
    let collisionPath;
    try {
      await runVerifyReleaseCommand({
        args: [
          'ledger.json',
          'journal.json',
          'registry.json',
          'registry.md',
          'provenance.json',
          'provenance.md',
        ],
        now: () => 0,
        readFile: async file => JSON.stringify(
          file === 'ledger.json' ? fixture.ledger : fixture.journal,
        ),
        queryNpmEvidence: async ({entry}) => ({
          integrity: entry.integrity,
          name: entry.name,
          provenance: fixture.provenance[0],
          version: entry.version,
        }),
        rename: async (source, destination) => {
          events.push({destination, kind: 'rename', source});
          canonical.set(destination, temporary.get(source));
          temporary.delete(source);
        },
        sleep: async () => {},
        unlink: async file => {
          events.push({file, kind: 'unlink'});
          temporary.delete(file);
        },
        write: value => { events.push({kind: 'success', value}); },
        writeFile: async (file, value) => {
          events.push({file, kind: 'write'});
          if (!collisionPath) {
            collisionPath = file;
            temporary.set(file, 'foreign-temp-file');
            throw Object.assign(new Error('exclusive collision'), {code: 'EEXIST'});
          }
          temporary.set(file, String(value));
        },
      });
    } catch (error) {
      console.log(JSON.stringify({
        canonical: Object.fromEntries(canonical),
        collisionPath,
        code: error.code,
        events,
        failedOutputs: error.failedOutputs,
        temporary: Object.fromEntries(temporary),
      }));
    }
  `);

  expect(result.code).toBe('EEVIDENCEPERSIST');
  expect(result.failedOutputs).toEqual(['registry-json']);
  expect(result.events.filter(event => event.kind === 'write')).toHaveLength(4);
  expect(result.events.filter(event => event.kind === 'rename')).toHaveLength(
    3,
  );
  expect(result.events.filter(event => event.kind === 'unlink')).toEqual([]);
  expect(
    result.events.some(
      event => event.file === result.collisionPath && event.kind === 'unlink',
    ),
  ).toBe(false);
  expect(result.temporary).toEqual({
    [result.collisionPath]: 'foreign-temp-file',
  });
  expect(result.canonical['registry.json']).toBe('old-registry-json');
  expect(result.events.some(event => event.kind === 'success')).toBe(false);
});

test('best-effort atomic persistence preserves canonical files and the primary verification error', () => {
  const fixture = releaseFixture();
  const result = runModuleProgram(`
    import {runVerifyReleaseCommand} from ${JSON.stringify(verificationCommandModuleUrl)};
    const fixture = ${JSON.stringify(fixture)};
    const canonical = new Map([
      ['registry.json', 'old-registry-json'],
      ['registry.md', 'old-registry-markdown'],
      ['provenance.json', 'old-provenance-json'],
      ['provenance.md', 'old-provenance-markdown'],
    ]);
    const events = [];
    const temporary = new Map();
    try {
      await runVerifyReleaseCommand({
        args: [
          'ledger.json',
          'journal.json',
          'registry.json',
          'registry.md',
          'provenance.json',
          'provenance.md',
        ],
        now: () => 0,
        readFile: async file => JSON.stringify(
          file === 'ledger.json' ? fixture.ledger : fixture.journal,
        ),
        queryNpmEvidence: async () => {
          throw Object.assign(new Error('primary verification failure'), {
            classification: 'fatal',
            code: 'EPROVENANCECLAIM',
          });
        },
        rename: async (source, destination) => {
          events.push({destination, kind: 'rename', source});
          if (destination === 'provenance.json') {
            throw new Error('rename interrupted with npm-secret');
          }
          canonical.set(destination, temporary.get(source));
          temporary.delete(source);
        },
        sleep: async () => {},
        unlink: async file => {
          events.push({file, kind: 'unlink'});
          temporary.delete(file);
        },
        writeFile: async (file, value, options) => {
          events.push({file, kind: 'write', options});
          if (file.startsWith('registry.md.')) {
            throw new Error('write interrupted with npm-secret');
          }
          temporary.set(file, String(value));
        },
      });
    } catch (error) {
      console.log(JSON.stringify({
        canonical: Object.fromEntries(canonical),
        classification: error.classification,
        events,
        message: error.message,
        persistenceFailure: error.persistenceFailure,
        temporary: Object.fromEntries(temporary),
      }));
    }
  `);

  expect(result.classification).toBe('fatal');
  expect(result.message).toContain('Fatal npm evidence query');
  expect(result.message).not.toContain('npm-secret');
  expect(result.persistenceFailure).toEqual({
    code: 'EEVIDENCEPERSIST',
    failedOutputs: ['registry-markdown', 'provenance-json'],
    message: 'Failed to persist 2 evidence output(s)',
  });
  expect(result.events.filter(event => event.kind === 'write')).toHaveLength(4);
  expect(result.events.filter(event => event.kind === 'rename')).toHaveLength(
    3,
  );
  const failedWritePaths = result.events
    .filter(event => event.kind === 'write')
    .slice(1, 3)
    .map(event => event.file);
  expect(
    result.events
      .filter(event => event.kind === 'unlink')
      .map(event => event.file),
  ).toEqual(failedWritePaths);
  expect(result.temporary).toEqual({});
  expect(result.canonical['registry.md']).toBe('old-registry-markdown');
  expect(result.canonical['provenance.json']).toBe('old-provenance-json');
  expect(result.canonical['registry.json']).not.toBe('old-registry-json');
  expect(result.canonical['provenance.md']).not.toBe('old-provenance-markdown');
  expect(JSON.stringify(result)).not.toContain('write interrupted');
  expect(JSON.stringify(result)).not.toContain('rename interrupted');
});

test('persistence failure rejects a successful verification after attempting every output', () => {
  const fixture = releaseFixture();
  const result = runModuleProgram(`
    import {runVerifyReleaseCommand} from ${JSON.stringify(verificationCommandModuleUrl)};
    const fixture = ${JSON.stringify(fixture)};
    const events = [];
    let outcome;
    try {
      await runVerifyReleaseCommand({
        args: [
          'ledger.json',
          'journal.json',
          'registry.json',
          'registry.md',
          'provenance.json',
          'provenance.md',
        ],
        now: () => 0,
        readFile: async file => JSON.stringify(
          file === 'ledger.json' ? fixture.ledger : fixture.journal,
        ),
        queryNpmEvidence: async ({entry}) => ({
          integrity: entry.integrity,
          name: entry.name,
          provenance: fixture.provenance[0],
          version: entry.version,
        }),
        rename: async (source, destination) => {
          events.push({destination, kind: 'rename', source});
          if (destination === 'registry.json') {
            throw new Error('rename interrupted with npm-secret');
          }
        },
        sleep: async () => {},
        unlink: async file => { events.push({file, kind: 'unlink'}); },
        write: value => { events.push({kind: 'success', value}); },
        writeFile: async (file, _value, options) => {
          events.push({file, kind: 'write', options});
        },
      });
      outcome = {completed: true, events};
    } catch (error) {
      outcome = {
        code: error.code,
        events,
        failedOutputs: error.failedOutputs,
        message: error.message,
      };
    }
    console.log(JSON.stringify(outcome));
  `);

  expect(result).toMatchObject({
    code: 'EEVIDENCEPERSIST',
    failedOutputs: ['registry-json'],
    message: 'Failed to persist 1 evidence output(s)',
  });
  expect(result.events.filter(event => event.kind === 'write')).toHaveLength(4);
  expect(result.events.filter(event => event.kind === 'rename')).toHaveLength(
    4,
  );
  const firstWritePath = result.events.find(
    event => event.kind === 'write',
  ).file;
  expect(result.events.filter(event => event.kind === 'unlink')).toEqual([
    {file: firstWritePath, kind: 'unlink'},
  ]);
  expect(result.events.some(event => event.kind === 'success')).toBe(false);
  expect(JSON.stringify(result)).not.toContain('npm-secret');
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

test('provenance Markdown escapes normalized claims and log identifiers', () => {
  const result = runModuleProgram(`
    import {provenanceEvidenceMarkdown} from ${JSON.stringify(verificationCommandModuleUrl)};
    const markdown = provenanceEvidenceMarkdown({
      packages: [{
        attempts: '1*2',
        bundleDigest: 'sha256-abc|def',
        classification: '_fatal_',
        disposition: '*published*',
        elapsedMs: '0\\n1',
        name: '<pkg>\\nname',
        order: '1|x',
        predicateType: '[predicate]|x',
        repository: '<repo>',
        runnerEnvironment: 'github|hosted',
        sourceCommit: '<commit>',
        sourceRef: 'refs/tags/v1|x',
        transparencyLogIds: ['log|1', '<log-2>'],
        version: '[1.0.0]',
        workflowPath: '.github/workflows/release.yml|x',
      }],
    });
    console.log(JSON.stringify({markdown}));
  `);

  expect(result.markdown).toContain('# pkg-nec provenance verification');
  expect(result.markdown).toContain('log\\|1, &lt;log-2&gt;');
  expect(result.markdown).toContain('\\[predicate\\]\\|x');
  expect(result.markdown).toContain('&lt;repo&gt;');
  expect(result.markdown).not.toContain('<repo>');
  expect(result.markdown.split('\n')).toHaveLength(6);
});

test('command requires exactly the six evidence paths', () => {
  const result = runModuleProgram(`
    import {runVerifyReleaseCommand} from ${JSON.stringify(verificationCommandModuleUrl)};
    try {
      await runVerifyReleaseCommand({
        args: ['ledger', 'journal', 'registry.json', 'registry.md', 'provenance.json'],
      });
    } catch (error) {
      console.log(JSON.stringify({message: error.message}));
    }
  `);

  expect(result.message).toBe(
    'Usage: yarn verify:pkg-nec-release <ledger-path> <journal-path> <registry-json-path> <registry-markdown-path> <provenance-json-path> <provenance-markdown-path>',
  );
});

test('command persists both stable partial projections before rejecting', () => {
  const fixture = releaseFixture();
  const result = runModuleProgram(`
    import {runVerifyReleaseCommand} from ${JSON.stringify(verificationCommandModuleUrl)};
    const fixture = ${JSON.stringify(fixture)};
    const events = [];
    const temporary = new Map();
    try {
      await runVerifyReleaseCommand({
        args: [
          'ledger.json',
          'journal.json',
          'registry.json',
          'registry.md',
          'provenance.json',
          'provenance.md',
        ],
        now: () => 0,
        readFile: async file => JSON.stringify(file === 'ledger.json' ? fixture.ledger : fixture.journal),
        queryNpmEvidence: async () => {
          throw Object.assign(new Error('_authToken=npm_secret'), {
            classification: 'fatal',
            code: 'EPROVENANCECLAIM',
          });
        },
        rename: async (source, destination) => {
          events.push({file: destination, value: temporary.get(source)});
          temporary.delete(source);
        },
        sleep: async () => {},
        unlink: async file => { temporary.delete(file); },
        writeFile: async (file, value) => {
          temporary.set(file, String(value));
        },
      });
    } catch (error) {
      events.push({classification: error.classification, message: error.message});
    }
    console.log(JSON.stringify(events));
  `);

  expect(result.map(event => event.file ?? event.classification)).toEqual([
    'registry.json',
    'registry.md',
    'provenance.json',
    'provenance.md',
    'fatal',
  ]);
  const registryPartial = JSON.parse(result[0].value);
  expect(registryPartial.packages[0]).toEqual({
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
  const provenancePartial = JSON.parse(result[2].value);
  expect(provenancePartial.packages[0]).toEqual({
    attempts: 1,
    buildType: null,
    bundleDigest: null,
    classification: 'fatal',
    disposition: 'published',
    elapsedMs: 0,
    name: '@pkg-nec/package-1',
    order: 1,
    predicateType: null,
    repository: null,
    runnerEnvironment: null,
    sourceCommit: null,
    sourceRef: null,
    subjectName: null,
    subjectSha512: null,
    transparencyLogIds: [],
    version: '1.0.0',
    workflowPath: null,
  });
  expect(result[0].value).toBe(`${JSON.stringify(registryPartial, null, 2)}\n`);
  expect(result[2].value).toBe(
    `${JSON.stringify(provenancePartial, null, 2)}\n`,
  );
  expect(result[1].value).toContain('| 1 | @pkg-nec/package-1 |');
  expect(result[3].value).toContain('| 1 | @pkg-nec/package-1 |');
  expect(JSON.stringify(result)).not.toContain('npm_secret');
});
