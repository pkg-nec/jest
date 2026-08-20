/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

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

function validateLedger({ledger, releaseTag}) {
  if (ledger?.schemaVersion !== 1) {
    throw new Error('Unsupported release ledger schema');
  }
  if (!Array.isArray(ledger.packages)) {
    throw new Error('Release ledger packages must be an array');
  }
  if (!releaseTag) throw new Error('Release tag is required');

  const names = new Set();
  for (const [index, entry] of ledger.packages.entries()) {
    if (entry.order !== index + 1) {
      throw new Error('Release ledger package order must be contiguous');
    }
    if (names.has(entry.name)) {
      throw new Error(`Duplicate release ledger package: ${entry.name}`);
    }
    names.add(entry.name);
    if (!validSha512Integrity(entry.integrity)) {
      throw new Error(`Invalid release ledger integrity for ${entry.name}`);
    }
  }
}

export async function publishRelease({
  inspect,
  ledger,
  now,
  persistJournal,
  publish,
  releaseTag,
  verifyConflict,
}) {
  validateLedger({ledger, releaseTag});
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

    journal.packages.push({
      completedAt: new Date(now()).toISOString(),
      disposition,
      integrity: entry.integrity,
      name: entry.name,
      order: entry.order,
      version: entry.version,
    });
    await persistJournal(journal);
  }

  return journal;
}
