/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import fs from 'graceful-fs';
import {componentReleaseOrder} from './releaseGraph.mjs';

const dependencyFields = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'devDependencies',
];

function compare(left, right) {
  return left.localeCompare(right);
}

function comparePaths(left, right) {
  return compare(JSON.stringify(left), JSON.stringify(right));
}

function resolveWorkspace(name, inventory) {
  return inventory.byOldName.get(name) ?? inventory.byNewName.get(name);
}

export function buildWorkspaceReleaseGraph(
  inventory,
  {readFile = file => fs.readFileSync(file, 'utf8')} = {},
) {
  const packages = inventory.packages
    .filter(identity => identity.publishable !== false)
    .sort((left, right) => compare(left.newName, right.newName));
  const graph = new Map(
    packages.map(identity => [identity.newName, new Set()]),
  );

  for (const identity of packages) {
    const manifest = JSON.parse(readFile(identity.manifestPath));
    const dependencies = graph.get(identity.newName);

    for (const field of dependencyFields) {
      for (const [dependencyName, value] of Object.entries(
        manifest[field] ?? {},
      )) {
        if (!String(value).startsWith('workspace:')) continue;
        const dependency = resolveWorkspace(dependencyName, inventory);
        if (!dependency || !graph.has(dependency.newName)) {
          throw new Error(
            `Unknown workspace target ${dependencyName} referenced by ${identity.newName}`,
          );
        }
        dependencies.add(dependency.newName);
      }
    }
  }

  return graph;
}

function reverseGraph(graph) {
  const reverse = new Map([...graph.keys()].map(name => [name, new Set()]));
  for (const [consumer, dependencies] of graph) {
    for (const dependency of dependencies) {
      if (!reverse.has(dependency)) {
        throw new Error(
          `Unknown workspace target ${dependency} referenced by ${consumer}`,
        );
      }
      reverse.get(dependency).add(consumer);
    }
  }
  return reverse;
}

export function selectDependentClosure({directNames, graph}) {
  const direct = [...new Set(directNames)].sort(compare);
  const reverse = reverseGraph(graph);
  for (const name of direct) {
    if (!graph.has(name)) {
      throw new Error(`Unknown directly selected package: ${name}`);
    }
  }

  const distances = new Map(direct.map(name => [name, 0]));
  let frontier = direct;
  while (frontier.length > 0) {
    const next = new Set();
    for (const dependency of frontier) {
      const distance = distances.get(dependency);
      for (const consumer of [...reverse.get(dependency)].sort(compare)) {
        if (!distances.has(consumer)) {
          distances.set(consumer, distance + 1);
          next.add(consumer);
        }
      }
    }
    frontier = [...next].sort(compare);
  }

  const paths = new Map(direct.map(name => [name, [[name]]]));
  const maximumDistance = Math.max(0, ...distances.values());
  for (let distance = 1; distance <= maximumDistance; distance++) {
    const names = [...distances]
      .filter(([, value]) => value === distance)
      .map(([name]) => name)
      .sort(compare);
    for (const name of names) {
      const candidates = [];
      for (const dependency of [...graph.get(name)].sort(compare)) {
        if (distances.get(dependency) !== distance - 1) continue;
        for (const dependencyPath of paths.get(dependency)) {
          candidates.push([...dependencyPath, name]);
        }
      }
      const unique = new Map(
        candidates.map(candidate => [JSON.stringify(candidate), candidate]),
      );
      paths.set(name, [...unique.values()].sort(comparePaths));
    }
  }

  const selectedNames = [...distances.keys()].sort(compare);
  return {
    dependentPaths: new Map(
      selectedNames
        .filter(name => !direct.includes(name))
        .map(name => [name, paths.get(name)]),
    ),
    selectedNames,
  };
}

export function selectedReleaseOrder({graph, selectedNames}) {
  const selected = new Set(selectedNames);
  for (const name of selected) {
    if (!graph.has(name)) {
      throw new Error(`Unknown selected package: ${name}`);
    }
  }
  for (const [consumer, dependencies] of graph) {
    for (const dependency of dependencies) {
      if (!graph.has(dependency)) {
        throw new Error(
          `Unknown workspace target ${dependency} referenced by ${consumer}`,
        );
      }
    }
  }

  const inducedGraph = new Map(
    [...selected].map(name => [
      name,
      new Set(
        [...graph.get(name)].filter(dependency => selected.has(dependency)),
      ),
    ]),
  );
  return componentReleaseOrder(inducedGraph);
}
