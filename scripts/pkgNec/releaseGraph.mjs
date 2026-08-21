/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import fs from 'graceful-fs';

function compare(left, right) {
  return left.localeCompare(right);
}

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

export function induceReleaseGraph({graph, selectedNames}) {
  if (!Array.isArray(selectedNames) || selectedNames.length === 0) {
    throw new Error('Selected release packages must not be empty');
  }
  const selected = new Set(selectedNames);
  if (selected.size !== selectedNames.length) {
    throw new Error('Selected release packages must be unique');
  }

  for (const [consumer, dependencies] of graph) {
    for (const dependency of dependencies) {
      if (!graph.has(dependency)) {
        throw new Error(
          `Unresolved internal release dependency ${dependency} referenced by ${consumer}`,
        );
      }
    }
  }

  return new Map(
    selectedNames.map(name => {
      const dependencies = graph.get(name);
      if (!dependencies) {
        throw new Error(`Selected release workspace is missing: ${name}`);
      }
      return [
        name,
        new Set(
          [...dependencies].filter(dependency => selected.has(dependency)),
        ),
      ];
    }),
  );
}

function validateReleaseGraph(graph) {
  for (const [consumer, dependencies] of graph) {
    for (const dependency of dependencies) {
      if (!graph.has(dependency)) {
        throw new Error(
          `Unresolved internal runtime dependency ${dependency} referenced by ${consumer}`,
        );
      }
    }
  }
}

function appendFinishingOrder({finished, graph, root, visited}) {
  visited.add(root);
  const stack = [
    {
      index: 0,
      name: root,
      neighbors: [...graph.get(root)].sort(compare),
    },
  ];
  while (stack.length > 0) {
    const frame = stack.at(-1);
    if (frame.index < frame.neighbors.length) {
      const neighbor = frame.neighbors[frame.index];
      frame.index += 1;
      if (visited.has(neighbor)) continue;
      visited.add(neighbor);
      stack.push({
        index: 0,
        name: neighbor,
        neighbors: [...graph.get(neighbor)].sort(compare),
      });
      continue;
    }
    finished.push(frame.name);
    stack.pop();
  }
}

export function stronglyConnectedReleaseComponents(graph) {
  validateReleaseGraph(graph);
  const names = [...graph.keys()].sort(compare);
  const finished = [];
  const visited = new Set();
  for (const name of names) {
    if (!visited.has(name)) {
      appendFinishingOrder({finished, graph, root: name, visited});
    }
  }

  const reverse = new Map(names.map(name => [name, new Set()]));
  for (const [consumer, dependencies] of graph) {
    for (const dependency of dependencies) {
      reverse.get(dependency).add(consumer);
    }
  }

  const assigned = new Set();
  const components = [];
  for (const root of [...finished].reverse()) {
    if (assigned.has(root)) continue;
    const members = [];
    const stack = [root];
    assigned.add(root);
    while (stack.length > 0) {
      const name = stack.pop();
      members.push(name);
      const neighbors = [...reverse.get(name)].sort(compare).reverse();
      for (const neighbor of neighbors) {
        if (assigned.has(neighbor)) continue;
        assigned.add(neighbor);
        stack.push(neighbor);
      }
    }
    components.push(members.sort(compare));
  }
  return components.sort((left, right) => compare(left[0], right[0]));
}

export function componentReleaseOrder(graph) {
  const components = stronglyConnectedReleaseComponents(graph);
  const componentByName = new Map();
  for (const [index, component] of components.entries()) {
    for (const name of component) componentByName.set(name, index);
  }
  const dependencies = components.map(() => new Set());
  for (const [consumer, packageDependencies] of graph) {
    const consumerComponent = componentByName.get(consumer);
    for (const dependency of packageDependencies) {
      const dependencyComponent = componentByName.get(dependency);
      if (dependencyComponent !== consumerComponent) {
        dependencies[consumerComponent].add(dependencyComponent);
      }
    }
  }

  const emitted = new Set();
  const order = [];
  while (emitted.size < components.length) {
    const next = components
      .map((component, index) => ({
        component,
        dependencies: dependencies[index],
        index,
        key: component[0],
      }))
      .filter(
        item =>
          !emitted.has(item.index) &&
          [...item.dependencies].every(dependency => emitted.has(dependency)),
      )
      .sort((left, right) => compare(left.key, right.key))[0];
    if (next === undefined) {
      throw new Error('Invalid strongly connected release graph');
    }
    emitted.add(next.index);
    order.push(...next.component);
  }
  return order;
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
