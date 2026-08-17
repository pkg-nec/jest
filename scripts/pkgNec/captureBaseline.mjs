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
  createManifestBaseline,
  discoverPackageIdentities,
} from '../pkgNecPackageIdentity.mjs';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const baselinePath = path.join(
  repoRoot,
  'scripts/pkgNec/upstreamManifestBaseline.json',
);

if (fs.existsSync(baselinePath)) {
  throw new Error(`Refusing to overwrite existing baseline: ${baselinePath}`);
}

const inventory = discoverPackageIdentities({repoRoot});
const baseline = createManifestBaseline(inventory);
fs.writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
