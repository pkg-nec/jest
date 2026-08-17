/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import path from 'node:path';
import fs from 'graceful-fs';

const excludedDirectories = new Set([
  '.git',
  '.superpowers',
  'build',
  'coverage',
  'dist',
  'node_modules',
]);
const excludedFiles = new Set([
  'docs/pkg-nec-rebrand-technical-guide.md',
  'docs/superpowers/plans/2026-08-12-pkg-nec-package-rebrand.md',
  'docs/superpowers/specs/2026-08-12-pkg-nec-package-rebrand-design.md',
  'scripts/pkgNec/upstreamManifestBaseline.json',
]);
const moduleExtensions = new Set([
  '.cjs',
  '.js',
  '.jsx',
  '.mjs',
  '.ts',
  '.tsx',
]);

function normalizedPath(filePath) {
  return filePath.split(path.sep).join('/');
}

function isExcludedDirectory(relativePath, name) {
  return (
    excludedDirectories.has(name) ||
    normalizedPath(relativePath) === '.pkg-nec-release' ||
    normalizedPath(relativePath) === '.yarn/cache'
  );
}

function classify(relativePath) {
  const normalized = normalizedPath(relativePath);
  const basename = path.basename(relativePath);
  const extension = path.extname(relativePath).toLowerCase();

  if (basename === 'package.json') return 'manifest';
  if (basename === 'yarn.lock') {
    return normalized.includes('/') ? 'fixture-lock' : 'lock';
  }
  if (moduleExtensions.has(extension)) return 'module';
  if (extension === '.jsonc' || /^tsconfig(?:\..+)?\.json$/.test(basename)) {
    return 'jsonc';
  }
  if (extension === '.json') return 'json';
  if (extension === '.md' || extension === '.mdx') return 'documentation';
  if (extension === '.yaml' || extension === '.yml') return 'workflow';
  if (
    extension === '.ini' ||
    extension === '.sh' ||
    extension === '.snap' ||
    extension === '.toml' ||
    extension === '.txt'
  ) {
    return 'text';
  }
  return null;
}

export function enumerateRepositoryFiles({repoRoot}) {
  const root = path.resolve(repoRoot);
  const files = [];

  function visit(directory, relativeDirectory = '') {
    const entries = fs
      .readdirSync(directory, {withFileTypes: true})
      .sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
      );

    for (const entry of entries) {
      const relativePath = path.join(relativeDirectory, entry.name);
      const absolutePath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        if (!isExcludedDirectory(relativePath, entry.name)) {
          visit(absolutePath, relativePath);
        }
        continue;
      }
      if (!entry.isFile() || excludedFiles.has(normalizedPath(relativePath))) {
        continue;
      }

      const category = classify(relativePath);
      if (category !== null) files.push({category, path: absolutePath});
    }
  }

  visit(root);
  return files;
}
