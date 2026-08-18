/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import path from 'node:path';
import fs from 'graceful-fs';
import {auditRepository} from './pkgNec/audit.mjs';
import {createPackageInventory} from './pkgNecPackageIdentity.mjs';

const repoRoot = process.cwd();
const policy = JSON.parse(
  fs.readFileSync(
    path.join(repoRoot, 'scripts/pkgNec/packageIdentityPolicy.json'),
    'utf8',
  ),
);
const inventory = createPackageInventory({policy, repoRoot});
const findings = auditRepository({inventory, repoRoot});

if (findings.length === 0) {
  console.log('pkg-nec package identity audit passed');
} else {
  for (const item of findings) {
    console.error(
      [
        item.filePath,
        `category=${item.category}`,
        `literal=${JSON.stringify(item.literal)}`,
        `expected=${JSON.stringify(item.expected)}`,
        `exception=${item.exceptionId ?? 'none'}`,
      ].join(' | '),
    );
  }
  console.error(
    `pkg-nec package identity audit found ${findings.length} issue(s)`,
  );
  process.exitCode = 1;
}
