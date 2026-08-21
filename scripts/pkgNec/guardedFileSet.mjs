/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {randomUUID} from 'node:crypto';
import path from 'node:path';

function isOutside(root, target) {
  const relative = path.relative(root, target);
  return (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  );
}

function canonicalKey(target) {
  return process.platform === 'win32' ? target.toLowerCase() : target;
}

function fileIdentity(stat) {
  return {dev: String(stat.dev), ino: String(stat.ino)};
}

function sameIdentity(left, right) {
  return (
    left !== null &&
    right !== null &&
    left.dev === right.dev &&
    left.ino === right.ino
  );
}

function exactBytes(value, label) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  throw new TypeError(`${label} must be a string or Buffer`);
}

function missing(error) {
  return error?.code === 'ENOENT';
}

async function statOrNull(lstat, target) {
  try {
    return await lstat(target, {bigint: true});
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

function stateError(action, target) {
  return new Error(
    `Cannot ${action}; the guarded object changed or is not owned: ${target}`,
  );
}

function preimageError(stage, target) {
  return Object.assign(
    new Error(
      `Guarded expected preimage changed ${stage}; refusing a stale write: ${target}`,
    ),
    {code: 'ERR_GUARDED_PREIMAGE_CHANGED'},
  );
}

async function assertExpectedPreimage(file, target, readFile, stage) {
  const actual = exactBytes(
    await readFile(target),
    `Guarded file bytes for ${target}`,
  );
  if (!actual.equals(file.expectedPreimage)) {
    throw preimageError(stage, target);
  }
}

function existsError(target, label = 'Guarded file target') {
  return Object.assign(new Error(`${label} already exists: ${target}`), {
    code: 'EEXIST',
  });
}

function primaryMessage(primary) {
  return primary &&
    (typeof primary === 'object' || typeof primary === 'function') &&
    typeof primary.message === 'string'
    ? primary.message
    : String(primary);
}

function withGuardedMetadata(primary, cleanupErrors, recoveryPaths = null) {
  if (cleanupErrors.length === 0 && recoveryPaths === null) return primary;
  if (
    primary !== null &&
    (typeof primary === 'object' || typeof primary === 'function')
  ) {
    try {
      const previousCleanupErrors = Array.isArray(primary.cleanupErrors)
        ? primary.cleanupErrors
        : [];
      const combinedCleanupErrors = [
        ...previousCleanupErrors,
        ...cleanupErrors,
      ];
      if (combinedCleanupErrors.length > 0) {
        primary.cleanupErrors = combinedCleanupErrors;
        if (primary.cleanupErrors !== combinedCleanupErrors) {
          throw new Error('cleanup errors not attached');
        }
      }
      if (recoveryPaths !== null) {
        const previousRecoveryPaths = Array.isArray(primary.recoveryPaths)
          ? primary.recoveryPaths
          : [];
        const combinedRecoveryPaths = [
          ...new Set([...previousRecoveryPaths, ...recoveryPaths]),
        ];
        primary.recoveryPaths = combinedRecoveryPaths;
        if (primary.recoveryPaths !== combinedRecoveryPaths) {
          throw new Error('recovery paths not attached');
        }
      }
      return primary;
    } catch {
      // A frozen or otherwise non-extensible primary needs a wrapper.
    }
  }
  const wrapped = new Error(primaryMessage(primary), {cause: primary});
  if (cleanupErrors.length > 0) wrapped.cleanupErrors = cleanupErrors;
  if (recoveryPaths !== null) wrapped.recoveryPaths = recoveryPaths;
  return wrapped;
}

async function reconcileStat(lstat, target, cleanupErrors) {
  try {
    return await statOrNull(lstat, target);
  } catch (error) {
    cleanupErrors.push(error);
    return undefined;
  }
}

async function resolveFiles({files, lstat, readFile, realpath}) {
  if (!Array.isArray(files)) throw new TypeError('files must be an array');
  const lexicalRoot = path.resolve(process.cwd());
  const repositoryRoot = await realpath(lexicalRoot);
  const seen = new Set();
  const resolved = [];

  for (const [index, file] of files.entries()) {
    if (
      !file ||
      typeof file.path !== 'string' ||
      file.path.length === 0 ||
      typeof file.text !== 'string' ||
      (file.mustNotExist !== undefined && file.mustNotExist !== true)
    ) {
      throw new TypeError(`Invalid guarded file at index ${index}`);
    }
    const target = path.resolve(lexicalRoot, file.path);
    if (target === lexicalRoot || isOutside(lexicalRoot, target)) {
      throw new Error(
        `Guarded file target is outside the repository: ${file.path}`,
      );
    }

    const canonicalParent = await realpath(path.dirname(target));
    const canonicalTarget = path.resolve(
      canonicalParent,
      path.basename(target),
    );
    if (
      canonicalTarget === repositoryRoot ||
      isOutside(repositoryRoot, canonicalTarget)
    ) {
      throw new Error(
        `Guarded file target is outside the repository: ${file.path}`,
      );
    }
    const key = canonicalKey(canonicalTarget);
    if (seen.has(key)) {
      throw new Error(`Duplicate guarded file target: ${file.path}`);
    }
    seen.add(key);

    let targetStat = await statOrNull(lstat, target);
    if (targetStat !== null && !targetStat.isFile()) {
      throw new Error(`Guarded target must be a regular file: ${file.path}`);
    }
    if (file.mustNotExist === true && targetStat !== null) {
      throw existsError(file.path, 'Guarded file target must not exist and');
    }
    const hasExpectedPreimage = Object.hasOwn(file, 'expectedPreimage');
    if (targetStat === null && hasExpectedPreimage) {
      throw preimageError('during canonical resolution', target);
    }
    if (targetStat !== null && !hasExpectedPreimage) {
      throw new TypeError(
        `Existing guarded target requires an expected preimage: ${file.path}`,
      );
    }
    const expectedPreimage = hasExpectedPreimage
      ? exactBytes(
          file.expectedPreimage,
          `Expected preimage for guarded target ${file.path}`,
        )
      : null;
    let originalIdentity =
      targetStat === null ? null : fileIdentity(targetStat);
    if (targetStat !== null) {
      const actualPreimage = exactBytes(
        await readFile(target),
        `Guarded file bytes for ${target}`,
      );
      if (!actualPreimage.equals(expectedPreimage)) {
        throw preimageError('during canonical resolution', target);
      }
      targetStat = await statOrNull(lstat, target);
      const afterReadIdentity =
        targetStat === null ? null : fileIdentity(targetStat);
      if (
        targetStat === null ||
        !targetStat.isFile() ||
        !sameIdentity(originalIdentity, afterReadIdentity)
      ) {
        throw stateError(
          'validate a target that changed while reading',
          target,
        );
      }
      originalIdentity = afterReadIdentity;
    }

    const suffix = `${process.pid}-${randomUUID()}`;
    resolved.push({
      backup: `${target}.pkg-nec-release-backup-${suffix}`,
      backupIdentity: null,
      canonicalTarget,
      expectedOutput: exactBytes(
        file.text,
        `Expected output for guarded target ${file.path}`,
      ),
      expectedPreimage,
      mustNotExist: file.mustNotExist === true,
      originalIdentity,
      ownedBackupBytes: null,
      ownedBackupIdentity: null,
      promotedBytes: null,
      promotedIdentity: null,
      target,
      temporary: `${target}.pkg-nec-release-tmp-${suffix}`,
      temporaryBytes: null,
      temporaryIdentity: null,
      text: file.text,
    });
  }
  return resolved;
}

async function captureOwnedBytes(
  target,
  expectedIdentity,
  {lstat, readFile},
  reconciliationErrors,
  label,
) {
  let bytes;
  try {
    bytes = exactBytes(
      await readFile(target),
      `Guarded owned file bytes for ${target}`,
    );
  } catch (error) {
    reconciliationErrors.push(error);
    return null;
  }
  const afterRead = await reconcileStat(lstat, target, reconciliationErrors);
  if (
    afterRead === undefined ||
    afterRead === null ||
    !afterRead.isFile() ||
    !sameIdentity(expectedIdentity, fileIdentity(afterRead))
  ) {
    if (afterRead !== undefined) {
      reconciliationErrors.push(stateError(label, target));
    }
    return null;
  }
  return bytes;
}

async function writeTemporary(
  file,
  {lstat, readFile, writeFile},
  reconciliationErrors,
) {
  if ((await statOrNull(lstat, file.temporary)) !== null) {
    throw existsError(file.temporary, 'Temporary sibling');
  }
  try {
    await writeFile(file.temporary, file.text, {
      encoding: 'utf8',
      flag: 'wx',
    });
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      const temporaryStat = await reconcileStat(
        lstat,
        file.temporary,
        reconciliationErrors,
      );
      if (temporaryStat?.isFile()) {
        file.temporaryIdentity = fileIdentity(temporaryStat);
        file.temporaryBytes = await captureOwnedBytes(
          file.temporary,
          file.temporaryIdentity,
          {lstat, readFile},
          reconciliationErrors,
          'capture the written temporary sibling',
        );
      }
    }
    throw error;
  }
  const temporaryStat = await statOrNull(lstat, file.temporary);
  if (temporaryStat === null || !temporaryStat.isFile()) {
    throw stateError('identify the written temporary sibling', file.temporary);
  }
  file.temporaryIdentity = fileIdentity(temporaryStat);
  file.temporaryBytes = await captureOwnedBytes(
    file.temporary,
    file.temporaryIdentity,
    {lstat, readFile},
    reconciliationErrors,
    'capture the written temporary sibling',
  );
  if (
    file.temporaryBytes === null ||
    !file.temporaryBytes.equals(file.expectedOutput)
  ) {
    throw stateError('verify the written temporary sibling', file.temporary);
  }
}

async function removeDuringTransaction({
  expectedIdentity,
  label,
  lstat,
  onAbsent,
  path: target,
  reconciliationErrors,
  rm,
}) {
  const before = await statOrNull(lstat, target);
  if (
    before === null ||
    !sameIdentity(expectedIdentity, fileIdentity(before))
  ) {
    throw stateError(label, target);
  }
  try {
    await rm(target, {force: false});
  } catch (error) {
    const after = await reconcileStat(lstat, target, reconciliationErrors);
    if (after === null) onAbsent();
    throw error;
  }
  onAbsent();
  const after = await statOrNull(lstat, target);
  if (after !== null) throw stateError(label, target);
}

async function backupTarget(
  file,
  {link, lstat, readFile, rm},
  reconciliationErrors,
) {
  if (file.originalIdentity === null) return;
  const current = await statOrNull(lstat, file.target);
  if (
    current === null ||
    !current.isFile() ||
    !sameIdentity(file.originalIdentity, fileIdentity(current))
  ) {
    throw stateError(
      'back up a target that changed after validation',
      file.target,
    );
  }
  await assertExpectedPreimage(
    file,
    file.target,
    readFile,
    'immediately before backup creation',
  );
  if ((await statOrNull(lstat, file.backup)) !== null) {
    throw existsError(file.backup, 'Backup sibling');
  }
  try {
    await link(file.target, file.backup);
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      const backupStat = await reconcileStat(
        lstat,
        file.backup,
        reconciliationErrors,
      );
      const sourceStat = await reconcileStat(
        lstat,
        file.target,
        reconciliationErrors,
      );
      if (backupStat?.isFile()) {
        const backupIdentity = fileIdentity(backupStat);
        if (
          sameIdentity(file.originalIdentity, backupIdentity) ||
          (sourceStat?.isFile() &&
            sameIdentity(fileIdentity(sourceStat), backupIdentity))
        ) {
          file.ownedBackupIdentity = backupIdentity;
          if (sameIdentity(file.originalIdentity, backupIdentity)) {
            file.backupIdentity = backupIdentity;
          }
        }
      }
      if (file.ownedBackupIdentity !== null) {
        file.ownedBackupBytes = await captureOwnedBytes(
          file.backup,
          file.ownedBackupIdentity,
          {lstat, readFile},
          reconciliationErrors,
          'capture the created backup sibling',
        );
      }
    }
    throw error;
  }
  const backupStat = await statOrNull(lstat, file.backup);
  if (backupStat === null || !backupStat.isFile()) {
    throw stateError('identify the created backup sibling', file.backup);
  }
  file.ownedBackupIdentity = fileIdentity(backupStat);
  if (!sameIdentity(file.originalIdentity, file.ownedBackupIdentity)) {
    file.ownedBackupBytes = await captureOwnedBytes(
      file.backup,
      file.ownedBackupIdentity,
      {lstat, readFile},
      reconciliationErrors,
      'capture the created backup sibling',
    );
    throw stateError(
      'back up a target whose source changed during link creation',
      file.target,
    );
  }
  file.backupIdentity = file.ownedBackupIdentity;
  file.ownedBackupBytes = file.expectedPreimage;
  const sourceStat = await statOrNull(lstat, file.target);
  if (
    sourceStat === null ||
    !sourceStat.isFile() ||
    !sameIdentity(file.originalIdentity, fileIdentity(sourceStat))
  ) {
    throw stateError(
      'continue after the backed-up target changed during link creation',
      file.target,
    );
  }
  await assertExpectedPreimage(
    file,
    file.target,
    readFile,
    'after backup creation',
  );
  await assertExpectedPreimage(
    file,
    file.backup,
    readFile,
    'in the owned backup after creation',
  );
  await removeDuringTransaction({
    expectedIdentity: file.originalIdentity,
    label: 'remove the backed-up original target',
    lstat,
    onAbsent: () => {},
    path: file.target,
    reconciliationErrors,
    rm,
  });
  await assertExpectedPreimage(
    file,
    file.backup,
    readFile,
    'after original removal',
  );
}

async function promoteTemporary(
  file,
  {link, lstat, readFile, rm},
  reconciliationErrors,
) {
  if (file.backupIdentity !== null) {
    await assertExpectedPreimage(
      file,
      file.backup,
      readFile,
      'immediately before promotion',
    );
  }
  if ((await statOrNull(lstat, file.target)) !== null) {
    throw existsError(file.target);
  }
  try {
    await link(file.temporary, file.target);
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      const targetStat = await reconcileStat(
        lstat,
        file.target,
        reconciliationErrors,
      );
      if (
        targetStat?.isFile() &&
        sameIdentity(file.temporaryIdentity, fileIdentity(targetStat))
      ) {
        file.promotedIdentity = fileIdentity(targetStat);
        file.promotedBytes = file.temporaryBytes;
      }
    }
    throw error;
  }
  file.promotedIdentity = file.temporaryIdentity;
  file.promotedBytes = file.temporaryBytes;
  const promotedStat = await statOrNull(lstat, file.target);
  if (
    promotedStat === null ||
    !promotedStat.isFile() ||
    !sameIdentity(file.promotedIdentity, fileIdentity(promotedStat))
  ) {
    file.promotedIdentity = null;
    throw stateError('identify the promoted target', file.target);
  }
  await removeDuringTransaction({
    expectedIdentity: file.temporaryIdentity,
    label: 'remove the promoted temporary sibling',
    lstat,
    onAbsent: () => {
      file.temporaryIdentity = null;
    },
    path: file.temporary,
    reconciliationErrors,
    rm,
  });
}

async function removeOwned(
  target,
  expectedIdentity,
  expectedBytes,
  label,
  {lstat, readFile, rm},
  cleanupErrors,
  linkedTarget = null,
) {
  if (!Buffer.isBuffer(expectedBytes)) {
    cleanupErrors.push(stateError(label, target));
    return {ownershipLost: true, removed: false};
  }
  const before = await reconcileStat(lstat, target, cleanupErrors);
  if (before === undefined) return {ownershipLost: false, removed: false};
  if (before === null) return {ownershipLost: false, removed: true};
  if (
    !before.isFile() ||
    !sameIdentity(expectedIdentity, fileIdentity(before))
  ) {
    cleanupErrors.push(stateError(label, target));
    return {ownershipLost: true, removed: false};
  }
  let actualBytes;
  try {
    actualBytes = exactBytes(
      await readFile(target),
      `Guarded owned file bytes for ${target}`,
    );
  } catch (error) {
    cleanupErrors.push(error);
    return {ownershipLost: false, removed: false};
  }
  const afterRead = await reconcileStat(lstat, target, cleanupErrors);
  if (afterRead === undefined) {
    return {ownershipLost: false, removed: false};
  }
  if (afterRead === null) return {ownershipLost: false, removed: true};
  let contentIsOwned = actualBytes.equals(expectedBytes);
  if (!contentIsOwned && linkedTarget !== null) {
    const linkedStat = await reconcileStat(lstat, linkedTarget, cleanupErrors);
    contentIsOwned =
      linkedStat?.isFile() === true &&
      sameIdentity(expectedIdentity, fileIdentity(linkedStat));
  }
  if (
    !afterRead.isFile() ||
    !sameIdentity(expectedIdentity, fileIdentity(afterRead)) ||
    !contentIsOwned
  ) {
    cleanupErrors.push(stateError(label, target));
    return {ownershipLost: true, removed: false};
  }
  try {
    await rm(target, {force: false});
  } catch (error) {
    cleanupErrors.push(error);
    const afterFailure = await reconcileStat(lstat, target, cleanupErrors);
    if (afterFailure === null) return {ownershipLost: false, removed: true};
    let ownershipLost = false;
    if (
      afterFailure !== undefined &&
      !sameIdentity(expectedIdentity, fileIdentity(afterFailure))
    ) {
      cleanupErrors.push(stateError(label, target));
      ownershipLost = true;
    }
    return {ownershipLost, removed: false};
  }
  const after = await reconcileStat(lstat, target, cleanupErrors);
  if (after === null) return {ownershipLost: false, removed: true};
  if (after !== undefined) {
    cleanupErrors.push(stateError(label, target));
    return {ownershipLost: true, removed: false};
  }
  return {ownershipLost: false, removed: false};
}

async function restoreBackup(file, adapters, cleanupErrors) {
  if (file.backupIdentity === null) return;
  const backupStat = await reconcileStat(
    adapters.lstat,
    file.backup,
    cleanupErrors,
  );
  if (backupStat === undefined) return;
  if (
    backupStat === null ||
    !sameIdentity(file.backupIdentity, fileIdentity(backupStat))
  ) {
    cleanupErrors.push(stateError('restore an owned backup', file.backup));
    return;
  }

  const targetStat = await reconcileStat(
    adapters.lstat,
    file.target,
    cleanupErrors,
  );
  if (targetStat === undefined) return;
  let restored =
    targetStat !== null &&
    sameIdentity(file.originalIdentity, fileIdentity(targetStat));
  if (targetStat !== null && !restored) {
    cleanupErrors.push(
      stateError('restore without replacing a foreign target', file.target),
    );
    return;
  }
  if (!restored) {
    try {
      await adapters.link(file.backup, file.target);
      const restoredStat = await reconcileStat(
        adapters.lstat,
        file.target,
        cleanupErrors,
      );
      restored =
        restoredStat !== undefined &&
        restoredStat !== null &&
        sameIdentity(file.originalIdentity, fileIdentity(restoredStat));
      if (!restored && restoredStat !== undefined) {
        cleanupErrors.push(
          stateError('verify the restored target', file.target),
        );
      }
    } catch (error) {
      cleanupErrors.push(error);
      const afterFailure = await reconcileStat(
        adapters.lstat,
        file.target,
        cleanupErrors,
      );
      restored =
        afterFailure !== undefined &&
        afterFailure !== null &&
        sameIdentity(file.originalIdentity, fileIdentity(afterFailure));
    }
  }
  if (!restored) return;

  const {ownershipLost, removed} = await removeOwned(
    file.backup,
    file.backupIdentity,
    file.ownedBackupBytes,
    'remove an owned backup after restoration',
    adapters,
    cleanupErrors,
    file.target,
  );
  if (removed || ownershipLost) {
    file.backupIdentity = null;
    file.ownedBackupBytes = null;
    file.ownedBackupIdentity = null;
  }
}

async function collectRecoveryPaths(resolved, adapters, cleanupErrors) {
  const recoveryPaths = [];
  for (const file of resolved) {
    if (file.ownedBackupIdentity === null) continue;
    const backupStat = await reconcileStat(
      adapters.lstat,
      file.backup,
      cleanupErrors,
    );
    if (
      backupStat?.isFile() &&
      sameIdentity(file.ownedBackupIdentity, fileIdentity(backupStat))
    ) {
      recoveryPaths.push(file.backup);
    }
  }
  return recoveryPaths;
}

async function cleanupRollbackIsSafe(resolved, adapters, cleanupErrors) {
  let safe = true;
  for (const file of resolved) {
    const targetStat = await reconcileStat(
      adapters.lstat,
      file.target,
      cleanupErrors,
    );
    if (targetStat === undefined) {
      safe = false;
    } else if (
      targetStat !== null &&
      (file.promotedIdentity === null ||
        !targetStat.isFile() ||
        !sameIdentity(file.promotedIdentity, fileIdentity(targetStat)))
    ) {
      cleanupErrors.push(
        stateError('roll back without replacing a foreign target', file.target),
      );
      safe = false;
    }

    if (file.originalIdentity === null) continue;
    if (
      file.backupIdentity === null ||
      file.ownedBackupIdentity === null ||
      !sameIdentity(file.originalIdentity, file.backupIdentity) ||
      !sameIdentity(file.backupIdentity, file.ownedBackupIdentity)
    ) {
      cleanupErrors.push(
        stateError('prove an original backup is restorable', file.backup),
      );
      safe = false;
      continue;
    }
    const backupStat = await reconcileStat(
      adapters.lstat,
      file.backup,
      cleanupErrors,
    );
    if (
      backupStat === undefined ||
      backupStat === null ||
      !backupStat.isFile() ||
      !sameIdentity(file.backupIdentity, fileIdentity(backupStat))
    ) {
      if (backupStat !== undefined) {
        cleanupErrors.push(
          stateError('prove an original backup is restorable', file.backup),
        );
      }
      safe = false;
      continue;
    }
    try {
      await assertExpectedPreimage(
        file,
        file.backup,
        adapters.readFile,
        'while proving cleanup rollback is safe',
      );
    } catch (error) {
      cleanupErrors.push(error);
      safe = false;
      continue;
    }
    const backupAfterRead = await reconcileStat(
      adapters.lstat,
      file.backup,
      cleanupErrors,
    );
    if (
      backupAfterRead === undefined ||
      backupAfterRead === null ||
      !backupAfterRead.isFile() ||
      !sameIdentity(file.backupIdentity, fileIdentity(backupAfterRead))
    ) {
      if (backupAfterRead !== undefined) {
        cleanupErrors.push(
          stateError(
            'prove an original backup stayed restorable while reading',
            file.backup,
          ),
        );
      }
      safe = false;
    }
  }
  return safe;
}

async function rollback(resolved, adapters, primary, reconciliationErrors) {
  const cleanupErrors = [...reconciliationErrors];
  for (const file of [...resolved].reverse()) {
    if (file.promotedIdentity === null) continue;
    const {ownershipLost, removed} = await removeOwned(
      file.target,
      file.promotedIdentity,
      file.promotedBytes,
      'remove an owned promoted target',
      adapters,
      cleanupErrors,
    );
    if (removed || ownershipLost) {
      file.promotedBytes = null;
      file.promotedIdentity = null;
    }
  }
  for (const file of [...resolved].reverse()) {
    await restoreBackup(file, adapters, cleanupErrors);
  }
  for (const file of [...resolved].reverse()) {
    if (file.backupIdentity !== null || file.ownedBackupIdentity === null) {
      continue;
    }
    const {ownershipLost, removed} = await removeOwned(
      file.backup,
      file.ownedBackupIdentity,
      file.ownedBackupBytes,
      'remove an owned invalid backup sibling',
      adapters,
      cleanupErrors,
      file.target,
    );
    if (removed || ownershipLost) {
      file.ownedBackupBytes = null;
      file.ownedBackupIdentity = null;
    }
  }
  for (const file of resolved) {
    if (file.temporaryIdentity === null) continue;
    const {ownershipLost, removed} = await removeOwned(
      file.temporary,
      file.temporaryIdentity,
      file.temporaryBytes,
      'remove an owned temporary sibling',
      adapters,
      cleanupErrors,
    );
    if (removed || ownershipLost) {
      file.temporaryBytes = null;
      file.temporaryIdentity = null;
    }
  }
  const recoveryPaths = await collectRecoveryPaths(
    resolved,
    adapters,
    cleanupErrors,
  );
  throw withGuardedMetadata(primary, cleanupErrors, recoveryPaths);
}

async function failCleanup(
  resolved,
  adapters,
  primary,
  cleanupErrors,
  reconciliationErrors,
) {
  const recoveryErrors = [...reconciliationErrors, ...cleanupErrors];
  if (await cleanupRollbackIsSafe(resolved, adapters, recoveryErrors)) {
    await rollback(resolved, adapters, primary, recoveryErrors);
  }
  const recoveryPaths = await collectRecoveryPaths(
    resolved,
    adapters,
    recoveryErrors,
  );
  throw withGuardedMetadata(primary, recoveryErrors, recoveryPaths);
}

export async function promoteGuardedFileSet({
  files,
  link,
  lstat,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
}) {
  for (const [name, operation] of Object.entries({
    link,
    lstat,
    readFile,
    realpath,
    rename,
    rm,
    writeFile,
  })) {
    if (typeof operation !== 'function') {
      throw new TypeError(`${name} must be a function`);
    }
  }
  const resolved = await resolveFiles({files, lstat, readFile, realpath});
  const adapters = {link, lstat, readFile, rm};
  const reconciliationErrors = [];
  try {
    for (const file of resolved) {
      await writeTemporary(
        file,
        {lstat, readFile, writeFile},
        reconciliationErrors,
      );
    }
    for (const file of resolved) {
      await backupTarget(file, adapters, reconciliationErrors);
    }
    for (const file of resolved) {
      await promoteTemporary(file, adapters, reconciliationErrors);
    }
  } catch (error) {
    await rollback(resolved, adapters, error, reconciliationErrors);
  }

  try {
    for (const file of resolved) {
      if (file.backupIdentity === null) continue;
      await assertExpectedPreimage(
        file,
        file.backup,
        readFile,
        'before success cleanup',
      );
    }
  } catch (error) {
    await failCleanup(resolved, adapters, error, [], reconciliationErrors);
  }

  const cleanupErrors = [];
  for (const file of resolved) {
    if (file.backupIdentity === null) continue;
    try {
      // This closes every path-addressable edit window before unlink. A writer
      // holding an already-open descriptor can still race after this read; the
      // portable Node filesystem API offers no lock that closes that boundary.
      await assertExpectedPreimage(
        file,
        file.backup,
        readFile,
        'immediately before owned backup deletion',
      );
    } catch (error) {
      await failCleanup(
        resolved,
        adapters,
        error,
        cleanupErrors,
        reconciliationErrors,
      );
    }
    const {ownershipLost, removed} = await removeOwned(
      file.backup,
      file.backupIdentity,
      file.ownedBackupBytes,
      'remove an owned backup after promotion',
      adapters,
      cleanupErrors,
    );
    if (removed || ownershipLost) {
      file.backupIdentity = null;
      file.ownedBackupBytes = null;
      file.ownedBackupIdentity = null;
    }
    if (cleanupErrors.length > 0) {
      const [primary, ...remaining] = cleanupErrors;
      await failCleanup(
        resolved,
        adapters,
        primary,
        remaining,
        reconciliationErrors,
      );
    }
  }
}
