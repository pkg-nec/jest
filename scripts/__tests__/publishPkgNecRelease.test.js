/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {gunzipSync, gzipSync} from 'node:zlib';
import fs from 'graceful-fs';

const {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} = fs;

const repoRoot = process.cwd();
const publisherModuleUrl = pathToFileURL(
  join(repoRoot, 'scripts/pkgNec/releasePublisher.mjs'),
).href;
const publisherCommandModuleUrl = pathToFileURL(
  join(repoRoot, 'scripts/publishPkgNecRelease.mjs'),
).href;
const validIntegrity = `sha512-${'A'.repeat(86)}==`;
function stateEntry(name, order, version) {
  return {
    files: ['package.json'],
    integrity: validIntegrity,
    name,
    order,
    prerequisites: [],
    tarball: `.pkg-nec-release/${name.slice(1).replace('/', '-')}-${version}.tgz`,
    version,
  };
}
const ledger = {
  generatedAt: '2026-08-19T12:34:56.000Z',
  nodeVersion: 'v22.23.1',
  packageManager: 'yarn@4.18.0',
  packages: [
    stateEntry('@pkg-nec/a', 1, '1.0.0'),
    stateEntry('@pkg-nec/b', 2, '2.0.0'),
    stateEntry('@pkg-nec/c', 3, '3.0.0'),
  ],
  releasePlan: {
    digest: `sha256-${'a'.repeat(64)}`,
    path: 'docs/releases/pkg-nec-jest-v30.4.3-plan.json',
  },
  schemaVersion: 2,
  sourceCommit: '0123456789abcdef0123456789abcdef01234567',
};

function matchingObserved(entry) {
  return {
    integrity: entry.integrity,
    kind: 'present',
    name: entry.name,
    version: entry.version,
  };
}

function runPublisherScenario(scenario) {
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
        import {publishRelease} from ${JSON.stringify(publisherModuleUrl)};
        const scenario = ${JSON.stringify(scenario)};
        const events = [];
        const persisted = [];
        let originalPublishError;
        const entryJournalEvent = journal => {
          const completed = journal.packages.at(-1);
          return completed
            ? 'journal:' + completed.name + ':' + completed.disposition
            : 'journal:empty';
        };
        try {
          const journal = await publishRelease({
            inspect: async entry => {
              if (!scenario.recordProgress) {
                events.push('inspect:' + entry.name);
              }
              return scenario.inspections?.[entry.name] ?? {kind: 'absent'};
            },
            ledger: scenario.ledger,
            now: () => '2026-08-19T12:34:56.000Z',
            persistJournal: async journal => {
              events.push(
                scenario.recordProgress
                  ? {count: journal.packages.length, kind: 'persist'}
                  : entryJournalEvent(journal),
              );
              persisted.push(structuredClone(journal));
              if (
                scenario.rejectPackagePersistence &&
                journal.packages.length === 1
              ) {
                throw new Error('journal persistence failed');
              }
            },
            onProgress: scenario.recordProgress
              ? async event => events.push({event, kind: 'progress'})
              : undefined,
            publish: async entry => {
              if (!scenario.recordProgress) {
                events.push('publish:' + entry.name);
              }
              if (scenario.publishError) {
                originalPublishError = Object.assign(
                  new Error(scenario.publishError.message),
                  {classification: scenario.publishError.classification},
                );
                throw originalPublishError;
              }
            },
            releaseTag: scenario.releaseTag,
            verifyConflict: async entry => {
              events.push('verify-conflict:' + entry.name);
              return scenario.conflictResults?.[entry.name];
            },
          });
          console.log(JSON.stringify({events, journal, persisted}));
        } catch (error) {
          console.log(JSON.stringify({
            error: error.message,
            events,
            isOriginalPublishError: error === originalPublishError,
            persisted,
          }));
        }
      `,
    ],
    {cwd: repoRoot, encoding: 'utf8'},
  );
  if (child.status !== 0) throw new Error(child.stderr || child.stdout);
  return JSON.parse(child.stdout.trim());
}

test('emits progress only after package journal persistence', () => {
  const result = runPublisherScenario(
    scenario({
      ledger: {...ledger, packages: [ledger.packages[0]]},
      recordProgress: true,
    }),
  );

  expect(result.events).toEqual([
    {count: 0, kind: 'persist'},
    {count: 1, kind: 'persist'},
    {
      event: {
        completedAt: '2026-08-19T12:34:56.000Z',
        disposition: 'published',
        name: '@pkg-nec/a',
        order: 1,
        total: 1,
        version: '1.0.0',
      },
      kind: 'progress',
    },
  ]);
  expect(result.journal.packages).toHaveLength(1);
});

test('does not emit progress when package journal persistence fails', () => {
  const result = runPublisherScenario(
    scenario({
      ledger: {...ledger, packages: [ledger.packages[0]]},
      recordProgress: true,
      rejectPackagePersistence: true,
    }),
  );

  expect(result.error).toBe('journal persistence failed');
  expect(result.events).toEqual([
    {count: 0, kind: 'persist'},
    {count: 1, kind: 'persist'},
  ]);
});

function runDeferredProgressScenario({rejectProgress = false} = {}) {
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
        import {publishRelease} from ${JSON.stringify(publisherModuleUrl)};
        const ledger = ${JSON.stringify({
          ...ledger,
          packages: ledger.packages.slice(0, 2),
        })};
        const events = [];
        const persisted = [];
        let progressCount = 0;
        let releaseFirstProgress;
        const firstProgress = new Promise(resolve => {
          releaseFirstProgress = resolve;
        });
        let firstProgressStarted;
        const firstProgressStart = new Promise(resolve => {
          firstProgressStarted = resolve;
        });
        const publisher = publishRelease({
          inspect: async entry => {
            events.push({kind: 'inspect', name: entry.name});
            return {kind: 'absent'};
          },
          ledger,
          now: () => '2026-08-20T00:00:00.000Z',
          onProgress: event => {
            progressCount += 1;
            events.push({kind: 'progress-start', name: event.name});
            if (progressCount > 1) {
              events.push({kind: 'progress-end', name: event.name});
              return Promise.resolve();
            }
            firstProgressStarted();
            const callback = (async () => {
              await firstProgress;
              if (${rejectProgress}) {
                throw new Error('progress callback failed');
              }
              events.push({kind: 'progress-end', name: event.name});
            })();
            callback.catch(() => {});
            return callback;
          },
          persistJournal: async journal => {
            events.push({kind: 'persist', count: journal.packages.length});
            persisted.push(structuredClone(journal));
          },
          publish: async entry => {
            events.push({kind: 'publish', name: entry.name});
          },
          releaseTag: '@pkg-nec/jest-v30.4.3',
          verifyConflict: async () => {
            throw new Error('unexpected conflict verification');
          },
        });
        let publisherSettled = false;
        publisher.then(
          () => { publisherSettled = true; },
          () => { publisherSettled = true; },
        );
        await firstProgressStart;
        await new Promise(resolve => setImmediate(resolve));
        const beforeRelease = {
          events: structuredClone(events),
          publisherSettled,
        };
        releaseFirstProgress();
        try {
          const journal = await publisher;
          console.log(JSON.stringify({beforeRelease, events, journal, persisted}));
        } catch (error) {
          console.log(JSON.stringify({
            beforeRelease,
            error: error.message,
            events,
            persisted,
          }));
        }
      `,
    ],
    {cwd: repoRoot, encoding: 'utf8'},
  );
  if (child.status !== 0) throw new Error(child.stderr || child.stdout);
  return JSON.parse(child.stdout.trim());
}

test('keeps publication pending until deferred progress callback resolves', () => {
  const result = runDeferredProgressScenario();

  expect(result.beforeRelease).toEqual({
    events: [
      {count: 0, kind: 'persist'},
      {kind: 'inspect', name: '@pkg-nec/a'},
      {kind: 'publish', name: '@pkg-nec/a'},
      {count: 1, kind: 'persist'},
      {kind: 'progress-start', name: '@pkg-nec/a'},
    ],
    publisherSettled: false,
  });
  expect(result.events).toEqual([
    ...result.beforeRelease.events,
    {kind: 'progress-end', name: '@pkg-nec/a'},
    {kind: 'inspect', name: '@pkg-nec/b'},
    {kind: 'publish', name: '@pkg-nec/b'},
    {count: 2, kind: 'persist'},
    {kind: 'progress-start', name: '@pkg-nec/b'},
    {kind: 'progress-end', name: '@pkg-nec/b'},
  ]);
  expect(result.journal.packages).toHaveLength(2);
});

test('propagates deferred progress rejection after persistence and stops publication', () => {
  const result = runDeferredProgressScenario({rejectProgress: true});

  expect(result.error).toBe('progress callback failed');
  expect(result.beforeRelease.publisherSettled).toBe(false);
  expect(result.events).toEqual(result.beforeRelease.events);
  expect(result.persisted).toHaveLength(2);
  expect(result.persisted[1].packages).toHaveLength(1);
});

function scenario(overrides = {}) {
  return {ledger, releaseTag: '@pkg-nec/jest-v30.4.3', ...overrides};
}

test('rejects a schema-2 consumer interleaved inside its prerequisite component', () => {
  const result = runPublisherScenario(
    scenario({
      ledger: {
        ...ledger,
        packages: [
          {
            ...stateEntry('@pkg-nec/a', 1, '1.0.0'),
            prerequisites: ['@pkg-nec/b'],
          },
          {
            ...stateEntry('@pkg-nec/c', 2, '3.0.0'),
            prerequisites: ['@pkg-nec/a'],
          },
          {
            ...stateEntry('@pkg-nec/b', 3, '2.0.0'),
            prerequisites: ['@pkg-nec/a'],
          },
        ],
      },
    }),
  );

  expect(result.error).toBe(
    'Release ledger packages must follow component release order',
  );
  expect(result.events).toEqual([]);
  expect(result.persisted).toEqual([]);
});

function writeTarChecksum(header) {
  header.fill(0x20, 148, 156);
  const checksum = [...header].reduce((sum, value) => sum + value, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
}

function tarEntry({contents, name, type = '0'}) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 'utf8');
  header.write('0000644\0', 100, 'ascii');
  header.write('0000000\0', 108, 'ascii');
  header.write('0000000\0', 116, 'ascii');
  header.write(
    `${contents.length.toString(8).padStart(11, '0')}\0`,
    124,
    'ascii',
  );
  header.write('00000000000\0', 136, 'ascii');
  header.write(type, 156, 'ascii');
  header.write('ustar\0', 257, 'ascii');
  header.write('00', 263, 'ascii');
  writeTarChecksum(header);
  const padding = Buffer.alloc((512 - (contents.length % 512)) % 512);
  return Buffer.concat([header, contents, padding]);
}

function tarballForManifest(manifest) {
  return gzipSync(
    Buffer.concat([
      tarEntry({
        contents: Buffer.from(JSON.stringify(manifest)),
        name: 'package/package.json',
      }),
      Buffer.alloc(1024),
    ]),
  );
}

function runCommandFixture({
  args: suppliedArgs,
  journalParentAlias,
  journalRelative = '.pkg-nec-release/publish-journal.json',
  ledgerMutate = value => value,
  ledgerRelative = '.pkg-nec-release/release-ledger.json',
  missingTarball = false,
  packages = [
    {
      dependencies: {},
      directory: 'packages/a',
      name: '@pkg-nec/a',
      oldName: '@jest/a',
      version: '1.0.0',
    },
  ],
  packedMutate = value => value,
  renameFailureAt = null,
  sourceMutate = value => value,
  tagCommit = '0123456789abcdef0123456789abcdef01234567',
  tarballMutate = value => value,
  tempSymlinkOutside = false,
} = {}) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'pkg-nec-publisher-'));
  const outsideRoot = mkdtempSync(join(tmpdir(), 'pkg-nec-outside-'));
  const releaseDirectory = join(fixtureRoot, '.pkg-nec-release');
  mkdirSync(releaseDirectory, {recursive: true});

  const identities = [];
  const entries = [];
  for (const [index, definition] of packages.entries()) {
    const repository = {
      directory: definition.directory,
      url: 'https://github.com/pkg-nec/jest.git',
    };
    const sourceManifest = sourceMutate(
      {
        dependencies: definition.dependencies,
        devDependencies: definition.devDependencies,
        name: definition.name,
        optionalDependencies: definition.optionalDependencies,
        peerDependencies: definition.peerDependencies,
        publishConfig: {access: 'public'},
        repository,
        version: definition.version,
      },
      index,
    );
    const manifestPath = join(
      fixtureRoot,
      definition.directory,
      'package.json',
    );
    mkdirSync(join(fixtureRoot, definition.directory), {recursive: true});
    writeFileSync(manifestPath, JSON.stringify(sourceManifest));
    identities.push({
      directory: join(fixtureRoot, definition.directory),
      manifestPath,
      newName: definition.name,
      oldName: definition.oldName,
      publishable: true,
      version: definition.version,
    });

    const packedManifest = packedMutate(structuredClone(sourceManifest), index);
    const originalBytes = tarballForManifest(packedManifest);
    const tarballBytes = tarballMutate(originalBytes, index);
    const tarballName = `${definition.name.slice(1).replace('/', '-')}-${definition.version}.tgz`;
    const tarballRelative =
      definition.tarballRelative ?? `.pkg-nec-release/${tarballName}`;
    if (!missingTarball) {
      writeFileSync(join(fixtureRoot, tarballRelative), tarballBytes);
    }
    entries.push({
      files: ['package.json'],
      integrity: `sha512-${createHash('sha512')
        .update(definition.bindTarballIntegrity ? tarballBytes : originalBytes)
        .digest('base64')}`,
      name: definition.name,
      order: index + 1,
      prerequisites: [
        ...new Set(
          [
            'dependencies',
            'devDependencies',
            'optionalDependencies',
            'peerDependencies',
          ].flatMap(field =>
            Object.entries(definition[field] ?? {})
              .filter(([, value]) => String(value).startsWith('workspace:'))
              .map(([name]) => name)
              .filter(name =>
                packages.some(
                  item => item.name === name || item.oldName === name,
                ),
              ),
          ),
        ),
      ].sort((left, right) => left.localeCompare(right)),
      tarball: tarballRelative,
      version: definition.version,
    });
  }

  const candidateLedger = ledgerMutate({
    packages: entries,
    schemaVersion: 1,
    sourceCommit: '0123456789abcdef0123456789abcdef01234567',
  });
  const ledgerPath = join(fixtureRoot, ledgerRelative);
  mkdirSync(join(ledgerPath, '..'), {recursive: true});
  writeFileSync(ledgerPath, JSON.stringify(candidateLedger));
  const journalPath = join(fixtureRoot, journalRelative);
  const journalParent = join(journalPath, '..');
  if (journalParentAlias) {
    mkdirSync(join(journalParent, '..'), {recursive: true});
    symlinkSync(
      journalParentAlias === 'release' ? releaseDirectory : outsideRoot,
      journalParent,
      'junction',
    );
  } else {
    mkdirSync(journalParent, {recursive: true});
  }
  const outsideTarget = join(outsideRoot, 'outside-target.json');
  writeFileSync(outsideTarget, 'outside-sentinel');
  if (tempSymlinkOutside) {
    symlinkSync(outsideTarget, `${journalPath}.tmp`, 'file');
  }
  const args = suppliedArgs?.({fixtureRoot, journalPath, ledgerPath}) ?? [
    ledgerPath,
    journalPath,
    '@pkg-nec/a-v1.0.0',
  ];

  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
        import fs from 'node:fs';
        import path from 'node:path';
        import {runPublishReleaseCommand} from ${JSON.stringify(publisherCommandModuleUrl)};
        const fixtureRoot = ${JSON.stringify(fixtureRoot)};
        const definitions = ${JSON.stringify(identities)};
        const renameFailureAt = ${JSON.stringify(renameFailureAt)};
        const inventory = {
          byNewName: new Map(definitions.map(item => [item.newName, item])),
          byOldName: new Map(definitions.map(item => [item.oldName, item])),
          packages: definitions,
        };
        const events = [];
        const writes = [];
        let renameCount = 0;
        try {
          const journal = await runPublishReleaseCommand({
            args: ${JSON.stringify(args)},
            inspect: async entry => {
              events.push('npm-view:' + entry.name);
              return {kind: 'absent'};
            },
            inventory,
            now: () => '2026-08-19T12:34:56.000Z',
            publish: async entry => { events.push('npm-publish:' + entry.name); },
            readFile: async (...input) => {
              events.push('read:' + path.relative(fixtureRoot, input[0]).replaceAll('\\\\', '/'));
              return fs.promises.readFile(...input);
            },
            rename: async (from, to) => {
              events.push('rename:' + path.basename(from) + '->' + path.basename(to));
              renameCount += 1;
              if (renameCount === renameFailureAt) {
                throw new Error('publication journal rename failed');
              }
              return fs.promises.rename(from, to);
            },
            repoRoot: fixtureRoot,
            runGit: async (gitArgs, options) => {
              events.push('git:' + gitArgs.join(' ') + ':' + (options.cwd === fixtureRoot));
              return {stdout: ${JSON.stringify(tagCommit)}};
            },
            verifyConflict: async entry => {
              events.push('verify-conflict:' + entry.name);
              return {integrity: entry.integrity, name: entry.name, version: entry.version};
            },
            write: value => events.push('write:' + value),
            writeFile: async (file, value) => {
              const text = String(value);
              events.push('write-file:' + path.basename(file));
              writes.push({file: path.basename(file), text});
              return fs.promises.writeFile(file, value);
            },
          });
          console.log(JSON.stringify({events, journal, writes}));
        } catch (error) {
          console.log(JSON.stringify({error: error.message, events, writes}));
        }
      `,
    ],
    {cwd: repoRoot, encoding: 'utf8'},
  );
  try {
    if (child.status !== 0) throw new Error(child.stderr || child.stdout);
    return {
      ...JSON.parse(child.stdout.trim()),
      outsideText: readFileSync(outsideTarget, 'utf8'),
    };
  } finally {
    rmSync(fixtureRoot, {force: true, recursive: true});
    rmSync(outsideRoot, {force: true, recursive: true});
  }
}

test('publishes in ledger order without a post-publish registry verification', () => {
  const result = runPublisherScenario(scenario());

  expect(result.events).toEqual([
    'journal:empty',
    'inspect:@pkg-nec/a',
    'publish:@pkg-nec/a',
    'journal:@pkg-nec/a:published',
    'inspect:@pkg-nec/b',
    'publish:@pkg-nec/b',
    'journal:@pkg-nec/b:published',
    'inspect:@pkg-nec/c',
    'publish:@pkg-nec/c',
    'journal:@pkg-nec/c:published',
  ]);
  expect(result.journal).toEqual({
    packages: [
      {
        completedAt: '2026-08-19T12:34:56.000Z',
        disposition: 'published',
        integrity: validIntegrity,
        name: '@pkg-nec/a',
        order: 1,
        version: '1.0.0',
      },
      {
        completedAt: '2026-08-19T12:34:56.000Z',
        disposition: 'published',
        integrity: validIntegrity,
        name: '@pkg-nec/b',
        order: 2,
        version: '2.0.0',
      },
      {
        completedAt: '2026-08-19T12:34:56.000Z',
        disposition: 'published',
        integrity: validIntegrity,
        name: '@pkg-nec/c',
        order: 3,
        version: '3.0.0',
      },
    ],
    releaseTag: '@pkg-nec/jest-v30.4.3',
    schemaVersion: 1,
    sourceCommit: '0123456789abcdef0123456789abcdef01234567',
  });
});

test('persists an empty journal before its first inspection and each completed entry', () => {
  const result = runPublisherScenario(
    scenario({ledger: {...ledger, packages: ledger.packages.slice(0, 2)}}),
  );

  expect(result.persisted).toEqual([
    {
      packages: [],
      releaseTag: '@pkg-nec/jest-v30.4.3',
      schemaVersion: 1,
      sourceCommit: '0123456789abcdef0123456789abcdef01234567',
    },
    {
      packages: [
        {
          completedAt: '2026-08-19T12:34:56.000Z',
          disposition: 'published',
          integrity: validIntegrity,
          name: '@pkg-nec/a',
          order: 1,
          version: '1.0.0',
        },
      ],
      releaseTag: '@pkg-nec/jest-v30.4.3',
      schemaVersion: 1,
      sourceCommit: '0123456789abcdef0123456789abcdef01234567',
    },
    {
      packages: [
        {
          completedAt: '2026-08-19T12:34:56.000Z',
          disposition: 'published',
          integrity: validIntegrity,
          name: '@pkg-nec/a',
          order: 1,
          version: '1.0.0',
        },
        {
          completedAt: '2026-08-19T12:34:56.000Z',
          disposition: 'published',
          integrity: validIntegrity,
          name: '@pkg-nec/b',
          order: 2,
          version: '2.0.0',
        },
      ],
      releaseTag: '@pkg-nec/jest-v30.4.3',
      schemaVersion: 1,
      sourceCommit: '0123456789abcdef0123456789abcdef01234567',
    },
  ]);
});

test('resumes a package already present with its matching integrity', () => {
  const entry = ledger.packages[0];
  const result = runPublisherScenario(
    scenario({
      inspections: {[entry.name]: matchingObserved(entry)},
      ledger: {...ledger, packages: [entry]},
    }),
  );

  expect(result.events).toEqual([
    'journal:empty',
    'inspect:@pkg-nec/a',
    'journal:@pkg-nec/a:verified-existing',
  ]);
  expect(result.journal.packages).toEqual([
    {
      completedAt: '2026-08-19T12:34:56.000Z',
      disposition: 'verified-existing',
      integrity: validIntegrity,
      name: '@pkg-nec/a',
      order: 1,
      version: '1.0.0',
    },
  ]);
});

test('rejects mismatched present integrity without publishing', () => {
  const entry = ledger.packages[0];
  const result = runPublisherScenario(
    scenario({
      inspections: {
        [entry.name]: {
          ...matchingObserved(entry),
          integrity: 'sha512-different',
        },
      },
      ledger: {...ledger, packages: [entry]},
    }),
  );

  expect(result.error).toBe('Registry integrity mismatch for @pkg-nec/a@1.0.0');
  expect(result.events).toEqual(['journal:empty', 'inspect:@pkg-nec/a']);
});

test('rejects present packages whose name or version differs', () => {
  const entry = ledger.packages[0];
  const mismatches = [
    {
      integrity: validIntegrity,
      kind: 'present',
      name: '@pkg-nec/unexpected',
      version: '1.0.0',
    },
    {
      integrity: validIntegrity,
      kind: 'present',
      name: '@pkg-nec/a',
      version: '1.0.1',
    },
  ];

  for (const observed of mismatches) {
    const result = runPublisherScenario(
      scenario({
        inspections: {'@pkg-nec/a': observed},
        ledger: {...ledger, packages: [entry]},
      }),
    );

    expect(result.error).toBe(
      'Registry integrity mismatch for @pkg-nec/a@1.0.0',
    );
    expect(result.events).toEqual(['journal:empty', 'inspect:@pkg-nec/a']);
  }
});

test('rejects an indeterminate registry inspection without publishing', () => {
  const entry = ledger.packages[0];
  const result = runPublisherScenario(
    scenario({
      inspections: {[entry.name]: {kind: 'indeterminate'}},
      ledger: {...ledger, packages: [entry]},
    }),
  );

  expect(result.error).toBe(
    'Indeterminate registry state for @pkg-nec/a@1.0.0',
  );
  expect(result.events).toEqual(['journal:empty', 'inspect:@pkg-nec/a']);
});

test('recovers a version conflict only when conflict verification matches', () => {
  const entry = ledger.packages[0];
  const result = runPublisherScenario(
    scenario({
      conflictResults: {[entry.name]: matchingObserved(entry)},
      ledger: {...ledger, packages: [entry]},
      publishError: {
        classification: 'version-conflict',
        message: 'version already exists',
      },
    }),
  );

  expect(result.events).toEqual([
    'journal:empty',
    'inspect:@pkg-nec/a',
    'publish:@pkg-nec/a',
    'verify-conflict:@pkg-nec/a',
    'journal:@pkg-nec/a:verified-existing',
  ]);
  expect(result.journal.packages[0].disposition).toBe('verified-existing');
});

test('rejects a version conflict when verification has mismatched integrity', () => {
  const entry = ledger.packages[0];
  const result = runPublisherScenario(
    scenario({
      conflictResults: {
        [entry.name]: {
          ...matchingObserved(entry),
          integrity: 'sha512-different',
        },
      },
      ledger: {...ledger, packages: [entry]},
      publishError: {
        classification: 'version-conflict',
        message: 'version already exists',
      },
    }),
  );

  expect(result.error).toBe('Registry integrity mismatch for @pkg-nec/a@1.0.0');
  expect(result.events).toEqual([
    'journal:empty',
    'inspect:@pkg-nec/a',
    'publish:@pkg-nec/a',
    'verify-conflict:@pkg-nec/a',
  ]);
});

test('rejects conflict verification whose name or version differs', () => {
  const entry = ledger.packages[0];
  const mismatches = [
    {
      integrity: validIntegrity,
      kind: 'present',
      name: '@pkg-nec/unexpected',
      version: '1.0.0',
    },
    {
      integrity: validIntegrity,
      kind: 'present',
      name: '@pkg-nec/a',
      version: '1.0.1',
    },
  ];

  for (const conflictResult of mismatches) {
    const result = runPublisherScenario(
      scenario({
        conflictResults: {'@pkg-nec/a': conflictResult},
        ledger: {...ledger, packages: [entry]},
        publishError: {
          classification: 'version-conflict',
          message: 'version already exists',
        },
      }),
    );

    expect(result.error).toBe(
      'Registry integrity mismatch for @pkg-nec/a@1.0.0',
    );
    expect(result.events).toEqual([
      'journal:empty',
      'inspect:@pkg-nec/a',
      'publish:@pkg-nec/a',
      'verify-conflict:@pkg-nec/a',
    ]);
  }
});

test('propagates a publish failure and stops before the next ledger entry', () => {
  const result = runPublisherScenario(
    scenario({publishError: {message: 'network unavailable'}}),
  );

  expect(result.error).toBe('network unavailable');
  expect(result.isOriginalPublishError).toBe(true);
  expect(result.events).toEqual([
    'journal:empty',
    'inspect:@pkg-nec/a',
    'publish:@pkg-nec/a',
  ]);
});

test('rejects invalid ledgers before invoking any adapter', () => {
  const invalidLedgers = [
    [{...ledger, schemaVersion: 3}, 'Unsupported release ledger schema'],
    [{...ledger, packages: {}}, 'Release ledger packages must be an array'],
    [
      {...ledger, sourceCommit: '0123456789abcdef'},
      'Release ledger source commit must be a full Git commit',
    ],
    [
      {...ledger, unexpected: true},
      'Unexpected release ledger field: unexpected',
    ],
    [
      {...ledger, packages: [null]},
      'Invalid release ledger package at order 1',
    ],
    [
      {
        ...ledger,
        packages: [{...ledger.packages[0], unexpected: true}],
      },
      'Unexpected release ledger package field: unexpected',
    ],
    [
      {...ledger, packages: [{...ledger.packages[0], name: ''}]},
      'Invalid release ledger package name at order 1',
    ],
    [
      {...ledger, packages: [{...ledger.packages[0], version: 'latest'}]},
      'Invalid release ledger version for @pkg-nec/a',
    ],
    [
      {...ledger, packages: [{...ledger.packages[0], tarball: 42}]},
      'Invalid release ledger tarball for @pkg-nec/a',
    ],
    [
      {...ledger, packages: [{...ledger.packages[0], prerequisites: 'a'}]},
      'Invalid release ledger prerequisites for @pkg-nec/a',
    ],
    [
      {
        ...ledger,
        packages: [
          {...ledger.packages[0], prerequisites: ['@pkg-nec/missing']},
        ],
      },
      'Unknown release prerequisite @pkg-nec/missing for @pkg-nec/a',
    ],
    [
      {...ledger, packages: [{...ledger.packages[0], files: [42]}]},
      'Invalid release ledger files for @pkg-nec/a',
    ],
    [
      {...ledger, packages: [{...ledger.packages[0], order: 2}]},
      'Release ledger package order must be contiguous',
    ],
    [
      {
        ...ledger,
        packages: [ledger.packages[0], {...ledger.packages[0], order: 2}],
      },
      'Duplicate release ledger package: @pkg-nec/a',
    ],
    [
      {
        ...ledger,
        packages: [{...ledger.packages[0], integrity: 'sha256-alpha'}],
      },
      'Invalid release ledger integrity for @pkg-nec/a',
    ],
    [
      {...ledger, packages: [{...ledger.packages[0], integrity: 'sha512-'}]},
      'Invalid release ledger integrity for @pkg-nec/a',
    ],
    [
      {
        ...ledger,
        packages: [{...ledger.packages[0], integrity: 'sha512-not-base64!'}],
      },
      'Invalid release ledger integrity for @pkg-nec/a',
    ],
    [
      {...ledger, packages: [{...ledger.packages[0], integrity: 'sha512-abc'}]},
      'Invalid release ledger integrity for @pkg-nec/a',
    ],
  ];

  for (const [invalidLedger, message] of invalidLedgers) {
    const result = runPublisherScenario(scenario({ledger: invalidLedger}));
    expect(result.error).toBe(message);
    expect(result.events).toEqual([]);
  }

  const invalidReleasePlans = [
    [{...ledger, releasePlan: undefined}, 'Unsupported release ledger schema'],
    [
      {...ledger, releasePlan: {...ledger.releasePlan, extra: true}},
      'Unexpected release plan field: extra',
    ],
    [
      {...ledger, releasePlan: {...ledger.releasePlan, digest: 'sha256-bad'}},
      'Invalid release plan digest',
    ],
    [
      {
        ...ledger,
        releasePlan: {...ledger.releasePlan, path: '../hostile-plan.json'},
      },
      'Invalid release plan path',
    ],
  ];
  for (const [invalidLedger, message] of invalidReleasePlans) {
    const result = runPublisherScenario(scenario({ledger: invalidLedger}));
    expect(result.error).toBe(message);
    expect(result.events).toEqual([]);
  }

  const result = runPublisherScenario(scenario({releaseTag: ''}));
  expect(result.error).toBe('Release tag is required');
  expect(result.events).toEqual([]);
});

test('accepts a two-package schema-v2 ledger with release-plan metadata', () => {
  const result = runPublisherScenario(
    scenario({
      ledger: {
        ...ledger,
        generatedAt: '2026-08-19T12:34:56.000Z',
        nodeVersion: 'v22.23.1',
        packageManager: 'yarn@4.18.0',
        packages: ledger.packages.slice(0, 2),
      },
    }),
  );

  expect(result.error).toBeUndefined();
  expect(result.journal.packages).toHaveLength(2);
});

test('npm adapters use the exact public registry arguments and redact failures', () => {
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
        import {
          inspectRegistryEntry,
          publishRegistryEntry,
        } from ${JSON.stringify(publisherCommandModuleUrl)};
        const entry = {
          integrity: 'sha512-ledger',
          name: '@pkg-nec/jest',
          tarball: '.pkg-nec-release/pkg-nec-jest-30.4.3.tgz',
          version: '30.4.3',
        };
        const calls = [];
        const present = await inspectRegistryEntry(entry, async (command, args) => {
          calls.push({args, command});
          return {stdout: JSON.stringify({
            dist: {integrity: 'sha512-registry'},
            name: entry.name,
            version: entry.version,
          })};
        });
        const failures = [];
        for (const failure of [
          Object.assign(new Error('Command failed with exit code 1: npm view'), {
            stderr: 'npm error code E404\\nnpm error 404 Not Found - GET https://registry.npmjs.org/%40pkg-nec%2fjest',
          }),
          Object.assign(new Error('server Bearer npm_serverSecret'), {code: 'E503'}),
          Object.assign(new Error('auth _authToken=npm_authSecret'), {code: 'E401'}),
          new Error('malformed response'),
        ]) {
          try {
            const value = failure.message === 'malformed response'
              ? await inspectRegistryEntry(entry, async () => ({stdout: '{bad'}))
              : await inspectRegistryEntry(entry, async () => { throw failure; });
            failures.push(value);
          } catch (error) {
            failures.push({classification: error.classification, message: error.message});
          }
        }
        await publishRegistryEntry(entry, async (command, args) => {
          calls.push({args, command});
          return {stdout: ''};
        });
        const publishFailures = [];
        for (const failure of [
          Object.assign(new Error('You cannot publish over the previously published versions: 30.4.3'), {code: 'E403'}),
          Object.assign(new Error('authorization denied Bearer npm_publishSecret'), {code: 'E403'}),
          Object.assign(new Error('service unavailable'), {code: 'E503'}),
        ]) {
          try {
            await publishRegistryEntry(entry, async () => { throw failure; });
          } catch (error) {
            publishFailures.push({classification: error.classification, message: error.message});
          }
        }
        console.log(JSON.stringify({calls, failures, present, publishFailures}));
      `,
    ],
    {cwd: repoRoot, encoding: 'utf8'},
  );
  if (child.status !== 0) throw new Error(child.stderr || child.stdout);
  const result = JSON.parse(child.stdout.trim());

  expect(result.calls).toEqual([
    {
      args: [
        'view',
        '@pkg-nec/jest@30.4.3',
        '--json',
        '--registry=https://registry.npmjs.org/',
      ],
      command: 'npm',
    },
    {
      args: [
        'publish',
        '.pkg-nec-release/pkg-nec-jest-30.4.3.tgz',
        '--access',
        'public',
        '--provenance',
        '--registry=https://registry.npmjs.org/',
      ],
      command: 'npm',
    },
  ]);
  expect(result.present).toEqual({
    integrity: 'sha512-registry',
    kind: 'present',
    name: '@pkg-nec/jest',
    version: '30.4.3',
  });
  expect(result.failures[0]).toEqual({kind: 'absent'});
  expect(result.failures.slice(1).map(item => item.classification)).toEqual([
    'fatal',
    'fatal',
    'fatal',
  ]);
  expect(JSON.stringify(result.failures)).not.toContain('npm_serverSecret');
  expect(JSON.stringify(result.failures)).not.toContain('npm_authSecret');
  expect(result.publishFailures.map(item => item.classification)).toEqual([
    'version-conflict',
    'fatal',
    'fatal',
  ]);
  expect(JSON.stringify(result.publishFailures)).not.toContain(
    'npm_publishSecret',
  );
});

// Mutation caught: rendering a package's live progress before its completed
// journal entry has been atomically promoted.
test('publisher preflights tag, packed metadata, bytes, and order before side effects', () => {
  const success = runCommandFixture();
  const firstJournalWrite = success.events.findIndex(event =>
    event.startsWith('write-file:'),
  );
  expect(success.events.slice(0, firstJournalWrite)).toEqual([
    'read:.pkg-nec-release/release-ledger.json',
    'git:rev-list -n 1 @pkg-nec/a-v1.0.0:true',
    'read:packages/a/package.json',
    'read:.pkg-nec-release/pkg-nec-a-1.0.0.tgz',
  ]);
  expect(success.events.slice(firstJournalWrite)).toEqual([
    'write-file:publish-journal.json.tmp',
    'rename:publish-journal.json.tmp->publish-journal.json',
    'npm-view:@pkg-nec/a',
    'npm-publish:@pkg-nec/a',
    'write-file:publish-journal.json.tmp',
    'rename:publish-journal.json.tmp->publish-journal.json',
    'write:[1/1] @pkg-nec/a@1.0.0: published',
    'write:Published 1 pkg-nec release artifact(s).',
  ]);
  expect(success.writes).toHaveLength(2);
  for (const {file, text} of success.writes) {
    expect(file).toBe('publish-journal.json.tmp');
    expect(text).toBe(`${JSON.stringify(JSON.parse(text), null, 2)}\n`);
  }

  const cases = [
    {
      expected: 'Release ledger source commit does not match the release tag',
      options: {tagCommit: 'f'.repeat(40)},
    },
    {
      expected: 'Invalid prepared artifact path for @pkg-nec/a',
      options: {
        ledgerMutate: value => ({
          ...value,
          packages: [{...value.packages[0], tarball: '../escape.tgz'}],
        }),
      },
    },
    {
      expected: 'Prepared artifact missing for @pkg-nec/a',
      options: {missingTarball: true},
    },
    {
      expected: 'Prepared artifact integrity mismatch for @pkg-nec/a',
      options: {
        tarballMutate: value => Buffer.concat([value, Buffer.from('changed')]),
      },
    },
  ];
  for (const {expected, options} of cases) {
    const result = runCommandFixture(options);
    expect(result.error).toBe(expected);
    expect(result.events).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^(?:npm-|rename:|write-file:)/u),
      ]),
    );
  }
});

// Mutation caught: applying schema-2's four-field workspace graph to a
// historical schema-1 ledger whose preparation recorded runtime edges only.
test('publisher preserves dependencies-only graph semantics for schema-1 ledgers', () => {
  const packages = [
    {
      dependencies: {},
      directory: 'packages/a',
      name: '@pkg-nec/a',
      oldName: '@jest/a',
      version: '1.0.0',
    },
    {
      dependencies: {'@pkg-nec/a': '1.0.0'},
      devDependencies: {'@pkg-nec/z': 'workspace:*'},
      directory: 'packages/b',
      name: '@pkg-nec/b',
      oldName: '@jest/b',
      version: '2.0.0',
    },
    {
      dependencies: {},
      directory: 'packages/z',
      name: '@pkg-nec/z',
      oldName: '@jest/z',
      version: '3.0.0',
    },
  ];
  const legacyLedger = value => ({
    ...value,
    packages: value.packages.map(entry =>
      entry.name === '@pkg-nec/b'
        ? {...entry, prerequisites: ['@pkg-nec/a']}
        : entry,
    ),
  });
  const packedMutate = manifest => {
    if (manifest.devDependencies?.['@pkg-nec/z'] === 'workspace:*') {
      manifest.devDependencies['@pkg-nec/z'] = '3.0.0';
    }
    return manifest;
  };

  const accepted = runCommandFixture({
    ledgerMutate: legacyLedger,
    packages,
    packedMutate,
  });
  expect(accepted.error).toBeUndefined();
  expect(accepted.journal.packages.map(item => item.name)).toEqual([
    '@pkg-nec/a',
    '@pkg-nec/b',
    '@pkg-nec/z',
  ]);
  expect(accepted.events).toEqual(
    expect.arrayContaining([
      'npm-publish:@pkg-nec/a',
      'npm-publish:@pkg-nec/b',
      'npm-publish:@pkg-nec/z',
    ]),
  );

  const missingRuntimeEdge = runCommandFixture({
    ledgerMutate: value => {
      const ledger = legacyLedger(value);
      ledger.packages[1] = {...ledger.packages[1], prerequisites: []};
      return ledger;
    },
    packages,
    packedMutate,
  });
  expect(missingRuntimeEdge.error).toBe(
    'Release prerequisites changed for @pkg-nec/b',
  );

  const wrongRuntimeOrder = runCommandFixture({
    ledgerMutate: value => {
      const ledger = legacyLedger(value);
      ledger.packages = [
        ledger.packages[1],
        ledger.packages[0],
        ledger.packages[2],
      ].map((entry, index) => ({...entry, order: index + 1}));
      return ledger;
    },
    packages,
    packedMutate,
  });
  expect(wrongRuntimeOrder.error).toBe(
    'Release prerequisite @pkg-nec/a must precede @pkg-nec/b',
  );
  for (const result of [missingRuntimeEdge, wrongRuntimeOrder]) {
    expect(result.events).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^(?:npm-|rename:|write-file:)/u),
      ]),
    );
  }
});

// Mutation caught: reconstructing publication prerequisites from only
// dependencies while preparation uses all four workspace dependency fields.
test('publisher accepts a four-field selected graph and rejects missing edges or order', () => {
  const packages = [
    {
      dependencies: {},
      directory: 'packages/a',
      name: '@pkg-nec/a',
      oldName: '@jest/a',
      version: '1.0.0',
    },
    {
      dependencies: {},
      directory: 'packages/b',
      name: '@pkg-nec/b',
      oldName: '@jest/b',
      version: '2.0.0',
    },
    {
      dependencies: {},
      directory: 'packages/c',
      name: '@pkg-nec/c',
      oldName: '@jest/c',
      version: '3.0.0',
    },
    {
      dependencies: {},
      devDependencies: {'@pkg-nec/a': 'workspace:*'},
      directory: 'packages/d',
      name: '@pkg-nec/d',
      oldName: '@jest/d',
      optionalDependencies: {'@pkg-nec/c': 'workspace:^'},
      peerDependencies: {'@pkg-nec/b': 'workspace:~'},
      version: '4.0.0',
    },
    {
      dependencies: {'@pkg-nec/d': 'workspace:*'},
      directory: 'packages/e',
      name: '@pkg-nec/e',
      oldName: '@jest/e',
      version: '5.0.0',
    },
  ];
  const versions = new Map(packages.map(item => [item.name, item.version]));
  const packedMutate = manifest => {
    for (const field of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
    ]) {
      for (const [name, value] of Object.entries(manifest[field] ?? {})) {
        if (String(value).startsWith('workspace:')) {
          const protocol = String(value).slice('workspace:'.length);
          manifest[field][name] =
            protocol === '*'
              ? versions.get(name)
              : `${protocol}${versions.get(name)}`;
        }
      }
    }
    return manifest;
  };
  const selectiveLedger = value => ({
    generatedAt: '2026-08-21T00:00:00.000Z',
    nodeVersion: 'v24.18.0',
    packageManager: 'yarn@4.18.0',
    packages: value.packages.slice(0, 4),
    releasePlan: {
      digest: `sha256-${'a'.repeat(64)}`,
      path: 'docs/releases/pkg-nec-a-v1.0.0-plan.json',
    },
    schemaVersion: 2,
    sourceCommit: value.sourceCommit,
  });

  const accepted = runCommandFixture({
    ledgerMutate: selectiveLedger,
    packages,
    packedMutate,
  });
  expect(accepted.error).toBeUndefined();
  expect(accepted.events).toEqual(
    expect.arrayContaining([
      'npm-view:@pkg-nec/a',
      'npm-publish:@pkg-nec/a',
      'npm-view:@pkg-nec/b',
      'npm-publish:@pkg-nec/b',
      'npm-view:@pkg-nec/c',
      'npm-publish:@pkg-nec/c',
      'npm-view:@pkg-nec/d',
      'npm-publish:@pkg-nec/d',
    ]),
  );
  expect(accepted.events).not.toEqual(
    expect.arrayContaining([
      expect.stringMatching(/^npm-(?:view|publish):@pkg-nec\/e$/u),
    ]),
  );
  expect(accepted.journal.packages.map(item => item.name)).toEqual([
    '@pkg-nec/a',
    '@pkg-nec/b',
    '@pkg-nec/c',
    '@pkg-nec/d',
  ]);

  const missingEdge = runCommandFixture({
    ledgerMutate: value => {
      const ledger = selectiveLedger(value);
      ledger.packages[3] = {
        ...ledger.packages[3],
        prerequisites: ['@pkg-nec/a', '@pkg-nec/b'],
      };
      return ledger;
    },
    packages,
    packedMutate,
  });
  expect(missingEdge.error).toBe(
    'Release prerequisites changed for @pkg-nec/d',
  );

  const wrongOrder = runCommandFixture({
    ledgerMutate: value => {
      const ledger = selectiveLedger(value);
      ledger.packages = [
        ledger.packages[0],
        ledger.packages[1],
        ledger.packages[3],
        ledger.packages[2],
      ].map((entry, index) => ({...entry, order: index + 1}));
      return ledger;
    },
    packages,
    packedMutate,
  });
  expect(wrongOrder.error).toBe(
    'Release prerequisite @pkg-nec/c must precede @pkg-nec/d',
  );
  for (const result of [missingEdge, wrongOrder]) {
    expect(result.events).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^(?:npm-|rename:|write-file:)/u),
      ]),
    );
  }
});

test('publisher preflight accepts cyclic schema-2 prerequisites in component order', () => {
  const packages = [
    {
      dependencies: {},
      devDependencies: {'@pkg-nec/b': 'workspace:*'},
      directory: 'packages/a',
      name: '@pkg-nec/a',
      oldName: '@jest/a',
      version: '1.0.0',
    },
    {
      dependencies: {},
      directory: 'packages/b',
      name: '@pkg-nec/b',
      oldName: '@jest/b',
      peerDependencies: {'@pkg-nec/a': 'workspace:*'},
      version: '2.0.0',
    },
    {
      dependencies: {},
      directory: 'packages/c',
      name: '@pkg-nec/c',
      oldName: '@jest/c',
      optionalDependencies: {'@pkg-nec/b': 'workspace:*'},
      version: '3.0.0',
    },
    {
      dependencies: {},
      devDependencies: {'@pkg-nec/z': 'workspace:*'},
      directory: 'packages/z',
      name: '@pkg-nec/z',
      oldName: '@jest/z',
      version: '4.0.0',
    },
  ];
  const versions = new Map(packages.map(item => [item.name, item.version]));
  const packedMutate = manifest => {
    for (const field of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
    ]) {
      for (const [name, value] of Object.entries(manifest[field] ?? {})) {
        if (String(value).startsWith('workspace:')) {
          manifest[field][name] = versions.get(name);
        }
      }
    }
    return manifest;
  };
  const ledgerMutate = value => ({
    generatedAt: '2026-08-21T00:00:00.000Z',
    nodeVersion: 'v24.18.0',
    packageManager: 'yarn@4.18.0',
    packages: value.packages,
    releasePlan: {
      digest: `sha256-${'a'.repeat(64)}`,
      path: 'docs/releases/pkg-nec-a-v1.0.0-plan.json',
    },
    schemaVersion: 2,
    sourceCommit: value.sourceCommit,
  });

  const result = runCommandFixture({
    ledgerMutate,
    packages,
    packedMutate,
  });

  expect(result.error).toBeUndefined();
  expect(result.journal.packages.map(item => item.name)).toEqual([
    '@pkg-nec/a',
    '@pkg-nec/b',
    '@pkg-nec/c',
    '@pkg-nec/z',
  ]);
  expect(result.events).toEqual(
    expect.arrayContaining([
      'npm-publish:@pkg-nec/a',
      'npm-publish:@pkg-nec/b',
      'npm-publish:@pkg-nec/c',
      'npm-publish:@pkg-nec/z',
    ]),
  );
});

// Mutation caught: emitting package progress or final aggregate output after a
// completed journal write has failed to promote.
test('publisher writes no terminal output when package journal promotion fails', () => {
  const result = runCommandFixture({renameFailureAt: 2});
  const firstJournalWrite = result.events.findIndex(event =>
    event.startsWith('write-file:'),
  );

  expect(result.error).toBe('publication journal rename failed');
  expect(result.events.slice(firstJournalWrite)).toEqual([
    'write-file:publish-journal.json.tmp',
    'rename:publish-journal.json.tmp->publish-journal.json',
    'npm-view:@pkg-nec/a',
    'npm-publish:@pkg-nec/a',
    'write-file:publish-journal.json.tmp',
    'rename:publish-journal.json.tmp->publish-journal.json',
  ]);
  expect(result.events).not.toContain(
    'write:[1/1] @pkg-nec/a@1.0.0: published',
  );
  expect(result.events).not.toContain(
    'write:Published 1 pkg-nec release artifact(s).',
  );
});

test('publisher rejects transported packed metadata mutations before journaling or npm', () => {
  const alteredLedgerVersion = runCommandFixture({
    ledgerMutate: value => ({
      ...value,
      packages: [{...value.packages[0], version: '9.9.9'}],
    }),
  });
  expect(alteredLedgerVersion.error).toBe(
    'Release ledger version does not match source for @pkg-nec/a',
  );
  expect(alteredLedgerVersion.events).not.toEqual(
    expect.arrayContaining([
      expect.stringMatching(/^(?:npm-|rename:|write-file:)/u),
    ]),
  );

  const mutations = [
    [
      manifest => ({...manifest, name: '@pkg-nec/wrong'}),
      'Packed manifest name changed',
    ],
    [
      manifest => ({...manifest, version: '9.9.9'}),
      'Packed manifest version changed',
    ],
    [manifest => ({...manifest, private: true}), 'Packed manifest is private'],
    [
      manifest => ({...manifest, publishConfig: {access: 'restricted'}}),
      'Packed manifest access is not public',
    ],
    [
      manifest => {
        const {publishConfig: _publishConfig, ...withoutPublishConfig} =
          manifest;
        return withoutPublishConfig;
      },
      'Packed manifest access is not public',
    ],
    [
      manifest => ({
        ...manifest,
        repository: {
          ...manifest.repository,
          url: 'https://evil.invalid/repo.git',
        },
      }),
      'Packed manifest repository changed',
    ],
    [
      manifest => ({
        ...manifest,
        repository: {...manifest.repository, directory: 'packages/wrong'},
      }),
      'Packed manifest repository changed',
    ],
  ];
  for (const [packedMutate, message] of mutations) {
    const result = runCommandFixture({packedMutate});
    expect(result.error).toContain(message);
    expect(result.events).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^(?:npm-|rename:|write-file:)/u),
      ]),
    );
  }

  const wrongOrder = runCommandFixture({
    packages: [
      {
        dependencies: {'@pkg-nec/b': 'workspace:*'},
        directory: 'packages/a',
        name: '@pkg-nec/a',
        oldName: '@jest/a',
        version: '1.0.0',
      },
      {
        dependencies: {},
        directory: 'packages/b',
        name: '@pkg-nec/b',
        oldName: '@jest/b',
        version: '2.0.0',
      },
    ],
  });
  expect(wrongOrder.error).toBe(
    'Release prerequisite @pkg-nec/b must precede @pkg-nec/a',
  );
  expect(wrongOrder.events).not.toEqual(
    expect.arrayContaining([
      expect.stringMatching(/^(?:npm-|rename:|write-file:)/u),
    ]),
  );

  const jointlyWrongDirectory = runCommandFixture({
    sourceMutate: manifest => ({
      ...manifest,
      repository: {...manifest.repository, directory: 'packages/wrong'},
    }),
  });
  expect(jointlyWrongDirectory.error).toContain(
    'Packed manifest repository changed',
  );
  expect(jointlyWrongDirectory.events).not.toEqual(
    expect.arrayContaining([
      expect.stringMatching(/^(?:npm-|rename:|write-file:)/u),
    ]),
  );
});

test('publisher rejects usage and ledger or journal paths outside the release directory', () => {
  const cases = [
    {
      args: () => [],
      message:
        'Usage: yarn publish:pkg-nec-release <ledger-path> <journal-path> <release-tag>',
    },
    {
      args: ({fixtureRoot, journalPath}) => [
        join(fixtureRoot, 'outside-ledger.json'),
        journalPath,
        '@pkg-nec/a-v1.0.0',
      ],
      message: 'Invalid release ledger path',
    },
    {
      args: ({fixtureRoot, ledgerPath}) => [
        ledgerPath,
        join(fixtureRoot, 'outside-journal.json'),
        '@pkg-nec/a-v1.0.0',
      ],
      message: 'Invalid publication journal path',
    },
  ];
  for (const {args, message} of cases) {
    const result = runCommandFixture({args});
    expect(result.error).toContain(message);
    expect(result.events).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^(?:npm-|rename:|write-file:)/u),
      ]),
    );
  }
});

test('publisher rejects ledger and tarball collisions with the journal temp path', () => {
  const cases = [
    runCommandFixture({
      ledgerRelative: '.pkg-nec-release/publish-journal.json.tmp',
    }),
    runCommandFixture({
      packages: [
        {
          dependencies: {},
          directory: 'packages/a',
          name: '@pkg-nec/a',
          oldName: '@jest/a',
          tarballRelative: '.pkg-nec-release/publish-journal.json.tmp',
          version: '1.0.0',
        },
      ],
    }),
  ];

  expect(cases.map(result => result.error)).toEqual([
    'Publication journal temp path conflicts with release input',
    'Prepared artifact path is reused for @pkg-nec/a',
  ]);
  for (const result of cases) {
    expect(result.events).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^(?:npm-|rename:|write-file:)/u),
      ]),
    );
  }
});

test('publisher rejects canonical journal aliases and outside-root temp targets', () => {
  const cases = [
    {
      expected: 'Publication path aliases release input',
      result: runCommandFixture({
        journalParentAlias: 'release',
        journalRelative: '.pkg-nec-release/journal-alias/pkg-nec-a-1.0.0.tgz',
      }),
    },
    {
      // Both paths resolve outside the release root, so either concurrent
      // validation may reject first.
      expected: /Invalid publication journal(?: temp)? path/u,
      result: runCommandFixture({
        journalParentAlias: 'outside',
        journalRelative: '.pkg-nec-release/outside-alias/journal.json',
      }),
    },
    {
      expected: 'Invalid publication journal temp path',
      result: runCommandFixture({tempSymlinkOutside: true}),
    },
  ];

  for (const {expected, result} of cases) {
    expect(result.error).toMatch(expected);
    expect(result.events).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^(?:npm-|rename:|write-file:)/u),
      ]),
    );
    expect(result.outsideText).toBe('outside-sentinel');
  }
});

test('publisher rejects ambiguous or corrupt tar metadata before side effects', () => {
  const cases = [
    {
      message: 'Prepared artifact has an invalid tar checksum for @pkg-nec/a',
      mutate: value => {
        const archive = gunzipSync(value);
        archive[148] = archive[148] === 0x30 ? 0x31 : 0x30;
        return gzipSync(archive);
      },
    },
    {
      message:
        'Prepared artifact package manifest is not a regular file for @pkg-nec/a',
      mutate: value => {
        const archive = gunzipSync(value);
        archive.write('2', 156, 'ascii');
        writeTarChecksum(archive.subarray(0, 512));
        return gzipSync(archive);
      },
    },
    ...['x', 'g', 'L', 'K', 'N', 'X'].map(type => ({
      message: `Prepared artifact contains unsupported tar extension ${type} for @pkg-nec/a`,
      mutate: value =>
        gzipSync(
          Buffer.concat([
            tarEntry({
              contents: Buffer.from(
                type === 'x' ? '25 path=package/package.json\n' : 'ignored\0',
              ),
              name: 'package/extension',
              type,
            }),
            gunzipSync(value),
          ]),
        ),
    })),
  ];

  for (const {message, mutate} of cases) {
    const result = runCommandFixture({
      packages: [
        {
          bindTarballIntegrity: true,
          dependencies: {},
          directory: 'packages/a',
          name: '@pkg-nec/a',
          oldName: '@jest/a',
          version: '1.0.0',
        },
      ],
      tarballMutate: mutate,
    });
    expect(result.error).toBe(message);
    expect(result.events).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^(?:npm-|rename:|write-file:)/u),
      ]),
    );
  }
});
