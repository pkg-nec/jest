/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

const retryableCodes = new Set([
  'ABORT_ERR',
  'E404',
  'E408',
  'E429',
  'EAI_AGAIN',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ESOCKETTIMEDOUT',
  'ETIMEDOUT',
  'ERR_ABORTED',
]);
const fatalAuthenticationCodes = new Set([
  'E401',
  'E403',
  'EAUTH',
  'ENEEDAUTH',
]);

function statusCode(error) {
  return Number(
    error?.statusCode ??
      error?.status ??
      error?.response?.statusCode ??
      error?.response?.status,
  );
}

function errorText(error) {
  return [error?.message, error?.stderr, error?.stdout]
    .filter(value => typeof value === 'string')
    .join(' ');
}

function registryErrorClass(error) {
  if (typeof error?.code === 'string' && error.code.length > 0) {
    return error.code.toUpperCase();
  }
  if (typeof error?.name === 'string' && error.name !== 'Error') {
    return error.name;
  }

  const status = statusCode(error);
  return Number.isFinite(status) ? `HTTP_${status}` : 'Error';
}

function redactRegistryError(value) {
  return String(value)
    .replaceAll(
      /(authorization\s*[:=]\s*)(?:basic|bearer)?\s*[^\s,;]+/gi,
      '$1[REDACTED]',
    )
    .replaceAll(/(_authToken\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replaceAll(/\b(?:basic|bearer)\s+[^\s,;]+/gi, '[REDACTED]')
    .replaceAll(/npm_[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replaceAll(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@');
}

export function classifyRegistryError(error) {
  const code = String(error?.code ?? '').toUpperCase();
  const name = String(error?.name ?? '').toUpperCase();
  const status = statusCode(error);
  const text = redactRegistryError(errorText(error)).toLowerCase();

  if (
    fatalAuthenticationCodes.has(code) ||
    status === 401 ||
    status === 403 ||
    /\b(?:e401|e403|eauth|eneedauth|401|403|authentication|authorization|unauthorized|forbidden)\b/.test(
      text,
    )
  ) {
    return 'fatal';
  }

  if (
    retryableCodes.has(code) ||
    name === 'ABORTERROR' ||
    name === 'TIMEOUTERROR' ||
    status === 404 ||
    status === 408 ||
    status === 429 ||
    (status >= 500 && status <= 599) ||
    /\b(?:abort_err|e404|e408|e429|e5\d{2}|eai_again|econnaborted|econnrefused|econnreset|ehostunreach|enetdown|enetunreach|enotfound|epipe|esockettimedout|etimedout|err_aborted|404|408|429|5\d{2}|not found|rate limit|timed? out|timeout)\b/.test(
      text,
    )
  ) {
    return 'retryable';
  }

  return 'fatal';
}

function parseRegistryResult(result) {
  const value = result?.stdout ?? result;
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  return Array.isArray(parsed) ? parsed[0] : parsed;
}

function registryFailure({attempts, classification, elapsedMs, message}) {
  const error = new Error(message);
  error.attempts = attempts;
  error.classification = classification;
  error.elapsedMs = elapsedMs;
  return error;
}

function defaultSleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function isSha512Integrity(integrity) {
  return typeof integrity === 'string' && /^sha512-\S+$/.test(integrity);
}

export function releaseEntryFromLedger({ledger, packageName}) {
  if (ledger?.schemaVersion !== 1 || !Array.isArray(ledger.packages)) {
    throw new TypeError('Unsupported pkg-nec release ledger');
  }
  const matches = ledger.packages.filter(item => item?.name === packageName);
  if (matches.length !== 1) {
    throw new Error(
      `Expected one release ledger entry for ${packageName}, found ${matches.length}`,
    );
  }
  const [{integrity, name, version}] = matches;
  if (!isSha512Integrity(integrity) || typeof version !== 'string') {
    throw new TypeError(`Invalid release ledger entry for ${packageName}`);
  }
  return {integrity, name, version};
}

export async function waitForExactVersion({
  expectedIntegrity,
  name,
  version,
  query,
  intervalMs = 5000,
  queryTimeoutMs = 10_000,
  deadlineMs = 480_000,
  now = Date.now,
  sleep = defaultSleep,
}) {
  const startedAt = now();
  const exactSpecifier = `${name}@${version}`;
  if (!isSha512Integrity(expectedIntegrity)) {
    throw new TypeError(`Expected SHA-512 integrity for ${exactSpecifier}`);
  }
  let attempts = 0;
  let lastError;

  while (now() - startedAt < deadlineMs) {
    const elapsedBeforeQuery = now() - startedAt;
    const remainingMs = deadlineMs - elapsedBeforeQuery;
    attempts += 1;

    try {
      const result = await query(
        [
          'view',
          exactSpecifier,
          '--json',
          '--registry=https://registry.npmjs.org/',
        ],
        {
          signal: AbortSignal.timeout(Math.min(queryTimeoutMs, remainingMs)),
        },
      );
      const manifest = parseRegistryResult(result);

      if (manifest?.name !== name || manifest?.version !== version) {
        throw new Error(
          `Registry returned a different package version for ${exactSpecifier}`,
        );
      }
      if (typeof manifest?.dist?.integrity !== 'string') {
        throw new TypeError(
          `Registry response omitted integrity for ${exactSpecifier}`,
        );
      }
      if (manifest.dist.integrity !== expectedIntegrity) {
        throw new Error(
          `Registry returned a different package integrity for ${exactSpecifier}`,
        );
      }

      return {
        attempts,
        elapsedMs: now() - startedAt,
        integrity: manifest.dist.integrity,
        name,
        version,
      };
    } catch (error) {
      const classification = classifyRegistryError(error);
      const elapsedMs = now() - startedAt;

      if (classification === 'fatal') {
        throw registryFailure({
          attempts,
          classification,
          elapsedMs,
          message: `Fatal registry query for ${exactSpecifier} (${registryErrorClass(error)}): ${redactRegistryError(errorText(error))}`,
        });
      }

      lastError = error;
      if (elapsedMs >= deadlineMs) break;
      await sleep(Math.min(intervalMs, deadlineMs - elapsedMs));
    }
  }

  const elapsedMs = now() - startedAt;
  const errorClass = lastError ? registryErrorClass(lastError) : 'none';
  throw registryFailure({
    attempts,
    classification: 'retryable',
    elapsedMs,
    message: `Timed out waiting for ${exactSpecifier} after ${attempts} attempts; last error class: ${errorClass}; last error: ${redactRegistryError(errorText(lastError))}`,
  });
}
