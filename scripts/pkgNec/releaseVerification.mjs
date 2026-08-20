/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  classifyRegistryError,
  redactRegistryFailure,
} from './registryVisibility.mjs';
import {validateReleaseLedger} from './releasePublisher.mjs';

const maximumBatchConcurrency = 8;
const journalFields = new Set([
  'packages',
  'releaseTag',
  'schemaVersion',
  'sourceCommit',
]);
const journalPackageFields = new Set([
  'completedAt',
  'disposition',
  'integrity',
  'name',
  'order',
  'version',
]);
const journalDispositions = new Set(['published', 'verified-existing']);

function unexpectedField(value, allowed) {
  return Object.keys(value).find(field => !allowed.has(field));
}

function exactFields(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`Invalid ${label}`);
  }
  const extraField = unexpectedField(value, allowed);
  if (extraField) throw new Error(`Unexpected ${label} field: ${extraField}`);
  const missingField = [...allowed].find(field => !(field in value));
  if (missingField) throw new Error(`Missing ${label} field: ${missingField}`);
}

function validIsoTimestamp(value) {
  if (typeof value !== 'string') return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

export function validatePublicationJournal({journal, ledger}) {
  exactFields(journal, journalFields, 'publication journal');
  validateReleaseLedger({ledger, releaseTag: journal.releaseTag});
  if (journal.schemaVersion !== 1) {
    throw new Error('Unsupported publication journal schema');
  }
  if (journal.sourceCommit !== ledger.sourceCommit) {
    throw new Error('Publication journal source commit does not match ledger');
  }
  if (!Array.isArray(journal.packages)) {
    throw new TypeError('Publication journal packages must be an array');
  }
  if (journal.packages.length !== ledger.packages.length) {
    throw new Error('Publication journal packages do not match release ledger');
  }

  for (const [index, journalEntry] of journal.packages.entries()) {
    exactFields(
      journalEntry,
      journalPackageFields,
      `publication journal package at order ${index + 1}`,
    );
    const ledgerEntry = ledger.packages[index];
    if (
      journalEntry.integrity !== ledgerEntry.integrity ||
      journalEntry.name !== ledgerEntry.name ||
      journalEntry.order !== ledgerEntry.order ||
      journalEntry.version !== ledgerEntry.version
    ) {
      throw new Error(
        `Publication journal entry does not match ledger at order ${index + 1}`,
      );
    }
    if (!journalDispositions.has(journalEntry.disposition)) {
      throw new Error(
        `Invalid publication disposition for ${journalEntry.name}`,
      );
    }
    if (!validIsoTimestamp(journalEntry.completedAt)) {
      throw new TypeError(
        `Invalid publication completion time for ${journalEntry.name}`,
      );
    }
  }
}

async function mapWithConcurrency(items, limit, operation) {
  const results = Array.from({length: items.length});
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await operation(items[index], index);
    }
  }

  await Promise.all(
    Array.from({length: Math.min(limit, items.length)}, () => worker()),
  );
  return results;
}

function queryAbortScope({batchSignal, timeoutMs}) {
  const controller = new AbortController();
  let rejectInterruption;
  const interruption = new Promise((_resolve, reject) => {
    rejectInterruption = reject;
  });
  const abortForBatch = () => {
    const reason =
      batchSignal.reason instanceof Error
        ? batchSignal.reason
        : new Error('Batch verification aborted');
    controller.abort(reason);
    rejectInterruption(reason);
  };
  if (batchSignal.aborted) {
    abortForBatch();
  } else {
    batchSignal.addEventListener('abort', abortForBatch, {once: true});
  }

  const timeoutError = new Error(
    `Registry query timed out after ${timeoutMs} milliseconds`,
  );
  timeoutError.name = 'TimeoutError';
  const timer = setTimeout(() => {
    controller.abort(timeoutError);
    rejectInterruption(timeoutError);
  }, timeoutMs);

  return {
    cleanup() {
      clearTimeout(timer);
      batchSignal.removeEventListener('abort', abortForBatch);
    },
    settle(queryPromise) {
      return Promise.race([queryPromise, interruption]);
    },
    signal: controller.signal,
  };
}

function batchPreparationScope({batchController, timeoutMs}) {
  const {signal} = batchController;
  let rejectInterruption;
  const interruption = new Promise((_resolve, reject) => {
    rejectInterruption = reject;
  });
  const interrupt = () => {
    const reason =
      signal.reason instanceof Error
        ? signal.reason
        : new Error('Batch verification preparation aborted');
    rejectInterruption(reason);
  };
  if (signal.aborted) interrupt();
  else signal.addEventListener('abort', interrupt, {once: true});

  const timeoutError = new Error(
    `Batch verification preparation timed out after ${timeoutMs} milliseconds`,
  );
  timeoutError.classification = 'retryable';
  timeoutError.name = 'TimeoutError';
  const timer = setTimeout(() => {
    batchController.abort(timeoutError);
  }, timeoutMs);

  return {
    cleanup() {
      clearTimeout(timer);
      signal.removeEventListener('abort', interrupt);
    },
    settle(preparationPromise) {
      return Promise.race([preparationPromise, interruption]);
    },
  };
}

function defaultSleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function numericOption(value, label, {integer = false} = {}) {
  if (
    !Number.isFinite(value) ||
    value <= 0 ||
    (integer && !Number.isInteger(value))
  ) {
    throw new TypeError(`${label} must be a positive number`);
  }
}

function verificationFailure({classification, evidence, message}) {
  const error = new Error(message);
  error.classification = classification;
  error.evidence = evidence;
  return error;
}

function evidenceHeader({completedAt, journal, ledger, startedAt}) {
  return {
    completedAt: new Date(completedAt).toISOString(),
    elapsedMs: completedAt - startedAt,
    releaseTag: journal.releaseTag,
    schemaVersion: 1,
    sourceCommit: ledger.sourceCommit,
  };
}

function buildRegistryEvidence(context) {
  const {journal, ledger, states} = context;
  return {
    ...evidenceHeader(context),
    packages: ledger.packages.map((entry, index) => {
      const state = states[index];
      return {
        attempts: state.attempts,
        classification: state.classification,
        disposition: journal.packages[index].disposition,
        elapsedMs: state.elapsedMs,
        expectedIntegrity: entry.integrity,
        integrity: state.observedIntegrity,
        name: entry.name,
        observedIntegrity: state.observedIntegrity,
        order: entry.order,
        version: entry.version,
      };
    }),
  };
}

function provenanceString(provenance, field) {
  return typeof provenance?.[field] === 'string' ? provenance[field] : null;
}

function provenanceLogIds(provenance) {
  return Array.isArray(provenance?.transparencyLogIds) &&
    provenance.transparencyLogIds.every(value => typeof value === 'string')
    ? [...provenance.transparencyLogIds]
    : [];
}

function buildProvenanceEvidence(context) {
  const {journal, ledger, states} = context;
  return {
    ...evidenceHeader(context),
    packages: ledger.packages.map((entry, index) => {
      const state = states[index];
      const provenance = state.provenance;
      return {
        attempts: state.attempts,
        buildType: provenanceString(provenance, 'buildType'),
        bundleDigest: provenanceString(provenance, 'bundleDigest'),
        classification: state.classification,
        disposition: journal.packages[index].disposition,
        elapsedMs: state.elapsedMs,
        name: entry.name,
        order: entry.order,
        predicateType: provenanceString(provenance, 'predicateType'),
        repository: provenanceString(provenance, 'repository'),
        runnerEnvironment: provenanceString(provenance, 'runnerEnvironment'),
        sourceCommit: provenanceString(provenance, 'sourceCommit'),
        sourceRef: provenanceString(provenance, 'sourceRef'),
        subjectName: provenanceString(provenance, 'subjectName'),
        subjectSha512: provenanceString(provenance, 'subjectSha512'),
        transparencyLogIds: provenanceLogIds(provenance),
        version: entry.version,
        workflowPath: provenanceString(provenance, 'workflowPath'),
      };
    }),
  };
}

function buildEvidence({journal, ledger, now, startedAt, states}) {
  const context = {
    completedAt: now(),
    journal,
    ledger,
    startedAt,
    states,
  };
  return {
    provenanceEvidence: buildProvenanceEvidence(context),
    registryEvidence: buildRegistryEvidence(context),
  };
}

function fatalRegistryResult(message) {
  const error = new Error(message);
  error.classification = 'fatal';
  return error;
}

export async function verifyReleaseBatch({
  deadlineMs = 480_000,
  intervalMs = 5000,
  journal,
  ledger,
  maxConcurrency = maximumBatchConcurrency,
  now = Date.now,
  prepareQuery,
  query,
  queryTimeoutMs = 10_000,
  sleep = defaultSleep,
}) {
  validatePublicationJournal({journal, ledger});
  numericOption(deadlineMs, 'deadlineMs');
  numericOption(intervalMs, 'intervalMs');
  numericOption(maxConcurrency, 'maxConcurrency', {integer: true});
  numericOption(queryTimeoutMs, 'queryTimeoutMs');
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  if (typeof query !== 'function') {
    throw new TypeError('query must be a function');
  }
  if (prepareQuery !== undefined && typeof prepareQuery !== 'function') {
    throw new TypeError('prepareQuery must be a function');
  }
  if (typeof sleep !== 'function') {
    throw new TypeError('sleep must be a function');
  }

  const startedAt = now();
  if (!Number.isFinite(startedAt)) {
    throw new TypeError('now must return a finite timestamp');
  }
  const deadlineAt = startedAt + deadlineMs;
  const concurrency = Math.min(maxConcurrency, maximumBatchConcurrency);
  const states = ledger.packages.map(() => ({
    attempts: 0,
    classification: 'pending',
    elapsedMs: 0,
    observedIntegrity: null,
    provenance: null,
  }));
  const batchController = new AbortController();
  let batchFailure = null;
  let batchQuery = query;

  if (prepareQuery) {
    const remainingMs = deadlineAt - now();
    const preparationScope = batchPreparationScope({
      batchController,
      timeoutMs: remainingMs,
    });
    try {
      batchQuery = await preparationScope.settle(
        Promise.resolve().then(() =>
          prepareQuery({
            deadlineAt,
            signal: batchController.signal,
            timeoutMs: remainingMs,
          }),
        ),
      );
      if (typeof batchQuery !== 'function') {
        throw fatalRegistryResult(
          'Batch preparation did not return a package query',
        );
      }
    } catch (error) {
      const classification =
        error?.classification === 'retryable'
          ? 'retryable'
          : error?.classification === 'fatal'
            ? 'fatal'
            : classifyRegistryError(error);
      if (!batchController.signal.aborted) {
        batchController.abort(
          new Error('Batch verification preparation failed'),
        );
      }
      const elapsedMs = now() - startedAt;
      for (const state of states) {
        state.classification = classification;
        state.elapsedMs = elapsedMs;
      }
      const evidence = buildEvidence({journal, ledger, now, startedAt, states});
      throw verificationFailure({
        classification,
        evidence,
        message: 'Npm evidence trust preparation failed',
      });
    } finally {
      preparationScope.cleanup();
    }
  }

  while (true) {
    const unresolvedIndexes = states
      .map((state, index) => (state.classification === 'verified' ? -1 : index))
      .filter(index => index !== -1);
    if (unresolvedIndexes.length === 0) {
      return buildEvidence({journal, ledger, now, startedAt, states});
    }

    const beforeRound = now();
    if (!Number.isFinite(beforeRound)) {
      throw new TypeError('now must return a finite timestamp');
    }
    if (beforeRound >= deadlineAt) {
      const elapsedMs = beforeRound - startedAt;
      for (const index of unresolvedIndexes) {
        states[index].elapsedMs = elapsedMs;
        if (states[index].classification === 'pending') {
          states[index].classification = 'retryable';
        }
      }
      const evidence = buildEvidence({journal, ledger, now, startedAt, states});
      throw verificationFailure({
        classification: 'retryable',
        evidence,
        message: `Timed out verifying pkg-nec release after ${elapsedMs} milliseconds`,
      });
    }

    await mapWithConcurrency(unresolvedIndexes, concurrency, async index => {
      if (batchFailure) return;
      const entry = ledger.packages[index];
      const state = states[index];
      const remainingMs = deadlineAt - now();
      if (remainingMs <= 0) return;

      state.attempts += 1;
      const abortScope = queryAbortScope({
        batchSignal: batchController.signal,
        timeoutMs: Math.min(queryTimeoutMs, remainingMs),
      });
      try {
        const result = await abortScope.settle(
          batchQuery(entry, {signal: abortScope.signal}),
        );
        if (batchFailure) {
          state.classification = 'cancelled';
          state.elapsedMs = now() - startedAt;
          return;
        }
        const observed = result;
        state.observedIntegrity =
          typeof observed?.integrity === 'string' ? observed.integrity : null;
        state.provenance =
          observed?.provenance &&
          typeof observed.provenance === 'object' &&
          !Array.isArray(observed.provenance)
            ? observed.provenance
            : null;
        const completedAt = now();
        if (
          observed?.name !== entry.name ||
          observed?.version !== entry.version
        ) {
          throw fatalRegistryResult(
            `Registry returned a different package identity for ${entry.name}@${entry.version}`,
          );
        }
        if (typeof observed?.integrity !== 'string') {
          throw fatalRegistryResult(
            `Registry response omitted integrity for ${entry.name}@${entry.version}`,
          );
        }
        if (observed.integrity !== entry.integrity) {
          throw fatalRegistryResult(
            `Registry returned a different package integrity for ${entry.name}@${entry.version}`,
          );
        }
        if (state.provenance === null) {
          throw fatalRegistryResult(
            `Registry response omitted normalized provenance for ${entry.name}@${entry.version}`,
          );
        }
        if (completedAt >= deadlineAt) {
          state.classification = 'retryable';
          state.elapsedMs = completedAt - startedAt;
          return;
        }
        state.classification = 'verified';
        state.elapsedMs = completedAt - startedAt;
      } catch (error) {
        const elapsedMs = now() - startedAt;
        state.elapsedMs = elapsedMs;
        if (batchFailure) {
          state.classification = 'cancelled';
          return;
        }
        const classification =
          error?.classification === 'fatal'
            ? 'fatal'
            : error?.classification === 'retryable'
              ? 'retryable'
              : classifyRegistryError(error);
        state.classification = classification;
        if (classification === 'fatal') {
          const detail = redactRegistryFailure(error) || error?.name || 'Error';
          batchFailure = verificationFailure({
            classification,
            evidence: null,
            message: `Fatal npm evidence query for ${entry.name}@${entry.version}: ${detail}`,
          });
          batchController.abort(new Error('Batch verification failed'));
        }
      } finally {
        abortScope.cleanup();
      }
    });

    if (batchFailure) {
      const cancelledAt = now();
      for (const state of states) {
        if (
          state.classification !== 'fatal' &&
          state.classification !== 'verified'
        ) {
          state.classification = 'cancelled';
          state.elapsedMs = cancelledAt - startedAt;
        }
      }
      batchFailure.evidence = buildEvidence({
        journal,
        ledger,
        now,
        startedAt,
        states,
      });
      throw batchFailure;
    }
    if (states.every(state => state.classification === 'verified')) {
      return buildEvidence({journal, ledger, now, startedAt, states});
    }

    const afterRound = now();
    if (afterRound >= deadlineAt) continue;
    await sleep(Math.min(intervalMs, deadlineAt - afterRound));
  }
}
