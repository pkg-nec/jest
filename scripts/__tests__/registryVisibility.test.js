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
const registryModuleUrl = pathToFileURL(
  join(repoRoot, 'scripts/pkgNec/registryVisibility.mjs'),
).href;
const registryCommandModuleUrl = pathToFileURL(
  join(repoRoot, 'scripts/waitForPkgNecRegistry.mjs'),
).href;

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

describe('pkg-nec registry visibility', () => {
  test('classifies transient registry failures as retryable', () => {
    const result = runModuleProgram(`
      import {classifyRegistryError} from ${JSON.stringify(registryModuleUrl)};

      const cases = ${JSON.stringify([
        {code: 'E404', message: 'package not found'},
        {
          code: 'ENOTFOUND',
          message: 'getaddrinfo ENOTFOUND registry.npmjs.org',
        },
        {code: 'ETIMEDOUT', message: 'request timed out'},
        {message: 'too many requests', statusCode: 429},
        {code: 'ECONNRESET', message: 'socket hang up'},
        {message: 'service unavailable', statusCode: 503},
        {code: 'ABORT_ERR', message: 'query aborted', name: 'AbortError'},
      ])};
      console.log(JSON.stringify(cases.map(item =>
        classifyRegistryError(Object.assign(new Error(item.message), item)),
      )));
    `);

    expect(result).toEqual(Array.from({length: 7}).fill('retryable'));
  });

  test('classifies authentication, authorization, and unknown failures as fatal', () => {
    const result = runModuleProgram(`
      import {classifyRegistryError} from ${JSON.stringify(registryModuleUrl)};

      const cases = ${JSON.stringify([
        {code: 'E401', message: 'authentication required'},
        {code: 'E403', message: 'authorization denied'},
        {code: 'EINVALIDTAGNAME', message: 'invalid package'},
      ])};
      console.log(JSON.stringify(cases.map(item =>
        classifyRegistryError(Object.assign(new Error(item.message), item)),
      )));
    `);

    expect(result).toEqual(['fatal', 'fatal', 'fatal']);
  });

  test('classifies realistic npm adapter text from stderr and stdout', () => {
    const result = runModuleProgram(`
      import {classifyRegistryError} from ${JSON.stringify(registryModuleUrl)};

      const cases = ${JSON.stringify([
        {stderr: 'npm error code E503'},
        {stdout: 'npm error 503 Service Unavailable'},
        {stderr: 'npm error code EAI_AGAIN'},
        {stdout: 'npm error code ECONNRESET'},
        {stderr: 'npm error 429 Too Many Requests'},
        {stderr: 'npm error code E401'},
        {stdout: 'npm error code E403'},
        {stderr: 'npm error Authentication token rejected'},
      ])};
      console.log(JSON.stringify(cases.map(item =>
        classifyRegistryError(Object.assign(new Error('Command failed'), item)),
      )));
    `);

    expect(result).toEqual([
      'retryable',
      'retryable',
      'retryable',
      'retryable',
      'retryable',
      'fatal',
      'fatal',
      'fatal',
    ]);
  });

  test('retries transient failures with exact npm view arguments and returns evidence', () => {
    const result = runModuleProgram(`
      import {waitForExactVersion} from ${JSON.stringify(registryModuleUrl)};

      const failures = [
        {code: 'E404', message: 'not found'},
        {code: 'ENOTFOUND', message: 'dns'},
        {code: 'ETIMEDOUT', message: 'timeout'},
        {statusCode: 429, message: 'rate limit'},
        {code: 'ECONNRESET', message: 'connection'},
        {statusCode: 502, message: 'bad gateway'},
      ];
      const calls = [];
      let clock = 100;
      const query = async (args, {signal}) => {
        calls.push({args, hasSignal: signal instanceof AbortSignal});
        const failure = failures.shift();
        if (failure) throw Object.assign(new Error(failure.message), failure);
        return {dist: {integrity: 'sha512-registry-integrity'}, name: '@pkg-nec/jest', version: '30.4.2'};
      };
      const evidence = await waitForExactVersion({
        deadlineMs: 100, expectedIntegrity: 'sha512-registry-integrity', intervalMs: 10, name: '@pkg-nec/jest', now: () => clock,
        query, queryTimeoutMs: 25, sleep: async milliseconds => {clock += milliseconds;},
        version: '30.4.2',
      });
      console.log(JSON.stringify({calls, evidence}));
    `);

    expect(result.evidence).toEqual({
      attempts: 7,
      elapsedMs: 60,
      integrity: 'sha512-registry-integrity',
      name: '@pkg-nec/jest',
      version: '30.4.2',
    });
    expect(result.calls).toEqual(
      Array.from({length: 7}).fill({
        args: [
          'view',
          '@pkg-nec/jest@30.4.2',
          '--json',
          '--registry=https://registry.npmjs.org/',
        ],
        hasSignal: true,
      }),
    );
  });

  test('aborts an overlong query and retries it', () => {
    const result = runModuleProgram(`
      import {waitForExactVersion} from ${JSON.stringify(registryModuleUrl)};

      let attempts = 0;
      let clock = 0;
      const evidence = await waitForExactVersion({
        deadlineMs: 50, expectedIntegrity: 'sha512-after-timeout', intervalMs: 3, name: '@pkg-nec/jest-core', now: () => clock,
        query: async (_args, {signal}) => {
          attempts += 1;
          if (attempts > 1) return {dist: {integrity: 'sha512-after-timeout'}, name: '@pkg-nec/jest-core', version: '30.4.2'};
          return new Promise((_resolve, reject) => {
            const inFlightQuery = setTimeout(() => {}, 50);
            signal.addEventListener('abort', () => {
              clearTimeout(inFlightQuery);
              reject(Object.assign(new Error('query aborted'), {code: 'ABORT_ERR', name: 'AbortError'}));
            }, {once: true});
          });
        },
        queryTimeoutMs: 5, sleep: async milliseconds => {clock += milliseconds;},
        version: '30.4.2',
      });
      console.log(JSON.stringify({attempts, evidence}));
    `);

    expect(result).toEqual({
      attempts: 2,
      evidence: {
        attempts: 2,
        elapsedMs: 3,
        integrity: 'sha512-after-timeout',
        name: '@pkg-nec/jest-core',
        version: '30.4.2',
      },
    });
  });

  test('fails immediately on authorization errors and redacts credentials', () => {
    const result = runModuleProgram(`
      import {waitForExactVersion} from ${JSON.stringify(registryModuleUrl)};

      let sleeps = 0;
      try {
        await waitForExactVersion({
          expectedIntegrity: 'sha512-expected', name: '@pkg-nec/jest',
          query: async () => { throw Object.assign(new Error('authorization: Bearer npm_secret123 _authToken=npm_other456'), {code: 'E403'}); },
          sleep: async () => {sleeps += 1;}, version: '30.4.2',
        });
      } catch (error) {
        console.log(JSON.stringify({attempts: error.attempts, classification: error.classification, message: error.message, sleeps}));
      }
    `);

    expect(result.classification).toBe('fatal');
    expect(result.attempts).toBe(1);
    expect(result.sleeps).toBe(0);
    expect(result.message).toContain('@pkg-nec/jest@30.4.2');
    expect(result.message).not.toContain('npm_secret123');
    expect(result.message).not.toContain('npm_other456');
  });

  test('reports bounded deadline evidence without leaking the last error', () => {
    const result = runModuleProgram(`
      import {waitForExactVersion} from ${JSON.stringify(registryModuleUrl)};

      let clock = 0;
      try {
        await waitForExactVersion({
          deadlineMs: 20, expectedIntegrity: 'sha512-expected', intervalMs: 10, name: '@pkg-nec/jest-cli', now: () => clock,
          query: async () => { throw Object.assign(new Error('registry token npm_deadlineSecret'), {code: 'ENOTFOUND'}); },
          sleep: async milliseconds => {clock += milliseconds;}, version: '30.4.2',
        });
      } catch (error) {
        console.log(JSON.stringify({attempts: error.attempts, classification: error.classification, elapsedMs: error.elapsedMs, message: error.message}));
      }
    `);

    expect(result).toEqual(
      expect.objectContaining({
        attempts: 2,
        classification: 'retryable',
        elapsedMs: 20,
      }),
    );
    expect(result.message).toContain('@pkg-nec/jest-cli@30.4.2');
    expect(result.message).toContain('last error class: ENOTFOUND');
    expect(result.message).toContain('2 attempts');
    expect(result.message).not.toContain('npm_deadlineSecret');
  });
});

describe('pkg-nec registry visibility command', () => {
  test('accepts one selected ledger entry and prints terminal evidence', () => {
    const result = runModuleProgram(`
      import {runRegistryVisibilityCommand} from ${JSON.stringify(registryCommandModuleUrl)};

      const lines = [];
      const evidence = await runRegistryVisibilityCommand({
        args: ['release-ledger.json', '@pkg-nec/jest'], now: () => 25,
        query: async () => ({dist: {integrity: 'sha512-cli-integrity'}, name: '@pkg-nec/jest', version: '30.4.2'}),
        readFile: async () => JSON.stringify({
          packages: [{integrity: 'sha512-cli-integrity', name: '@pkg-nec/jest', version: '30.4.2'}],
          schemaVersion: 1,
        }),
        sleep: async () => {}, write: line => lines.push(line),
      });
      console.log(JSON.stringify({evidence, lines}));
    `);

    expect(result).toEqual({
      evidence: {
        attempts: 1,
        elapsedMs: 0,
        integrity: 'sha512-cli-integrity',
        name: '@pkg-nec/jest',
        version: '30.4.2',
      },
      lines: [
        'package=@pkg-nec/jest',
        'version=30.4.2',
        'attempts=1',
        'elapsedMs=0',
        'integrity=sha512-cli-integrity',
        'classification=visible',
      ],
    });
  });

  test('rejects missing, extra, and incomplete ledger arguments', () => {
    const result = runModuleProgram(`
      import {runRegistryVisibilityCommand} from ${JSON.stringify(registryCommandModuleUrl)};

      const cases = [[], ['ledger.json'], ['ledger.json', '@pkg-nec/jest', 'extra'], ['ledger.json', '']];
      const messages = [];
      for (const args of cases) {
        try {
          await runRegistryVisibilityCommand({args, query: async () => {throw new Error('query must not run');}});
        } catch (error) { messages.push(error.message); }
      }
      console.log(JSON.stringify(messages));
    `);

    expect(result).toHaveLength(4);
    expect(result).toEqual(
      Array.from({length: 4}).fill(
        'Usage: yarn check:pkg-nec-registry <ledger-path> <package-name>',
      ),
    );
  });
});

describe('pkg-nec registry ledger verification', () => {
  test('rejects waiter requests without a SHA-512 expected integrity before polling', () => {
    const result = runModuleProgram(`
      import {waitForExactVersion} from ${JSON.stringify(registryModuleUrl)};

      let calls = 0;
      try {
        await waitForExactVersion({
          name: '@pkg-nec/example',
          query: async () => {
            calls += 1;
            return {dist: {integrity: 'sha512-actual'}, name: '@pkg-nec/example', version: '31.0.0'};
          },
          version: '31.0.0',
        });
        console.log(JSON.stringify({calls, message: 'visible'}));
      } catch (error) {
        console.log(JSON.stringify({calls, message: error.message}));
      }
    `);

    expect(result).toEqual({
      calls: 0,
      message: 'Expected SHA-512 integrity for @pkg-nec/example@31.0.0',
    });
  });

  test('rejects integrity different from the ledger without retrying', () => {
    const result = runModuleProgram(`
      import {waitForExactVersion} from ${JSON.stringify(registryModuleUrl)};

      let calls = 0;
      try {
        await waitForExactVersion({
          expectedIntegrity: 'sha512-expected', name: '@pkg-nec/example',
          query: async () => {
            calls += 1;
            return {dist: {integrity: 'sha512-other'}, name: '@pkg-nec/example', version: '31.0.0'};
          },
          version: '31.0.0',
        });
        console.log(JSON.stringify({calls, classification: 'visible'}));
      } catch (error) {
        console.log(JSON.stringify({calls, classification: error.classification}));
      }
    `);

    expect(result).toEqual({calls: 1, classification: 'fatal'});
  });

  test('rejects unsupported and ambiguous release ledger entries', () => {
    const result = runModuleProgram(`
      import {releaseEntryFromLedger} from ${JSON.stringify(registryModuleUrl)};

      const cases = [
        {ledger: {packages: []}},
        {ledger: {packages: [], schemaVersion: 1}},
        {ledger: {schemaVersion: 1, packages: [
          {integrity: 'sha512-a', name: '@pkg-nec/example', version: '31.0.0'},
          {integrity: 'sha512-b', name: '@pkg-nec/example', version: '31.0.0'},
        ]}},
        {ledger: {schemaVersion: 1, packages: [
          {integrity: '', name: '@pkg-nec/example', version: '31.0.0'},
        ]}},
        {ledger: {schemaVersion: 1, packages: [
          {integrity: 'sha256-not-sha512', name: '@pkg-nec/example', version: '31.0.0'},
        ]}},
      ];
      console.log(JSON.stringify(cases.map(({ledger}) => {
        try { releaseEntryFromLedger({ledger, packageName: '@pkg-nec/example'}); }
        catch (error) { return error.message; }
      })));
    `);

    expect(result).toEqual([
      'Unsupported pkg-nec release ledger',
      'Expected one release ledger entry for @pkg-nec/example, found 0',
      'Expected one release ledger entry for @pkg-nec/example, found 2',
      'Invalid release ledger entry for @pkg-nec/example',
      'Invalid release ledger entry for @pkg-nec/example',
    ]);
  });

  test('rejects a release ledger entry without expected integrity', () => {
    const result = runModuleProgram(`
      import {releaseEntryFromLedger} from ${JSON.stringify(registryModuleUrl)};

      try {
        releaseEntryFromLedger({
          ledger: {packages: [{name: '@pkg-nec/example', version: '31.0.0'}], schemaVersion: 1},
          packageName: '@pkg-nec/example',
        });
      } catch (error) { console.log(JSON.stringify(error.message)); }
    `);

    expect(result).toBe('Invalid release ledger entry for @pkg-nec/example');
  });

  test('does not expire before and expires at the 480000ms default deadline', () => {
    const result = runModuleProgram(`
      import {waitForExactVersion} from ${JSON.stringify(registryModuleUrl)};

      let clock = 0;
      const sleeps = [];
      try {
        await waitForExactVersion({
          expectedIntegrity: 'sha512-expected', name: '@pkg-nec/example', now: () => clock,
          query: async () => { throw Object.assign(new Error('not found'), {code: 'E404'}); },
          sleep: async milliseconds => {
            sleeps.push(milliseconds);
            clock = sleeps.length === 1 ? 479999 : clock + milliseconds;
          },
          version: '31.0.0',
        });
      } catch (error) {
        console.log(JSON.stringify({
          attempts: error.attempts, classification: error.classification,
          elapsedMs: error.elapsedMs, sleeps,
        }));
      }
    `);

    expect(result).toEqual({
      attempts: 2,
      classification: 'retryable',
      elapsedMs: 480_000,
      sleeps: [5000, 1],
    });
  });

  test('queries public npm for the selected ledger entry', () => {
    const result = runModuleProgram(`
      import {runRegistryVisibilityCommand} from ${JSON.stringify(registryCommandModuleUrl)};

      const calls = [];
      let message;
      try {
        await runRegistryVisibilityCommand({
          args: ['.pkg-nec-release/release-ledger.json', '@pkg-nec/example'],
          query: async (args, options) => {
            calls.push({args, hasSignal: options.signal instanceof AbortSignal});
            return {stdout: JSON.stringify({dist: {integrity: 'sha512-expected'}, name: '@pkg-nec/example', version: '31.0.0'})};
          },
          readFile: async () => JSON.stringify({
            packages: [{integrity: 'sha512-expected', name: '@pkg-nec/example', version: '31.0.0'}],
            schemaVersion: 1,
          }),
          write: () => {},
        });
      } catch (error) { message = error.message; }
      console.log(JSON.stringify({calls, message}));
    `);

    expect(result.calls).toEqual([
      {
        args: [
          'view',
          '@pkg-nec/example@31.0.0',
          '--json',
          '--registry=https://registry.npmjs.org/',
        ],
        hasSignal: true,
      },
    ]);
  });
});
