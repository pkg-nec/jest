/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import path from 'node:path';
import fs from 'graceful-fs';
import ts from 'typescript';
import {rewritePackageSpecifier} from '../pkgNecPackageIdentity.mjs';
import {collectModuleCandidates} from './moduleCandidates.mjs';
import {enumerateRepositoryFiles} from './repositoryFiles.mjs';
import {collectStructuredCandidates} from './structuredCandidates.mjs';

export const EXPECTED_PUBLISH_REPOSITORY_URL =
  'https://github.com/pkg-nec/jest.git';

const dependencyFields = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'peerDependenciesMeta',
  'resolutions',
];
const historicalFiles = new Set(['CHANGELOG.md', 'CHANGELOG_PRE_v30.md']);
const exactExceptions = new Set([
  ['jest.config.mjs', 'mapper-key', '^@jest/globals$'].join('\0'),
  ['tsconfig.test.json', 'compiler-path', '@jest/globals'].join('\0'),
]);
const externalModulePackages = new Set([
  'jest-pnp-resolver',
  'jest-preset-angular',
  'jest-runner-parallel',
  'jest-runner-serial',
  'jest-serializer-ansi-escapes',
  'jest-watch-typeahead',
  'jest-whatever',
]);
const fixtureLinks = new Map([
  [
    'e2e/global-setup/package.json',
    ['devDependencies', '@pkg-nec/jest-util', 'link:../../packages/jest-util'],
  ],
  [
    'e2e/global-teardown/package.json',
    ['devDependencies', '@pkg-nec/jest-util', 'link:../../packages/jest-util'],
  ],
  [
    'e2e/transform/transform-environment/package.json',
    [
      'dependencies',
      '@pkg-nec/jest-environment-node',
      'link:../../../packages/jest-environment-node',
    ],
  ],
  [
    'e2e/transform/transform-runner/package.json',
    [
      'dependencies',
      '@pkg-nec/jest-environment-node',
      'link:../../../packages/jest-environment-node',
    ],
  ],
  [
    'e2e/transform/transform-esm-testrunner/package.json',
    [
      'dependencies',
      '@pkg-nec/jest-test-result',
      'link:../../../packages/jest-test-result',
    ],
  ],
  [
    'e2e/transform/transform-testrunner/package.json',
    [
      'dependencies',
      '@pkg-nec/jest-test-result',
      'link:../../../packages/jest-test-result',
    ],
  ],
]);
const fixtureLinkTuples = new Set(
  [...fixtureLinks].map(([filePath, tuple]) => [filePath, ...tuple].join('\0')),
);
const moduleSpecifierPattern =
  /\b(?:from\s*|import\s*\(|import\s+|require(?:\.resolve)?\s*\(|(?:createMockFromModule|doMock|dontMock|mock|requireActual|requireMock|setMock|unmock)\s*\()\s*['"]([^'"]+)['"]/g;
const internalIdentityPattern =
  /^(?:@jest\/[A-Za-z0-9._-]+|jest-[A-Za-z0-9._-]+)(?:\/.*)?$/;
const doublePrefixPrefix = ['@pkg-nec/jest', 'jest', ''].join('-');
const doublePrefixPattern = new RegExp(
  `${doublePrefixPrefix}[A-Za-z0-9._/-]+`,
  'g',
);
const mapperKeyPattern = /['"](\^?(@jest\/[A-Za-z0-9._-]+)\$?)['"]\s*:/g;

function normalizedPath(filePath) {
  return filePath.split(path.sep).join('/').replace(/^\.\//, '');
}

function normalizeCategory(category) {
  if (category === 'source' || category === 'config') return 'module';
  return category;
}

function finding({category, expected, filePath, literal}) {
  return {category, exceptionId: null, expected, filePath, literal};
}

function auditCategory(category) {
  if (category === 'module') return 'module-specifier';
  if (category === 'manifest') return 'manifest-identity';
  if (category === 'json' || category === 'jsonc') return 'compiler-type';
  if (category === 'lock' || category === 'fixture-lock') {
    return 'lock-identity';
  }
  return 'package-literal';
}

function parserCompatibleModuleSource(code) {
  return code.replaceAll(
    /^(\s*(?:import|export)\b[^\r\n;]*?(?:\bfrom\s+)?['"][^'"\r\n]+['"]\s+)assert(?=\s*\{)/gm,
    '$1with  ',
  );
}

function moduleMayContainIdentity(code, inventory) {
  if (code.includes('\\')) return true;

  for (const identity of inventory.byOldName.values()) {
    for (const quote of ["'", '"']) {
      const prefix = `${quote}${identity.oldName}`;
      let index = code.indexOf(prefix);
      while (index !== -1) {
        const suffix = code[index + prefix.length];
        if (suffix === quote || suffix === '/') return true;
        index = code.indexOf(prefix, index + prefix.length);
      }
    }
  }
  return false;
}

function collectAuditedModuleCandidates({filePath, inventory, text}) {
  if (/^(?:\.\.\/)+[A-Za-z0-9_./@-]+\r?\n?$/.test(text)) return [];
  if (!moduleMayContainIdentity(text, inventory)) return [];

  const compatibleText = parserCompatibleModuleSource(text);
  try {
    return collectModuleCandidates({
      code: compatibleText,
      filePath,
      inventory,
    });
  } catch (error) {
    if (
      path.extname(filePath) !== '.js' ||
      error?.code !== 'BABEL_PARSE_ERROR'
    ) {
      throw error;
    }
    return collectModuleCandidates({
      code: compatibleText,
      filePath: `${filePath}x`,
      inventory,
    });
  }
}

function semanticFindings({category, filePath, inventory, text}) {
  const candidates =
    category === 'module'
      ? collectAuditedModuleCandidates({filePath, inventory, text})
      : collectStructuredCandidates({category, filePath, inventory, text});

  let filteredCandidates = candidates;
  if (category === 'lock' || category === 'fixture-lock') {
    filteredCandidates = filteredCandidates.filter(
      candidate => !isUpstreamNpmLockRecord(text, candidate.start),
    );
  } else if (category === 'documentation' || category === 'workflow') {
    filteredCandidates = filteredCandidates.filter(
      candidate => !isProtectedDocumentationCandidate(text, candidate),
    );
  }

  return filteredCandidates.map(candidate =>
    finding({
      category: auditCategory(category),
      expected: candidate.newValue,
      filePath,
      literal: candidate.oldValue,
    }),
  );
}

function isUpstreamNpmLockRecord(text, offset) {
  const before = text.slice(0, offset);
  const headers = [...before.matchAll(/^"([^"]+)":\r?$/gm)];
  return headers.at(-1)?.[1].includes('@npm:') === true;
}

function isProtectedDocumentationCandidate(text, candidate) {
  if (candidate.oldValue !== 'jest' && candidate.oldValue !== 'expect') {
    return false;
  }

  const lineStart = text.lastIndexOf('\n', candidate.start) + 1;
  const lineEnd = text.indexOf('\n', candidate.end);
  const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
  const packageContext =
    /\b(?:npm|pnpm|yarn)\s+(?:add|i|install)\b/.test(line) ||
    /\b(?:from|import|require(?:\.resolve)?)\b/.test(line) ||
    /https?:\/\/(?:www\.)?(?:npmjs\.com|registry\.npmjs\.org|npm\.im)\//.test(
      line,
    ) ||
    /^\s*\|/.test(line);
  return !packageContext;
}

function sourceIdentityFindings({filePath, inventory, text}) {
  const literals = [];
  const moduleAugmentationPattern = /\bdeclare\s+module\s+(['"])([^'"]+)\1/g;
  for (const match of text.matchAll(moduleAugmentationPattern)) {
    literals.push(match[2]);
  }

  const comparisonPattern = /\b(?:dep|pkg\.name)\s*={2,3}\s*(['"])([^'"]+)\1/g;
  for (const match of text.matchAll(comparisonPattern)) literals.push(match[2]);

  const setPattern =
    /\b(?:excludedPackages|typeOnlyPackages)\s*=\s*new Set\s*\(\s*\[([\s\S]*?)\]\s*\)/g;
  for (const setMatch of text.matchAll(setPattern)) {
    for (const stringMatch of setMatch[1].matchAll(/(['"])([^'"]+)\1/g)) {
      literals.push(stringMatch[2]);
    }
  }

  const dependencyCheckPattern =
    /Object\.keys\(\s*pkg\.(?:dependencies|devDependencies)[^)]*\)\.includes\(\s*(['"])([^'"]+)\1\s*\)/g;
  for (const match of text.matchAll(dependencyCheckPattern)) {
    literals.push(match[2]);
  }

  return literals.flatMap(literal => {
    const expected = rewritePackageSpecifier(literal, inventory);
    return expected === null
      ? []
      : [
          finding({
            category: 'source-identity',
            expected,
            filePath,
            literal,
          }),
        ];
  });
}

function scopedPackageFileFindings({category, filePath, inventory, text}) {
  if (!/^(?:docs|e2e|examples|packages|website)\//.test(filePath)) return [];

  const findings = [];
  for (const identity of inventory.byOldName.values()) {
    if (!identity.oldName.startsWith('@jest/')) continue;

    let index = text.indexOf(identity.oldName);
    while (index !== -1) {
      const suffix = text[index + identity.oldName.length];
      const isUpstreamLockIdentity =
        (category === 'lock' || category === 'fixture-lock') &&
        isUpstreamNpmLockRecord(text, index);
      if (
        !isUpstreamLockIdentity &&
        (suffix === undefined || !/[A-Za-z0-9._-]/.test(suffix))
      ) {
        findings.push(
          finding({
            category: 'source-identity',
            expected: identity.newName,
            filePath,
            literal: identity.oldName,
          }),
        );
        break;
      }
      index = text.indexOf(identity.oldName, index + identity.oldName.length);
    }
  }
  return findings;
}

function jsonPropertyName(name) {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null;
}

function compilerPathFindings({category, filePath, inventory, text}) {
  if (
    (category !== 'json' && category !== 'jsonc') ||
    !/(?:^|\/)tsconfig(?:\.[^/]*)?\.json$/.test(filePath)
  ) {
    return [];
  }

  const sourceFile = ts.parseJsonText(filePath, text);
  if (sourceFile.parseDiagnostics.length > 0) return [];

  const root = sourceFile.statements[0]?.expression;
  if (!ts.isObjectLiteralExpression(root)) return [];
  const compilerOptions = root.properties.find(
    property =>
      ts.isPropertyAssignment(property) &&
      jsonPropertyName(property.name) === 'compilerOptions',
  );
  if (
    !compilerOptions ||
    !ts.isPropertyAssignment(compilerOptions) ||
    !ts.isObjectLiteralExpression(compilerOptions.initializer)
  ) {
    return [];
  }
  const paths = compilerOptions.initializer.properties.find(
    property =>
      ts.isPropertyAssignment(property) &&
      jsonPropertyName(property.name) === 'paths',
  );
  if (
    !paths ||
    !ts.isPropertyAssignment(paths) ||
    !ts.isObjectLiteralExpression(paths.initializer)
  ) {
    return [];
  }

  return paths.initializer.properties.flatMap(property => {
    if (!ts.isPropertyAssignment(property)) return [];
    const literal = jsonPropertyName(property.name);
    if (literal === null) return [];
    const expected = rewritePackageSpecifier(literal, inventory);
    return expected === null
      ? []
      : [
          finding({
            category: 'compiler-path',
            expected,
            filePath,
            literal,
          }),
        ];
  });
}

function moduleSpecifierFindings({filePath, inventory, text}) {
  const findings = [];
  for (const match of text.matchAll(moduleSpecifierPattern)) {
    const literal = match[1];
    if (!internalIdentityPattern.test(literal)) continue;
    if (rewritePackageSpecifier(literal, inventory) !== null) continue;
    if (
      [...externalModulePackages].some(
        packageName =>
          literal === packageName || literal.startsWith(`${packageName}/`),
      )
    ) {
      continue;
    }
    findings.push(
      finding({
        category: 'unresolved-identity',
        expected: null,
        filePath,
        literal,
      }),
    );
  }
  return findings;
}

function doublePrefixFindings({filePath, text}) {
  return [...text.matchAll(doublePrefixPattern)].map(match => {
    const literal = match[0];
    return finding({
      category: 'double-prefix',
      expected: literal.replace(doublePrefixPrefix, '@pkg-nec/jest-'),
      filePath,
      literal,
    });
  });
}

function mapperKeyFindings({filePath, inventory, text}) {
  const findings = [];
  for (const match of text.matchAll(mapperKeyPattern)) {
    const expectedIdentity = rewritePackageSpecifier(match[2], inventory);
    if (expectedIdentity === null) continue;
    findings.push(
      finding({
        category: 'mapper-key',
        expected: `${match[1].startsWith('^') ? '^' : ''}${expectedIdentity}${match[1].endsWith('$') ? '$' : ''}`,
        filePath,
        literal: match[1],
      }),
    );
  }
  return findings;
}

function manifestIdentityForPath(filePath, inventory) {
  const repoRoot = inventory.root.directory;
  return [inventory.root, ...inventory.packages].find(
    identity =>
      normalizedPath(path.relative(repoRoot, identity.manifestPath)) ===
      filePath,
  );
}

function manifestDependencyTuples(manifest) {
  return dependencyFields.flatMap(field =>
    Object.entries(manifest[field] ?? {}).map(([dependencyName, value]) => ({
      dependencyName,
      field,
      literal:
        value !== null && typeof value === 'object' ? value.optional : value,
    })),
  );
}

function manifestPolicyFindings({filePath, inventory, text}) {
  const manifest = JSON.parse(text);
  const findings = [];
  const identity = manifestIdentityForPath(filePath, inventory);
  const dependencyTuples = manifestDependencyTuples(manifest);

  if (
    !identity &&
    /^packages\/[^/]+\/package\.json$/u.test(filePath) &&
    manifest.private !== true
  ) {
    findings.push(
      finding({
        category: 'unrecognized-publishable-workspace',
        expected: 'pkg-nec package identity policy entry',
        filePath,
        literal: manifest.name ?? null,
      }),
    );
  }

  if (identity && manifest.name !== identity.newName) {
    findings.push(
      finding({
        category: 'manifest-identity',
        expected: identity.newName,
        filePath,
        literal: manifest.name ?? null,
      }),
    );
  }

  if (identity && (manifest.private !== true) !== identity.publishable) {
    findings.push(
      finding({
        category: 'publishability',
        expected: !identity.publishable,
        filePath,
        literal: manifest.private === true,
      }),
    );
  }

  if (identity?.publishable && manifest.publishConfig?.access !== 'public') {
    findings.push(
      finding({
        category: 'publish-access',
        expected: 'public',
        filePath,
        literal: manifest.publishConfig?.access ?? null,
      }),
    );
  }

  if (
    identity?.publishable &&
    manifest.repository?.url !== EXPECTED_PUBLISH_REPOSITORY_URL
  ) {
    findings.push(
      finding({
        category: 'repository-url',
        expected: EXPECTED_PUBLISH_REPOSITORY_URL,
        filePath,
        literal: manifest.repository?.url ?? null,
      }),
    );
  }

  const expectedRepositoryDirectory = filePath.replace(/\/package\.json$/u, '');
  if (
    identity?.publishable &&
    manifest.repository?.directory !== expectedRepositoryDirectory
  ) {
    findings.push(
      finding({
        category: 'repository-directory',
        expected: expectedRepositoryDirectory,
        filePath,
        literal: manifest.repository?.directory ?? null,
      }),
    );
  }

  const expectedFixtureLink = fixtureLinks.get(filePath);
  if (expectedFixtureLink) {
    const [expectedField, dependencyName, expected] = expectedFixtureLink;
    const occurrences = dependencyTuples.filter(
      tuple => tuple.dependencyName === dependencyName,
    );
    const [occurrence] = occurrences;
    if (
      occurrences.length !== 1 ||
      occurrence.field !== expectedField ||
      occurrence.literal !== expected
    ) {
      findings.push(
        finding({
          category: 'fixture-link',
          expected,
          filePath,
          literal:
            occurrences.length === 1
              ? occurrence.literal
              : Object.fromEntries(
                  occurrences.map(({field, literal}) => [field, literal]),
                ),
        }),
      );
    }
  }

  for (const {dependencyName, field, literal} of dependencyTuples) {
    if (
      typeof literal === 'string' &&
      literal.startsWith('workspace:') &&
      dependencyName.startsWith('@pkg-nec/') &&
      !inventory.byNewName.has(dependencyName)
    ) {
      findings.push(
        finding({
          category: 'unresolved-internal-dependency',
          expected: 'known @pkg-nec package',
          filePath,
          literal: dependencyName,
        }),
      );
    }

    if (
      typeof literal !== 'string' ||
      (!literal.startsWith('file:') && !literal.startsWith('link:'))
    ) {
      continue;
    }

    const tupleKey = [filePath, field, dependencyName, literal].join('\0');
    if (fixtureLinkTuples.has(tupleKey)) continue;

    const [expectedField, expectedName] = expectedFixtureLink ?? [];
    if (field === expectedField && dependencyName === expectedName) continue;

    if (expectedFixtureLink) {
      findings.push(
        finding({
          category: 'fixture-link',
          expected: 'only the approved fixture dependency tuple',
          filePath,
          literal,
        }),
      );
    } else if (identity?.publishable) {
      findings.push(
        finding({
          category: 'published-link',
          expected: 'registry or workspace protocol',
          filePath,
          literal,
        }),
      );
    } else {
      findings.push(
        finding({
          category: 'fixture-link',
          expected: 'only the approved fixture dependency tuple',
          filePath,
          literal,
        }),
      );
    }
  }

  return findings;
}

function isExactException(auditFinding) {
  return exactExceptions.has(
    [auditFinding.filePath, auditFinding.category, auditFinding.literal].join(
      '\0',
    ),
  );
}

function uniqueSortedFindings(findings) {
  const unique = new Map();
  for (const auditFinding of findings) {
    const key = JSON.stringify(auditFinding);
    if (!unique.has(key)) unique.set(key, auditFinding);
  }
  return [...unique.values()].sort((left, right) =>
    [left.filePath, left.category, String(left.literal)]
      .join('\0')
      .localeCompare(
        [right.filePath, right.category, String(right.literal)].join('\0'),
      ),
  );
}

export function auditText({category, filePath, inventory, text}) {
  const normalizedFilePath = normalizedPath(filePath);
  if (historicalFiles.has(normalizedFilePath)) return [];

  const normalizedCategory = normalizeCategory(category);
  const semantic = semanticFindings({
    category: normalizedCategory,
    filePath: normalizedFilePath,
    inventory,
    text,
  });
  const findings = [
    ...doublePrefixFindings({filePath: normalizedFilePath, text}),
    ...scopedPackageFileFindings({
      category: normalizedCategory,
      filePath: normalizedFilePath,
      inventory,
      text,
    }).filter(
      scopedFinding =>
        normalizedCategory !== 'module' ||
        !semantic.some(
          semanticFinding => semanticFinding.literal === scopedFinding.literal,
        ),
    ),
    ...semantic,
  ];
  if (normalizedCategory === 'module') {
    findings.push(
      ...mapperKeyFindings({
        filePath: normalizedFilePath,
        inventory,
        text,
      }),
      ...moduleSpecifierFindings({
        filePath: normalizedFilePath,
        inventory,
        text,
      }),
      ...sourceIdentityFindings({
        filePath: normalizedFilePath,
        inventory,
        text,
      }),
    );
  }
  if (normalizedCategory === 'manifest') {
    findings.push(
      ...manifestPolicyFindings({
        filePath: normalizedFilePath,
        inventory,
        text,
      }),
    );
  }
  if (normalizedCategory === 'json' || normalizedCategory === 'jsonc') {
    findings.push(
      ...compilerPathFindings({
        category: normalizedCategory,
        filePath: normalizedFilePath,
        inventory,
        text,
      }),
    );
  }

  return uniqueSortedFindings(findings.filter(item => !isExactException(item)));
}

export function auditRepository({inventory, repoRoot}) {
  const root = path.resolve(repoRoot);
  const findings = [];
  for (const entry of enumerateRepositoryFiles({repoRoot: root})) {
    findings.push(
      ...auditText({
        category: entry.category,
        filePath: path.relative(root, entry.path),
        inventory,
        text: fs.readFileSync(entry.path, 'utf8'),
      }),
    );
  }
  return uniqueSortedFindings(findings);
}
