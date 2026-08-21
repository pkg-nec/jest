/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

const {spawnSync} = require('node:child_process');
const fs = require('graceful-fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');

const repoRoot = process.cwd();
const moduleUrl = pathToFileURL(
  path.join(repoRoot, 'scripts/pkgNec/guardedFileSet.mjs'),
).href;
const artifactPattern = /\.pkg-nec-release-(?:tmp|backup)-/u;

let fixtureDirectories = [];

function supportsDirectoryLinks() {
  const directory = fs.mkdtempSync(
    path.join(repoRoot, '.guarded-link-support-'),
  );
  try {
    const target = path.join(directory, 'target');
    fs.mkdirSync(target);
    fs.symlinkSync(
      target,
      path.join(directory, 'link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    return true;
  } catch (error) {
    if (['EACCES', 'EPERM'].includes(error.code)) return false;
    throw error;
  } finally {
    fs.rmSync(directory, {force: true, recursive: true});
  }
}

const directoryLinksSupported = supportsDirectoryLinks();

afterEach(() => {
  for (const directory of fixtureDirectories) {
    fs.rmSync(directory, {force: true, recursive: true});
  }
  fixtureDirectories = [];
});

function fixture() {
  const directory = fs.mkdtempSync(
    path.join(repoRoot, '.guarded-file-set-test-'),
  );
  fixtureDirectories.push(directory);
  const first = path.join(directory, 'first.json');
  const second = path.join(directory, 'second.json');
  const plan = path.join(directory, 'new-plan.json');
  const originals = new Map([
    [first, Buffer.from('{"first":"original"}\r\n')],
    [second, Buffer.from('{"second":"original"}\n')],
  ]);
  for (const [file, content] of originals) fs.writeFileSync(file, content);
  return {
    directory,
    files: [
      {
        expectedPreimage: originals.get(first).toString('utf8'),
        path: first,
        text: '{"first":"updated"}\n',
      },
      {
        expectedPreimage: originals.get(second).toString('utf8'),
        path: second,
        text: '{"second":"updated"}\n',
      },
      {mustNotExist: true, path: plan, text: '{"plan":true}\n'},
    ],
    originals,
    plan,
  };
}

function runGuarded({
  cleanupRemovalMutationKind = null,
  cleanupRemovalMutationPath = null,
  cleanupWindowEditedPath = null,
  cleanupWindowTriggerRead = 4,
  cleanupWindowTriggerPath = null,
  driftAfterBackupPath = null,
  driftAfterOriginalRemovalPath = null,
  driftBeforeBackupPath = null,
  driftBeforeCleanupPath = null,
  driftText = 'externally-edited',
  failBackupAt = null,
  failBackupRemoveAt = null,
  failLinkUnsupported = false,
  failPromotionAt = null,
  failRemove = false,
  failWriteAt = null,
  files,
  foreignBackupAt = null,
  foreignPromotionPath = null,
  foreignReplacementPath = null,
  foreignWriteAt = null,
  missingTargets = [],
  primaryKind = 'error',
  reuseForeignIdentity = false,
  sourceSwapPath = null,
  sourceSwapAfterLinkPath = null,
  throwAfterBackupAt = null,
  throwAfterBackupRemoveAt = null,
  throwAfterPostLinkSourceSwap = false,
  throwAfterSourceSwapBackup = false,
  throwAfterOriginalRemoveAt = null,
  throwAfterPromotionAt = null,
  throwAfterRestoreAt = null,
  throwAfterTempRemoveAt = null,
}) {
  const scenario = {
    cleanupRemovalMutationKind,
    cleanupRemovalMutationPath,
    cleanupWindowEditedPath,
    cleanupWindowTriggerPath,
    cleanupWindowTriggerRead,
    driftAfterBackupPath,
    driftAfterOriginalRemovalPath,
    driftBeforeBackupPath,
    driftBeforeCleanupPath,
    driftText,
    failBackupAt,
    failBackupRemoveAt,
    failLinkUnsupported,
    failPromotionAt,
    failRemove,
    failWriteAt,
    files,
    foreignBackupAt,
    foreignPromotionPath,
    foreignReplacementPath,
    foreignWriteAt,
    missingTargets,
    primaryKind,
    reuseForeignIdentity,
    sourceSwapAfterLinkPath,
    sourceSwapPath,
    throwAfterBackupAt,
    throwAfterBackupRemoveAt,
    throwAfterOriginalRemoveAt,
    throwAfterPostLinkSourceSwap,
    throwAfterPromotionAt,
    throwAfterRestoreAt,
    throwAfterSourceSwapBackup,
    throwAfterTempRemoveAt,
  };
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
        import fs from 'graceful-fs';
        import {promoteGuardedFileSet} from ${JSON.stringify(moduleUrl)};

        const scenario = ${JSON.stringify(scenario)};
        const calls = [];
        let adapterFailure = null;
        const counts = {backup: 0, backupRemove: 0, originalRemove: 0, promotion: 0, restore: 0, tempRemove: 0};
        const backupByTarget = new Map();
        const backupReadCounts = new Map();
        const cleanupRemovalMutated = new Set();
        const reusedIdentities = new Map();
        const targetByBackup = new Map();
        let driftedBeforeBackup = false;
        let writeCount = 0;
        const isBackup = file => String(file).includes('.pkg-nec-release-backup-');
        const isTemporary = file => String(file).includes('.pkg-nec-release-tmp-');
        const messageOf = value =>
          value && typeof value === 'object' && typeof value.message === 'string'
            ? value.message
            : String(value);
        const makeFailure = message => {
          if (scenario.primaryKind === 'primitive') {
            adapterFailure = message;
          } else {
            adapterFailure = new Error(message);
            if (scenario.primaryKind === 'frozen') Object.freeze(adapterFailure);
          }
          return adapterFailure;
        };
        const readFile = async (file, encoding) => {
          calls.push({file, kind: 'read'});
          if (scenario.missingTargets.includes(file)) {
            throw Object.assign(new Error('missing'), {code: 'ENOENT'});
          }
          if (isBackup(file)) {
            const backupReadCount = (backupReadCounts.get(file) ?? 0) + 1;
            backupReadCounts.set(file, backupReadCount);
            if (
              targetByBackup.get(file) === scenario.cleanupWindowTriggerPath &&
              backupReadCount === scenario.cleanupWindowTriggerRead
            ) {
              const editedBackup = backupByTarget.get(
                scenario.cleanupWindowEditedPath,
              );
              await fs.promises.writeFile(editedBackup, scenario.driftText);
              calls.push({file: editedBackup, kind: 'cleanup-window-drift'});
            }
          }
          return fs.promises.readFile(file, encoding);
        };
        const realpath = async file => {
          calls.push({file, kind: 'realpath'});
          return fs.promises.realpath(file);
        };
        const lstat = async (file, options) => {
          calls.push({file, kind: 'lstat'});
          if (
            isBackup(file) &&
            targetByBackup.get(file) === scenario.cleanupRemovalMutationPath &&
            backupReadCounts.get(file) === 5 &&
            !cleanupRemovalMutated.has(file)
          ) {
            cleanupRemovalMutated.add(file);
            const replacedStat = await fs.promises.lstat(file, {bigint: true});
            await fs.promises.rm(file, {force: true});
            if (scenario.cleanupRemovalMutationKind === 'foreign') {
              await fs.promises.writeFile(file, 'foreign-backup-replacement');
              if (scenario.reuseForeignIdentity) {
                reusedIdentities.set(file, {
                  dev: replacedStat.dev,
                  ino: replacedStat.ino,
                });
              }
            }
            calls.push({
              file,
              kind: 'cleanup-removal-mutation',
              mutation: scenario.cleanupRemovalMutationKind,
            });
          }
          const stat = await fs.promises.lstat(file, options);
          const reusedIdentity = reusedIdentities.get(file);
          if (!reusedIdentity) return stat;
          return {
            dev: reusedIdentity.dev,
            ino: reusedIdentity.ino,
            isFile: () => stat.isFile(),
          };
        };
        const link = async (from, to) => {
          const operation = isBackup(to)
            ? 'backup'
            : isBackup(from)
              ? 'restore'
              : 'promotion';
          counts[operation]++;
          calls.push({from, kind: 'link', operation, to});
          if (scenario.failLinkUnsupported) {
            throw Object.assign(new Error('hard links unsupported'), {code: 'EPERM'});
          }
          if (
            operation === 'backup' &&
            counts.backup === scenario.foreignBackupAt
          ) {
            await fs.promises.writeFile(to, 'foreign-backup');
          }
          if (
            operation === 'promotion' &&
            to === scenario.foreignPromotionPath
          ) {
            await fs.promises.writeFile(to, 'foreign-plan');
          }
          if (
            operation === 'promotion' &&
            counts.promotion === scenario.failPromotionAt
          ) {
            if (scenario.foreignReplacementPath) {
              const replacedStat = await fs.promises.lstat(
                scenario.foreignReplacementPath,
                {bigint: true},
              );
              await fs.promises.rm(scenario.foreignReplacementPath, {force: true});
              await fs.promises.writeFile(
                scenario.foreignReplacementPath,
                'foreign-replacement',
              );
              if (scenario.reuseForeignIdentity) {
                reusedIdentities.set(scenario.foreignReplacementPath, {
                  dev: replacedStat.dev,
                  ino: replacedStat.ino,
                });
              }
            }
            throw makeFailure('promotion ' + counts.promotion);
          }
          if (
            operation === 'backup' &&
            counts.backup === scenario.failBackupAt
          ) {
            throw makeFailure('backup ' + counts.backup);
          }
          if (operation === 'backup' && from === scenario.sourceSwapPath) {
            await fs.promises.rm(from, {force: true});
            await fs.promises.writeFile(from, scenario.driftText);
            calls.push({file: from, kind: 'backup-source-swap'});
          }
          await fs.promises.link(from, to);
          if (operation === 'backup') {
            backupByTarget.set(from, to);
            targetByBackup.set(to, from);
          }
          if (
            operation === 'backup' &&
            from === scenario.sourceSwapAfterLinkPath
          ) {
            await fs.promises.rm(from, {force: true});
            await fs.promises.writeFile(from, scenario.driftText);
            calls.push({file: from, kind: 'backup-post-link-source-swap'});
          }
          if (
            operation === 'backup' &&
            from === scenario.sourceSwapAfterLinkPath &&
            scenario.throwAfterPostLinkSourceSwap
          ) {
            throw makeFailure('backup post-link source swap after mutation');
          }
          if (
            operation === 'backup' &&
            from === scenario.sourceSwapPath &&
            scenario.throwAfterSourceSwapBackup
          ) {
            throw makeFailure('backup source swap after mutation');
          }
          if (
            operation === 'backup' &&
            from === scenario.driftAfterBackupPath
          ) {
            await fs.promises.writeFile(from, scenario.driftText);
          }
          if (
            operation === 'promotion' &&
            counts.promotion === scenario.files.length &&
            scenario.driftBeforeCleanupPath
          ) {
            await fs.promises.writeFile(
              backupByTarget.get(scenario.driftBeforeCleanupPath),
              scenario.driftText,
            );
          }
          if (
            operation === 'backup' &&
            counts.backup === scenario.throwAfterBackupAt
          ) {
            throw makeFailure('backup ' + counts.backup + ' after mutation');
          }
          if (
            operation === 'promotion' &&
            counts.promotion === scenario.throwAfterPromotionAt
          ) {
            throw makeFailure(
              'promotion ' + counts.promotion + ' after mutation',
            );
          }
          if (
            operation === 'restore' &&
            counts.restore === scenario.throwAfterRestoreAt
          ) {
            throw new Error('restore ' + counts.restore + ' after mutation');
          }
        };
        const rename = async (from, to) => {
          const operation = isBackup(to)
            ? 'backup'
            : isBackup(from)
              ? 'restore'
              : 'promotion';
          counts[operation]++;
          calls.push({from, kind: 'rename', operation, to});
          if (
            operation === 'backup' &&
            counts.backup === scenario.foreignBackupAt
          ) {
            await fs.promises.writeFile(to, 'foreign-backup');
            await fs.promises.rm(to);
          }
          if (
            operation === 'promotion' &&
            to === scenario.foreignPromotionPath
          ) {
            await fs.promises.writeFile(to, 'foreign-plan');
            await fs.promises.rm(to);
          }
          if (
            operation === 'promotion' &&
            counts.promotion === scenario.failPromotionAt
          ) {
            if (scenario.foreignReplacementPath) {
              await fs.promises.rm(scenario.foreignReplacementPath, {force: true});
              await fs.promises.writeFile(
                scenario.foreignReplacementPath,
                'foreign-replacement',
              );
            }
            throw makeFailure('promotion ' + counts.promotion);
          }
          if (
            operation === 'backup' &&
            counts.backup === scenario.failBackupAt
          ) {
            throw makeFailure('backup ' + counts.backup);
          }
          await fs.promises.rename(from, to);
          if (
            operation === 'backup' &&
            counts.backup === scenario.throwAfterBackupAt
          ) {
            throw makeFailure('backup ' + counts.backup + ' after mutation');
          }
          if (
            operation === 'promotion' &&
            counts.promotion === scenario.throwAfterPromotionAt
          ) {
            throw makeFailure(
              'promotion ' + counts.promotion + ' after mutation',
            );
          }
          if (
            operation === 'restore' &&
            counts.restore === scenario.throwAfterRestoreAt
          ) {
            throw new Error('restore ' + counts.restore + ' after mutation');
          }
        };
        const rm = async (file, options) => {
          const operation = isTemporary(file)
            ? 'tempRemove'
            : isBackup(file)
              ? 'backupRemove'
              : 'originalRemove';
          if (operation === 'tempRemove') counts.tempRemove++;
          if (operation === 'backupRemove') counts.backupRemove++;
          if (operation === 'originalRemove') counts.originalRemove++;
          calls.push({file, kind: 'rm', operation, options});
          if (scenario.failRemove) throw new Error('cleanup removal failure');
          if (
            operation === 'backupRemove' &&
            counts.backupRemove === scenario.failBackupRemoveAt
          ) {
            throw new Error('backup cleanup removal failure');
          }
          await fs.promises.rm(file, options);
          if (
            operation === 'backupRemove' &&
            counts.backupRemove === scenario.throwAfterBackupRemoveAt
          ) {
            throw new Error('backup cleanup removal failed after mutation');
          }
          if (
            operation === 'originalRemove' &&
            file === scenario.driftAfterOriginalRemovalPath
          ) {
            await fs.promises.writeFile(
              backupByTarget.get(file),
              scenario.driftText,
            );
          }
          if (
            operation === 'originalRemove' &&
            counts.originalRemove === scenario.throwAfterOriginalRemoveAt
          ) {
            throw makeFailure(
              'original removal ' + counts.originalRemove + ' after mutation',
            );
          }
          if (
            operation === 'tempRemove' &&
            counts.tempRemove === scenario.throwAfterTempRemoveAt
          ) {
            throw makeFailure(
              'temporary removal ' + counts.tempRemove + ' after mutation',
            );
          }
        };
        const writeFile = async (file, text, options) => {
          writeCount++;
          calls.push({file, kind: 'write', options, text});
          if (
            !driftedBeforeBackup &&
            scenario.driftBeforeBackupPath &&
            isTemporary(file)
          ) {
            const beforeDrift = await fs.promises.lstat(
              scenario.driftBeforeBackupPath,
            );
            await fs.promises.writeFile(
              scenario.driftBeforeBackupPath,
              scenario.driftText,
            );
            const afterDrift = await fs.promises.lstat(
              scenario.driftBeforeBackupPath,
            );
            calls.push({
              kind: 'drift',
              sameInode:
                beforeDrift.dev === afterDrift.dev &&
                beforeDrift.ino === afterDrift.ino,
            });
            driftedBeforeBackup = true;
          }
          if (writeCount === scenario.foreignWriteAt) {
            await fs.promises.writeFile(file, 'foreign');
            adapterFailure = Object.assign(new Error('temporary sibling exists'), {
              code: 'EEXIST',
            });
            throw adapterFailure;
          }
          if (writeCount === scenario.failWriteAt) {
            await fs.promises.writeFile(file, 'partial', options);
            throw makeFailure('write ' + writeCount);
          }
          return fs.promises.writeFile(file, text, options);
        };

        let error = null;
        try {
          await promoteGuardedFileSet({
            files: scenario.files,
            link,
            lstat,
            readFile,
            realpath,
            rename,
            rm,
            writeFile,
          });
        } catch (failure) {
          const cleanupErrors = failure?.cleanupErrors;
          const recoveryPaths = failure?.recoveryPaths;
          error = {
            causeMessage:
              failure && typeof failure === 'object' && 'cause' in failure
                ? messageOf(failure.cause)
                : null,
            cleanupErrors: Array.isArray(cleanupErrors)
              ? cleanupErrors.map(messageOf)
              : [],
            message: messageOf(failure),
            primaryPreserved:
              adapterFailure === null ||
              failure === adapterFailure ||
              (failure &&
                typeof failure === 'object' &&
                failure.cause === adapterFailure),
            recoveryPaths: Array.isArray(recoveryPaths) ? recoveryPaths : [],
          };
        }
        console.log(JSON.stringify({calls, error, pid: process.pid}));
      `,
    ],
    {cwd: repoRoot, encoding: 'utf8'},
  );
  if (child.status !== 0) throw new Error(child.stderr || child.stdout);
  return JSON.parse(child.stdout.trim());
}

function artifactNames(directory) {
  return fs
    .readdirSync(directory)
    .filter(name => artifactPattern.test(name))
    .sort();
}

function expectRestored({directory, originals, plan}) {
  for (const [file, content] of originals) {
    expect(fs.readFileSync(file)).toEqual(content);
  }
  expect(fs.existsSync(plan)).toBe(false);
  expect(artifactNames(directory)).toEqual([]);
}

function expectExternalEditPreserved(state, editedPath, editedText) {
  expect(fs.readFileSync(editedPath, 'utf8')).toBe(editedText);
  for (const [file, content] of state.originals) {
    if (file !== editedPath) expect(fs.readFileSync(file)).toEqual(content);
  }
  expect(fs.existsSync(state.plan)).toBe(false);
  expect(artifactNames(state.directory)).toEqual([]);
}

function expectPromotedWithRecoveryBackups(
  state,
  result,
  editedTarget,
  editedText,
) {
  const backupLinks = result.calls.filter(
    call => call.kind === 'link' && call.operation === 'backup',
  );
  const backups = new Map(backupLinks.map(call => [call.from, call.to]));

  for (const file of state.files) {
    expect(fs.readFileSync(file.path, 'utf8')).toBe(file.text);
  }
  for (const [target, original] of state.originals) {
    const expected = target === editedTarget ? editedText : original;
    expect(fs.readFileSync(backups.get(target))).toEqual(
      Buffer.isBuffer(expected) ? expected : Buffer.from(expected),
    );
  }
  const recoveryPaths = [...backups.values()].sort();
  expect(result.error.recoveryPaths.sort()).toEqual(recoveryPaths);
  expect(artifactNames(state.directory)).toEqual(
    recoveryPaths.map(file => path.basename(file)).sort(),
  );
}

test('removes every temporary sibling when writing temporary 2 fails', () => {
  const state = fixture();
  const result = runGuarded({failWriteAt: 2, files: state.files});

  expect(result.error.message).toBe('write 2');
  expectRestored(state);
  expect(
    result.calls.filter(
      call =>
        ['link', 'rename'].includes(call.kind) && call.operation === 'backup',
    ),
  ).toEqual([]);
});

test('restores target 1 when backing up target 2 fails', () => {
  const state = fixture();
  const result = runGuarded({failBackupAt: 2, files: state.files});

  expect(result.error.message).toBe('backup 2');
  expectRestored(state);
});

test('removes promoted target 1 and restores both backups when promoting target 2 fails', () => {
  const state = fixture();
  const result = runGuarded({failPromotionAt: 2, files: state.files});

  expect(result.error.message).toBe('promotion 2');
  expectRestored(state);
  const restoreCalls = result.calls.filter(
    call =>
      call.kind === 'link' &&
      path.basename(call.from).includes('.pkg-nec-release-backup-'),
  );
  expect(restoreCalls.map(call => path.basename(call.to))).toEqual([
    'second.json',
    'first.json',
  ]);
});

test('promotes every target when expected preimage bytes are unchanged', () => {
  const state = fixture();
  const result = runGuarded({files: state.files});

  expect(result.error).toBeNull();
  for (const file of state.files) {
    expect(fs.readFileSync(file.path, 'utf8')).toBe(file.text);
  }
  expect(artifactNames(state.directory)).toEqual([]);
  const writeAndLink = result.calls.filter(call =>
    ['link', 'write'].includes(call.kind),
  );
  expect(writeAndLink.slice(0, 3).map(call => call.kind)).toEqual([
    'write',
    'write',
    'write',
  ]);
  expect(
    writeAndLink
      .slice(3, 5)
      .every(call => call.kind === 'link' && call.operation === 'backup'),
  ).toBe(true);
  expect(
    writeAndLink
      .slice(5)
      .every(call => call.kind === 'link' && call.operation === 'promotion'),
  ).toBe(true);
  const temporaryWrites = result.calls.filter(call => call.kind === 'write');
  expect(temporaryWrites).toHaveLength(3);
  for (const call of temporaryWrites) {
    expect(path.dirname(call.file)).toBe(state.directory);
    expect(path.basename(call.file)).toMatch(
      new RegExp(
        `\\.pkg-nec-release-tmp-${result.pid}-[0-9a-f]{8}-[0-9a-f-]{27}$`,
        'u',
      ),
    );
  }
  const backupNames = result.calls
    .filter(
      call =>
        call.kind === 'link' &&
        path.basename(call.to).includes('.pkg-nec-release-backup-'),
    )
    .map(call => path.basename(call.to));
  expect(backupNames).toHaveLength(2);
  for (const name of backupNames) {
    expect(name).toMatch(
      new RegExp(
        `\\.pkg-nec-release-backup-${result.pid}-[0-9a-f]{8}-[0-9a-f-]{27}$`,
        'u',
      ),
    );
  }
});

test.each([
  [
    'resolved duplicate targets',
    [
      {path: 'target.json', text: 'first'},
      {path: 'nested/../target.json', text: 'second'},
    ],
    /duplicate/iu,
  ],
  [
    'a resolved target outside the repository',
    [{path: '../outside.json', text: 'outside'}],
    /outside/iu,
  ],
])('rejects %s before any mutation', (_label, files, message) => {
  const result = runGuarded({files});

  expect(result.error.message).toMatch(message);
  expect(
    result.calls.filter(call =>
      ['link', 'rename', 'rm', 'write'].includes(call.kind),
    ),
  ).toEqual([]);
});

test('attaches cleanup failures without replacing the primary error', () => {
  const state = fixture();
  const target = path.join(state.directory, 'new.json');
  const result = runGuarded({
    failRemove: true,
    failWriteAt: 1,
    files: [{path: target, text: 'new'}],
    missingTargets: [target],
  });

  expect(result.error.message).toBe('write 1');
  expect(result.error.primaryPreserved).toBe(true);
  expect(result.error.cleanupErrors).toEqual(['cleanup removal failure']);
});

test('does not remove a foreign temporary sibling after an exclusive-name collision', () => {
  const state = fixture();
  const result = runGuarded({files: state.files, foreignWriteAt: 1});
  const foreignPath = result.calls.find(call => call.kind === 'write').file;

  expect(result.error.message).toBe('temporary sibling exists');
  expect(fs.readFileSync(foreignPath, 'utf8')).toBe('foreign');
  for (const [file, content] of state.originals) {
    expect(fs.readFileSync(file)).toEqual(content);
  }
  expect(fs.existsSync(state.plan)).toBe(false);
});

(directoryLinksSupported ? test : test.skip)(
  'rejects a real symlink or junction parent that escapes the canonical repository',
  () => {
    const state = fixture();
    const outside = fs.mkdtempSync(
      path.join(path.dirname(repoRoot), '.guarded-outside-test-'),
    );
    fixtureDirectories.push(outside);
    const alias = path.join(state.directory, 'escape');
    fs.symlinkSync(
      outside,
      alias,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const escaped = path.join(alias, 'escaped.json');

    const result = runGuarded({
      files: [{mustNotExist: true, path: escaped, text: 'escaped'}],
    });

    expect(result.error.message).toMatch(/outside.*repository/iu);
    expect(
      result.calls.filter(call =>
        ['link', 'rename', 'rm', 'write'].includes(call.kind),
      ),
    ).toEqual([]);
    expect(fs.existsSync(path.join(outside, 'escaped.json'))).toBe(false);
  },
);

(directoryLinksSupported ? test : test.skip)(
  'rejects real parent aliases that resolve to one canonical target',
  () => {
    const state = fixture();
    const actual = path.join(state.directory, 'actual');
    const alias = path.join(state.directory, 'alias');
    fs.mkdirSync(actual);
    fs.symlinkSync(
      actual,
      alias,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const result = runGuarded({
      files: [
        {
          mustNotExist: true,
          path: path.join(actual, 'same.json'),
          text: 'first',
        },
        {
          mustNotExist: true,
          path: path.join(alias, 'same.json'),
          text: 'second',
        },
      ],
    });

    expect(result.error.message).toMatch(/duplicate/iu);
    expect(
      result.calls.filter(call =>
        ['link', 'rename', 'rm', 'write'].includes(call.kind),
      ),
    ).toEqual([]);
  },
);

test('rejects an existing target that is not a regular file before mutation', () => {
  const state = fixture();
  const directoryTarget = path.join(state.directory, 'directory.json');
  fs.mkdirSync(directoryTarget);

  const result = runGuarded({
    files: [{path: directoryTarget, text: 'not-a-directory'}],
  });

  expect(result.error.message).toMatch(/regular file/iu);
  expect(
    result.calls.filter(call =>
      ['link', 'rename', 'rm', 'write'].includes(call.kind),
    ),
  ).toEqual([]);
});

(process.platform === 'win32' ? test : test.skip)(
  'rejects Windows case aliases before mutation',
  () => {
    const state = fixture();
    const result = runGuarded({
      files: [
        {
          mustNotExist: true,
          path: path.join(state.directory, 'Case.json'),
          text: 'first',
        },
        {
          mustNotExist: true,
          path: path.join(state.directory, 'case.json'),
          text: 'second',
        },
      ],
    });

    expect(result.error.message).toMatch(/duplicate/iu);
    expect(
      result.calls.filter(call =>
        ['link', 'rename', 'rm', 'write'].includes(call.kind),
      ),
    ).toEqual([]);
  },
);

test('reconciles a backup created before its adapter throws', () => {
  const state = fixture();
  const result = runGuarded({files: state.files, throwAfterBackupAt: 1});

  expect(result.error.message).toBe('backup 1 after mutation');
  expectRestored(state);
});

test('reconciles a promoted target created before its adapter throws', () => {
  const state = fixture();
  const result = runGuarded({files: state.files, throwAfterPromotionAt: 1});

  expect(result.error.message).toBe('promotion 1 after mutation');
  expectRestored(state);
});

test('reconciles an original removed before its adapter throws', () => {
  const state = fixture();
  const result = runGuarded({
    files: state.files,
    throwAfterOriginalRemoveAt: 1,
  });

  expect(result.error.message).toBe('original removal 1 after mutation');
  expectRestored(state);
});

test('reconciles a temporary removed before its adapter throws', () => {
  const state = fixture();
  const result = runGuarded({
    files: state.files,
    throwAfterTempRemoveAt: 1,
  });

  expect(result.error.message).toBe('temporary removal 1 after mutation');
  expectRestored(state);
});

test('reconciles a restored target created before its adapter throws', () => {
  const state = fixture();
  const result = runGuarded({
    failPromotionAt: 2,
    files: state.files,
    throwAfterRestoreAt: 1,
  });

  expect(result.error.message).toBe('promotion 2');
  expect(result.error.cleanupErrors).toContain('restore 1 after mutation');
  expectRestored(state);
});

test('preserves a foreign backup destination collision', () => {
  const state = fixture();
  const result = runGuarded({files: state.files, foreignBackupAt: 1});
  const backupCall = result.calls.find(
    call =>
      ['link', 'rename'].includes(call.kind) && call.operation === 'backup',
  );

  expect(result.error.message).toMatch(/exist/iu);
  for (const [file, content] of state.originals) {
    expect(fs.readFileSync(file)).toEqual(content);
  }
  expect(fs.existsSync(state.plan)).toBe(false);
  expect(fs.readFileSync(backupCall.to, 'utf8')).toBe('foreign-backup');
});

test('preserves a foreign replacement of a promoted target', () => {
  const state = fixture();
  const first = state.files[0].path;
  const second = state.files[1].path;
  const result = runGuarded({
    failPromotionAt: 2,
    files: state.files,
    foreignReplacementPath: first,
    reuseForeignIdentity: true,
  });

  expect(result.error.message).toBe('promotion 2');
  expect(result.error.cleanupErrors.join('\n')).toMatch(/owned|changed/iu);
  expect(fs.readFileSync(first, 'utf8')).toBe('foreign-replacement');
  expect(fs.readFileSync(second)).toEqual(state.originals.get(second));
  expect(fs.existsSync(state.plan)).toBe(false);
  expect(artifactNames(state.directory)).toEqual([
    expect.stringContaining('.pkg-nec-release-backup-'),
  ]);
});

test('refuses an existing must-not-exist target before mutation', () => {
  const state = fixture();
  fs.writeFileSync(state.plan, 'foreign-plan');

  const result = runGuarded({files: state.files});

  expect(result.error.message).toMatch(/must not exist|already exists/iu);
  expect(fs.readFileSync(state.plan, 'utf8')).toBe('foreign-plan');
  expect(
    result.calls.filter(call =>
      ['link', 'rename', 'rm', 'write'].includes(call.kind),
    ),
  ).toEqual([]);
});

test('does not clobber a must-not-exist target that appears during promotion', () => {
  const state = fixture();
  const result = runGuarded({
    files: state.files,
    foreignPromotionPath: state.plan,
  });

  expect(result.error.message).toMatch(/exist/iu);
  for (const [file, content] of state.originals) {
    expect(fs.readFileSync(file)).toEqual(content);
  }
  expect(fs.readFileSync(state.plan, 'utf8')).toBe('foreign-plan');
  expect(artifactNames(state.directory)).toEqual([]);
});

test('fails safely when same-directory hard links are unsupported', () => {
  const state = fixture();
  const result = runGuarded({failLinkUnsupported: true, files: state.files});

  expect(result.error.message).toBe('hard links unsupported');
  expectRestored(state);
});

test('rejects an existing target without an exact expected preimage before mutation', () => {
  const state = fixture();
  const [first, ...remaining] = state.files;
  const {expectedPreimage: _expectedPreimage, ...withoutPreimage} = first;
  const result = runGuarded({
    files: [withoutPreimage, ...remaining],
  });

  expect(result.error.message).toMatch(/expected preimage/iu);
  expectRestored(state);
  expect(
    result.calls.filter(call =>
      ['link', 'rename', 'rm', 'write'].includes(call.kind),
    ),
  ).toEqual([]);
});

test('rejects same-inode drift between resolution and backup without losing the edit', () => {
  const state = fixture();
  const target = state.files[0].path;
  const result = runGuarded({
    driftBeforeBackupPath: target,
    files: state.files,
  });

  expect(result.calls.find(call => call.kind === 'drift').sameInode).toBe(true);
  expect(result.error.message).toMatch(/preimage.*changed|stale/iu);
  expectExternalEditPreserved(state, target, 'externally-edited');
});

test('rejects drift after backup creation and removes only the owned backup link', () => {
  const state = fixture();
  const target = state.files[0].path;
  const result = runGuarded({
    driftAfterBackupPath: target,
    files: state.files,
  });

  expect(result.error.message).toMatch(/preimage.*changed|stale/iu);
  expectExternalEditPreserved(state, target, 'externally-edited');
});

test('restores edited bytes when the owned backup drifts after original removal', () => {
  const state = fixture();
  const target = state.files[0].path;
  const result = runGuarded({
    driftAfterOriginalRemovalPath: target,
    files: state.files,
  });

  expect(result.error.message).toMatch(/preimage.*changed|stale/iu);
  expectExternalEditPreserved(state, target, 'externally-edited');
});

test('retains promoted targets when a backup drifts before success cleanup', () => {
  const state = fixture();
  const target = state.files[0].path;
  const result = runGuarded({
    driftBeforeCleanupPath: target,
    files: state.files,
  });

  expect(result.error.message).toMatch(/preimage.*changed|stale/iu);
  expectPromotedWithRecoveryBackups(state, result, target, 'externally-edited');
});

test('retains promoted targets when an earlier backup drifts during the group preflight', () => {
  const state = fixture();
  const editedTarget = state.files[0].path;
  const triggerTarget = state.files[1].path;
  const result = runGuarded({
    cleanupWindowEditedPath: editedTarget,
    cleanupWindowTriggerPath: triggerTarget,
    files: state.files,
  });

  expect(result.calls.some(call => call.kind === 'cleanup-window-drift')).toBe(
    true,
  );
  expect(result.error.message).toMatch(/preimage.*changed|stale/iu);
  expectPromotedWithRecoveryBackups(
    state,
    result,
    editedTarget,
    'externally-edited',
  );
});

test('retains a path-addressable backup edit when an earlier backup is already deleted', () => {
  const state = fixture();
  const editedTarget = state.files[1].path;
  const result = runGuarded({
    cleanupWindowEditedPath: editedTarget,
    cleanupWindowTriggerPath: editedTarget,
    cleanupWindowTriggerRead: 5,
    files: state.files,
  });
  const editedBackup = result.calls.find(
    call => call.kind === 'cleanup-window-drift',
  ).file;

  expect(result.error.message).toMatch(/preimage.*changed|stale/iu);
  expect(result.error.message).toContain(editedBackup);
  expect(fs.readFileSync(editedTarget, 'utf8')).toBe(state.files[1].text);
  expect(fs.readFileSync(editedBackup, 'utf8')).toBe('externally-edited');
  expect(artifactNames(state.directory)).toEqual([path.basename(editedBackup)]);
});

test('keeps promoted targets when a foreign first backup makes rollback unsafe', () => {
  const state = fixture();
  const firstTarget = state.files[0].path;
  const secondTarget = state.files[1].path;
  const result = runGuarded({
    cleanupRemovalMutationKind: 'foreign',
    cleanupRemovalMutationPath: firstTarget,
    cleanupWindowEditedPath: secondTarget,
    cleanupWindowTriggerPath: secondTarget,
    cleanupWindowTriggerRead: 5,
    files: state.files,
    reuseForeignIdentity: true,
  });
  const backupLinks = result.calls.filter(
    call => call.kind === 'link' && call.operation === 'backup',
  );
  const firstBackup = backupLinks.find(call => call.from === firstTarget).to;
  const secondBackup = backupLinks.find(call => call.from === secondTarget).to;

  expect(result.error.message).toContain(firstBackup);
  expect(result.error.cleanupErrors.join('\n')).toContain(secondBackup);
  expect(result.error.recoveryPaths).toEqual([secondBackup]);
  expect(fs.readFileSync(firstTarget, 'utf8')).toBe(state.files[0].text);
  expect(fs.readFileSync(secondTarget, 'utf8')).toBe(state.files[1].text);
  expect(fs.readFileSync(state.plan, 'utf8')).toBe(state.files[2].text);
  expect(fs.readFileSync(firstBackup, 'utf8')).toBe(
    'foreign-backup-replacement',
  );
  expect(fs.readFileSync(secondBackup, 'utf8')).toBe('externally-edited');
  expect(artifactNames(state.directory)).toEqual(
    [path.basename(firstBackup), path.basename(secondBackup)].sort(),
  );
});

test('keeps promoted targets when an absent first backup makes rollback unsafe', () => {
  const state = fixture();
  const firstTarget = state.files[0].path;
  const secondTarget = state.files[1].path;
  const result = runGuarded({
    cleanupRemovalMutationKind: 'absent',
    cleanupRemovalMutationPath: firstTarget,
    cleanupWindowEditedPath: secondTarget,
    cleanupWindowTriggerPath: secondTarget,
    cleanupWindowTriggerRead: 5,
    files: state.files,
  });
  const backupLinks = result.calls.filter(
    call => call.kind === 'link' && call.operation === 'backup',
  );
  const firstBackup = backupLinks.find(call => call.from === firstTarget).to;
  const secondBackup = backupLinks.find(call => call.from === secondTarget).to;

  expect(result.error.message).toContain(secondBackup);
  expect(result.error.recoveryPaths).toEqual([secondBackup]);
  expect(fs.existsSync(firstBackup)).toBe(false);
  expect(fs.readFileSync(firstTarget, 'utf8')).toBe(state.files[0].text);
  expect(fs.readFileSync(secondTarget, 'utf8')).toBe(state.files[1].text);
  expect(fs.readFileSync(state.plan, 'utf8')).toBe(state.files[2].text);
  expect(fs.readFileSync(secondBackup, 'utf8')).toBe('externally-edited');
  expect(artifactNames(state.directory)).toEqual([path.basename(secondBackup)]);
});

test('fully rolls back when cleanup fails with every backup restorable', () => {
  const state = fixture();
  const result = runGuarded({failBackupRemoveAt: 1, files: state.files});

  expect(result.error.message).toBe('backup cleanup removal failure');
  expect(result.error.recoveryPaths).toEqual([]);
  expectRestored(state);
});

test('keeps promoted targets after a cleanup removal deletes then throws', () => {
  const state = fixture();
  const firstTarget = state.files[0].path;
  const secondTarget = state.files[1].path;
  const result = runGuarded({
    files: state.files,
    throwAfterBackupRemoveAt: 1,
  });
  const backupLinks = result.calls.filter(
    call => call.kind === 'link' && call.operation === 'backup',
  );
  const firstBackup = backupLinks.find(call => call.from === firstTarget).to;
  const secondBackup = backupLinks.find(call => call.from === secondTarget).to;

  expect(result.error.message).toBe(
    'backup cleanup removal failed after mutation',
  );
  expect(result.error.recoveryPaths).toEqual([secondBackup]);
  expect(fs.existsSync(firstBackup)).toBe(false);
  expect(fs.readFileSync(firstTarget, 'utf8')).toBe(state.files[0].text);
  expect(fs.readFileSync(secondTarget, 'utf8')).toBe(state.files[1].text);
  expect(fs.readFileSync(state.plan, 'utf8')).toBe(state.files[2].text);
  expect(fs.readFileSync(secondBackup)).toEqual(
    state.originals.get(secondTarget),
  );
  expect(artifactNames(state.directory)).toEqual([path.basename(secondBackup)]);
});

test.each([
  {label: 'after link returns', throwAfterPostLinkSourceSwap: false},
  {label: 'after link mutates and throws', throwAfterPostLinkSourceSwap: true},
])(
  'exposes the original recovery backup when the source is swapped $label',
  ({throwAfterPostLinkSourceSwap}) => {
    const state = fixture();
    const target = state.files[0].path;
    const result = runGuarded({
      files: state.files,
      sourceSwapAfterLinkPath: target,
      throwAfterPostLinkSourceSwap,
    });
    const backup = result.calls.find(
      call => call.kind === 'link' && call.operation === 'backup',
    ).to;

    expect(
      result.calls.some(call => call.kind === 'backup-post-link-source-swap'),
    ).toBe(true);
    expect(result.error.message).toMatch(
      throwAfterPostLinkSourceSwap
        ? /backup post-link source swap after mutation/iu
        : /changed|preimage|owned/iu,
    );
    expect(result.error.recoveryPaths).toEqual([backup]);
    expect(fs.readFileSync(target, 'utf8')).toBe('externally-edited');
    expect(fs.readFileSync(backup)).toEqual(state.originals.get(target));
    expect(fs.readFileSync(state.files[1].path)).toEqual(
      state.originals.get(state.files[1].path),
    );
    expect(fs.existsSync(state.plan)).toBe(false);
    expect(artifactNames(state.directory)).toEqual([path.basename(backup)]);
  },
);

test.each([
  {label: 'after link returns', throwAfterSourceSwapBackup: false},
  {label: 'after link mutates and throws', throwAfterSourceSwapBackup: true},
])(
  'removes only the created backup link when its source is swapped $label',
  ({throwAfterSourceSwapBackup}) => {
    const state = fixture();
    const target = state.files[0].path;
    const result = runGuarded({
      files: state.files,
      sourceSwapPath: target,
      throwAfterSourceSwapBackup,
    });

    expect(result.calls.some(call => call.kind === 'backup-source-swap')).toBe(
      true,
    );
    expect(result.error.message).toMatch(
      throwAfterSourceSwapBackup
        ? /backup source swap after mutation/iu
        : /changed|owned/iu,
    );
    expect(result.error.recoveryPaths).toEqual([]);
    expectExternalEditPreserved(state, target, 'externally-edited');
  },
);

test.each(['frozen', 'primitive'])(
  'preserves a %s primary when cleanup errors cannot be attached directly',
  primaryKind => {
    const state = fixture();
    const target = path.join(state.directory, 'new.json');
    const result = runGuarded({
      failRemove: true,
      failWriteAt: 1,
      files: [{mustNotExist: true, path: target, text: 'new'}],
      primaryKind,
    });

    expect(result.error.message).toBe('write 1');
    expect(result.error.primaryPreserved).toBe(true);
    expect(result.error.causeMessage).toBe('write 1');
    expect(result.error.cleanupErrors).toEqual(['cleanup removal failure']);
  },
);
