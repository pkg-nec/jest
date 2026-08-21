/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import semver from 'semver';
import {
  componentReleaseOrder,
  stronglyConnectedReleaseComponents,
} from './releaseGraph.mjs';
import {releasePlanPathFromTag} from './releasePlanSchema.mjs';

const schemaOneLedgerFields = new Set([
  'generatedAt',
  'nodeVersion',
  'packageManager',
  'packages',
  'schemaVersion',
  'sourceCommit',
]);
const schemaTwoLedgerFields = new Set([
  ...schemaOneLedgerFields,
  'releasePlan',
]);
const releasePlanFields = new Set(['digest', 'path']);
const packageFields = new Set([
  'files',
  'integrity',
  'name',
  'order',
  'prerequisites',
  'tarball',
  'version',
]);

function matchingIntegrity(entry, observed) {
  return (
    observed.name === entry.name &&
    observed.version === entry.version &&
    observed.integrity === entry.integrity
  );
}

function initialJournal({ledger, releaseTag}) {
  return {
    packages: [],
    releaseTag,
    schemaVersion: 1,
    sourceCommit: ledger.sourceCommit,
  };
}

function validSha512Integrity(integrity) {
  if (typeof integrity !== 'string') return false;
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(integrity);
  if (!match) return false;

  const payload = match[1];
  const digest = Buffer.from(payload, 'base64');
  return digest.length === 64 && digest.toString('base64') === payload;
}

function unexpectedField(value, allowed) {
  return Object.keys(value).find(field => !allowed.has(field));
}

function validStringArray(value) {
  return (
    Array.isArray(value) &&
    value.every(item => typeof item === 'string' && item.length > 0) &&
    new Set(value).size === value.length
  );
}

function validateLedgerReleasePlan({releasePlan, releaseTag}) {
  if (
    !releasePlan ||
    typeof releasePlan !== 'object' ||
    Array.isArray(releasePlan)
  ) {
    throw new TypeError('Invalid release ledger releasePlan');
  }
  const extraField = unexpectedField(releasePlan, releasePlanFields);
  if (extraField) {
    throw new Error(`Unexpected release plan field: ${extraField}`);
  }
  const missingField = [...releasePlanFields].find(
    field => !(field in releasePlan),
  );
  if (missingField) {
    throw new Error(`Missing release plan field: ${missingField}`);
  }
  if (!/^sha256-[0-9a-f]{64}$/u.test(releasePlan.digest)) {
    throw new Error('Invalid release plan digest');
  }
  let expectedPath;
  try {
    expectedPath = releasePlanPathFromTag(releaseTag);
  } catch {
    throw new Error('Invalid release plan path');
  }
  if (releasePlan.path !== expectedPath) {
    throw new Error('Invalid release plan path');
  }
}

export function validateReleaseLedger({ledger, releaseTag}) {
  if (ledger?.schemaVersion !== 1 && ledger?.schemaVersion !== 2) {
    throw new Error('Unsupported release ledger schema');
  }
  if (ledger.schemaVersion === 2 && !('releasePlan' in ledger)) {
    throw new Error('Unsupported release ledger schema');
  }
  if (!Array.isArray(ledger.packages)) {
    throw new TypeError('Release ledger packages must be an array');
  }
  if (typeof releaseTag !== 'string' || releaseTag.length === 0) {
    throw new Error('Release tag is required');
  }
  if (!/^[0-9a-f]{40}$/iu.test(ledger.sourceCommit)) {
    throw new Error('Release ledger source commit must be a full Git commit');
  }
  const ledgerFields =
    ledger.schemaVersion === 2 ? schemaTwoLedgerFields : schemaOneLedgerFields;
  const extraLedgerField = unexpectedField(ledger, ledgerFields);
  if (extraLedgerField) {
    throw new Error(`Unexpected release ledger field: ${extraLedgerField}`);
  }
  if (ledger.schemaVersion === 2) {
    const missingLedgerField = [...ledgerFields].find(
      field => !(field in ledger),
    );
    if (missingLedgerField) {
      throw new Error(`Missing release ledger field: ${missingLedgerField}`);
    }
    validateLedgerReleasePlan({releasePlan: ledger.releasePlan, releaseTag});
  }
  for (const metadataField of [
    'generatedAt',
    'nodeVersion',
    'packageManager',
  ]) {
    if (
      ledger[metadataField] !== undefined &&
      (typeof ledger[metadataField] !== 'string' ||
        ledger[metadataField].length === 0)
    ) {
      throw new TypeError(`Invalid release ledger ${metadataField}`);
    }
  }
  if (ledger.packages.length === 0) {
    throw new Error('Release ledger packages must not be empty');
  }

  const names = new Set();
  for (const [index, entry] of ledger.packages.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError(
        `Invalid release ledger package at order ${index + 1}`,
      );
    }
    const extraPackageField = unexpectedField(entry, packageFields);
    if (extraPackageField) {
      throw new Error(
        `Unexpected release ledger package field: ${extraPackageField}`,
      );
    }
    if (entry.order !== index + 1) {
      throw new Error('Release ledger package order must be contiguous');
    }
    if (!/^@pkg-nec\/[a-z0-9][a-z0-9._-]*$/u.test(entry.name)) {
      throw new TypeError(
        `Invalid release ledger package name at order ${index + 1}`,
      );
    }
    if (names.has(entry.name)) {
      throw new Error(`Duplicate release ledger package: ${entry.name}`);
    }
    names.add(entry.name);
    if (semver.valid(entry.version) === null) {
      throw new TypeError(`Invalid release ledger version for ${entry.name}`);
    }
    if (typeof entry.tarball !== 'string' || entry.tarball.length === 0) {
      throw new TypeError(`Invalid release ledger tarball for ${entry.name}`);
    }
    if (!validStringArray(entry.prerequisites)) {
      throw new TypeError(
        `Invalid release ledger prerequisites for ${entry.name}`,
      );
    }
    if (!validStringArray(entry.files) || entry.files.length === 0) {
      throw new TypeError(`Invalid release ledger files for ${entry.name}`);
    }
    if (!validSha512Integrity(entry.integrity)) {
      throw new Error(`Invalid release ledger integrity for ${entry.name}`);
    }
  }
  const orderByName = new Map(
    ledger.packages.map(entry => [entry.name, entry.order]),
  );
  for (const entry of ledger.packages) {
    for (const prerequisite of entry.prerequisites) {
      if (!names.has(prerequisite)) {
        throw new Error(
          `Unknown release prerequisite ${prerequisite} for ${entry.name}`,
        );
      }
    }
  }
  if (ledger.schemaVersion === 2) {
    const graph = new Map(
      ledger.packages.map(entry => [entry.name, new Set(entry.prerequisites)]),
    );
    const components = stronglyConnectedReleaseComponents(graph);
    const componentByName = new Map();
    for (const [index, component] of components.entries()) {
      for (const name of component) componentByName.set(name, index);
    }
    const actualOrder = ledger.packages.map(entry => entry.name);
    for (const entry of ledger.packages) {
      for (const prerequisite of entry.prerequisites) {
        if (
          componentByName.get(prerequisite) !==
            componentByName.get(entry.name) &&
          orderByName.get(prerequisite) >= entry.order
        ) {
          throw new Error(
            `Release prerequisite ${prerequisite} must precede ${entry.name}`,
          );
        }
      }
    }
    for (const component of components) {
      const members = actualOrder.filter(name => component.includes(name));
      if (members.some((name, index) => name !== component[index])) {
        throw new Error(
          'Release ledger component packages must be in lexical order',
        );
      }
    }
    const expectedOrder = componentReleaseOrder(graph);
    if (expectedOrder.some((name, index) => name !== actualOrder[index])) {
      throw new Error(
        'Release ledger packages must follow component release order',
      );
    }
    return;
  }
  for (const entry of ledger.packages) {
    for (const prerequisite of entry.prerequisites) {
      if (orderByName.get(prerequisite) >= entry.order) {
        throw new Error(
          `Release prerequisite ${prerequisite} must precede ${entry.name}`,
        );
      }
    }
  }
}

export async function publishRelease({
  inspect,
  ledger,
  now,
  onProgress = async () => {},
  persistJournal,
  publish,
  releaseTag,
  verifyConflict,
}) {
  validateReleaseLedger({ledger, releaseTag});
  const journal = initialJournal({ledger, releaseTag});
  await persistJournal(journal);

  for (const entry of ledger.packages) {
    const observed = await inspect(entry);
    let disposition;
    if (observed.kind === 'present') {
      if (!matchingIntegrity(entry, observed)) {
        throw new Error(
          `Registry integrity mismatch for ${entry.name}@${entry.version}`,
        );
      }
      disposition = 'verified-existing';
    } else if (observed.kind === 'absent') {
      try {
        await publish(entry);
        disposition = 'published';
      } catch (error) {
        if (error.classification !== 'version-conflict') throw error;
        const conflictResult = await verifyConflict(entry);
        if (!matchingIntegrity(entry, conflictResult)) {
          throw new Error(
            `Registry integrity mismatch for ${entry.name}@${entry.version}`,
          );
        }
        disposition = 'verified-existing';
      }
    } else {
      throw new Error(
        `Indeterminate registry state for ${entry.name}@${entry.version}`,
      );
    }

    const completed = {
      completedAt: new Date(now()).toISOString(),
      disposition,
      integrity: entry.integrity,
      name: entry.name,
      order: entry.order,
      version: entry.version,
    };
    const progress = Object.freeze({
      completedAt: completed.completedAt,
      disposition: completed.disposition,
      name: completed.name,
      order: completed.order,
      total: ledger.packages.length,
      version: completed.version,
    });
    journal.packages.push(completed);
    await persistJournal(journal);
    await onProgress(progress);
  }

  return journal;
}
