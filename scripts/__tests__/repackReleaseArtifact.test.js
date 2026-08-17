/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {spawnSync} from 'node:child_process';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const repoRoot = process.cwd();
const repackModuleUrl = pathToFileURL(
  join(repoRoot, 'scripts/pkgNec/repackReleaseArtifact.mjs'),
).href;

function runModuleProgram(program) {
  const child = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', program],
    {cwd: repoRoot, encoding: 'utf8'},
  );
  if (child.status !== 0) throw new Error(child.stderr || child.stdout);
  return JSON.parse(child.stdout);
}

function validateArchiveEntries(entries, packageName) {
  const program = `
    import {validateArchiveEntries} from ${JSON.stringify(repackModuleUrl)};
    try {
      console.log(JSON.stringify({
        ok: true,
        value: validateArchiveEntries(${JSON.stringify(entries)}, ${JSON.stringify(
          packageName,
        )}),
      }));
    } catch (error) {
      console.log(JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        ok: false,
      }));
    }
  `;
  const child = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', program],
    {cwd: repoRoot, encoding: 'utf8'},
  );
  if (child.status !== 0) throw new Error(child.stderr);
  const response = JSON.parse(child.stdout);
  if (!response.ok) throw new Error(response.error);
  return response.value;
}

function expectedTarFileSystemPath(filePath) {
  if (process.platform !== 'win32') return filePath;
  return filePath
    .replace(/^([A-Za-z]):/u, (_match, drive) => `/${drive.toLowerCase()}`)
    .replaceAll('\\', '/');
}

test('accepts package-relative archive entries', () => {
  expect(
    validateArchiveEntries(
      ['package/', 'package/package.json', 'package/build/index.js'],
      '@pkg-nec/example',
    ),
  ).toEqual(['package/', 'package/build/index.js', 'package/package.json']);
});

test.each([
  '../outside',
  'package/../../outside',
  '/absolute/package.json',
  'C:/absolute/package.json',
])('rejects unsafe archive entry %s', entry => {
  expect(() => validateArchiveEntries([entry], '@pkg-nec/example')).toThrow(
    /unsafe archive entry.*@pkg-nec\/example/i,
  );
});

test('only adapts GNU tar filesystem paths on Windows', () => {
  const result = runModuleProgram(`
    import {localTarArguments} from ${JSON.stringify(repackModuleUrl)};
    console.log(JSON.stringify({
      extractOnWindows: localTarArguments(
        ['-xzf', 'D:\\\\temp\\\\example.tgz', '-C', 'D:\\\\temp\\\\extract'],
        [1, 3],
        'win32',
      ),
      manifestOnWindows: localTarArguments(
        ['-xOzf', 'D:\\\\temp\\\\example.tgz', 'package/package.json'],
        [1],
        'win32',
      ),
      posix: localTarArguments(
        ['-xzf', '/tmp/example.tgz', '-C', '/tmp/extract'],
        [1, 3],
        'linux',
      ),
    }));
  `);

  expect(result).toEqual({
    extractOnWindows: [
      '--force-local',
      '-xzf',
      '/d/temp/example.tgz',
      '-C',
      '/d/temp/extract',
    ],
    manifestOnWindows: [
      '--force-local',
      '-xOzf',
      '/d/temp/example.tgz',
      'package/package.json',
    ],
    posix: ['-xzf', '/tmp/example.tgz', '-C', '/tmp/extract'],
  });
});

test('passes --force-local for a Windows-drive raw archive path', async () => {
  const temporaryDirectory = await mkdtemp(join(repoRoot, 'pkg-nec-repack-'));

  try {
    const result = runModuleProgram(`
      import path from 'node:path';
      import fs from 'graceful-fs';
      import {repackReleaseArtifact} from ${JSON.stringify(repackModuleUrl)};

      const stagingDirectory = ${JSON.stringify(temporaryDirectory)};
      const rawTarballPath = path.join(stagingDirectory, 'raw.tgz');
      const finalTarballPath = path.join(stagingDirectory, 'final.tgz');
      const licensePath = path.join(stagingDirectory, 'LICENSE');
      const extractionDirectory = path.join(stagingDirectory, 'pkg-nec-example-extract');
      const npmOutputDirectory = path.join(stagingDirectory, 'pkg-nec-example-npm');
      const tarCalls = [];
      fs.writeFileSync(rawTarballPath, 'raw');
      fs.writeFileSync(licensePath, 'license');

      await repackReleaseArtifact({
        finalTarballPath,
        licensePath,
        packageName: '@pkg-nec/example',
        rawTarballPath,
        runCommand: async (command, args) => {
          if (command === 'tar') {
            tarCalls.push(args);
            if (args.includes('-tzf')) {
              return {stdout: 'package/\\npackage/package.json\\n'};
            }
            fs.mkdirSync(path.join(extractionDirectory, 'package'), {
              recursive: true,
            });
            fs.writeFileSync(
              path.join(extractionDirectory, 'package', 'package.json'),
              '{}',
            );
            return {stdout: ''};
          }
          fs.mkdirSync(npmOutputDirectory, {recursive: true});
          fs.writeFileSync(
            path.join(npmOutputDirectory, 'pkg-nec-example-1.0.0.tgz'),
            'final',
          );
          return {
            stdout: JSON.stringify([{filename: 'pkg-nec-example-1.0.0.tgz'}]),
          };
        },
        stagingDirectory,
      });

      console.log(JSON.stringify({rawTarballPath, tarCalls}));
    `);

    if (process.platform === 'win32') {
      expect(result.rawTarballPath).toMatch(/^[A-Za-z]:\\/u);
    }
    const tarPrefix = process.platform === 'win32' ? ['--force-local'] : [];
    const rawTarball = expectedTarFileSystemPath(result.rawTarballPath);
    const extractionDirectory = expectedTarFileSystemPath(
      join(temporaryDirectory, 'pkg-nec-example-extract'),
    );
    expect(result.tarCalls).toEqual([
      [...tarPrefix, '-tzf', rawTarball],
      [...tarPrefix, '-xzf', rawTarball, '-C', extractionDirectory],
    ]);
  } finally {
    await rm(temporaryDirectory, {force: true, recursive: true});
  }
});

test('repackages a checked archive with the root license', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'pkg-nec-repack-'));

  try {
    const result = runModuleProgram(`
      import path from 'node:path';
      import fs from 'graceful-fs';
      import {repackReleaseArtifact} from ${JSON.stringify(repackModuleUrl)};

      const stagingDirectory = ${JSON.stringify(temporaryDirectory)};
      const packageName = '@pkg-nec/example';
      const rawTarballPath = path.join(stagingDirectory, 'raw.tgz');
      const finalTarballPath = path.join(stagingDirectory, 'final.tgz');
      const licensePath = path.join(stagingDirectory, 'root-LICENSE');
      const extractionDirectory = path.join(stagingDirectory, 'pkg-nec-example-extract');
      const npmOutputDirectory = path.join(stagingDirectory, 'pkg-nec-example-npm');
      const calls = [];
      const copies = [];
      const copyFile = fs.promises.copyFile;
      fs.writeFileSync(rawTarballPath, 'raw');
      fs.writeFileSync(licensePath, 'root license');
      fs.promises.copyFile = async (...args) => {
        copies.push(args);
        return copyFile(...args);
      };

      try {
        await repackReleaseArtifact({
          finalTarballPath,
          licensePath,
          packageName,
          rawTarballPath,
          runCommand: async (command, args, options = {}) => {
            calls.push({args, command});
            if (command === 'tar' && args.includes('-tzf')) {
              return {
                stdout: 'package/\\npackage/package.json\\npackage/build/index.js\\n',
              };
            }
            if (command === 'tar') {
              fs.mkdirSync(path.join(extractionDirectory, 'package'), {
                recursive: true,
              });
              fs.writeFileSync(
                path.join(extractionDirectory, 'package', 'package.json'),
                '{}',
              );
              return {stdout: ''};
            }
            if (command === 'npm') {
              fs.mkdirSync(npmOutputDirectory, {recursive: true});
              fs.writeFileSync(
                path.join(npmOutputDirectory, 'pkg-nec-example-1.0.0.tgz'),
                fs.readFileSync(path.join(options.cwd, 'LICENSE')),
              );
              return {
                stdout: JSON.stringify([{filename: 'pkg-nec-example-1.0.0.tgz'}]),
              };
            }
            throw new Error('Unexpected command');
          },
          stagingDirectory,
        });
      } finally {
        fs.promises.copyFile = copyFile;
      }

      console.log(JSON.stringify({
        calls,
        copies,
        extractionExists: fs.existsSync(extractionDirectory),
        finalContents: fs.readFileSync(finalTarballPath, 'utf8'),
        npmOutputExists: fs.existsSync(npmOutputDirectory),
      }));
    `);

    const tarPrefix = process.platform === 'win32' ? ['--force-local'] : [];
    const rawTarball = expectedTarFileSystemPath(
      join(temporaryDirectory, 'raw.tgz'),
    );
    const extractionDirectory = expectedTarFileSystemPath(
      join(temporaryDirectory, 'pkg-nec-example-extract'),
    );
    expect(result.calls).toEqual([
      {
        args: [...tarPrefix, '-tzf', rawTarball],
        command: 'tar',
      },
      {
        args: [...tarPrefix, '-xzf', rawTarball, '-C', extractionDirectory],
        command: 'tar',
      },
      {
        args: [
          'pack',
          '--ignore-scripts',
          '--json',
          `--pack-destination=${join(
            temporaryDirectory,
            'pkg-nec-example-npm',
          )}`,
        ],
        command: 'npm',
      },
    ]);
    expect(result.copies).toEqual([
      [
        join(temporaryDirectory, 'root-LICENSE'),
        join(
          temporaryDirectory,
          'pkg-nec-example-extract',
          'package',
          'LICENSE',
        ),
      ],
    ]);
    expect(result).toEqual(
      expect.objectContaining({
        extractionExists: false,
        finalContents: 'root license',
        npmOutputExists: false,
      }),
    );
  } finally {
    await rm(temporaryDirectory, {force: true, recursive: true});
  }
});

test('rejects an npm tarball filename outside its output directory', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'pkg-nec-repack-'));

  try {
    const result = runModuleProgram(`
      import path from 'node:path';
      import fs from 'graceful-fs';
      import {repackReleaseArtifact} from ${JSON.stringify(repackModuleUrl)};

      const stagingDirectory = ${JSON.stringify(temporaryDirectory)};
      const rawTarballPath = path.join(stagingDirectory, 'raw.tgz');
      const finalTarballPath = path.join(stagingDirectory, 'final.tgz');
      const licensePath = path.join(stagingDirectory, 'LICENSE');
      const extractionDirectory = path.join(stagingDirectory, 'pkg-nec-example-extract');
      const npmOutputDirectory = path.join(stagingDirectory, 'pkg-nec-example-npm');
      fs.writeFileSync(rawTarballPath, 'raw');
      fs.writeFileSync(licensePath, 'license');
      let message;
      try {
        await repackReleaseArtifact({
          finalTarballPath,
          licensePath,
          packageName: '@pkg-nec/example',
          rawTarballPath,
          runCommand: async (command, args) => {
            if (command === 'tar' && args.includes('-tzf')) {
              return {stdout: 'package/\\npackage/package.json\\n'};
            }
            if (command === 'tar') {
              fs.mkdirSync(path.join(extractionDirectory, 'package'), {
                recursive: true,
              });
              return {stdout: ''};
            }
            fs.mkdirSync(npmOutputDirectory, {recursive: true});
            fs.writeFileSync(
              path.join(extractionDirectory, 'package', 'package.json'),
              '{}',
            );
            return {stdout: JSON.stringify([{filename: '../pkg-nec-example-extract/package.json'}])};
          },
          stagingDirectory,
        });
      } catch (error) {
        message = error.message;
      }
      console.log(JSON.stringify({
        finalExists: fs.existsSync(finalTarballPath),
        message,
      }));
    `);

    expect(result).toEqual({
      finalExists: false,
      message: expect.stringMatching(/outside.*npm.*output/i),
    });
  } finally {
    await rm(temporaryDirectory, {force: true, recursive: true});
  }
});

test('rejects an archive-created package link before copying the license', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'pkg-nec-repack-'));

  try {
    const result = runModuleProgram(`
      import path from 'node:path';
      import {tmpdir} from 'node:os';
      import fs from 'graceful-fs';
      import {repackReleaseArtifact} from ${JSON.stringify(repackModuleUrl)};

      const stagingDirectory = ${JSON.stringify(temporaryDirectory)};
      const outsideDirectory = fs.mkdtempSync(path.join(tmpdir(), 'pkg-nec-outside-'));
      const rawTarballPath = path.join(stagingDirectory, 'raw.tgz');
      const finalTarballPath = path.join(stagingDirectory, 'final.tgz');
      const licensePath = path.join(stagingDirectory, 'LICENSE');
      const extractionDirectory = path.join(stagingDirectory, 'pkg-nec-example-extract');
      fs.writeFileSync(rawTarballPath, 'raw');
      fs.writeFileSync(licensePath, 'license');
      let message;
      let supported = true;
      try {
        await repackReleaseArtifact({
          finalTarballPath,
          licensePath,
          packageName: '@pkg-nec/example',
          rawTarballPath,
          runCommand: async (command, args) => {
            if (command === 'tar' && args.includes('-tzf')) {
              return {stdout: 'package/\\npackage/package.json\\n'};
            }
            if (command === 'tar') {
              try {
                fs.symlinkSync(
                  outsideDirectory,
                  path.join(extractionDirectory, 'package'),
                  process.platform === 'win32' ? 'junction' : 'dir',
                );
              } catch {
                supported = false;
                fs.mkdirSync(path.join(extractionDirectory, 'package'));
              }
              return {stdout: ''};
            }
            throw new Error('npm must not run');
          },
          stagingDirectory,
        });
      } catch (error) {
        message = error.message;
      }
      const outsideLicense = fs.existsSync(path.join(outsideDirectory, 'LICENSE'));
      fs.rmSync(outsideDirectory, {force: true, recursive: true});
      console.log(JSON.stringify({message, outsideLicense, supported}));
    `);

    if (result.supported) {
      expect(result).toEqual({
        message: expect.stringMatching(/link|symbolic|staging/i),
        outsideLicense: false,
        supported: true,
      });
    }
  } finally {
    await rm(temporaryDirectory, {force: true, recursive: true});
  }
});

test.each(['hard link', 'symbolic link'])(
  'rejects a nested archive %s before npm pack',
  async linkType => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'pkg-nec-repack-'));

    try {
      const result = runModuleProgram(`
        import path from 'node:path';
        import fs from 'graceful-fs';
        import {repackReleaseArtifact} from ${JSON.stringify(repackModuleUrl)};

        const stagingDirectory = ${JSON.stringify(temporaryDirectory)};
        const linkType = ${JSON.stringify(linkType)};
        const rawTarballPath = path.join(stagingDirectory, 'raw.tgz');
        const finalTarballPath = path.join(stagingDirectory, 'final.tgz');
        const licensePath = path.join(stagingDirectory, 'LICENSE');
        const extractionDirectory = path.join(stagingDirectory, 'pkg-nec-example-extract');
        const npmOutputDirectory = path.join(stagingDirectory, 'pkg-nec-example-npm');
        let npmCalls = 0;
        let message;
        fs.writeFileSync(rawTarballPath, 'raw');
        fs.writeFileSync(licensePath, 'license');
        try {
          await repackReleaseArtifact({
            finalTarballPath,
            licensePath,
            packageName: '@pkg-nec/example',
            rawTarballPath,
            runCommand: async (command, args) => {
              if (command === 'tar' && args.includes('-tzf')) {
                return {
                  stdout: 'package/\\npackage/package.json\\npackage/build/linked.js\\n',
                };
              }
              if (command === 'tar') {
                const packageDirectory = path.join(extractionDirectory, 'package');
                const source = path.join(packageDirectory, 'package.json');
                const linked = path.join(packageDirectory, 'build', 'linked.js');
                fs.mkdirSync(path.dirname(linked), {recursive: true});
                fs.writeFileSync(source, '{}');
                if (linkType === 'hard link') fs.linkSync(source, linked);
                else fs.symlinkSync(source, linked, 'file');
                return {stdout: ''};
              }
              npmCalls += 1;
              fs.mkdirSync(npmOutputDirectory, {recursive: true});
              fs.writeFileSync(path.join(npmOutputDirectory, 'final.tgz'), 'final');
              return {stdout: JSON.stringify([{filename: 'final.tgz'}])};
            },
            stagingDirectory,
          });
        } catch (error) {
          message = error.message;
        }
        console.log(JSON.stringify({message, npmCalls}));
      `);

      expect(result).toEqual({
        message: expect.stringMatching(/link|special/i),
        npmCalls: 0,
      });
    } finally {
      await rm(temporaryDirectory, {force: true, recursive: true});
    }
  },
);

test('rejects a nested special archive entry before npm pack', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'pkg-nec-repack-'));

  try {
    const result = runModuleProgram(`
      import path from 'node:path';
      import fs from 'graceful-fs';
      import {repackReleaseArtifact} from ${JSON.stringify(repackModuleUrl)};

      const stagingDirectory = ${JSON.stringify(temporaryDirectory)};
      const rawTarballPath = path.join(stagingDirectory, 'raw.tgz');
      const finalTarballPath = path.join(stagingDirectory, 'final.tgz');
      const licensePath = path.join(stagingDirectory, 'LICENSE');
      const extractionDirectory = path.join(stagingDirectory, 'pkg-nec-example-extract');
      const npmOutputDirectory = path.join(stagingDirectory, 'pkg-nec-example-npm');
      let npmCalls = 0;
      let message;
      fs.writeFileSync(rawTarballPath, 'raw');
      fs.writeFileSync(licensePath, 'license');
      const lstat = fs.promises.lstat;
      try {
        await repackReleaseArtifact({
          finalTarballPath,
          licensePath,
          packageName: '@pkg-nec/example',
          rawTarballPath,
          runCommand: async (command, args) => {
            if (command === 'tar' && args.includes('-tzf')) {
              return {stdout: 'package/\\npackage/package.json\\npackage/build/pipe\\n'};
            }
            if (command === 'tar') {
              const pipe = path.join(extractionDirectory, 'package', 'build', 'pipe');
              fs.mkdirSync(path.dirname(pipe), {recursive: true});
              fs.writeFileSync(path.join(extractionDirectory, 'package', 'package.json'), '{}');
              fs.writeFileSync(pipe, 'special');
              fs.promises.lstat = async target => {
                const status = await lstat(target);
                if (path.resolve(target) !== path.resolve(pipe)) return status;
                return Object.assign(Object.create(status), {
                  isDirectory: () => false,
                  isFile: () => false,
                  isSymbolicLink: () => false,
                  nlink: 1,
                });
              };
              return {stdout: ''};
            }
            npmCalls += 1;
            fs.mkdirSync(npmOutputDirectory, {recursive: true});
            fs.writeFileSync(path.join(npmOutputDirectory, 'final.tgz'), 'final');
            return {stdout: JSON.stringify([{filename: 'final.tgz'}])};
          },
          stagingDirectory,
        });
      } catch (error) {
        message = error.message;
      } finally {
        fs.promises.lstat = lstat;
      }
      console.log(JSON.stringify({message, npmCalls}));
    `);

    expect(result).toEqual({
      message: expect.stringMatching(/special/i),
      npmCalls: 0,
    });
  } finally {
    await rm(temporaryDirectory, {force: true, recursive: true});
  }
});
