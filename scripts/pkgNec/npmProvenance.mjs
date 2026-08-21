/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {createHash, createPublicKey} from 'node:crypto';
import {homedir, tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {initTUF as defaultInitTUF} from '@sigstore/tuf';
import pacote from 'pacote';
import sigstore from 'sigstore';

const defaultRegistry = 'https://registry.npmjs.org/';
const fatalCodes = new Set([
  'EATTESTATIONKEY',
  'EATTESTATIONSUBJECT',
  'EATTESTATIONVERIFY',
  'EEXPIREDSIGNATUREKEY',
  'EINTEGRITY',
  'EINTEGRITYSIGNATURE',
  'EMALFORMEDATTESTATION',
  'EMALFORMEDVERIFICATIONKEYS',
  'EMISSINGSIGNATUREKEY',
  'EPROVENANCECLAIM',
]);
const githubHostedBuilderIdentity =
  'https://github.com/actions/runner/github-hosted';
const requiredCertificateOids = [
  {
    id: [1, 3, 6, 1, 4, 1, 57_264, 1, 11],
    value: Buffer.from('0c0d6769746875622d686f73746564', 'hex'),
  },
  {
    id: [1, 3, 6, 1, 4, 1, 57_264, 1, 22],
    value: Buffer.from('0c067075626c6963', 'hex'),
  },
];
const githubRepository = 'https://github.com/pkg-nec/jest';
const githubWorkflowPath = '.github/workflows/release.yml';
const provenanceBuildType =
  'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1';
const provenancePredicateType = 'https://slsa.dev/provenance/v1';
const publishPredicateType =
  'https://github.com/npm/attestation/tree/main/specs/publish/v0.1';
const statementTypeByPredicate = new Map([
  [provenancePredicateType, 'https://in-toto.io/Statement/v1'],
  [publishPredicateType, 'https://in-toto.io/Statement/v0.1'],
]);
const retryableCodes = new Set([
  'E404',
  'E408',
  'E429',
  'EAI_AGAIN',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'EMISSINGATTESTATIONS',
  'EMISSINGATTESTATIONTYPE',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ESOCKETTIMEDOUT',
  'ETARGET',
  'ETIMEDOUT',
]);
const transientTufCodes = new Set([
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
]);

function npmTufCache() {
  const home = homedir() || resolve(tmpdir(), `npm-${process.pid}`);
  const cacheRoot =
    process.platform === 'win32' && process.env.LOCALAPPDATA
      ? process.env.LOCALAPPDATA
      : home;
  const cacheDirectory = process.platform === 'win32' ? 'npm-cache' : '.npm';
  return resolve(cacheRoot, cacheDirectory, '_tuf');
}

function statusCode(error) {
  return Number(
    error?.statusCode ??
      error?.status ??
      error?.response?.statusCode ??
      error?.response?.status,
  );
}

function codedError(code, message) {
  return Object.assign(new Error(message), {code});
}

function exactRegexPattern(value) {
  return `^${value.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`;
}

function errorChain(error) {
  const chain = [];
  const seen = new Set();
  let current = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = current.cause;
  }
  return chain;
}

function errorKind(error) {
  const constructorName = error?.constructor?.name;
  return typeof constructorName === 'string' && constructorName !== 'Error'
    ? constructorName
    : String(error?.name ?? '');
}

function fatalTufMetadataShape(chain) {
  const fatalKind =
    /(?:BadVersion|DownloadLengthMismatch|EqualVersion|ExpiredMetadata|HashMismatch|RepositoryError|Rollback|Signature|Threshold|UnsignedMetadata|ValueError)/u;
  const fatalText =
    /(?:bad version|expired metadata|hash mismatch|length mismatch|rollback|signature verification|threshold|unsigned metadata)/iu;
  return chain.some(
    error =>
      fatalKind.test(errorKind(error)) || fatalText.test(String(error.message)),
  );
}

function transientTufMetadata(chain) {
  for (const error of chain) {
    const status = statusCode(error);
    if (status === 404 || status === 408 || status === 429) {
      return {code: `E${status}`, statusCode: status};
    }
    if (status >= 500 && status <= 599) {
      return {code: `E${status}`, statusCode: status};
    }
    const code = String(error?.code ?? '').toUpperCase();
    if (transientTufCodes.has(code)) return {code};
  }

  for (const error of chain) {
    if (errorKind(error) !== 'RuntimeError') continue;
    const message = String(error.message ?? '');
    if (
      !/^Unable to load (?:snapshot metadata|targets) error /u.test(message)
    ) {
      continue;
    }
    const code = [...transientTufCodes].find(value =>
      new RegExp(`\\b${value}\\b`, 'u').test(message),
    );
    if (code) return {code};
    if (/\b(?:timed? out|timeout)\b/iu.test(message)) {
      return {code: 'ETIMEDOUT'};
    }
  }
  return null;
}

function isTufErrorShape(chain) {
  return chain.some(error => {
    const code = String(error?.code ?? '').toUpperCase();
    return (
      code.startsWith('TUF_') ||
      /^(?:Download|RuntimeError|TUFError)/u.test(errorKind(error))
    );
  });
}

function translatedTufError(error, {force = false} = {}) {
  const chain = errorChain(error);
  if (!force && !isTufErrorShape(chain)) return error;
  const transient = fatalTufMetadataShape(chain)
    ? null
    : transientTufMetadata(chain);
  const translated = codedError(
    transient?.code ?? 'ETUF',
    transient
      ? 'TUF trust data request failed'
      : 'TUF trust data verification failed',
  );
  translated.classification = transient ? 'retryable' : 'fatal';
  if (transient?.statusCode) {
    translated.statusCode = transient.statusCode;
  }
  return translated;
}

function malformedKeys() {
  return codedError(
    'EMALFORMEDVERIFICATIONKEYS',
    'Registry verification keys were malformed',
  );
}

function malformedAttestation() {
  return codedError(
    'EMALFORMEDATTESTATION',
    'Registry attestation bundle was malformed',
  );
}

function publicKeyPem(rawBytes) {
  return `-----BEGIN PUBLIC KEY-----\n${rawBytes}\n-----END PUBLIC KEY-----`;
}

function validatedPublicKeyPem(rawBytes) {
  if (typeof rawBytes !== 'string' || rawBytes.length === 0) {
    throw malformedKeys();
  }
  const bytes = Buffer.from(rawBytes, 'base64');
  if (
    bytes.length === 0 ||
    bytes.toString('base64').replace(/=+$/u, '') !==
      rawBytes.replace(/=+$/u, '')
  ) {
    throw malformedKeys();
  }
  const pemkey = publicKeyPem(rawBytes);
  try {
    createPublicKey(pemkey);
  } catch {
    throw malformedKeys();
  }
  return pemkey;
}

function normalizeTufKeys(target) {
  let body;
  try {
    body = JSON.parse(target);
  } catch {
    throw malformedKeys();
  }
  if (!Array.isArray(body?.keys) || body.keys.length === 0) {
    throw malformedKeys();
  }

  return body.keys.map(key => {
    const keyid = key?.keyId;
    const rawBytes = key?.publicKey?.rawBytes;
    if (
      typeof keyid !== 'string' ||
      keyid.length === 0 ||
      typeof rawBytes !== 'string'
    ) {
      throw malformedKeys();
    }
    return {
      expires: key.publicKey?.validFor?.end || null,
      keyid,
      pemkey: validatedPublicKeyPem(rawBytes),
    };
  });
}

function normalizeFallbackKeys(body) {
  if (!Array.isArray(body?.keys) || body.keys.length === 0) {
    throw malformedKeys();
  }

  return body.keys.map(key => {
    if (
      typeof key?.keyid !== 'string' ||
      key.keyid.length === 0 ||
      typeof key?.key !== 'string'
    ) {
      throw malformedKeys();
    }
    return {
      expires: key.expires ?? null,
      keyid: key.keyid,
      pemkey: validatedPublicKeyPem(key.key),
    };
  });
}

async function defaultFetchJson(url, {signal} = {}) {
  const response = await fetch(url, {
    headers: {accept: 'application/json'},
    signal,
  });
  if (!response.ok) {
    throw Object.assign(new Error('Registry verification key request failed'), {
      code: `E${response.status}`,
      statusCode: response.status,
    });
  }
  return response.json();
}

function isAbortError(error) {
  return (
    String(error?.code ?? '').toUpperCase() === 'ABORT_ERR' ||
    error?.name === 'AbortError'
  );
}

export function classifyProvenanceError(error) {
  const code = String(error?.code ?? '').toUpperCase();
  const status = statusCode(error);
  if (fatalCodes.has(code) || error?.name === 'VerificationError') {
    return 'fatal';
  }
  if (isAbortError(error)) return 'retryable';
  if (
    retryableCodes.has(code) ||
    status === 404 ||
    status === 429 ||
    (status >= 500 && status <= 599)
  ) {
    return 'retryable';
  }
  return 'fatal';
}

function sanitizedProvenanceError(error) {
  const classification = classifyProvenanceError(error);
  if (classification === 'retryable' && isAbortError(error)) {
    const sanitized = new Error('Npm provenance evidence request aborted');
    sanitized.code = 'ABORT_ERR';
    sanitized.classification = 'retryable';
    sanitized.name = 'AbortError';
    return sanitized;
  }

  const sanitized = new Error('Npm provenance evidence verification failed');
  const code = String(error?.code ?? '').toUpperCase();
  const status = statusCode(error);
  if (/^[A-Z][A-Z0-9_]+$/u.test(code)) sanitized.code = code;
  if (Number.isInteger(status) && status >= 100 && status <= 599) {
    sanitized.statusCode = status;
  }
  sanitized.classification = classification;
  if (error?.name === 'VerificationError') {
    sanitized.name = 'VerificationError';
  }
  return sanitized;
}

export async function loadNpmVerificationKeys({
  fetchJson,
  initTUF,
  registry,
  signal,
  timeout,
  tufCache,
}) {
  const {host, pathname} = new URL(registry);
  const targetName = `${host}${pathname.replace(/\/$/u, '')}/keys.json`;
  const tufOptions = {cachePath: tufCache};
  if (Number.isFinite(timeout) && timeout > 0) tufOptions.timeout = timeout;
  let tuf;
  try {
    tuf = await initTUF(tufOptions);
  } catch (error) {
    throw translatedTufError(error, {force: true});
  }
  let target;
  let targetMissing = false;
  try {
    target = await tuf.getTarget(targetName);
  } catch (error) {
    if (error?.code !== 'TUF_FIND_TARGET_ERROR') {
      throw translatedTufError(error, {force: true});
    }
    targetMissing = true;
  }

  if (!targetMissing) return normalizeTufKeys(target);

  const keysUrl = new URL('/-/npm/v1/keys', registry).href;
  return normalizeFallbackKeys(
    await fetchJson(keysUrl, ...(signal ? [{signal}] : [])),
  );
}

function decodeStatement(payload) {
  if (typeof payload !== 'string' || payload.length === 0) {
    throw malformedAttestation();
  }
  let bytes;
  try {
    bytes = Buffer.from(payload, 'base64');
  } catch {
    throw malformedAttestation();
  }
  const canonicalPayload = bytes.toString('base64').replace(/=+$/u, '');
  if (bytes.length === 0 || canonicalPayload !== payload.replace(/=+$/u, '')) {
    throw malformedAttestation();
  }
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw malformedAttestation();
  }
}

function transparencyLogId(entry) {
  if (typeof entry?.logId?.keyId === 'string' && entry.logId.keyId.length > 0) {
    return entry.logId.keyId;
  }
  const logIndex = entry?.logIndex;
  if (
    !(
      (typeof logIndex === 'string' && /^(?:0|[1-9]\d*)$/u.test(logIndex)) ||
      (Number.isSafeInteger(logIndex) && logIndex >= 0)
    )
  ) {
    throw malformedAttestation();
  }
  return BigInt(logIndex).toString();
}

export function normalizeAttestationBundle(item) {
  const {bundle, predicateType} = item ?? {};
  if (
    typeof predicateType !== 'string' ||
    predicateType.length === 0 ||
    !bundle ||
    typeof bundle !== 'object'
  ) {
    throw malformedAttestation();
  }
  const statement = decodeStatement(bundle.dsseEnvelope?.payload);
  const subject = statement?.subject?.[0];
  const expectedStatementType = statementTypeByPredicate.get(predicateType);
  if (
    expectedStatementType === undefined ||
    statement?._type !== expectedStatementType ||
    statement?.predicateType !== predicateType ||
    typeof subject?.name !== 'string' ||
    typeof subject?.digest?.sha512 !== 'string' ||
    !/^[0-9a-f]{128}$/u.test(subject.digest.sha512)
  ) {
    throw malformedAttestation();
  }
  const tlogEntries = bundle.verificationMaterial?.tlogEntries;
  if (!Array.isArray(tlogEntries) || tlogEntries.length === 0) {
    throw malformedAttestation();
  }

  const buildDefinition = statement.predicate?.buildDefinition;
  const workflow = buildDefinition?.externalParameters?.workflow;
  const expectedSourceUri = `git+${githubRepository}@${workflow?.ref}`;
  const sourceDependencies = Array.isArray(
    buildDefinition?.resolvedDependencies,
  )
    ? buildDefinition.resolvedDependencies.filter(
        dependency =>
          dependency?.uri === expectedSourceUri &&
          typeof dependency?.digest?.gitCommit === 'string',
      )
    : [];
  const sourceDependency =
    sourceDependencies.length === 1 ? sourceDependencies[0] : undefined;
  const builderId = statement.predicate?.runDetails?.builder?.id;

  return {
    buildType:
      buildDefinition?.buildType === provenanceBuildType
        ? provenanceBuildType
        : undefined,
    bundleDigest: `sha256-${createHash('sha256')
      .update(JSON.stringify(bundle))
      .digest('hex')}`,
    predicateType,
    repository: workflow?.repository,
    runnerEnvironment:
      builderId === githubHostedBuilderIdentity ? 'github-hosted' : undefined,
    sourceCommit: sourceDependency?.digest?.gitCommit,
    sourceRef: workflow?.ref,
    subjectName: subject.name,
    subjectSha512: subject.digest.sha512,
    transparencyLogIds: tlogEntries.map(transparencyLogId),
    workflowPath: workflow?.path,
  };
}

function expectedSubjectName({name, version}) {
  if (typeof name !== 'string' || typeof version !== 'string') return null;
  if (name.startsWith('@')) {
    const [scope, packageName, ...rest] = name.split('/');
    if (!scope || !packageName || rest.length > 0) return null;
    return `pkg:npm/${encodeURIComponent(scope)}/${encodeURIComponent(
      packageName,
    )}@${encodeURIComponent(version)}`;
  }
  return `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`;
}

function expectedIntegrityHex(integrity) {
  if (typeof integrity !== 'string' || !integrity.startsWith('sha512-')) {
    return null;
  }
  const encoded = integrity.slice('sha512-'.length);
  const bytes = Buffer.from(encoded, 'base64');
  if (
    bytes.length !== 64 ||
    bytes.toString('base64').replace(/=+$/u, '') !== encoded.replace(/=+$/u, '')
  ) {
    return null;
  }
  return bytes.toString('hex');
}

function requireExactMetadata(entry, metadata) {
  if (
    metadata?.name !== entry?.name ||
    metadata?.version !== entry?.version ||
    metadata?._integrity !== entry?.integrity ||
    expectedIntegrityHex(entry?.integrity) === null
  ) {
    throw codedError(
      'EINTEGRITY',
      'Registry metadata did not match the exact release ledger entry',
    );
  }
}

function requireAttestationSubject(entry, normalized) {
  if (
    normalized.subjectName !== expectedSubjectName(entry) ||
    normalized.subjectSha512 !== expectedIntegrityHex(entry.integrity)
  ) {
    throw codedError(
      'EATTESTATIONSUBJECT',
      'Attestation subject did not match the exact release ledger entry',
    );
  }
}

function requireExpectedProvenanceClaims({
  normalized,
  releaseTag,
  sourceCommit,
}) {
  const expectedSourceRef = `refs/tags/${releaseTag}`;
  if (
    normalized.buildType !== provenanceBuildType ||
    normalized.repository !== githubRepository ||
    normalized.workflowPath !== githubWorkflowPath ||
    normalized.sourceRef !== expectedSourceRef ||
    normalized.sourceCommit !== sourceCommit ||
    normalized.runnerEnvironment !== 'github-hosted' ||
    !Array.isArray(normalized.transparencyLogIds) ||
    normalized.transparencyLogIds.length === 0
  ) {
    throw codedError(
      'EPROVENANCECLAIM',
      'Provenance claims did not match the expected release identity',
    );
  }
}

function oneRequiredBundle(bundles, predicateType) {
  const matches = bundles.filter(item => item?.predicateType === predicateType);
  if (matches.length === 0) {
    throw codedError(
      'EMISSINGATTESTATIONTYPE',
      'Registry metadata omitted a required attestation type',
    );
  }
  if (matches.length !== 1) throw malformedAttestation();
  return matches[0];
}

function attestationKeyId(item) {
  const signatures = item?.bundle?.dsseEnvelope?.signatures;
  if (
    !Array.isArray(signatures) ||
    signatures.length !== 1 ||
    typeof signatures[0]?.keyid !== 'string'
  ) {
    throw malformedAttestation();
  }
  return signatures[0].keyid;
}

function requireExpectedAttestationKeying(provenanceItem, publishItem) {
  const provenanceKeyId = attestationKeyId(provenanceItem);
  const publishKeyId = attestationKeyId(publishItem);
  if (provenanceKeyId !== '' || publishKeyId.trim().length === 0) {
    throw codedError(
      'EATTESTATIONKEY',
      'Attestation signing method did not match the required npm policy',
    );
  }
}

function requireExpectedCertificateOids(signer) {
  const signerOids = signer?.identity?.oids;
  if (!Array.isArray(signerOids)) {
    throw codedError(
      'EATTESTATIONVERIFY',
      'Verified signer did not match the required certificate OIDs',
    );
  }

  for (const requiredOid of requiredCertificateOids) {
    const matches = signerOids.filter(
      signerOid =>
        Array.isArray(signerOid?.oid?.id) &&
        signerOid.oid.id.length === requiredOid.id.length &&
        signerOid.oid.id.every(
          (component, index) => component === requiredOid.id[index],
        ),
    );
    if (
      matches.length !== 1 ||
      !Buffer.isBuffer(matches[0].value) ||
      !matches[0].value.equals(requiredOid.value)
    ) {
      throw codedError(
        'EATTESTATIONVERIFY',
        'Verified signer did not match the required certificate OIDs',
      );
    }
  }
}

function certificateVerificationOptions(releaseTag) {
  const sourceRef = `refs/tags/${releaseTag}`;
  const certificateIdentity = `${githubRepository}/${githubWorkflowPath}@${sourceRef}`;
  return {
    certificateIdentityURI: exactRegexPattern(certificateIdentity),
    certificateIssuer: 'https://token.actions.githubusercontent.com',
  };
}

export async function validateAndNormalizeNpmEvidence({
  entry,
  metadata,
  releaseTag,
  sourceCommit,
  verifyBundle,
}) {
  requireExactMetadata(entry, metadata);
  if (!metadata?._attestations) {
    throw codedError(
      'EMISSINGATTESTATIONS',
      'Registry metadata did not yet include attestations',
    );
  }
  const bundles = metadata._attestationBundles;
  if (!Array.isArray(bundles)) {
    throw codedError(
      'EMISSINGATTESTATIONTYPE',
      'Registry metadata did not yet include attestation bundles',
    );
  }

  const provenanceItem = oneRequiredBundle(bundles, provenancePredicateType);
  const publishItem = oneRequiredBundle(bundles, publishPredicateType);
  requireExpectedAttestationKeying(provenanceItem, publishItem);
  const normalizedProvenance = normalizeAttestationBundle(provenanceItem);
  const normalizedPublish = normalizeAttestationBundle(publishItem);
  requireAttestationSubject(entry, normalizedProvenance);
  requireAttestationSubject(entry, normalizedPublish);
  requireExpectedProvenanceClaims({
    normalized: normalizedProvenance,
    releaseTag,
    sourceCommit,
  });

  try {
    const signer = await verifyBundle(provenanceItem.bundle, {
      ...certificateVerificationOptions(releaseTag),
    });
    requireExpectedCertificateOids(signer);
  } catch (error) {
    throw sanitizedProvenanceError(error);
  }

  return {
    integrity: entry.integrity,
    name: entry.name,
    provenance: normalizedProvenance,
    version: entry.version,
  };
}

export async function queryNpmPackageEvidence(
  {entry, releaseTag, signal, sourceCommit},
  {
    fetchJson = defaultFetchJson,
    initTUF = defaultInitTUF,
    manifest = pacote.manifest,
    registry = defaultRegistry,
    tufCache = npmTufCache(),
    verificationKeys: preparedVerificationKeys,
    verifyBundle = sigstore.verify,
  } = {},
) {
  try {
    const verificationKeys =
      preparedVerificationKeys ??
      (await loadNpmVerificationKeys({
        fetchJson,
        initTUF,
        registry,
        signal,
        tufCache,
      }));
    const metadata = await manifest(`${entry.name}@${entry.version}`, {
      '//registry.npmjs.org/:_keys': verificationKeys,
      before: null,
      fullMetadata: true,
      integrity: entry.integrity,
      registry,
      signal,
      tufCache,
      verifyAttestations: true,
    });
    return await validateAndNormalizeNpmEvidence({
      entry,
      metadata,
      releaseTag,
      sourceCommit,
      verifyBundle,
    });
  } catch (error) {
    throw sanitizedProvenanceError(translatedTufError(error));
  }
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = codedError(
    'ABORT_ERR',
    'Npm provenance evidence preparation aborted',
  );
  error.name = 'AbortError';
  throw error;
}

function remainingPreparationTimeout({deadlineAt, now, timeoutMs}) {
  const remainingMs = Math.min(timeoutMs, deadlineAt - now());
  if (Number.isFinite(remainingMs) && remainingMs > 0) return remainingMs;
  const error = codedError(
    'ETIMEDOUT',
    'Npm provenance evidence preparation timed out',
  );
  error.classification = 'retryable';
  error.name = 'TimeoutError';
  throw error;
}

export async function prepareNpmPackageEvidenceQuery(
  {deadlineAt, releaseTag, signal, sourceCommit, timeoutMs},
  {
    createVerifier = sigstore.createVerifier,
    fetchJson = defaultFetchJson,
    initTUF = defaultInitTUF,
    manifest = pacote.manifest,
    now = Date.now,
    registry = defaultRegistry,
    tufCache = npmTufCache(),
  } = {},
) {
  try {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError('Preparation timeout must be a positive number');
    }
    if (typeof now !== 'function') {
      throw new TypeError('Preparation clock must be a function');
    }
    const preparationDeadline = Number.isFinite(deadlineAt)
      ? deadlineAt
      : now() + timeoutMs;
    throwIfAborted(signal);
    const keyTimeout = remainingPreparationTimeout({
      deadlineAt: preparationDeadline,
      now,
      timeoutMs,
    });
    const verificationKeys = await loadNpmVerificationKeys({
      fetchJson,
      initTUF,
      registry,
      signal,
      timeout: keyTimeout,
      tufCache,
    });
    throwIfAborted(signal);
    const verifierTimeout = remainingPreparationTimeout({
      deadlineAt: preparationDeadline,
      now,
      timeoutMs,
    });
    const verifier = await createVerifier({
      ...certificateVerificationOptions(releaseTag),
      timeout: verifierTimeout,
      tufCachePath: tufCache,
    });
    throwIfAborted(signal);
    remainingPreparationTimeout({
      deadlineAt: preparationDeadline,
      now,
      timeoutMs,
    });
    if (typeof verifier?.verify !== 'function') {
      throw codedError(
        'EATTESTATIONVERIFY',
        'Sigstore verifier preparation returned an invalid verifier',
      );
    }

    return (entry, {signal: querySignal}) =>
      queryNpmPackageEvidence(
        {
          entry,
          releaseTag,
          signal: querySignal,
          sourceCommit,
        },
        {
          manifest,
          registry,
          tufCache,
          verificationKeys,
          verifyBundle: bundle => verifier.verify(bundle),
        },
      );
  } catch (error) {
    throw sanitizedProvenanceError(translatedTufError(error));
  }
}
