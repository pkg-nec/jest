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
const parityModuleUrl = pathToFileURL(
  join(repoRoot, 'scripts/checkPkgNecPackParity.mjs'),
).href;

function runParityProgram(program) {
  const child = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', program],
    {cwd: repoRoot, encoding: 'utf8'},
  );
  if (child.status !== 0) throw new Error(child.stderr || child.stdout);
  return JSON.parse(child.stdout.trim());
}

function fixtureProgram({localCoreFiles, upstreamCoreFiles}) {
  return `
    import {runPackParityCommand} from ${JSON.stringify(parityModuleUrl)};

    const baseline = {
      'packages/jest-core/package.json': {
        name: '@jest/core',
        version: '30.4.2',
      },
      'packages/test-globals/package.json': {
        name: '@jest/test-globals',
        version: '30.4.2',
      },
    };
    const ledger = {
      packages: [
        {
          files: ${JSON.stringify(localCoreFiles)},
          name: '@pkg-nec/jest-core',
          version: '30.4.2',
        },
        {
          files: [
            'LICENSE',
            'README.md',
            'build/index.d.ts',
            'build/index.js',
            'package.json',
          ],
          name: '@pkg-nec/jest-test-globals',
          version: '30.4.2',
        },
      ],
    };
    const reportFiles = new Map();
    const lines = [];
    let result;
    try {
      result = await runPackParityCommand({
      baseline,
      ledgerPath: '/repo/.pkg-nec-release/release-ledger.json',
      packUpstream: async (name, version) => {
        if (name !== '@jest/core' || version !== '30.4.2') {
          throw new Error('unexpected upstream request');
        }
        return {files: ${JSON.stringify(upstreamCoreFiles)}};
      },
      queryLatest: async name => {
        if (name !== '@jest/core') throw new Error('unexpected latest request');
        return '30.4.2';
      },
      readFile: async file => {
        if (file.endsWith('release-ledger.json')) return JSON.stringify(ledger);
        if (file.replaceAll('\\\\', '/').endsWith('packages/test-globals/package.json')) {
          return JSON.stringify({
            exports: {
              '.': {
                default: './build/index.js',
                types: './build/index.d.ts',
              },
              './package.json': './package.json',
            },
            main: './build/index.js',
            types: './build/index.d.ts',
          });
        }
        throw new Error('unexpected read: ' + file);
      },
      repoRoot: '/repo',
      removeDirectory: async () => {},
      rename: async (from, to) => {
        const value = reportFiles.get(from);
        if (value === undefined) {
          const error = new Error('not found');
          error.code = 'ENOENT';
          throw error;
        }
        reportFiles.delete(from);
        reportFiles.set(to, value);
      },
      write: line => lines.push(line),
      writeFile: async (file, value) => reportFiles.set(file, value),
      });
    } catch (error) {
      result = {error: error.message};
    }
    console.log(JSON.stringify({
      lines, result, reports: Object.fromEntries(reportFiles),
    }));
  `;
}

test('reports exact normal packages and helper-policy packages without querying helpers', () => {
  const result = runParityProgram(
    fixtureProgram({
      localCoreFiles: ['package.json', 'LICENSE', 'build/index.js'],
      upstreamCoreFiles: ['build/index.js', 'LICENSE', 'package.json'],
    }),
  );

  expect(result.result.packages).toEqual([
    {
      added: [],
      localCount: 3,
      localName: '@pkg-nec/jest-core',
      localVersion: '30.4.2',
      missing: [],
      oldName: '@jest/core',
      status: 'exact',
      upstreamCount: 3,
      upstreamVersion: '30.4.2',
    },
    {
      added: [],
      localCount: 5,
      localName: '@pkg-nec/jest-test-globals',
      localVersion: '30.4.2',
      missing: [],
      oldName: '@jest/test-globals',
      status: 'helper-policy',
      upstreamCount: null,
      upstreamVersion: null,
    },
  ]);
  expect(Object.values(result.reports).join('\n')).toContain(
    '| @pkg-nec/jest-core | @jest/core | 30.4.2 | 30.4.2 | exact | 3 | 3 | none | none |',
  );
  const json = Object.entries(result.reports).find(([file]) =>
    file.endsWith('upstream-parity.json'),
  )[1];
  expect(JSON.parse(json).packages.map(item => item.localName)).toEqual([
    '@pkg-nec/jest-core',
    '@pkg-nec/jest-test-globals',
  ]);
  expect(result.lines).toContain(
    'Checked 2 pkg-nec release artifact(s): exact=1, helper-policy=1.',
  );
});

test('reports sorted missing and added paths when equal file counts drift', () => {
  const result = runParityProgram(
    fixtureProgram({
      localCoreFiles: ['package.json', 'build/extra.d.ts'],
      upstreamCoreFiles: ['package.json', 'LICENSE'],
    }),
  );

  expect(result.result.error).toContain('missing [LICENSE]');
  expect(result.result.error).toContain('added [build/extra.d.ts]');
  expect(result.result.error).toContain('LICENSE');
  expect(result.result.error).toContain('build/extra.d.ts');
});

test('reports a distinct latest version without inventing an upstream inventory', () => {
  const result = runParityProgram(`
    import {runPackParityCommand} from ${JSON.stringify(parityModuleUrl)};
    const reports = new Map();
    try {
      await runPackParityCommand({
        baseline: {
          'packages/jest-core/package.json': {name: '@jest/core', version: '30.4.2'},
        },
        ledgerPath: '/repo/.pkg-nec-release/release-ledger.json',
        packUpstream: async () => { throw new Error('must not pack'); },
        queryLatest: async () => '30.4.3',
        readFile: async () => JSON.stringify({packages: [{
          files: ['LICENSE', 'package.json'], name: '@pkg-nec/jest-core', version: '30.4.2',
        }]}),
        removeDirectory: async () => {},
        rename: async (from, to) => {
          const value = reports.get(from);
          if (value === undefined) {
            const error = new Error('not found');
            error.code = 'ENOENT';
            throw error;
          }
          reports.delete(from);
          reports.set(to, value);
        },
        repoRoot: '/repo',
        writeFile: async (file, value) => reports.set(file, value),
      });
    } catch (error) {
      console.log(JSON.stringify({error: error.message, reports: Object.fromEntries(reports)}));
    }
  `);

  expect(result.error).toContain('@pkg-nec/jest-core <- @jest/core');
  expect(result.error).toContain('local version 30.4.2');
  expect(result.error).toContain('latest upstream 30.4.3');
  expect(result.error).toContain('local files 2, upstream files unavailable');
  expect(result.error).toContain('Reports:');
  const json = Object.entries(result.reports).find(([file]) =>
    file.endsWith('upstream-parity.json'),
  )[1];
  expect(JSON.parse(json).packages[0]).toMatchObject({
    added: [],
    missing: [],
    status: 'version-mismatch',
    upstreamCount: null,
    upstreamVersion: '30.4.3',
  });
});

test('retains a queried upstream version when npm pack fails', () => {
  const result = runParityProgram(`
    import {runPackParityCommand} from ${JSON.stringify(parityModuleUrl)};
    const reports = new Map();
    try {
      await runPackParityCommand({
        baseline: {
          'packages/jest-core/package.json': {name: '@jest/core', version: '30.4.2'},
        },
        ledgerPath: '/repo/.pkg-nec-release/release-ledger.json',
        packUpstream: async () => { throw new Error('upstream pack failed'); },
        queryLatest: async () => '30.4.2',
        readFile: async () => JSON.stringify({packages: [{
          files: ['LICENSE', 'package.json'], name: '@pkg-nec/jest-core', version: '30.4.2',
        }]}),
        removeDirectory: async () => {},
        rename: async (from, to) => {
          const value = reports.get(from);
          if (value === undefined) {
            const error = new Error('not found');
            error.code = 'ENOENT';
            throw error;
          }
          reports.delete(from);
          reports.set(to, value);
        },
        repoRoot: '/repo',
        writeFile: async (file, value) => reports.set(file, value),
      });
    } catch (error) {
      console.log(JSON.stringify({error: error.message, reports: Object.fromEntries(reports)}));
    }
  `);

  const json = Object.entries(result.reports).find(([file]) =>
    file.endsWith('upstream-parity.json'),
  )[1];
  const markdown = Object.entries(result.reports).find(([file]) =>
    file.endsWith('upstream-parity.md'),
  )[1];
  expect(JSON.parse(json).packages[0]).toMatchObject({
    status: 'error',
    upstreamCount: null,
    upstreamVersion: '30.4.2',
  });
  expect(markdown).toContain('| Error |');
  expect(markdown).toContain(
    '| @pkg-nec/jest-core | @jest/core | 30.4.2 | 30.4.2 | error | 2 | n/a | none | none |',
  );
  expect(markdown).toContain('upstream pack failed');
  expect(result.error).toContain('latest upstream 30.4.2');
  expect(result.error).not.toContain('latest upstream unavailable');
});

test('escapes pipes and collapses newlines in Markdown error cells', () => {
  const result = runParityProgram(`
    import {parityMarkdown} from ${JSON.stringify(parityModuleUrl)};
    const markdown = parityMarkdown({
      generatedAt: '2026-08-16T00:00:00.000Z',
      packages: [{
        added: [],
        error: ${JSON.stringify('registry | failure\nsecond\r\nthird')},
        localCount: 2,
        localName: '@pkg-nec/jest-core',
        localVersion: '30.4.2',
        missing: [],
        oldName: '@jest/core',
        status: 'error',
        upstreamCount: null,
        upstreamVersion: null,
      }],
    });
    console.log(JSON.stringify({markdown}));
  `);

  expect(result.markdown).toContain(
    'registry \\| failure<br>second<br>third |',
  );
  expect(result.markdown).not.toContain('registry | failure');
});

test('rejects multiple npm pack JSON results', () => {
  const result = runParityProgram(`
    import {parseNpmPackResult} from ${JSON.stringify(parityModuleUrl)};
    try {
      parseNpmPackResult({
        oldName: '@jest/core', version: '30.4.2',
        output: JSON.stringify([{files: []}, {files: []}]),
      });
    } catch (error) {
      console.log(JSON.stringify({error: error.message}));
    }
  `);

  expect(result.error).toBe(
    'npm pack for @jest/core@30.4.2 returned an invalid result',
  );
});

test('does not recursively remove the system temporary directory', () => {
  const result = runParityProgram(`
    import {tmpdir} from 'node:os';
    import {runPackParityCommand} from ${JSON.stringify(parityModuleUrl)};
    let removals = 0;
    try {
      await runPackParityCommand({
        baseline: {
          'packages/jest-core/package.json': {name: '@jest/core', version: '30.4.2'},
        },
        ledgerPath: '/repo/.pkg-nec-release/release-ledger.json',
        makeTemporaryDirectory: async () => tmpdir(),
        readFile: async () => JSON.stringify({packages: [{
          files: ['LICENSE', 'package.json'], name: '@pkg-nec/jest-core', version: '30.4.2',
        }]}),
        removeDirectory: async () => { removals += 1; },
        repoRoot: '/repo',
      });
    } catch (error) {
      console.log(JSON.stringify({error: error.message, removals}));
    }
  `);

  expect(result.removals).toBe(0);
  expect(result.error).toContain('must be a generated child');
});

test('fails when temporary-directory cleanup fails after a successful check', () => {
  const result = runParityProgram(`
    import {runPackParityCommand} from ${JSON.stringify(parityModuleUrl)};
    const reports = new Map();
    let outcome;
    try {
      await runPackParityCommand({
        baseline: {
          'packages/jest-core/package.json': {name: '@jest/core', version: '30.4.2'},
        },
        ledgerPath: '/repo/.pkg-nec-release/release-ledger.json',
        packUpstream: async () => ({files: ['LICENSE', 'package.json']}),
        queryLatest: async () => '30.4.2',
        readFile: async () => JSON.stringify({packages: [{
          files: ['LICENSE', 'package.json'],
          name: '@pkg-nec/jest-core',
          version: '30.4.2',
        }]}),
        removeDirectory: async () => {
          throw new Error('temporary cleanup failed');
        },
        rename: async (from, to) => {
          const value = reports.get(from);
          if (value === undefined) {
            const error = new Error('not found');
            error.code = 'ENOENT';
            throw error;
          }
          reports.delete(from);
          reports.set(to, value);
        },
        repoRoot: '/repo',
        write: () => {},
        writeFile: async (file, value) => reports.set(file, value),
      });
      outcome = {returned: true};
    } catch (error) {
      outcome = {error: error.message};
    }
    console.log(JSON.stringify(outcome));
  `);

  expect(result).toEqual({error: 'temporary cleanup failed'});
});

test.each([
  [
    'not found registry responses',
    'async () => { throw Object.assign(new Error("not found"), {code: "E404"}); }',
    'async () => ({files: ["LICENSE", "package.json"]})',
    'retryable',
  ],
  [
    'authentication registry responses',
    'async () => { throw Object.assign(new Error("Bearer npm_secret"), {code: "E401"}); }',
    'async () => ({files: ["LICENSE", "package.json"]})',
    'fatal',
  ],
  [
    'malformed npm view output',
    'async () => ({latest: null})',
    'async () => ({files: ["LICENSE", "package.json"]})',
    'fatal',
  ],
  [
    'malformed npm pack output',
    "async () => '30.4.2'",
    'async () => ({files: null})',
    'fatal',
  ],
])(
  'reports %s without exposing credentials',
  (_name, queryLatest, packUpstream, classification) => {
    const result = runParityProgram(`
      import {runPackParityCommand} from ${JSON.stringify(parityModuleUrl)};
      const reports = new Map();
      try {
        await runPackParityCommand({
          baseline: {
            'packages/jest-core/package.json': {name: '@jest/core', version: '30.4.2'},
          },
          ledgerPath: '/repo/.pkg-nec-release/release-ledger.json',
          packUpstream: ${packUpstream},
          queryLatest: ${queryLatest},
          readFile: async () => JSON.stringify({packages: [{
            files: ['LICENSE', 'package.json'],
            name: '@pkg-nec/jest-core',
            version: '30.4.2',
          }]}),
          removeDirectory: async () => {},
          rename: async (from, to) => {
            const value = reports.get(from);
            if (value === undefined) {
              const error = new Error('not found');
              error.code = 'ENOENT';
              throw error;
            }
            reports.delete(from);
            reports.set(to, value);
          },
          repoRoot: '/repo',
          write: () => {},
          writeFile: async (file, value) => reports.set(file, value),
        });
      } catch (error) {
        console.log(JSON.stringify({error: error.message, reports: Object.fromEntries(reports)}));
      }
    `);

    expect(result.error).toContain('@jest/core');
    expect(result.error).toContain(classification);
    expect(result.error).not.toContain('npm_secret');
    expect(Object.values(result.reports).join('\n')).toContain(
      '@pkg-nec/jest-core',
    );
  },
);

test('redacts legacy npm credentials from already-prefixed adapter failures', () => {
  const result = runParityProgram(`
    import {runPackParityCommand} from ${JSON.stringify(parityModuleUrl)};
    const reports = new Map();
    try {
      await runPackParityCommand({
        baseline: {
          'packages/jest-core/package.json': {name: '@jest/core', version: '30.4.2'},
        },
        ledgerPath: '/repo/.pkg-nec-release/release-ledger.json',
        queryLatest: async () => {
          throw new Error(
            'npm view failed for @jest/core (fatal): _auth=legacy-auth _password=legacy-password',
          );
        },
        readFile: async () => JSON.stringify({packages: [{
          files: ['LICENSE', 'package.json'],
          name: '@pkg-nec/jest-core',
          version: '30.4.2',
        }]}),
        removeDirectory: async () => {},
        rename: async (from, to) => {
          const value = reports.get(from);
          if (value === undefined) {
            const error = new Error('not found');
            error.code = 'ENOENT';
            throw error;
          }
          reports.delete(from);
          reports.set(to, value);
        },
        repoRoot: '/repo',
        write: () => {},
        writeFile: async (file, value) => reports.set(file, value),
      });
    } catch (error) {
      console.log(JSON.stringify({
        error: error.message,
        reports: Object.fromEntries(reports),
      }));
    }
  `);

  const persisted = `${result.error}\n${Object.values(result.reports).join('\n')}`;
  expect(persisted).toContain('[REDACTED]');
  expect(persisted).not.toContain('legacy-auth');
  expect(persisted).not.toContain('legacy-password');
});

test('enforces helper policy without calling npm adapters', () => {
  const result = runParityProgram(`
    import {runPackParityCommand} from ${JSON.stringify(parityModuleUrl)};
    let packCalls = 0;
    let queryCalls = 0;
    const reports = new Map();
    try {
      await runPackParityCommand({
        baseline: {
          'packages/test-utils/package.json': {
            name: '@jest/test-utils', private: true, version: '30.4.2',
          },
        },
        ledgerPath: '/repo/.pkg-nec-release/release-ledger.json',
        packUpstream: async () => { packCalls += 1; },
        queryLatest: async () => { queryCalls += 1; },
        readFile: async file => file.endsWith('release-ledger.json')
          ? JSON.stringify({packages: [{
              files: ['LICENSE', 'build/index.js', 'package.json'],
              name: '@pkg-nec/jest-test-utils', version: '30.4.2',
            }]})
          : JSON.stringify({main: './build/index.js'}),
        removeDirectory: async () => {},
        rename: async (from, to) => {
          const value = reports.get(from);
          if (value === undefined) {
            const error = new Error('not found');
            error.code = 'ENOENT';
            throw error;
          }
          reports.delete(from);
          reports.set(to, value);
        },
        repoRoot: '/repo',
        writeFile: async (file, value) => reports.set(file, value),
      });
    } catch (error) {
      console.log(JSON.stringify({error: error.message, packCalls, queryCalls}));
    }
  `);

  expect(result).toMatchObject({packCalls: 0, queryCalls: 0});
  expect(result.error).toContain('missing README.md');
});

test('keeps the previous report pair when promotion fails', () => {
  const result = runParityProgram(`
    import path from 'node:path';
    import {runPackParityCommand} from ${JSON.stringify(parityModuleUrl)};
    const reportDirectory = path.resolve('/repo/.pkg-nec-release');
    const jsonPath = path.join(reportDirectory, 'upstream-parity.json');
    const markdownPath = path.join(reportDirectory, 'upstream-parity.md');
    const files = new Map([[jsonPath, 'old json'], [markdownPath, 'old markdown']]);
    let failed = false;
    try {
      await runPackParityCommand({
        baseline: {
          'packages/jest-core/package.json': {name: '@jest/core', version: '30.4.2'},
        },
        ledgerPath: path.join(reportDirectory, 'release-ledger.json'),
        packUpstream: async () => ({files: ['LICENSE', 'package.json']}),
        queryLatest: async () => '30.4.2',
        readFile: async () => JSON.stringify({packages: [{
          files: ['LICENSE', 'package.json'], name: '@pkg-nec/jest-core', version: '30.4.2',
        }]}),
        removeDirectory: async () => {},
        removeFile: async file => files.delete(file),
        rename: async (from, to) => {
          if (!failed && from.endsWith('.md') && to === markdownPath) {
            failed = true;
            throw new Error('promotion failed');
          }
          const value = files.get(from);
          if (value === undefined) {
            const error = new Error('not found');
            error.code = 'ENOENT';
            throw error;
          }
          files.delete(from);
          files.set(to, value);
        },
        repoRoot: '/repo',
        write: () => {},
        writeFile: async (file, value) => files.set(file, value),
      });
    } catch (error) {
      console.log(JSON.stringify({
        error: error.message, json: files.get(jsonPath), markdown: files.get(markdownPath),
      }));
    }
  `);

  expect(result).toEqual({
    error: 'promotion failed',
    json: 'old json',
    markdown: 'old markdown',
  });
});

test('preserves unrestored report backups when cleanup and restoration fail', () => {
  const result = runParityProgram(`
    import path from 'node:path';
    import {runPackParityCommand} from ${JSON.stringify(parityModuleUrl)};
    const reportDirectory = path.resolve('/repo/.pkg-nec-release');
    const jsonPath = path.join(reportDirectory, 'upstream-parity.json');
    const markdownPath = path.join(reportDirectory, 'upstream-parity.md');
    const files = new Map([[jsonPath, 'old json'], [markdownPath, 'old markdown']]);
    let promotionFailed = false;
    try {
      await runPackParityCommand({
        baseline: {
          'packages/jest-core/package.json': {name: '@jest/core', version: '30.4.2'},
        },
        ledgerPath: path.join(reportDirectory, 'release-ledger.json'),
        packUpstream: async () => ({files: ['LICENSE', 'package.json']}),
        queryLatest: async () => '30.4.2',
        readFile: async () => JSON.stringify({packages: [{
          files: ['LICENSE', 'package.json'], name: '@pkg-nec/jest-core', version: '30.4.2',
        }]}),
        removeDirectory: async () => {},
        removeFile: async file => {
          if (file === jsonPath) throw new Error('cannot remove promoted json');
          files.delete(file);
        },
        rename: async (from, to) => {
          if (!promotionFailed && from.endsWith('.md') && to === markdownPath) {
            promotionFailed = true;
            throw new Error('promotion failed');
          }
          if (from.endsWith('.json.bak') && to === jsonPath) {
            throw new Error('cannot restore json');
          }
          const value = files.get(from);
          if (value === undefined) {
            const error = new Error('not found');
            error.code = 'ENOENT';
            throw error;
          }
          files.delete(from);
          files.set(to, value);
        },
        repoRoot: '/repo',
        write: () => {},
        writeFile: async (file, value) => files.set(file, value),
      });
    } catch (error) {
      console.log(JSON.stringify({
        cleanupErrors: error.cleanupErrors?.map(item => item.message),
        error: error.message,
        hasOldJsonBackup: [...files.values()].includes('old json'),
        markdown: files.get(markdownPath),
      }));
    }
  `);

  expect(result).toMatchObject({
    error: 'promotion failed',
    hasOldJsonBackup: true,
    markdown: 'old markdown',
  });
  expect(result.cleanupErrors).toEqual(
    expect.arrayContaining([
      'cannot remove promoted json',
      'cannot restore json',
    ]),
  );
});

test('keeps the primary temporary-write failure when temporary cleanup also fails', () => {
  const result = runParityProgram(`
    import {runPackParityCommand} from ${JSON.stringify(parityModuleUrl)};
    const files = new Map();
    try {
      await runPackParityCommand({
        baseline: {
          'packages/jest-core/package.json': {name: '@jest/core', version: '30.4.2'},
        },
        ledgerPath: '/repo/.pkg-nec-release/release-ledger.json',
        packUpstream: async () => ({files: ['LICENSE', 'package.json']}),
        queryLatest: async () => '30.4.2',
        readFile: async () => JSON.stringify({packages: [{
          files: ['LICENSE', 'package.json'], name: '@pkg-nec/jest-core', version: '30.4.2',
        }]}),
        removeDirectory: async () => {},
        removeFile: async file => {
          if (file.endsWith('.json')) throw new Error('cannot clean temporary json');
          files.delete(file);
        },
        repoRoot: '/repo',
        writeFile: async (file, value) => {
          if (file.endsWith('.md')) throw new Error('temporary write failed');
          files.set(file, value);
        },
      });
    } catch (error) {
      console.log(JSON.stringify({
        cleanupErrors: error.cleanupErrors?.map(item => item.message), error: error.message,
      }));
    }
  `);

  expect(result.error).toBe('temporary write failed');
  expect(result.cleanupErrors).toContain('cannot clean temporary json');
});
