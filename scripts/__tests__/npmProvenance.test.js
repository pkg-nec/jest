/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const npmProvenanceModuleUrl = pathToFileURL(
  join(process.cwd(), 'scripts/pkgNec/npmProvenance.mjs'),
).href;
const sigstorePolicyModuleUrl = pathToFileURL(
  join(process.cwd(), 'node_modules/@sigstore/verify/dist/policy.js'),
).href;

const certificateIdentity =
  'https://github.com/pkg-nec/jest/.github/workflows/release.yml@refs/tags/@pkg-nec/a-v1.2.3';
const certificateIdentityPattern =
  '^https://github\\.com/pkg-nec/jest/\\.github/workflows/release\\.yml@refs/tags/@pkg-nec/a-v1\\.2\\.3$';
const expectedIntegrity =
  'sha512-Hd8KszarD9yGomGtdBM9na1YYvRGKjdjIW23y0AWf5LZY1b43Y8SLgqfnGBYCFtk8tscEGuT2HbOM6yOoIHIPQ==';
const expectedSha512Hex =
  '1ddf0ab336ab0fdc86a261ad74133d9dad5862f4462a3763216db7cb40167f92d96356f8dd8f122e0a9f9c6058085b64f2db1c106b93d876ce33ac8ea081c83d';
const packagePurl = 'pkg:npm/%40pkg-nec/a@1.2.3';
const provenancePredicateType = 'https://slsa.dev/provenance/v1';
const publishPredicateType =
  'https://github.com/npm/attestation/tree/main/specs/publish/v0.1';
const releaseTag = '@pkg-nec/a-v1.2.3';
const sourceCommit = 'a'.repeat(40);
const sourceRef = 'refs/tags/@pkg-nec/a-v1.2.3';
const registryPublicKey =
  'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE+g7QmezB0LUTp3uXYuFUJuPaNES+sX6J7L5nTNdZUeTAV27M82U/dYxfsNMblTOD9iB7SbhA/aSW6NdE2Q1aJA==';
const registryPublicKeyPem = `-----BEGIN PUBLIC KEY-----\n${registryPublicKey}\n-----END PUBLIC KEY-----`;

function runNpmProvenanceProgram(program, input = {}) {
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
        import * as provenanceApi from ${JSON.stringify(npmProvenanceModuleUrl)};
        const input = ${JSON.stringify(input)};
        const errorDetails = error => ({
          code: error?.code,
          name: error?.name,
          response: error?.response,
          status: error?.status,
          statusCode: error?.statusCode,
        });
        const attempt = async operation => {
          try {
            return {result: await operation()};
          } catch (error) {
            return {error: errorDetails(error)};
          }
        };
        const makeError = value => Object.assign(
          new Error(value?.message ?? 'fixture error'),
          value,
        );
        const output = value => console.log(JSON.stringify(value));
        ${program}
      `,
    ],
    {cwd: process.cwd(), encoding: 'utf8'},
  );

  if (child.status !== 0) {
    throw new Error(child.stderr || child.stdout);
  }
  return JSON.parse(child.stdout.trim());
}

function makeStatement({predicate, predicateType, statementType}) {
  return {
    _type: statementType ?? 'https://in-toto.io/Statement/v1',
    predicate,
    predicateType,
    subject: [
      {
        digest: {sha512: expectedSha512Hex},
        name: packagePurl,
      },
    ],
  };
}

function makeProvenanceStatement() {
  return makeStatement({
    predicate: {
      buildDefinition: {
        buildType:
          'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1',
        externalParameters: {
          workflow: {
            path: '.github/workflows/release.yml',
            ref: sourceRef,
            repository: 'https://github.com/pkg-nec/jest',
          },
        },
        internalParameters: {
          github: {
            eventName: 'push',
            repositoryId: '123456789',
          },
        },
        resolvedDependencies: [
          {
            digest: {gitCommit: sourceCommit},
            uri: `git+https://github.com/pkg-nec/jest@${sourceRef}`,
          },
        ],
      },
      runDetails: {
        builder: {id: 'https://github.com/actions/runner/github-hosted'},
        metadata: {
          invocationId:
            'https://github.com/pkg-nec/jest/actions/runs/123/attempts/1',
        },
      },
    },
    predicateType: provenancePredicateType,
  });
}

function makePublishStatement() {
  return makeStatement({
    predicate: {
      name: '@pkg-nec/a',
      registry: 'https://registry.npmjs.org',
      version: '1.2.3',
    },
    predicateType: publishPredicateType,
    statementType: 'https://in-toto.io/Statement/v0.1',
  });
}

function makeBundle(statement, {keyid = '', logId = 'rekor-entry-1'} = {}) {
  return {
    dsseEnvelope: {
      payload: Buffer.from(JSON.stringify(statement)).toString('base64'),
      payloadType: 'application/vnd.in-toto+json',
      signatures: [{keyid, sig: 'test-signature'}],
    },
    mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
    verificationMaterial: {
      certificate: {rawBytes: 'test-certificate-bytes'},
      tlogEntries: [
        {
          canonicalizedBody: 'test-canonicalized-body',
          integratedTime: '1723456789',
          logId: logId === null ? undefined : {keyId: logId},
          logIndex: '42',
        },
      ],
    },
  };
}

function makeFixture() {
  const provenanceBundle = makeBundle(makeProvenanceStatement());
  const publishBundle = makeBundle(makePublishStatement(), {
    keyid: 'registry-key-1',
    logId: 'rekor-entry-2',
  });

  return {
    entry: {
      integrity: expectedIntegrity,
      name: '@pkg-nec/a',
      version: '1.2.3',
    },
    metadata: {
      _attestationBundles: [
        {bundle: provenanceBundle, predicateType: provenancePredicateType},
        {bundle: publishBundle, predicateType: publishPredicateType},
      ],
      _attestations: {
        provenance: {predicateType: provenancePredicateType},
        url: 'https://registry.npmjs.org/-/npm/v1/attestations/%40pkg-nec%2fa@1.2.3',
      },
      _integrity: expectedIntegrity,
      dist: {
        integrity: expectedIntegrity,
        tarball: 'https://registry.npmjs.org/@pkg-nec/a/-/a-1.2.3.tgz',
      },
      name: '@pkg-nec/a',
      version: '1.2.3',
    },
    provenanceBundle,
  };
}

const tufTarget = JSON.stringify({
  keys: [
    {
      keyId: 'registry-key-1',
      publicKey: {
        rawBytes: registryPublicKey,
        validFor: {
          end: '2035-01-01T00:00:00Z',
          start: '2025-01-01T00:00:00Z',
        },
      },
    },
  ],
});
const verificationKeys = [
  {
    expires: '2035-01-01T00:00:00Z',
    keyid: 'registry-key-1',
    pemkey: registryPublicKeyPem,
  },
];

function runValidation(metadata, verifyError, entry = makeFixture().entry) {
  return runNpmProvenanceProgram(
    `
      const selectedBundle = input.metadata._attestationBundles?.find(
        item => item.predicateType === ${JSON.stringify(provenancePredicateType)},
      )?.bundle;
      const verifyCalls = [];
      const outcome = await attempt(() =>
        provenanceApi.validateAndNormalizeNpmEvidence({
          entry: input.entry,
          metadata: input.metadata,
          releaseTag: input.releaseTag,
          sourceCommit: input.sourceCommit,
          verifyBundle: async (bundle, options) => {
            verifyCalls.push({sameBundle: bundle === selectedBundle, options});
            if (input.verifyError) throw makeError(input.verifyError);
          },
        }),
      );
      output({outcome, verifyCalls});
    `,
    {
      entry,
      metadata,
      releaseTag,
      sourceCommit,
      verifyError,
    },
  );
}

function classifySerializedError(error) {
  return runNpmProvenanceProgram(
    'output(provenanceApi.classifyProvenanceError(input.error));',
    {error},
  );
}

describe('npm verification key loading', () => {
  // Mutation: use the wrong TUF target/options or leak rawBytes in returned keys.
  test('loads and minimizes registry keys from the npm TUF target', () => {
    const {calls, result} = runNpmProvenanceProgram(
      `
        const calls = {fetchJson: [], getTarget: [], initTUF: []};
        const result = await provenanceApi.loadNpmVerificationKeys({
          fetchJson: async (...args) => {
            calls.fetchJson.push(args);
            throw new Error('fallback must not run');
          },
          initTUF: async options => {
            calls.initTUF.push(options);
            return {
              getTarget: async target => {
                calls.getTarget.push(target);
                return input.target;
              },
            };
          },
          registry: 'https://registry.npmjs.org/',
          tufCache: 'C:/npm-cache/_tuf',
        });
        output({calls, result});
      `,
      {target: tufTarget},
    );

    expect(calls).toEqual({
      fetchJson: [],
      getTarget: ['registry.npmjs.org/keys.json'],
      initTUF: [{cachePath: 'C:/npm-cache/_tuf'}],
    });
    expect(result).toEqual(verificationKeys);
    expect(JSON.stringify(result)).not.toContain('rawBytes');
  });

  // Mutation: fall back for the wrong TUF error or call a noncanonical endpoint.
  test('falls back only when the TUF target is absent', () => {
    const fallbackBody = {
      keys: [
        {
          expires: null,
          key: registryPublicKey,
          keyid: 'registry-key-fallback',
        },
      ],
    };
    const {calls, result} = runNpmProvenanceProgram(
      `
        const calls = {fetchJson: []};
        const result = await provenanceApi.loadNpmVerificationKeys({
          fetchJson: async (...args) => {
            calls.fetchJson.push(args);
            return input.fallbackBody;
          },
          initTUF: async () => ({
            getTarget: async () => {
              throw makeError({code: 'TUF_FIND_TARGET_ERROR'});
            },
          }),
          registry: 'https://registry.npmjs.org/',
          tufCache: 'C:/npm-cache/_tuf',
        });
        output({calls, result});
      `,
      {fallbackBody},
    );

    expect(calls.fetchJson).toEqual([
      ['https://registry.npmjs.org/-/npm/v1/keys'],
    ]);
    expect(result).toEqual([
      {
        expires: null,
        keyid: 'registry-key-fallback',
        pemkey: registryPublicKeyPem,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('"key"');
  });

  // Mutation: omit the shared preparation timeout from TUF or fail to forward
  // the shared cancellation signal to the registry fallback fetch.
  test('bounds TUF and fallback key loading by the shared preparation scope', () => {
    const result = runNpmProvenanceProgram(
      `
        const calls = {fetchJson: [], initTUF: []};
        const signal = new AbortController().signal;
        const keys = await provenanceApi.loadNpmVerificationKeys({
          fetchJson: async (url, options) => {
            calls.fetchJson.push({
              sameSignal: options?.signal === signal,
              url,
            });
            return input.fallbackBody;
          },
          initTUF: async options => {
            calls.initTUF.push(options);
            return {
              getTarget: async () => {
                throw makeError({code: 'TUF_FIND_TARGET_ERROR'});
              },
            };
          },
          registry: 'https://registry.npmjs.org/',
          signal,
          timeout: 1234,
          tufCache: 'C:/npm-cache/_tuf',
        });
        output({calls, keys});
      `,
      {
        fallbackBody: {
          keys: [
            {
              expires: null,
              key: registryPublicKey,
              keyid: 'registry-key-fallback',
            },
          ],
        },
      },
    );

    expect(result.calls).toEqual({
      fetchJson: [
        {
          sameSignal: true,
          url: 'https://registry.npmjs.org/-/npm/v1/keys',
        },
      ],
      initTUF: [{cachePath: 'C:/npm-cache/_tuf', timeout: 1234}],
    });
    expect(result.keys).toHaveLength(1);
  });

  // Mutation: silently downgrade to the registry API on any TUF failure.
  test('does not downgrade on transient TUF failures', () => {
    const result = runNpmProvenanceProgram(`
      let fallbackCalls = 0;
      const outcome = await attempt(() =>
        provenanceApi.loadNpmVerificationKeys({
          fetchJson: async () => {
            fallbackCalls += 1;
          },
          initTUF: async () => ({
            getTarget: async () => {
              throw makeError({code: 'ETIMEDOUT'});
            },
          }),
          registry: 'https://registry.npmjs.org/',
          tufCache: 'C:/npm-cache/_tuf',
        }),
      );
      output({fallbackCalls, outcome});
    `);

    expect(result).toEqual({
      fallbackCalls: 0,
      outcome: {error: expect.objectContaining({code: 'ETIMEDOUT'})},
    });
  });

  // Mutation: treat an undefined TUF target as target absence and silently
  // downgrade to the registry endpoint.
  test('rejects an undefined TUF target without fetching fallback keys', () => {
    const result = runNpmProvenanceProgram(
      `
        let fallbackCalls = 0;
        const outcome = await attempt(() =>
          provenanceApi.loadNpmVerificationKeys({
            fetchJson: async () => {
              fallbackCalls += 1;
              return input.fallbackBody;
            },
            initTUF: async () => ({getTarget: async () => undefined}),
            registry: 'https://registry.npmjs.org/',
            tufCache: 'C:/npm-cache/_tuf',
          }),
        );
        output({
          classification: provenanceApi.classifyProvenanceError(outcome.error),
          fallbackCalls,
          outcome,
        });
      `,
      {
        fallbackBody: {
          keys: [
            {
              expires: null,
              key: registryPublicKey,
              keyid: 'registry-key-fallback',
            },
          ],
        },
      },
    );

    expect(result).toEqual({
      classification: 'fatal',
      fallbackCalls: 0,
      outcome: {
        error: expect.objectContaining({code: 'EMALFORMEDVERIFICATIONKEYS'}),
      },
    });
  });

  // Mutation: accept empty, malformed, or incomplete TUF verification keys.
  test.each([
    ['invalid JSON', '{not-json'],
    ['missing keys', '{}'],
    ['empty keys', '{"keys":[]}'],
    [
      'missing raw bytes',
      '{"keys":[{"keyId":"registry-key-1","publicKey":{"validFor":{"end":null}}}]}',
    ],
    [
      'unparseable public key bytes',
      '{"keys":[{"keyId":"registry-key-1","publicKey":{"rawBytes":"cmVnaXN0cnkta2V5"}}]}',
    ],
  ])('rejects %s from the TUF target as fatal', (_label, target) => {
    const result = runNpmProvenanceProgram(
      `
        const outcome = await attempt(() =>
          provenanceApi.loadNpmVerificationKeys({
            fetchJson: async () => ({}),
            initTUF: async () => ({getTarget: async () => input.target}),
            registry: 'https://registry.npmjs.org/',
            tufCache: 'C:/npm-cache/_tuf',
          }),
        );
        const classification = outcome.error
          ? provenanceApi.classifyProvenanceError(outcome.error)
          : null;
        output({classification, outcome});
      `,
      {target},
    );

    expect(result).toEqual({
      classification: 'fatal',
      outcome: {
        error: expect.objectContaining({code: 'EMALFORMEDVERIFICATIONKEYS'}),
      },
    });
  });

  // Mutation: accept empty or incomplete fallback verification keys.
  test.each([
    ['missing keys', {}],
    ['empty keys', {keys: []}],
    ['missing key material', {keys: [{keyid: 'registry-key-1'}]}],
    [
      'unparseable public key material',
      {keys: [{key: 'cmVnaXN0cnkta2V5', keyid: 'registry-key-1'}]},
    ],
  ])('rejects %s from the registry fallback as fatal', (_label, body) => {
    const result = runNpmProvenanceProgram(
      `
        const outcome = await attempt(() =>
          provenanceApi.loadNpmVerificationKeys({
            fetchJson: async () => input.body,
            initTUF: async () => ({
              getTarget: async () => {
                throw makeError({code: 'TUF_FIND_TARGET_ERROR'});
              },
            }),
            registry: 'https://registry.npmjs.org/',
            tufCache: 'C:/npm-cache/_tuf',
          }),
        );
        const classification = outcome.error
          ? provenanceApi.classifyProvenanceError(outcome.error)
          : null;
        output({classification, outcome});
      `,
      {body},
    );

    expect(result).toEqual({
      classification: 'fatal',
      outcome: {
        error: expect.objectContaining({code: 'EMALFORMEDVERIFICATIONKEYS'}),
      },
    });
  });

  // Mutation: relabel a transient registry key-fetch failure as fatal.
  test.each(['EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', 'E429'])(
    'preserves transient fallback failure %s as retryable',
    code => {
      const result = runNpmProvenanceProgram(
        `
          const outcome = await attempt(() =>
            provenanceApi.loadNpmVerificationKeys({
              fetchJson: async () => { throw makeError({code: input.code}); },
              initTUF: async () => ({
                getTarget: async () => {
                  throw makeError({code: 'TUF_FIND_TARGET_ERROR'});
                },
              }),
              registry: 'https://registry.npmjs.org/',
              tufCache: 'C:/npm-cache/_tuf',
            }),
          );
          output({
            classification: provenanceApi.classifyProvenanceError(outcome.error),
            outcome,
          });
        `,
        {code},
      );

      expect(result).toEqual({
        classification: 'retryable',
        outcome: {error: expect.objectContaining({code})},
      });
    },
  );

  // Mutation: inspect only the outer @sigstore/tuf wrapper and miss the real
  // retryable HTTP/network metadata carried by TUF_DOWNLOAD_TARGET_ERROR.cause.
  test('translates realistic nested TUF target failures to safe retry metadata', () => {
    const result = runNpmProvenanceProgram(`
      const {TUFError} = await import('@sigstore/tuf');
      const {DownloadHTTPError} = await import('tuf-js/dist/error.js');
      const unsafe = 'https://publisher:npm-secret@tuf.invalid/target';
      const causes = [
        new DownloadHTTPError(unsafe, 404),
        new DownloadHTTPError(unsafe, 408),
        new DownloadHTTPError(unsafe, 429),
        new DownloadHTTPError(unsafe, 503),
        Object.assign(new Error(unsafe), {code: 'ECONNRESET'}),
        Object.assign(new Error(unsafe), {code: 'ENOTFOUND'}),
      ];
      const outcomes = [];
      for (const cause of causes) {
        const upstream = new TUFError({
          cause,
          code: 'TUF_DOWNLOAD_TARGET_ERROR',
          message: unsafe,
        });
        try {
          await provenanceApi.loadNpmVerificationKeys({
            fetchJson: async () => { throw new Error('fallback must not run'); },
            initTUF: async () => ({
              getTarget: async () => { throw upstream; },
            }),
            registry: 'https://registry.npmjs.org/',
            tufCache: 'C:/npm-cache/_tuf',
          });
        } catch (error) {
          outcomes.push({
            classification: provenanceApi.classifyProvenanceError(error),
            code: error.code,
            keys: Object.keys(error).sort(),
            message: error.message,
            serialized: JSON.stringify(error),
            statusCode: error.statusCode,
          });
        }
      }
      output(outcomes);
    `);

    expect(result.map(item => item.classification)).toEqual([
      'retryable',
      'retryable',
      'retryable',
      'retryable',
      'retryable',
      'retryable',
    ]);
    expect(result.map(item => item.statusCode ?? null)).toEqual([
      404,
      408,
      429,
      503,
      null,
      null,
    ]);
    expect(result.map(item => item.code)).toEqual([
      'E404',
      'E408',
      'E429',
      'E503',
      'ECONNRESET',
      'ENOTFOUND',
    ]);
    for (const error of result) {
      expect(error.keys).toEqual(
        error.statusCode
          ? ['classification', 'code', 'statusCode']
          : ['classification', 'code'],
      );
      expect(error.message).toBe('TUF trust data request failed');
      expect(error.serialized).not.toContain('npm-secret');
      expect(error.serialized).not.toContain('tuf.invalid');
      expect(error.serialized).not.toContain('cause');
    }
  });

  // Mutation: treat code-less tuf-js snapshot/targets RuntimeErrors as fatal
  // even when their exact flattened download text contains a network timeout.
  test('translates flattened TUF metadata network failures without leaking text', () => {
    const result = runNpmProvenanceProgram(`
      const {RuntimeError} = await import('tuf-js/dist/error.js');
      const messages = [
        'Unable to load snapshot metadata error FetchError: request to https://publisher:npm-secret@tuf.invalid/snapshot.json failed, reason: connect ETIMEDOUT',
        'Unable to load targets error FetchError: request to https://publisher:npm-secret@tuf.invalid/targets.json failed, reason: getaddrinfo EAI_AGAIN',
        'Unable to load targets error Error: network timeout at https://publisher:npm-secret@tuf.invalid/targets.json',
      ];
      const outcomes = [];
      for (const message of messages) {
        try {
          await provenanceApi.loadNpmVerificationKeys({
            fetchJson: async () => { throw new Error('fallback must not run'); },
            initTUF: async () => { throw new RuntimeError(message); },
            registry: 'https://registry.npmjs.org/',
            tufCache: 'C:/npm-cache/_tuf',
          });
        } catch (error) {
          outcomes.push({
            classification: provenanceApi.classifyProvenanceError(error),
            code: error.code,
            keys: Object.keys(error).sort(),
            message: error.message,
            serialized: JSON.stringify(error),
          });
        }
      }
      output(outcomes);
    `);

    expect(result.map(item => item.classification)).toEqual([
      'retryable',
      'retryable',
      'retryable',
    ]);
    expect(result.map(item => item.code)).toEqual([
      'ETIMEDOUT',
      'EAI_AGAIN',
      'ETIMEDOUT',
    ]);
    for (const error of result) {
      expect(error.keys).toEqual(['classification', 'code']);
      expect(error.message).toBe('TUF trust data request failed');
      expect(error.serialized).not.toContain('npm-secret');
      expect(error.serialized).not.toContain('tuf.invalid');
    }
  });

  // Mutation: retry a fatal cryptographic/metadata error merely because its
  // nested or flattened text contains a transient-looking status/token.
  test('keeps fatal TUF metadata lookalikes fatal and sanitized', () => {
    const result = runNpmProvenanceProgram(`
      const {
        BadVersionError,
        DownloadLengthMismatchError,
        ExpiredMetadataError,
        RuntimeError,
      } = await import('tuf-js/dist/error.js');
      const unsafe = 'https://publisher:npm-secret@tuf.invalid/metadata';
      const failures = [
        new ExpiredMetadataError('expired metadata after ETIMEDOUT ' + unsafe),
        new BadVersionError('bad version returned with 503 ' + unsafe),
        new DownloadLengthMismatchError('length mismatch after EAI_AGAIN ' + unsafe),
        new RuntimeError(
          'Unable to load snapshot metadata error Error: signature verification failed after timeout ' + unsafe,
        ),
        new RuntimeError(
          'Unable to load targets error DownloadHTTPError: Failed to download ' + unsafe,
        ),
      ];
      const outcomes = [];
      for (const upstream of failures) {
        try {
          await provenanceApi.loadNpmVerificationKeys({
            fetchJson: async () => { throw new Error('fallback must not run'); },
            initTUF: async () => { throw upstream; },
            registry: 'https://registry.npmjs.org/',
            tufCache: 'C:/npm-cache/_tuf',
          });
        } catch (error) {
          outcomes.push({
            classification: provenanceApi.classifyProvenanceError(error),
            keys: Object.keys(error).sort(),
            message: error.message,
            serialized: JSON.stringify(error),
          });
        }
      }
      output(outcomes);
    `);

    expect(result).toHaveLength(5);
    for (const error of result) {
      expect(error.classification).toBe('fatal');
      expect(error.keys).toEqual(['classification', 'code']);
      expect(error.message).toBe('TUF trust data verification failed');
      expect(error.serialized).not.toContain('npm-secret');
      expect(error.serialized).not.toContain('tuf.invalid');
      expect(error.serialized).not.toContain('timeout');
    }
  });
});

describe('npm provenance normalization', () => {
  // Mutation: hash a statement/payload instead of the complete bundle or
  // expose signatures, certificate bytes, bundle bodies, or DSSE payloads.
  test('returns only normalized claims and a complete-bundle digest', () => {
    const {provenanceBundle} = makeFixture();
    const result = runNpmProvenanceProgram(
      'output(provenanceApi.normalizeAttestationBundle(input.item));',
      {
        item: {
          bundle: provenanceBundle,
          predicateType: provenancePredicateType,
        },
      },
    );

    expect(result).toMatchObject({
      buildType:
        'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1',
      bundleDigest:
        'sha256-422c3f55bebd3c0eb283076551d0824baa97c252c0f1179bc85f24a215a59202',
      predicateType: 'https://slsa.dev/provenance/v1',
      repository: 'https://github.com/pkg-nec/jest',
      runnerEnvironment: 'github-hosted',
      sourceCommit: 'a'.repeat(40),
      sourceRef: 'refs/tags/@pkg-nec/a-v1.2.3',
      transparencyLogIds: ['rekor-entry-1'],
      workflowPath: '.github/workflows/release.yml',
    });
    expect(Object.keys(result).sort()).toEqual([
      'buildType',
      'bundleDigest',
      'predicateType',
      'repository',
      'runnerEnvironment',
      'sourceCommit',
      'sourceRef',
      'subjectName',
      'subjectSha512',
      'transparencyLogIds',
      'workflowPath',
    ]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('test-certificate-bytes');
    expect(serialized).not.toContain('test-signature');
    expect(serialized).not.toContain(provenanceBundle.dsseEnvelope.payload);
  });

  // Mutation: discard transparency entries that do not contain a log key ID.
  test('canonicalizes a transparency log index when its key ID is absent', () => {
    const bundle = makeBundle(makeProvenanceStatement(), {logId: null});
    const result = runNpmProvenanceProgram(
      'output(provenanceApi.normalizeAttestationBundle(input.item));',
      {item: {bundle, predicateType: provenancePredicateType}},
    );

    expect(result.transparencyLogIds).toEqual(['42']);
  });

  // Mutation: accept an undecodable or non-JSON DSSE statement.
  test.each(['not-base64!', Buffer.from('{invalid-json').toString('base64')])(
    'rejects a malformed DSSE statement as fatal',
    payload => {
      const bundle = makeBundle(makeProvenanceStatement());
      bundle.dsseEnvelope.payload = payload;
      const result = runNpmProvenanceProgram(
        `
          const outcome = await attempt(() =>
            provenanceApi.normalizeAttestationBundle(input.item),
          );
          output({
            classification: provenanceApi.classifyProvenanceError(outcome.error),
            outcome,
          });
        `,
        {item: {bundle, predicateType: provenancePredicateType}},
      );

      expect(result).toEqual({
        classification: 'fatal',
        outcome: {
          error: expect.objectContaining({code: 'EMALFORMEDATTESTATION'}),
        },
      });
    },
  );

  // Mutation: accept an unknown predicate when its statement omits `_type`.
  test('rejects an unknown predicate with no statement type as fatal', () => {
    const predicateType = 'https://example.invalid/unknown-predicate';
    const statement = makeStatement({predicate: {}, predicateType});
    delete statement._type;
    const bundle = makeBundle(statement);
    const result = runNpmProvenanceProgram(
      `
        const outcome = await attempt(() =>
          provenanceApi.normalizeAttestationBundle(input.item),
        );
        output({
          classification: provenanceApi.classifyProvenanceError(outcome.error),
          outcome,
        });
      `,
      {item: {bundle, predicateType}},
    );

    expect(result).toEqual({
      classification: 'fatal',
      outcome: {
        error: expect.objectContaining({code: 'EMALFORMEDATTESTATION'}),
      },
    });
  });
});

describe('exact npm package provenance query', () => {
  // Mutation: require Statement/v1 for every bundle, rejecting npm's live
  // publish-attestation representation before its exact subject is checked.
  test('accepts npm Statement/v0.1 publish evidence with Statement/v1 provenance', () => {
    const fixture = makeFixture();
    const publishStatement = makePublishStatement();
    publishStatement._type = 'https://in-toto.io/Statement/v0.1';
    fixture.metadata._attestationBundles[1].bundle = makeBundle(
      publishStatement,
      {keyid: 'registry-key-1', logId: 'rekor-entry-2'},
    );

    const {outcome, verifyCalls} = runValidation(fixture.metadata);

    expect(outcome).toEqual({
      result: expect.objectContaining({
        integrity: expectedIntegrity,
        name: '@pkg-nec/a',
        version: '1.2.3',
      }),
    });
    expect(verifyCalls).toHaveLength(1);
  });

  // Mutation: allow either in-toto statement version for either predicate.
  test.each([
    [
      'Statement/v1 publish',
      1,
      makePublishStatement,
      'https://in-toto.io/Statement/v1',
    ],
    [
      'Statement/v0.1 provenance',
      0,
      makeProvenanceStatement,
      'https://in-toto.io/Statement/v0.1',
    ],
  ])(
    'rejects %s as malformed',
    (_label, bundleIndex, makeStatementForPredicate, statementType) => {
      const fixture = makeFixture();
      const statement = makeStatementForPredicate();
      statement._type = statementType;
      fixture.metadata._attestationBundles[bundleIndex].bundle = makeBundle(
        statement,
        bundleIndex === 1
          ? {keyid: 'registry-key-1', logId: 'rekor-entry-2'}
          : undefined,
      );

      const {outcome} = runValidation(fixture.metadata);

      expect(outcome).toEqual({
        error: expect.objectContaining({code: 'EMALFORMEDATTESTATION'}),
      });
      expect(classifySerializedError(outcome.error)).toBe('fatal');
    },
  );

  // Mutation: load npm keys or create Sigstore trust once per package attempt,
  // omit the remaining deadline from either trust API, or fail to reuse the
  // prepared verifier and keys.
  test('prepares npm and Sigstore trust once for all package query attempts', () => {
    const fixture = makeFixture();
    const result = runNpmProvenanceProgram(
      `
        const calls = {
          createVerifier: [],
          getTarget: [],
          initTUF: [],
          manifest: [],
          verify: [],
        };
        const selectedBundle = input.metadata._attestationBundles[0].bundle;
        let current = 1000;
        const preparationSignal = new AbortController().signal;
        const preparedQuery = await provenanceApi.prepareNpmPackageEvidenceQuery(
          {
            deadlineAt: 5321,
            releaseTag: input.releaseTag,
            signal: preparationSignal,
            sourceCommit: input.sourceCommit,
            timeoutMs: 4321,
          },
          {
            createVerifier: async options => {
              calls.createVerifier.push(options);
              return {
                verify: async bundle => {
                  calls.verify.push(bundle === selectedBundle);
                },
              };
            },
            fetchJson: async () => {
              throw new Error('fallback must not run');
            },
            initTUF: async options => {
              calls.initTUF.push(options);
              current += 321;
              return {
                getTarget: async target => {
                  calls.getTarget.push(target);
                  return input.tufTarget;
                },
              };
            },
            manifest: async (specifier, options) => {
              calls.manifest.push({
                keyCount: options['//registry.npmjs.org/:_keys'].length,
                specifier,
                tufCache: options.tufCache,
              });
              return input.metadata;
            },
            now: () => current,
            registry: 'https://registry.npmjs.org/',
            tufCache: 'C:/npm-cache/_tuf',
          },
        );
        const querySignal = new AbortController().signal;
        const first = await preparedQuery(input.entry, {signal: querySignal});
        const second = await preparedQuery(input.entry, {signal: querySignal});
        output({calls, first, second});
      `,
      {
        entry: fixture.entry,
        metadata: fixture.metadata,
        releaseTag,
        sourceCommit,
        tufTarget,
      },
    );

    expect(result.calls.initTUF).toEqual([
      {cachePath: 'C:/npm-cache/_tuf', timeout: 4321},
    ]);
    expect(result.calls.getTarget).toEqual(['registry.npmjs.org/keys.json']);
    expect(result.calls.createVerifier).toEqual([
      {
        certificateIdentityURI: certificateIdentityPattern,
        certificateIssuer: 'https://token.actions.githubusercontent.com',
        certificateOIDs: {
          '1.3.6.1.4.1.57264.1.11': 'github-hosted',
          '1.3.6.1.4.1.57264.1.22': 'public',
        },
        timeout: 4000,
        tufCachePath: 'C:/npm-cache/_tuf',
      },
    ]);
    expect(result.calls.manifest).toEqual([
      {
        keyCount: 1,
        specifier: '@pkg-nec/a@1.2.3',
        tufCache: 'C:/npm-cache/_tuf',
      },
      {
        keyCount: 1,
        specifier: '@pkg-nec/a@1.2.3',
        tufCache: 'C:/npm-cache/_tuf',
      },
    ]);
    expect(result.calls.verify).toEqual([true, true]);
    expect(result.first).toEqual(result.second);
  });

  // Mutation: query a range/tree, omit Pacote verification options, skip the
  // independent Sigstore policy, or expose raw bundle material.
  test('verifies only the exact ledger entry and returns minimized evidence', () => {
    const fixture = makeFixture();
    const {calls, result} = runNpmProvenanceProgram(
      `
        const calls = {manifest: [], verifyBundle: []};
        const signal = new AbortController().signal;
        const selectedBundle = input.metadata._attestationBundles[0].bundle;
        const result = await provenanceApi.queryNpmPackageEvidence(
          {
            entry: input.entry,
            releaseTag: input.releaseTag,
            signal,
            sourceCommit: input.sourceCommit,
          },
          {
            fetchJson: async () => { throw new Error('fallback must not run'); },
            initTUF: async () => ({getTarget: async () => input.tufTarget}),
            manifest: async (specifier, options) => {
              calls.manifest.push({
                options: {...options, signal: options.signal === signal},
                specifier,
              });
              return input.metadata;
            },
            registry: 'https://registry.npmjs.org/',
            tufCache: 'C:/npm-cache/_tuf',
            verifyBundle: async (bundle, options) => {
              calls.verifyBundle.push({
                options,
                sameBundle: bundle === selectedBundle,
              });
            },
          },
        );
        output({calls, result});
      `,
      {
        entry: fixture.entry,
        metadata: fixture.metadata,
        releaseTag,
        sourceCommit,
        tufTarget,
      },
    );

    expect(calls.manifest).toEqual([
      {
        options: {
          '//registry.npmjs.org/:_keys': verificationKeys,
          before: null,
          fullMetadata: true,
          integrity: expectedIntegrity,
          registry: 'https://registry.npmjs.org/',
          signal: true,
          tufCache: 'C:/npm-cache/_tuf',
          verifyAttestations: true,
        },
        specifier: '@pkg-nec/a@1.2.3',
      },
    ]);
    expect(calls.verifyBundle).toEqual([
      {
        options: expect.objectContaining({
          certificateIdentityURI: certificateIdentityPattern,
          certificateIssuer: 'https://token.actions.githubusercontent.com',
          certificateOIDs: {
            '1.3.6.1.4.1.57264.1.11': 'github-hosted',
            '1.3.6.1.4.1.57264.1.22': 'public',
          },
        }),
        sameBundle: true,
      },
    ]);
    expect(calls.verifyBundle[0].options).not.toHaveProperty(
      'certificateIdentity',
    );
    expect(result).toEqual({
      integrity: expectedIntegrity,
      name: '@pkg-nec/a',
      provenance: expect.objectContaining({
        predicateType: provenancePredicateType,
        repository: 'https://github.com/pkg-nec/jest',
        sourceCommit,
        sourceRef,
        workflowPath: '.github/workflows/release.yml',
      }),
      version: '1.2.3',
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('test-certificate-bytes');
    expect(serialized).not.toContain('test-signature');
    expect(serialized).not.toContain(
      fixture.provenanceBundle.dsseEnvelope.payload,
    );
  });

  // Mutation: pass an unescaped or unanchored identity pattern to Sigstore,
  // allowing suffix refs or wildcard substitutions for literal dots.
  test('enforces the exact workflow certificate identity with the pinned policy', () => {
    const fixture = makeFixture();
    const result = runNpmProvenanceProgram(
      `
        const {verifySubjectAlternativeName} = await import(
          ${JSON.stringify(sigstorePolicyModuleUrl)}
        );
        const policyResults = [];
        const outcome = await attempt(() =>
          provenanceApi.validateAndNormalizeNpmEvidence({
            entry: input.entry,
            metadata: input.metadata,
            releaseTag: input.releaseTag,
            sourceCommit: input.sourceCommit,
            verifyBundle: async (_bundle, options) => {
              for (const identity of input.identities) {
                let matched = true;
                try {
                  verifySubjectAlternativeName(
                    options.certificateIdentityURI,
                    identity,
                  );
                } catch {
                  matched = false;
                }
                policyResults.push({identity, matched});
              }
              policyResults.push({
                identityPattern: options.certificateIdentityURI,
                legacyIdentity: options.certificateIdentity,
              });
            },
          }),
        );
        output({outcome, policyResults});
      `,
      {
        entry: fixture.entry,
        identities: [
          certificateIdentity,
          `${certificateIdentity}-suffix`,
          certificateIdentity.replace('github.com', 'githubXcom'),
          certificateIdentity.replace('.github', 'Xgithub'),
        ],
        metadata: fixture.metadata,
        releaseTag,
        sourceCommit,
      },
    );

    expect(result.outcome).toHaveProperty('result');
    expect(result.policyResults).toEqual([
      {identity: certificateIdentity, matched: true},
      {identity: `${certificateIdentity}-suffix`, matched: false},
      {
        identity: certificateIdentity.replace('github.com', 'githubXcom'),
        matched: false,
      },
      {
        identity: certificateIdentity.replace('.github', 'Xgithub'),
        matched: false,
      },
      {
        identityPattern: certificateIdentityPattern,
        legacyIdentity: undefined,
      },
    ]);
  });

  // Mutation: collapse DOM-style or repository-standard cancellation into a
  // generic fatal verification error, or copy unsafe upstream error details.
  test('preserves safe cancellation identity at the query boundary', () => {
    const fixture = makeFixture();
    const result = runNpmProvenanceProgram(
      `
        const upstreamErrors = [
          new DOMException(input.unsafeMessage, 'AbortError'),
          Object.assign(new Error(input.unsafeMessage), {name: 'AbortError'}),
          Object.assign(new Error(input.unsafeMessage), {code: 'ABORT_ERR'}),
        ];
        const caught = [];
        for (const upstreamError of upstreamErrors) {
          Object.assign(upstreamError, input.unsafeProperties);
          Object.defineProperty(upstreamError, 'stack', {
            configurable: true,
            enumerable: true,
            value: input.unsafeStack,
          });
          try {
            await provenanceApi.queryNpmPackageEvidence(
              {
                entry: input.entry,
                releaseTag: input.releaseTag,
                signal: new AbortController().signal,
                sourceCommit: input.sourceCommit,
              },
              {
                fetchJson: async () => { throw new Error('fallback must not run'); },
                initTUF: async () => ({getTarget: async () => input.tufTarget}),
                manifest: async () => { throw upstreamError; },
                registry: 'https://registry.npmjs.org/',
                tufCache: 'C:/npm-cache/_tuf',
                verifyBundle: async () => {},
              },
            );
          } catch (error) {
            caught.push({
              classification: error.classification,
              classified: provenanceApi.classifyProvenanceError(error),
              code: error.code,
              keys: Object.keys(error).sort(),
              message: error.message,
              name: error.name,
              serialized: JSON.stringify(error),
              stack: error.stack,
            });
          }
        }
        output(caught);
      `,
      {
        entry: fixture.entry,
        releaseTag,
        sourceCommit,
        tufTarget,
        unsafeMessage:
          'Abort from https://publisher:npm-secret@registry.npmjs.org/',
        unsafeProperties: {
          bundle: {dsseEnvelope: {payload: 'raw-dsse-payload'}},
          cause: {message: 'raw-cause'},
          certificate: {rawBytes: 'raw-certificate-bytes'},
          integrity: expectedIntegrity,
          key: 'raw-key-material',
          keys: ['raw-key-material'],
          rawBytes: 'raw-key-bytes',
          response: {body: 'raw-response', statusCode: 503},
          signature: 'raw-signature',
          url: 'https://publisher:npm-secret@registry.npmjs.org/a.tgz',
        },
        unsafeStack: 'raw-upstream-stack',
      },
    );

    expect(result).toHaveLength(3);
    for (const error of result) {
      expect(error).toMatchObject({
        classification: 'retryable',
        classified: 'retryable',
        code: 'ABORT_ERR',
        keys: ['classification', 'code', 'name'],
        message: 'Npm provenance evidence request aborted',
        name: 'AbortError',
      });
      expect(error.serialized).toBe(
        '{"code":"ABORT_ERR","classification":"retryable","name":"AbortError"}',
      );
      expect(error.serialized).not.toContain('npm-secret');
      expect(error.serialized).not.toContain('raw-');
      expect(error.stack).not.toContain('npm-secret');
      expect(error.stack).not.toContain('raw-upstream-stack');
    }
  });

  // Mutation: propagate a Pacote verification error with its enumerable raw
  // signature/bundle fields or credential-bearing message intact.
  test('sanitizes dependency errors at the query boundary', () => {
    const fixture = makeFixture();
    const result = runNpmProvenanceProgram(
      `
        let caught;
        try {
          await provenanceApi.queryNpmPackageEvidence(
            {
              entry: input.entry,
              releaseTag: input.releaseTag,
              sourceCommit: input.sourceCommit,
            },
            {
              fetchJson: async () => { throw new Error('fallback must not run'); },
              initTUF: async () => ({getTarget: async () => input.tufTarget}),
              manifest: async () => {
                throw makeError(input.pacoteError);
              },
              registry: 'https://registry.npmjs.org/',
              tufCache: 'C:/npm-cache/_tuf',
              verifyBundle: async () => {},
            },
          );
        } catch (error) {
          caught = {
            classification: provenanceApi.classifyProvenanceError(error),
            code: error.code,
            keys: Object.keys(error).sort(),
            message: error.message,
            name: error.name,
            serialized: JSON.stringify(error),
            statusCode: error.statusCode,
          };
        }
        output(caught);
      `,
      {
        entry: fixture.entry,
        pacoteError: {
          bundle: {dsseEnvelope: {payload: 'raw-dsse-payload'}},
          certificate: {rawBytes: 'raw-certificate-bytes'},
          code: 'EATTESTATIONVERIFY',
          integrity: expectedIntegrity,
          keyid: 'registry-key-1',
          message:
            'https://publisher:npm-secret@registry.npmjs.org failed with raw-signature',
          predicateType: publishPredicateType,
          rawBytes: 'raw-key-bytes',
          resolved: 'https://publisher:npm-secret@registry.npmjs.org/a.tgz',
          signature: 'raw-signature',
          statusCode: 500,
        },
        releaseTag,
        sourceCommit,
        tufTarget,
      },
    );

    expect(result).toMatchObject({
      classification: 'fatal',
      code: 'EATTESTATIONVERIFY',
      keys: ['classification', 'code', 'statusCode'],
      message: 'Npm provenance evidence verification failed',
      name: 'Error',
      statusCode: 500,
    });
    expect(result.serialized).not.toContain('npm-secret');
    expect(result.serialized).not.toContain('raw-certificate-bytes');
    expect(result.serialized).not.toContain('raw-dsse-payload');
    expect(result.serialized).not.toContain('raw-key-bytes');
    expect(result.serialized).not.toContain('raw-signature');
  });

  // Mutation: treat a missing attestation document as permanent.
  test('classifies absent registry attestations as retryable', () => {
    const fixture = makeFixture();
    delete fixture.metadata._attestations;
    const {outcome} = runValidation(fixture.metadata);

    expect(outcome).toEqual({
      error: expect.objectContaining({code: 'EMISSINGATTESTATIONS'}),
    });
    expect(classifySerializedError(outcome.error)).toBe('retryable');
  });

  // Mutation: accept metadata without the mandatory SLSA bundle.
  test('classifies an absent provenance bundle as retryable', () => {
    const fixture = makeFixture();
    fixture.metadata._attestationBundles =
      fixture.metadata._attestationBundles.filter(
        item => item.predicateType !== provenancePredicateType,
      );
    const {outcome} = runValidation(fixture.metadata);

    expect(outcome).toEqual({
      error: expect.objectContaining({code: 'EMISSINGATTESTATIONTYPE'}),
    });
    expect(classifySerializedError(outcome.error)).toBe('retryable');
  });

  // Mutation: accept metadata without npm's keyed publish attestation.
  test('classifies an absent publish bundle as retryable', () => {
    const fixture = makeFixture();
    fixture.metadata._attestationBundles =
      fixture.metadata._attestationBundles.filter(
        item => item.predicateType !== publishPredicateType,
      );
    const {outcome} = runValidation(fixture.metadata);

    expect(outcome).toEqual({
      error: expect.objectContaining({code: 'EMISSINGATTESTATIONTYPE'}),
    });
    expect(classifySerializedError(outcome.error)).toBe('retryable');
  });

  // Mutation: accept an npm publish predicate whose first DSSE signature has
  // an empty key ID and was therefore verified by Pacote as keyless.
  test('rejects a keyless npm publish attestation as fatal', () => {
    const fixture = makeFixture();
    fixture.metadata._attestationBundles[1].bundle.dsseEnvelope.signatures[0].keyid =
      '';
    const {outcome} = runValidation(fixture.metadata);

    expect(outcome).toEqual({
      error: expect.objectContaining({code: 'EATTESTATIONKEY'}),
    });
  });

  // Mutation: accept a keyed provenance predicate instead of requiring the
  // independently Sigstore-verified provenance bundle to remain keyless.
  test('rejects a keyed provenance attestation as fatal', () => {
    const fixture = makeFixture();
    fixture.metadata._attestationBundles[0].bundle.dsseEnvelope.signatures[0].keyid =
      'registry-key-1';
    const {outcome} = runValidation(fixture.metadata);

    expect(outcome).toEqual({
      error: expect.objectContaining({code: 'EATTESTATIONKEY'}),
    });
  });

  // Mutation: trust Pacote output for a different package/version/integrity.
  test.each([
    ['name', 'name', '@pkg-nec/other'],
    ['version', 'version', '9.9.9'],
    ['integrity', '_integrity', 'sha512-other'],
  ])('rejects mismatched metadata %s as fatal', (_label, field, value) => {
    const fixture = makeFixture();
    fixture.metadata[field] = value;
    const {outcome} = runValidation(fixture.metadata);

    expect(outcome).toEqual({
      error: expect.objectContaining({code: 'EINTEGRITY'}),
    });
  });

  // Mutation: accept a canonically encoded integrity whose digest is not the
  // required 64-byte SHA-512 value when both signed subjects repeat it.
  test('rejects a non-64-byte SHA-512 ledger integrity as fatal', () => {
    const fixture = makeFixture();
    const shortIntegrity = 'sha512-ZXhwZWN0ZWQ=';
    const shortIntegrityHex = '6578706563746564';
    fixture.entry.integrity = shortIntegrity;
    fixture.metadata._integrity = shortIntegrity;
    const provenanceStatement = makeProvenanceStatement();
    provenanceStatement.subject[0].digest.sha512 = shortIntegrityHex;
    const publishStatement = makePublishStatement();
    publishStatement.subject[0].digest.sha512 = shortIntegrityHex;
    fixture.metadata._attestationBundles[0].bundle =
      makeBundle(provenanceStatement);
    fixture.metadata._attestationBundles[1].bundle = makeBundle(
      publishStatement,
      {keyid: 'registry-key-1', logId: 'rekor-entry-2'},
    );
    const {outcome} = runValidation(fixture.metadata, undefined, fixture.entry);

    expect(outcome).toEqual({
      error: expect.objectContaining({code: 'EINTEGRITY'}),
    });
  });

  // Mutation: accept either signed statement's subject for another package or
  // tarball digest.
  test.each([
    ['provenance identity', 0, 'name', 'pkg:npm/%40pkg-nec/other@1.2.3'],
    ['provenance integrity', 0, 'sha512', 'f'.repeat(128)],
    ['publish identity', 1, 'name', 'pkg:npm/%40pkg-nec/other@1.2.3'],
    ['publish integrity', 1, 'sha512', 'f'.repeat(128)],
  ])(
    'rejects mismatched attestation subject %s as fatal',
    (_label, bundleIndex, field, value) => {
      const fixture = makeFixture();
      const statement =
        bundleIndex === 0 ? makeProvenanceStatement() : makePublishStatement();
      if (field === 'name') statement.subject[0].name = value;
      else statement.subject[0].digest.sha512 = value;
      fixture.metadata._attestationBundles[bundleIndex].bundle = makeBundle(
        statement,
        bundleIndex === 1
          ? {keyid: 'registry-key-1', logId: 'rekor-entry-2'}
          : undefined,
      );
      const {outcome} = runValidation(fixture.metadata);

      expect(outcome).toEqual({
        error: expect.objectContaining({code: 'EATTESTATIONSUBJECT'}),
      });
    },
  );

  // Mutation: treat a short or non-hex subject SHA-512 as an ordinary subject
  // mismatch instead of rejecting the statement as malformed.
  test.each([
    ['provenance short digest', 0, 'f'.repeat(127)],
    ['provenance non-hex digest', 0, 'g'.repeat(128)],
    ['publish short digest', 1, 'f'.repeat(127)],
    ['publish non-hex digest', 1, 'g'.repeat(128)],
  ])('rejects malformed %s', (_label, bundleIndex, digest) => {
    const fixture = makeFixture();
    const statement =
      bundleIndex === 0 ? makeProvenanceStatement() : makePublishStatement();
    statement.subject[0].digest.sha512 = digest;
    fixture.metadata._attestationBundles[bundleIndex].bundle = makeBundle(
      statement,
      bundleIndex === 1
        ? {keyid: 'registry-key-1', logId: 'rekor-entry-2'}
        : undefined,
    );
    const {outcome} = runValidation(fixture.metadata);

    expect(outcome).toEqual({
      error: expect.objectContaining({code: 'EMALFORMEDATTESTATION'}),
    });
  });

  // Mutation: accept a provenance bundle whose declared predicate differs
  // from the wrapper used to select it.
  test('rejects a malformed provenance statement as fatal', () => {
    const fixture = makeFixture();
    const statement = makeProvenanceStatement();
    statement.predicateType = 'https://example.invalid/not-provenance';
    fixture.metadata._attestationBundles[0].bundle = makeBundle(statement);
    const {outcome} = runValidation(fixture.metadata);

    expect(outcome).toEqual({
      error: expect.objectContaining({code: 'EMALFORMEDATTESTATION'}),
    });
  });

  // Mutations: read any repository/workflow/ref/commit/runner claim from the
  // wrong SLSA field or omit its exact expected-value check.
  test.each([
    [
      'build type',
      statement => {
        delete statement.predicate.buildDefinition.buildType;
      },
    ],
    [
      'arbitrary build type URL',
      statement => {
        statement.predicate.buildDefinition.buildType =
          'https://example.invalid/custom-build/v1';
      },
    ],
    [
      'credential-like build type',
      statement => {
        statement.predicate.buildDefinition.buildType =
          'https://publisher:npm-secret@example.invalid/workflow/v1';
      },
    ],
    [
      'repository',
      statement => {
        statement.predicate.buildDefinition.externalParameters.workflow.repository =
          'https://github.com/pkg-nec/other';
      },
    ],
    [
      'workflow path',
      statement => {
        statement.predicate.buildDefinition.externalParameters.workflow.path =
          '.github/workflows/other.yml';
      },
    ],
    [
      'source ref',
      statement => {
        statement.predicate.buildDefinition.externalParameters.workflow.ref =
          'refs/heads/main';
      },
    ],
    [
      'source commit',
      statement => {
        statement.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit =
          'b'.repeat(40);
      },
    ],
    [
      'source dependency URI binding',
      statement => {
        statement.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit =
          'b'.repeat(40);
        statement.predicate.buildDefinition.resolvedDependencies.unshift({
          digest: {gitCommit: sourceCommit},
          uri: `git+https://github.com/pkg-nec/unrelated@${sourceRef}`,
        });
      },
    ],
    [
      'runner environment',
      statement => {
        statement.predicate.runDetails.builder.id =
          'https://github.com/actions/runner/self-hosted';
      },
    ],
    [
      'runner identity suffix',
      statement => {
        statement.predicate.runDetails.builder.id =
          'https://attacker.invalid/runner/github-hosted';
      },
    ],
  ])('rejects a wrong %s claim as fatal', (_label, mutate) => {
    const fixture = makeFixture();
    const statement = makeProvenanceStatement();
    mutate(statement);
    fixture.metadata._attestationBundles[0].bundle = makeBundle(statement);
    const {outcome} = runValidation(fixture.metadata);

    expect(outcome).toEqual({
      error: expect.objectContaining({code: 'EPROVENANCECLAIM'}),
    });
  });

  // Mutation: omit the public-visibility OID or swallow Sigstore's policy
  // rejection for a private repository certificate.
  test('rejects a private repository certificate policy as fatal', () => {
    const fixture = makeFixture();
    const {outcome, verifyCalls} = runValidation(fixture.metadata, {
      code: 'CERTIFICATE_POLICY_ERROR',
      message: 'certificate visibility was private',
      name: 'VerificationError',
    });

    expect(verifyCalls).toEqual([
      {
        options: expect.objectContaining({
          certificateOIDs: expect.objectContaining({
            '1.3.6.1.4.1.57264.1.22': 'public',
          }),
        }),
        sameBundle: true,
      },
    ]);
    expect(outcome).toEqual({
      error: expect.objectContaining({
        code: 'CERTIFICATE_POLICY_ERROR',
        name: 'VerificationError',
      }),
    });
  });
});

describe('npm provenance error classification', () => {
  // Mutation: retry a cryptographic/integrity failure or stop retrying an npm
  // propagation/transient failure.
  test('separates retryable registry failures from fatal verification failures', () => {
    const cases = [
      [{code: 'E404'}, 'retryable'],
      [{code: 'ETARGET'}, 'retryable'],
      [{code: 'EAI_AGAIN'}, 'retryable'],
      [{code: 'ECONNRESET'}, 'retryable'],
      [{code: 'ETIMEDOUT'}, 'retryable'],
      [{code: 'E429'}, 'retryable'],
      [{statusCode: 404}, 'retryable'],
      [{status: 429}, 'retryable'],
      [{statusCode: 500}, 'retryable'],
      [{response: {status: 599}}, 'retryable'],
      [{code: 'EINTEGRITY'}, 'fatal'],
      [{code: 'EATTESTATIONSUBJECT'}, 'fatal'],
      [{code: 'EATTESTATIONVERIFY'}, 'fatal'],
      [{code: 'EMALFORMEDVERIFICATIONKEYS'}, 'fatal'],
      [{name: 'VerificationError'}, 'fatal'],
      [{code: 'EINTEGRITY', statusCode: 500}, 'fatal'],
      [{code: 'EATTESTATIONVERIFY', response: {status: 503}}, 'fatal'],
      [{name: 'VerificationError', status: 429}, 'fatal'],
      [{code: 'EINTEGRITY', name: 'AbortError'}, 'fatal'],
      [{code: 'ABORT_ERR', name: 'VerificationError'}, 'fatal'],
      [{code: 'EUNKNOWN'}, 'fatal'],
    ];
    const result = runNpmProvenanceProgram(
      `
        output(input.cases.map(([error, expected]) => ({
          actual: provenanceApi.classifyProvenanceError(error),
          expected,
        })));
      `,
      {cases},
    );

    expect(result).toEqual(
      cases.map(([, expected]) => ({actual: expected, expected})),
    );
  });
});
