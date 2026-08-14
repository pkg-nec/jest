/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import path from 'node:path';
import fs from 'graceful-fs';
import {auditRepository} from './pkgNec/audit.mjs';
import {canonicalName} from './pkgNecPackageIdentity.mjs';

const repoRoot = process.cwd();
const baseline = JSON.parse(
  fs.readFileSync(
    path.join(repoRoot, 'scripts/pkgNec/upstreamManifestBaseline.json'),
    'utf8',
  ),
);
const publishablePrivatePackages = new Set([
  '@jest/test-globals',
  '@jest/test-utils',
]);

function identityFromBaseline(filePath, record, {isRoot = false} = {}) {
  const manifestPath = path.join(repoRoot, filePath);
  return {
    directory: path.dirname(manifestPath),
    manifestPath,
    newName: canonicalName(record.name, {isRoot}),
    oldName: record.name,
    publishable:
      record.private !== true || publishablePrivatePackages.has(record.name),
    version: record.version,
  };
}

const root = identityFromBaseline('package.json', baseline['package.json'], {
  isRoot: true,
});
const packages = Object.entries(baseline)
  .filter(([filePath]) => filePath !== 'package.json')
  .map(([filePath, record]) => identityFromBaseline(filePath, record));
const identities = [root, ...packages];
const inventory = {
  byNewName: new Map(identities.map(identity => [identity.newName, identity])),
  byOldName: new Map(identities.map(identity => [identity.oldName, identity])),
  packages,
  root,
};
const findings = auditRepository({baseline, inventory, repoRoot});

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
