/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import fs from 'graceful-fs';

function readRuntimeDependencies(identity) {
  const manifest = JSON.parse(fs.readFileSync(identity.manifestPath, 'utf8'));
  return manifest.dependencies ?? {};
}

function resolveInternalDependency(name, inventory) {
  return inventory.byOldName.get(name) ?? inventory.byNewName.get(name);
}

export function buildRuntimeReleaseGraph(inventory) {
  const packages = inventory.packages.filter(
    identity => identity.publishable !== false,
  );
  const graph = new Map(
    packages.map(identity => [identity.newName, new Set()]),
  );

  for (const identity of packages) {
    const dependencies = graph.get(identity.newName);

    for (const [dependencyName, range] of Object.entries(
      readRuntimeDependencies(identity),
    )) {
      const dependency = resolveInternalDependency(dependencyName, inventory);

      if (dependency) {
        if (!graph.has(dependency.newName)) {
          throw new Error(
            `Unresolved internal runtime dependency ${dependencyName} referenced by ${identity.newName}`,
          );
        }
        dependencies.add(dependency.newName);
      } else if (String(range).startsWith('workspace:')) {
        throw new Error(
          `Unresolved internal runtime dependency ${dependencyName} referenced by ${identity.newName}`,
        );
      }
    }
  }

  return graph;
}

export function topologicalReleaseOrder(graph) {
  const emitted = new Set();
  const order = [];

  for (const [consumer, dependencies] of graph) {
    for (const dependency of dependencies) {
      if (!graph.has(dependency)) {
        throw new Error(
          `Unresolved internal runtime dependency ${dependency} referenced by ${consumer}`,
        );
      }
    }
  }

  while (order.length < graph.size) {
    const next = [...graph]
      .filter(
        ([name, dependencies]) =>
          !emitted.has(name) &&
          [...dependencies].every(dependency => emitted.has(dependency)),
      )
      .map(([name]) => name)
      .sort((left, right) => left.localeCompare(right))[0];

    if (next === undefined) {
      const remaining = [...graph.keys()]
        .filter(name => !emitted.has(name))
        .sort((left, right) => left.localeCompare(right));
      throw new Error(`Detected runtime cycle among: ${remaining.join(', ')}`);
    }

    emitted.add(next);
    order.push(next);
  }

  return order;
}
