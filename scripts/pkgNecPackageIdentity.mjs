/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import path from 'node:path';
import fs from 'graceful-fs';

const dependencyFields = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
  'peerDependenciesMeta',
  'resolutions',
];
const publishablePrivatePackages = new Set([
  '@jest/test-globals',
  '@jest/test-utils',
]);

export function canonicalName(oldName, {isRoot = false} = {}) {
  if (oldName.startsWith('@pkg-nec/')) return oldName;
  if (isRoot && oldName === '@jest/monorepo') return '@pkg-nec/monorepo';
  if (oldName.startsWith('@jest/')) return `@pkg-nec/jest-${oldName.slice(6)}`;
  return `@pkg-nec/${oldName}`;
}

function readManifest(manifestPath) {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

function createPackageIdentity(directory, {isRoot = false} = {}) {
  const manifestPath = path.join(directory, 'package.json');
  const manifest = readManifest(manifestPath);
  const oldName = manifest.name;

  if (typeof oldName !== 'string') {
    throw new TypeError(`Package manifest is missing a name: ${manifestPath}`);
  }

  return {
    directory,
    manifestPath,
    newName: canonicalName(oldName, {isRoot}),
    oldName,
    publishable:
      manifest.private !== true || publishablePrivatePackages.has(oldName),
    version: manifest.version,
  };
}

function addIdentity(identity, byOldName, byNewName) {
  if (byOldName.has(identity.oldName)) {
    throw new Error(`Duplicate package name: ${identity.oldName}`);
  }
  if (byNewName.has(identity.newName)) {
    throw new Error(`Canonical package name collision: ${identity.newName}`);
  }

  byOldName.set(identity.oldName, identity);
  byNewName.set(identity.newName, identity);
}

export function discoverPackageIdentities({
  repoRoot,
  expectedPackageCount = 55,
}) {
  const rootDirectory = path.resolve(repoRoot);
  const root = createPackageIdentity(rootDirectory, {isRoot: true});
  const packagesDirectory = path.join(rootDirectory, 'packages');
  const packages = fs
    .readdirSync(packagesDirectory, {withFileTypes: true})
    .filter(entry => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(entry =>
      createPackageIdentity(path.join(packagesDirectory, entry.name)),
    );

  if (packages.length !== expectedPackageCount) {
    throw new Error(
      `Expected ${expectedPackageCount} release workspaces, found ${packages.length}`,
    );
  }

  const byOldName = new Map();
  const byNewName = new Map();
  for (const identity of [root, ...packages]) {
    addIdentity(identity, byOldName, byNewName);
  }

  return {byNewName, byOldName, packages, root};
}

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

function sortObject(object) {
  return Object.fromEntries(
    Object.entries(object)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [
        key,
        value !== null && typeof value === 'object' && !Array.isArray(value)
          ? sortObject(value)
          : value,
      ]),
  );
}

function normalizedManifestPath(rootDirectory, manifestPath) {
  return path.relative(rootDirectory, manifestPath).split(path.sep).join('/');
}

function createManifestRecord(manifestPath) {
  const manifest = readManifest(manifestPath);
  const record = {
    name: manifest.name,
    private: manifest.private === true,
    version: manifest.version,
  };

  for (const field of dependencyFields) {
    if (Object.hasOwn(manifest, field))
      record[field] = sortObject(manifest[field]);
  }

  return sortObject(record);
}

export function createManifestBaseline(inventory) {
  const identities = [inventory.root, ...inventory.packages].sort(
    (left, right) =>
      normalizedManifestPath(
        inventory.root.directory,
        left.manifestPath,
      ).localeCompare(
        normalizedManifestPath(inventory.root.directory, right.manifestPath),
      ),
  );

  return Object.fromEntries(
    identities.map(identity => [
      normalizedManifestPath(inventory.root.directory, identity.manifestPath),
      createManifestRecord(identity.manifestPath),
    ]),
  );
}

export function assertManifestBaseline({baseline, inventory}) {
  const currentBaseline = createManifestBaseline(inventory);

  if (JSON.stringify(baseline) !== JSON.stringify(currentBaseline)) {
    throw new Error('Manifest baseline does not match current inventory');
  }

  for (const identity of [inventory.root, ...inventory.packages]) {
    const manifestPath = normalizedManifestPath(
      inventory.root.directory,
      identity.manifestPath,
    );
    const record = baseline[manifestPath];

    if (
      record?.name !== identity.oldName ||
      record?.version !== identity.version
    ) {
      throw new Error('Manifest baseline does not match current inventory');
    }
  }
}
