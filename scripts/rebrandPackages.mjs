/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import path from 'node:path';
import {fileURLToPath} from 'node:url';
import fs from 'graceful-fs';
import {
  applyMigrationPlan,
  buildMigrationPlan,
} from './pkgNec/migrationPlan.mjs';
import {discoverPackageIdentities} from './pkgNecPackageIdentity.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const baseline = JSON.parse(
  fs.readFileSync(
    new URL('pkgNec/upstreamManifestBaseline.json', import.meta.url),
    'utf8',
  ),
);

function printPlan(plan) {
  const filesByCategory = new Map();
  for (const file of plan.files) {
    for (const edit of file.edits) {
      const category = edit.category ?? 'uncategorized';
      const files = filesByCategory.get(category) ?? new Map();
      files.set(file.path, (files.get(file.path) ?? 0) + 1);
      filesByCategory.set(category, files);
    }
  }

  const editCount = plan.files.reduce(
    (count, file) => count + file.edits.length,
    0,
  );
  console.log(
    `pkg-nec migration plan: ${plan.files.length} files, ${editCount} edits`,
  );
  for (const [category, files] of [...filesByCategory].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const categoryEditCount = [...files.values()].reduce(
      (count, value) => count + value,
      0,
    );
    console.log(`\n${category} (${categoryEditCount} edits)`);
    for (const [filePath, count] of [...files].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      console.log(`  ${path.relative(repoRoot, filePath)} (${count})`);
    }
  }
}

const arguments_ = process.argv.slice(2);
const unknownArguments = arguments_.filter(argument => argument !== '--check');
if (unknownArguments.length > 0) {
  throw new Error(`Unknown argument: ${unknownArguments[0]}`);
}

const inventory = discoverPackageIdentities({repoRoot});
const plan = buildMigrationPlan({baseline, inventory, repoRoot});
printPlan(plan);

if (arguments_.includes('--check')) {
  console.log('\nCheck complete; no files written.');
} else {
  const report = applyMigrationPlan(plan);
  console.log(`\nChanged ${report.changedPaths.length} files.`);
  for (const warning of report.cleanupWarnings ?? []) {
    console.warn(
      `Warning: migration committed, but backup cleanup failed; retained ${path.relative(
        repoRoot,
        warning.backupPath,
      )}: ${warning.message}`,
    );
  }
}
