/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import path from 'node:path';
import fs from 'graceful-fs';

export function createPackageInventory({
  policy,
  repoRoot,
  readFile = file => fs.readFileSync(file, 'utf8'),
}) {
  if (policy?.schemaVersion !== 1 || !Array.isArray(policy.packages)) {
    throw new TypeError('Unsupported pkg-nec package identity policy');
  }

  const identities = policy.packages.map(item => {
    const manifestPath = path.resolve(repoRoot, item.manifestPath);
    const manifest = JSON.parse(readFile(manifestPath));
    return {
      directory: path.dirname(manifestPath),
      manifestPath,
      newName: item.newName,
      oldName: item.oldName,
      publishable: item.publishable,
      version: manifest.version,
    };
  });

  const rootManifestPath = path.resolve(repoRoot, 'package.json');
  const root = identities.find(item => item.manifestPath === rootManifestPath);
  if (!root) {
    throw new Error('Package identity policy is missing package.json');
  }

  const packages = identities.filter(item => item !== root);
  if (packages.length !== 55) {
    throw new Error(`Expected 55 package identities, found ${packages.length}`);
  }

  const byOldName = new Map();
  const byNewName = new Map();
  const manifestPaths = new Set();
  for (const identity of identities) {
    if (manifestPaths.has(identity.manifestPath)) {
      throw new Error(`Duplicate manifest path: ${identity.manifestPath}`);
    }
    if (byOldName.has(identity.oldName)) {
      throw new Error(`Duplicate old package name: ${identity.oldName}`);
    }
    if (byNewName.has(identity.newName)) {
      throw new Error(`Duplicate new package name: ${identity.newName}`);
    }
    manifestPaths.add(identity.manifestPath);
    byOldName.set(identity.oldName, identity);
    byNewName.set(identity.newName, identity);
  }

  return {byNewName, byOldName, packages, root};
}

export function rewritePackageSpecifier(specifier, inventory) {
  const identities = [...inventory.byOldName.values()].sort(
    (left, right) => right.oldName.length - left.oldName.length,
  );

  for (const identity of identities) {
    if (specifier === identity.oldName) return identity.newName;
    if (specifier.startsWith(`${identity.oldName}/`)) {
      return `${identity.newName}${specifier.slice(identity.oldName.length)}`;
    }
  }

  return null;
}
