/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import path from 'node:path';
import execa from 'execa';
import fs from 'graceful-fs';

function unsafeArchiveEntry(packageName, entry) {
  throw new Error(`Unsafe archive entry for ${packageName}: ${entry}`);
}

export function validateArchiveEntries(entries, packageName) {
  const normalized = new Set();
  for (const entry of entries) {
    const file = String(entry).replaceAll('\\', '/');
    if (
      !file ||
      file.startsWith('/') ||
      /^[A-Za-z]:\//u.test(file) ||
      file.split('/').includes('..') ||
      (file !== 'package' && !file.startsWith('package/'))
    ) {
      unsafeArchiveEntry(packageName, file);
    }
    normalized.add(file);
  }
  return [...normalized].sort();
}

function requireStagingChild(stagingDirectory, candidate) {
  return requireDirectoryChild(
    stagingDirectory,
    candidate,
    'staging directory',
  );
}

function requireDirectoryChild(directory, candidate, description) {
  const parent = path.resolve(directory);
  const resolved = path.resolve(candidate);
  const relative = path.relative(parent, resolved);
  if (
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Repack path is outside ${description}: ${resolved}`);
  }
  return resolved;
}

async function assertSafeDirectory(stagingDirectory, directory) {
  const status = await fs.promises.lstat(directory);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error(
      `Repack staging path must be a directory, not a link: ${directory}`,
    );
  }
  const realStaging = await fs.promises.realpath(stagingDirectory);
  const realDirectory = await fs.promises.realpath(directory);
  requireStagingChild(realStaging, realDirectory);
  return realDirectory;
}

async function assertSafeFile(directory, filePath) {
  const status = await fs.promises.lstat(filePath);
  if (!status.isFile() || status.isSymbolicLink()) {
    throw new Error(
      `Repack output must be a regular file, not a link: ${filePath}`,
    );
  }
  const realDirectory = await fs.promises.realpath(directory);
  const realFile = await fs.promises.realpath(filePath);
  requireDirectoryChild(realDirectory, realFile, 'npm output directory');
  return realFile;
}

async function assertSafeArchiveTree(entryPath) {
  const status = await fs.promises.lstat(entryPath);
  if (status.isSymbolicLink()) {
    throw new Error(`Archive entry must not be a link: ${entryPath}`);
  }
  if (status.isDirectory()) {
    const entries = await fs.promises.readdir(entryPath);
    await Promise.all(
      entries.map(entry => assertSafeArchiveTree(path.join(entryPath, entry))),
    );
    return;
  }
  if (!status.isFile() || status.nlink > 1) {
    throw new Error(
      `Archive entry must be a regular file, not a link or special entry: ${entryPath}`,
    );
  }
}

async function rejectExistingLink(filePath) {
  try {
    const status = await fs.promises.lstat(filePath);
    if (status.isSymbolicLink()) {
      throw new Error(`Repack staging path must not be a link: ${filePath}`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function packageStagingName(packageName) {
  return packageName.replace(/^@/u, '').replaceAll('/', '-');
}

function toMsysFileSystemPath(filePath) {
  return String(filePath)
    .replace(/^([A-Za-z]):/u, (_match, drive) => `/${drive.toLowerCase()}`)
    .replaceAll('\\', '/');
}

export function localTarArguments(
  args,
  fileSystemPathIndexes = [],
  platform = process.platform,
) {
  if (platform !== 'win32') return args;
  const fileSystemPaths = new Set(fileSystemPathIndexes);
  return [
    '--force-local',
    ...args.map((arg, index) =>
      fileSystemPaths.has(index) ? toMsysFileSystemPath(arg) : arg,
    ),
  ];
}

async function defaultRunCommand(command, args, options) {
  return execa(command, args, options);
}

function parsePackedFilename(stdout, packageName) {
  const packed = JSON.parse(stdout);
  if (
    !Array.isArray(packed) ||
    packed.length !== 1 ||
    typeof packed[0]?.filename !== 'string'
  ) {
    throw new Error(`npm pack returned an invalid result for ${packageName}`);
  }
  return packed[0].filename;
}

export async function repackReleaseArtifact({
  finalTarballPath,
  licensePath,
  packageName,
  rawTarballPath,
  runCommand = defaultRunCommand,
  stagingDirectory,
}) {
  const stagingName = packageStagingName(packageName);
  const extractionDirectory = requireStagingChild(
    stagingDirectory,
    path.join(stagingDirectory, `${stagingName}-extract`),
  );
  const npmOutputDirectory = requireStagingChild(
    stagingDirectory,
    path.join(stagingDirectory, `${stagingName}-npm`),
  );
  const extractedPackage = requireStagingChild(
    stagingDirectory,
    path.join(extractionDirectory, 'package'),
  );
  const extractedLicense = requireStagingChild(
    stagingDirectory,
    path.join(extractedPackage, 'LICENSE'),
  );
  const finalTarball = requireStagingChild(stagingDirectory, finalTarballPath);
  const rawTarball = requireStagingChild(stagingDirectory, rawTarballPath);
  let primaryError;
  try {
    const {stdout: listing} = await runCommand(
      'tar',
      localTarArguments(['-tzf', rawTarball], [1]),
    );
    validateArchiveEntries(
      listing.split(/\r?\n/u).filter(Boolean),
      packageName,
    );
    await fs.promises.mkdir(extractionDirectory, {recursive: true});
    await assertSafeDirectory(stagingDirectory, extractionDirectory);
    await runCommand(
      'tar',
      localTarArguments(
        ['-xzf', rawTarball, '-C', extractionDirectory],
        [1, 3],
      ),
    );
    await assertSafeDirectory(stagingDirectory, extractedPackage);
    await assertSafeArchiveTree(extractedPackage);
    await rejectExistingLink(extractedLicense);
    await fs.promises.copyFile(licensePath, extractedLicense);
    await fs.promises.mkdir(npmOutputDirectory, {recursive: true});
    await assertSafeDirectory(stagingDirectory, npmOutputDirectory);
    const {stdout} = await runCommand(
      'npm',
      [
        'pack',
        '--ignore-scripts',
        '--json',
        `--pack-destination=${npmOutputDirectory}`,
      ],
      {cwd: extractedPackage},
    );
    const packedTarball = requireDirectoryChild(
      npmOutputDirectory,
      path.resolve(
        npmOutputDirectory,
        parsePackedFilename(stdout, packageName),
      ),
      'npm output directory',
    );
    await assertSafeFile(npmOutputDirectory, packedTarball);
    await fs.promises.rename(packedTarball, finalTarball);
  } catch (error) {
    primaryError = error;
  }
  let cleanupError;
  try {
    await Promise.all(
      [extractionDirectory, npmOutputDirectory].map(directory =>
        fs.promises.rm(directory, {force: true, recursive: true}),
      ),
    );
  } catch (error) {
    cleanupError = error;
  }
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
}
