/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import ts from 'typescript';
import {rewritePackageSpecifier} from '../pkgNecPackageIdentity.mjs';

const dependencyFields = new Set([
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'peerDependenciesMeta',
  'resolutions',
]);
const identityArrayFields = new Set([
  'moduleTypes',
  'reporters',
  'setupFiles',
  'setupFilesAfterEnv',
  'types',
  'watchPlugins',
]);
const identityValueFields = new Set([
  'filter',
  'globalSetup',
  'globalTeardown',
  'preset',
  'resolver',
  'runner',
  'snapshotResolver',
  'testEnvironment',
  'testRunner',
  'testSequencer',
]);

function propertyName(node) {
  if (
    ts.isIdentifier(node) ||
    ts.isStringLiteral(node) ||
    ts.isNumericLiteral(node)
  ) {
    return node.text;
  }
  return null;
}

function addJsonStringEdit(node, sourceFile, category, inventory, edits) {
  if (!ts.isStringLiteral(node)) return;

  const newValue = rewritePackageSpecifier(node.text, inventory);
  if (newValue === null) return;

  edits.push({
    category,
    end: node.end - 1,
    newValue,
    oldValue: node.text,
    replacement: newValue,
    start: node.getStart(sourceFile) + 1,
  });
}

function collectManifestEdits(root, sourceFile, inventory, edits) {
  if (!ts.isObjectLiteralExpression(root)) return;

  for (const property of root.properties) {
    if (!ts.isPropertyAssignment(property)) continue;

    const name = propertyName(property.name);
    if (name === 'name') {
      addJsonStringEdit(
        property.initializer,
        sourceFile,
        'manifest',
        inventory,
        edits,
      );
    } else if (
      dependencyFields.has(name) &&
      ts.isObjectLiteralExpression(property.initializer)
    ) {
      for (const dependency of property.initializer.properties) {
        if (ts.isPropertyAssignment(dependency)) {
          addJsonStringEdit(
            dependency.name,
            sourceFile,
            'manifest',
            inventory,
            edits,
          );
        }
      }
    }
  }
}

function collectIdentityArrayEntry(
  node,
  sourceFile,
  category,
  inventory,
  edits,
) {
  if (ts.isStringLiteral(node)) {
    addJsonStringEdit(node, sourceFile, category, inventory, edits);
    return;
  }
  if (!ts.isArrayLiteralExpression(node)) return;

  const first = node.elements[0];
  if (ts.isStringLiteral(first)) {
    addJsonStringEdit(first, sourceFile, category, inventory, edits);
    return;
  }
  for (const element of node.elements) {
    collectIdentityArrayEntry(element, sourceFile, category, inventory, edits);
  }
}

function collectJsonIdentityEdits(
  node,
  sourceFile,
  category,
  inventory,
  edits,
) {
  if (!ts.isObjectLiteralExpression(node)) return;

  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property)) continue;

    const name = propertyName(property.name);
    const value = property.initializer;
    if (identityValueFields.has(name)) {
      addJsonStringEdit(value, sourceFile, category, inventory, edits);
    } else if (
      identityArrayFields.has(name) &&
      ts.isArrayLiteralExpression(value)
    ) {
      for (const element of value.elements) {
        collectIdentityArrayEntry(
          element,
          sourceFile,
          category,
          inventory,
          edits,
        );
      }
    }

    if (ts.isObjectLiteralExpression(value)) {
      collectJsonIdentityEdits(value, sourceFile, category, inventory, edits);
    } else if (ts.isArrayLiteralExpression(value)) {
      for (const element of value.elements) {
        collectJsonIdentityEdits(
          element,
          sourceFile,
          category,
          inventory,
          edits,
        );
      }
    }
  }
}

function collectJsonEdits({category, filePath, inventory, text}) {
  const sourceFile = ts.parseJsonText(filePath, text);
  if (sourceFile.parseDiagnostics.length > 0) {
    const diagnostic = sourceFile.parseDiagnostics[0];
    throw new SyntaxError(
      `Cannot parse ${filePath}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`,
    );
  }

  const root = sourceFile.statements[0]?.expression;
  const edits = [];
  if (category === 'manifest') {
    collectManifestEdits(root, sourceFile, inventory, edits);
  } else {
    collectJsonIdentityEdits(root, sourceFile, category, inventory, edits);
  }
  return edits;
}

function escapeRegExp(value) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function identityEntries(inventory) {
  return [...inventory.byOldName.values()].sort(
    (left, right) => right.oldName.length - left.oldName.length,
  );
}

function addTextMatches({
  allowUnscoped,
  category,
  edits,
  end,
  inventory,
  start,
  text,
}) {
  const slice = text.slice(start, end);

  for (const identity of identityEntries(inventory)) {
    if (!allowUnscoped && !identity.oldName.startsWith('@')) continue;

    const before = identity.oldName.startsWith('@')
      ? '(?<![A-Za-z0-9_./-])'
      : '(?<![A-Za-z0-9@_./-])';
    const expression = new RegExp(
      `${before}${escapeRegExp(identity.oldName)}(?![A-Za-z0-9._-])`,
      'g',
    );
    let match;

    while ((match = expression.exec(slice)) !== null) {
      const matchStart = start + match.index;
      const matchEnd = matchStart + identity.oldName.length;
      if (edits.some(edit => edit.start < matchEnd && edit.end > matchStart)) {
        continue;
      }

      edits.push({
        category,
        end: matchEnd,
        newValue: identity.newName,
        oldValue: identity.oldName,
        replacement: identity.newName,
        start: matchStart,
      });
    }
  }
}

function isModuleStringContext(line, quoteStart) {
  const prefix = line.slice(0, quoteStart);
  return (
    /^\s*(?:[-*+]\s+)?(?:import|export)\b.*\bfrom\s*$/.test(prefix) ||
    /^\s*(?:[-*+]\s+)?import\s*$/.test(prefix) ||
    /\b(?:import|require(?:\.resolve)?)\s*\(\s*$/.test(prefix) ||
    /\.(?:createMockFromModule|doMock|dontMock|mock|requireActual|requireMock|setMock|unmock)\s*\(\s*$/.test(
      prefix,
    )
  );
}

function npmPackagePath(url) {
  const parts = /^https?:\/\/([^/?#]+)([^?#]*)/i.exec(url);
  if (!parts) return null;

  const host = parts[1].toLowerCase().replace(/:\d+$/, '');
  const routePatterns =
    host === 'npmjs.com' || host === 'www.npmjs.com'
      ? [/^\/package\/((?:@[^/]+\/)?[^/]+)/]
      : host === 'registry.npmjs.org' || host === 'npm.im'
        ? [/^\/((?:@[^/]+\/)?[^/]+)/]
        : host === 'img.shields.io'
          ? [/^\/npm\/(?:v|dt|dm|dw|dy)\/((?:@[^/]+\/)?[^/]+)/]
          : host === 'badge.fury.io'
            ? [/^\/js\/((?:@[^/]+\/)?[^/]+)/]
            : [];

  for (const pattern of routePatterns) {
    const match = pattern.exec(parts[2]);
    if (match) {
      return {
        packageName: match[1].replace(/\.svg$/, ''),
        start:
          parts[0].indexOf(parts[2]) + match.index + match[0].indexOf(match[1]),
      };
    }
  }
  return null;
}

function collectDocumentationEdits({category, inventory, text}) {
  const edits = [];

  const lines = text.split(/(?<=\n)/);
  let lineStart = 0;
  for (const line of lines) {
    const installCommand =
      /\b(?:npm|pnpm|yarn)\s+(?:add|i|install)\b([^\n]*)/.exec(line);
    if (installCommand) {
      const argumentsStart = line.indexOf(installCommand[1]);
      const tokens = installCommand[1].matchAll(/\S+/g);
      for (const token of tokens) {
        if (token[0].startsWith('#')) break;
        const tokenStart = lineStart + argumentsStart + token.index;
        addTextMatches({
          allowUnscoped: true,
          category,
          edits,
          end: tokenStart + token[0].length,
          inventory,
          start: tokenStart,
          text,
        });
      }
    }

    if (/^\s*\|/.test(line)) {
      const cells = line.matchAll(/(?<=\|)([^|]+)(?=\|)/g);
      for (const cell of cells) {
        const leadingWhitespace = /^\s*/.exec(cell[0])[0].length;
        const value = cell[0].trim();
        if (rewritePackageSpecifier(value, inventory) === null) continue;

        const cellStart = lineStart + cell.index + leadingWhitespace;
        addTextMatches({
          allowUnscoped: true,
          category,
          edits,
          end: cellStart + value.length,
          inventory,
          start: cellStart,
          text,
        });
      }
    }

    const contextExpression = /([`'"])([^\n]*?)\1|https?:\/\/[^\s)]+/g;
    let context;
    while ((context = contextExpression.exec(line)) !== null) {
      if (context[1]) {
        const isExactBacktickPackage =
          context[1] === '`' &&
          rewritePackageSpecifier(context[2], inventory) !== null;
        if (
          !isExactBacktickPackage &&
          !isModuleStringContext(line, context.index)
        ) {
          continue;
        }
        addTextMatches({
          allowUnscoped: true,
          category,
          edits,
          end: lineStart + context.index + context[0].length,
          inventory,
          start: lineStart + context.index,
          text,
        });
      } else {
        const packagePath = npmPackagePath(context[0]);
        if (packagePath) {
          const packageStart = lineStart + context.index + packagePath.start;
          addTextMatches({
            allowUnscoped: true,
            category,
            edits,
            end: packageStart + packagePath.packageName.length,
            inventory,
            start: packageStart,
            text,
          });
        }
      }
    }
    lineStart += line.length;
  }

  return edits;
}

function collectLockEdits({category, inventory, text}) {
  const edits = [];
  addTextMatches({
    allowUnscoped: true,
    category,
    edits,
    end: text.length,
    inventory,
    start: 0,
    text,
  });

  if (category !== 'fixture-lock') return edits;
  return edits.filter(edit => {
    const tokenStart = Math.max(
      text.lastIndexOf('"', edit.start),
      text.lastIndexOf(' ', edit.start),
      text.lastIndexOf('\n', edit.start),
    );
    const quoteEnd = text.indexOf('"', edit.end);
    const whitespaceEnd = text.slice(edit.end).search(/\s/);
    const tokenEnd = Math.min(
      quoteEnd === -1 ? text.length : quoteEnd,
      whitespaceEnd === -1 ? text.length : edit.end + whitespaceEnd,
    );
    return !text.slice(tokenStart + 1, tokenEnd).includes('@npm:');
  });
}

export function collectStructuredCandidates({
  category,
  filePath,
  inventory,
  text,
}) {
  if (category === 'manifest' || category === 'json' || category === 'jsonc') {
    return collectJsonEdits({category, filePath, inventory, text});
  }
  if (category === 'lock' || category === 'fixture-lock') {
    return collectLockEdits({category, inventory, text});
  }
  if (
    category === 'documentation' ||
    category === 'text' ||
    category === 'workflow'
  ) {
    return collectDocumentationEdits({category, inventory, text});
  }
  return [];
}
