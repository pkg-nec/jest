/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const repoRoot = process.cwd();
const identityModuleUrl = pathToFileURL(
  join(repoRoot, 'scripts/pkgNecPackageIdentity.mjs'),
).href;
const graphModuleUrl = pathToFileURL(
  join(repoRoot, 'scripts/pkgNec/releaseGraph.mjs'),
).href;
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

async function writeManifest(repo, directory, manifest) {
  const manifestDirectory = join(repo, directory);
  await mkdir(manifestDirectory, {recursive: true});
  await writeFile(
    join(manifestDirectory, 'package.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

function buildGraph(repo, expectedPackageCount) {
  return runModuleProgram(`
    import {discoverPackageIdentities} from ${JSON.stringify(
      identityModuleUrl,
    )};
    import {buildRuntimeReleaseGraph} from ${JSON.stringify(graphModuleUrl)};

    const inventory = discoverPackageIdentities({
      expectedPackageCount: ${expectedPackageCount},
      repoRoot: ${JSON.stringify(repo)},
    });

    try {
      const graph = buildRuntimeReleaseGraph(inventory);
      console.log(JSON.stringify({
        graph: Object.fromEntries(
          [...graph].map(([name, dependencies]) => [
            name,
            [...dependencies].sort(),
          ]),
        ),
      }));
    } catch (error) {
      console.log(JSON.stringify({error: error.message}));
    }
  `);
}

describe('pkg-nec runtime release graph', () => {
  test('orders dependencies first with lexical tie-breaking and rejects runtime cycles', () => {
    const result = runModuleProgram(`
      import {topologicalReleaseOrder} from ${JSON.stringify(graphModuleUrl)};

      const graph = new Map([
        ['@pkg-nec/jest', new Set(['@pkg-nec/jest-cli'])],
        ['@pkg-nec/jest-cli', new Set(['@pkg-nec/jest-core'])],
        ['@pkg-nec/jest-core', new Set()],
        ['@pkg-nec/expect', new Set()],
      ]);
      const cyclicGraph = new Map([
        ['@pkg-nec/a', new Set(['@pkg-nec/b'])],
        ['@pkg-nec/b', new Set(['@pkg-nec/a'])],
      ]);

      let cycleError;
      try {
        topologicalReleaseOrder(cyclicGraph);
      } catch (error) {
        cycleError = error.message;
      }

      console.log(JSON.stringify({
        cycleError,
        order: topologicalReleaseOrder(graph),
      }));
    `);

    expect(result.order).toEqual([
      '@pkg-nec/expect',
      '@pkg-nec/jest-core',
      '@pkg-nec/jest-cli',
      '@pkg-nec/jest',
    ]);
    expect(result.cycleError).toMatch(/runtime cycle/);
  });

  test('recalculates lexical priority after each emitted dependency', () => {
    const result = runModuleProgram(`
      import {topologicalReleaseOrder} from ${JSON.stringify(graphModuleUrl)};

      const graph = new Map([
        ['@pkg-nec/a', new Set(['@pkg-nec/b'])],
        ['@pkg-nec/b', new Set()],
        ['@pkg-nec/c', new Set()],
      ]);
      console.log(JSON.stringify(topologicalReleaseOrder(graph)));
    `);

    expect(result).toEqual(['@pkg-nec/b', '@pkg-nec/a', '@pkg-nec/c']);
  });

  test('builds consumer-to-dependency runtime edges and ignores dev-only cycles', async () => {
    const temporaryRepo = await mkdtemp(join(tmpdir(), 'pkg-nec-graph-'));

    try {
      await writeManifest(temporaryRepo, '.', {
        name: '@jest/monorepo',
        private: true,
        version: '0.0.0',
      });
      await writeManifest(temporaryRepo, 'packages/a', {
        dependencies: {'jest-b': 'workspace:*'},
        devDependencies: {'jest-c': 'workspace:*'},
        name: 'jest-a',
        version: '1.0.0',
      });
      await writeManifest(temporaryRepo, 'packages/b', {
        devDependencies: {'jest-a': 'workspace:*'},
        name: 'jest-b',
        version: '1.0.0',
      });
      await writeManifest(temporaryRepo, 'packages/c', {
        devDependencies: {'jest-a': 'workspace:*'},
        name: 'jest-c',
        version: '1.0.0',
      });

      expect(buildGraph(temporaryRepo, 3).graph).toEqual({
        '@pkg-nec/jest-a': ['@pkg-nec/jest-b'],
        '@pkg-nec/jest-b': [],
        '@pkg-nec/jest-c': [],
      });
    } finally {
      await rm(temporaryRepo, {force: true, recursive: true});
    }
  });

  test('rejects unresolved internal runtime dependencies', async () => {
    const temporaryRepo = await mkdtemp(join(tmpdir(), 'pkg-nec-graph-'));

    try {
      await writeManifest(temporaryRepo, '.', {
        name: '@jest/monorepo',
        private: true,
        version: '0.0.0',
      });
      await writeManifest(temporaryRepo, 'packages/a', {
        dependencies: {'jest-missing': 'workspace:*'},
        name: 'jest-a',
        version: '1.0.0',
      });

      expect(buildGraph(temporaryRepo, 1).error).toMatch(
        /Unresolved internal runtime dependency jest-missing.*@pkg-nec\/jest-a/,
      );
    } finally {
      await rm(temporaryRepo, {force: true, recursive: true});
    }
  });

  test('rejects resolved internal targets absent from the release graph', async () => {
    const temporaryRepo = await mkdtemp(join(tmpdir(), 'pkg-nec-graph-'));

    try {
      await writeManifest(temporaryRepo, '.', {
        name: '@jest/monorepo',
        private: true,
        version: '0.0.0',
      });
      await writeManifest(temporaryRepo, 'packages/a', {
        dependencies: {'jest-b': '^1.0.0'},
        name: 'jest-a',
        version: '1.0.0',
      });
      await writeManifest(temporaryRepo, 'packages/b', {
        name: 'jest-b',
        private: true,
        version: '1.0.0',
      });

      expect(buildGraph(temporaryRepo, 2).error).toMatch(
        /Unresolved internal runtime dependency jest-b.*@pkg-nec\/jest-a/,
      );
    } finally {
      await rm(temporaryRepo, {force: true, recursive: true});
    }
  });
});

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
      const classifications = cases.map(item => {
        const error = Object.assign(new Error(item.message), item);
        return classifyRegistryError(error);
      });
      console.log(JSON.stringify(classifications));
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
        return {
          dist: {integrity: 'sha512-registry-integrity'},
          name: '@pkg-nec/jest',
          version: '30.4.2',
        };
      };
      const evidence = await waitForExactVersion({
        deadlineMs: 100,
        intervalMs: 10,
        name: '@pkg-nec/jest',
        now: () => clock,
        query,
        queryTimeoutMs: 25,
        sleep: async milliseconds => {clock += milliseconds;},
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
        args: ['view', '@pkg-nec/jest@30.4.2', '--json'],
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
        deadlineMs: 50,
        intervalMs: 3,
        name: '@pkg-nec/jest-core',
        now: () => clock,
        query: async (_args, {signal}) => {
          attempts += 1;
          if (attempts > 1) {
            return {
              dist: {integrity: 'sha512-after-timeout'},
              name: '@pkg-nec/jest-core',
              version: '30.4.2',
            };
          }
          return new Promise((_resolve, reject) => {
            const inFlightQuery = setTimeout(() => {}, 50);
            signal.addEventListener('abort', () => {
              clearTimeout(inFlightQuery);
              reject(Object.assign(new Error('query aborted'), {
                code: 'ABORT_ERR',
                name: 'AbortError',
              }));
            }, {once: true});
          });
        },
        queryTimeoutMs: 5,
        sleep: async milliseconds => {clock += milliseconds;},
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
          name: '@pkg-nec/jest',
          query: async () => {
            throw Object.assign(
              new Error('authorization: Bearer npm_secret123 _authToken=npm_other456'),
              {code: 'E403'},
            );
          },
          sleep: async () => {sleeps += 1;},
          version: '30.4.2',
        });
      } catch (error) {
        console.log(JSON.stringify({
          attempts: error.attempts,
          classification: error.classification,
          message: error.message,
          sleeps,
        }));
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
          deadlineMs: 20,
          intervalMs: 10,
          name: '@pkg-nec/jest-cli',
          now: () => clock,
          query: async () => {
            throw Object.assign(
              new Error('registry token npm_deadlineSecret'),
              {code: 'ENOTFOUND'},
            );
          },
          sleep: async milliseconds => {clock += milliseconds;},
          version: '30.4.2',
        });
      } catch (error) {
        console.log(JSON.stringify({
          attempts: error.attempts,
          classification: error.classification,
          elapsedMs: error.elapsedMs,
          message: error.message,
        }));
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
  test('accepts one exact canonical version and prints terminal evidence', () => {
    const result = runModuleProgram(`
      import {runRegistryVisibilityCommand} from ${JSON.stringify(
        registryCommandModuleUrl,
      )};

      const lines = [];
      const evidence = await runRegistryVisibilityCommand({
        args: ['@pkg-nec/jest@30.4.2'],
        now: () => 25,
        query: async () => ({
          dist: {integrity: 'sha512-cli-integrity'},
          name: '@pkg-nec/jest',
          version: '30.4.2',
        }),
        sleep: async () => {},
        write: line => lines.push(line),
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

  test('rejects missing, extra, noncanonical, and nonexact positional values', () => {
    const result = runModuleProgram(`
      import {runRegistryVisibilityCommand} from ${JSON.stringify(
        registryCommandModuleUrl,
      )};

      const cases = [
        [],
        ['@pkg-nec/jest@30.4.2', 'extra'],
        ['@jest/core@30.4.2'],
        ['@pkg-nec/jest@^30.4.2'],
      ];
      const messages = [];
      for (const args of cases) {
        try {
          await runRegistryVisibilityCommand({
            args,
            query: async () => {throw new Error('query must not run');},
          });
        } catch (error) {
          messages.push(error.message);
        }
      }
      console.log(JSON.stringify(messages));
    `);

    expect(result).toHaveLength(4);
    expect(result).toEqual(
      Array.from({length: 4}).fill(
        'Usage: yarn check:pkg-nec-registry "@pkg-nec/name@version"',
      ),
    );
  });
});
