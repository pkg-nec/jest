/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import path from 'node:path';
import {parseSync} from '@babel/core';
import {rewritePackageSpecifier} from '../pkgNecPackageIdentity.mjs';

const jestModuleMethods = new Set([
  'createMockFromModule',
  'doMock',
  'dontMock',
  'mock',
  'requireActual',
  'requireMock',
  'setMock',
  'unmock',
]);

function parserPlugins(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const plugins =
    extension === '.ts' || extension === '.tsx' ? ['typescript'] : ['flow'];

  if (extension === '.jsx' || extension === '.tsx') plugins.push('jsx');
  return plugins;
}

function memberName(member) {
  if (!member.computed && member.property?.type === 'Identifier') {
    return member.property.name;
  }
  if (member.computed && member.property?.type === 'StringLiteral') {
    return member.property.value;
  }
  return null;
}

function createScope(parent = null) {
  return {bindings: new Map(), parent};
}

function declarePattern(scope, pattern, bindingKind = 'other') {
  if (!pattern) return;
  if (pattern.type === 'Identifier') {
    scope.bindings.set(pattern.name, bindingKind);
  } else if (pattern.type === 'AssignmentPattern') {
    declarePattern(scope, pattern.left, bindingKind);
  } else if (pattern.type === 'RestElement') {
    declarePattern(scope, pattern.argument, bindingKind);
  } else if (pattern.type === 'ArrayPattern') {
    for (const element of pattern.elements) {
      declarePattern(scope, element, bindingKind);
    }
  } else if (pattern.type === 'ObjectPattern') {
    for (const property of pattern.properties) {
      declarePattern(
        scope,
        property.type === 'RestElement' ? property.argument : property.value,
        bindingKind,
      );
    }
  }
}

function importBindingKind(declaration, specifier) {
  return declaration.source.value === '@jest/globals' &&
    specifier.type === 'ImportSpecifier' &&
    (specifier.imported.name ?? specifier.imported.value) === 'jest'
    ? 'jest-api'
    : 'other';
}

function predeclareStatement(statement, scope) {
  const declaration =
    statement.type === 'ExportNamedDeclaration' ||
    statement.type === 'ExportDefaultDeclaration'
      ? statement.declaration
      : statement;
  if (!declaration) return;

  if (declaration.type === 'ImportDeclaration') {
    for (const specifier of declaration.specifiers) {
      declarePattern(
        scope,
        specifier.local,
        importBindingKind(declaration, specifier),
      );
    }
  } else if (declaration.type === 'VariableDeclaration') {
    for (const variable of declaration.declarations) {
      declarePattern(scope, variable.id);
    }
  } else if (
    (declaration.type === 'FunctionDeclaration' ||
      declaration.type === 'ClassDeclaration') &&
    declaration.id
  ) {
    declarePattern(scope, declaration.id);
  }
}

function predeclareStatements(statements, scope) {
  for (const statement of statements) {
    predeclareStatement(statement, scope);
  }
}

function predeclareLoopBinding(declaration, scope) {
  if (declaration?.type === 'VariableDeclaration') {
    for (const variable of declaration.declarations) {
      declarePattern(scope, variable.id);
    }
  }
}

function resolveBinding(scope, name) {
  for (let current = scope; current !== null; current = current.parent) {
    if (current.bindings.has(name)) return current.bindings.get(name);
  }
  return null;
}

function isJestReference(node, scope) {
  if (node.type !== 'Identifier') return false;
  const binding = resolveBinding(scope, node.name);
  return binding === 'jest-api' || (binding === null && node.name === 'jest');
}

function isJestChain(node, scope) {
  if (!node) return false;
  if (node.type === 'Identifier') return isJestReference(node, scope);
  if (
    node.type === 'CallExpression' ||
    node.type === 'OptionalCallExpression'
  ) {
    return isJestChain(node.callee, scope);
  }
  if (
    node.type === 'MemberExpression' ||
    node.type === 'OptionalMemberExpression'
  ) {
    return isJestChain(node.object, scope);
  }
  return false;
}

function isRequireCall(node) {
  if (node.callee?.type === 'Identifier') return node.callee.name === 'require';
  return (
    node.callee?.type === 'MemberExpression' &&
    node.callee.object?.type === 'Identifier' &&
    node.callee.object.name === 'require' &&
    memberName(node.callee) === 'resolve'
  );
}

function isJestModuleCall(node, scope) {
  const callee = node.callee;
  return (
    (callee?.type === 'MemberExpression' ||
      callee?.type === 'OptionalMemberExpression') &&
    jestModuleMethods.has(memberName(callee)) &&
    isJestChain(callee.object, scope)
  );
}

function addStringEdit(node, inventory, edits) {
  if (node?.type !== 'StringLiteral') return;

  const newValue = rewritePackageSpecifier(node.value, inventory);
  if (newValue === null) return;

  edits.push({
    category: 'module',
    end: node.end - 1,
    newValue,
    oldValue: node.value,
    replacement: newValue,
    start: node.start + 1,
  });
}

function isFunctionNode(node) {
  return (
    node.type === 'ArrowFunctionExpression' ||
    node.type === 'ClassMethod' ||
    node.type === 'ClassPrivateMethod' ||
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression' ||
    node.type === 'ObjectMethod'
  );
}

function visitFunctionSignature(node, inventory, edits, scope) {
  for (const [key, value] of Object.entries(node)) {
    if (key === 'body' || key === 'params') continue;
    if (Array.isArray(value)) {
      for (const child of value) {
        visit(child, inventory, edits, scope);
      }
    } else if (value && typeof value === 'object' && 'type' in value) {
      visit(value, inventory, edits, scope);
    }
  }
}

function visit(node, inventory, edits, scope = null) {
  if (!node || typeof node !== 'object') return;

  if (node.type === 'Program') {
    const programScope = createScope(scope);
    predeclareStatements(node.body, programScope);
    for (const statement of node.body) {
      visit(statement, inventory, edits, programScope);
    }
    return;
  }

  if (isFunctionNode(node)) {
    const functionScope = createScope(scope);
    if (node.type === 'FunctionExpression') {
      declarePattern(functionScope, node.id);
    }
    for (const parameter of node.params) {
      declarePattern(functionScope, parameter);
      visit(parameter, inventory, edits, functionScope);
    }
    visitFunctionSignature(node, inventory, edits, functionScope);
    visit(node.body, inventory, edits, functionScope);
    return;
  }

  if (node.type === 'BlockStatement') {
    const blockScope = createScope(scope);
    predeclareStatements(node.body, blockScope);
    for (const statement of node.body) {
      visit(statement, inventory, edits, blockScope);
    }
    return;
  }

  if (node.type === 'CatchClause') {
    const catchScope = createScope(scope);
    declarePattern(catchScope, node.param);
    visit(node.body, inventory, edits, catchScope);
    return;
  }

  if (node.type === 'ForStatement') {
    const loopScope = createScope(scope);
    predeclareLoopBinding(node.init, loopScope);
    visit(node.init, inventory, edits, loopScope);
    visit(node.test, inventory, edits, loopScope);
    visit(node.update, inventory, edits, loopScope);
    visit(node.body, inventory, edits, loopScope);
    return;
  }

  if (node.type === 'ForInStatement' || node.type === 'ForOfStatement') {
    const loopScope = createScope(scope);
    predeclareLoopBinding(node.left, loopScope);
    visit(node.right, inventory, edits, loopScope);
    visit(node.left, inventory, edits, loopScope);
    visit(node.body, inventory, edits, loopScope);
    return;
  }

  if (node.type === 'SwitchStatement') {
    visit(node.discriminant, inventory, edits, scope);
    const switchScope = createScope(scope);
    for (const switchCase of node.cases) {
      predeclareStatements(switchCase.consequent, switchScope);
    }
    for (const switchCase of node.cases) {
      visit(switchCase.test, inventory, edits, switchScope);
      for (const statement of switchCase.consequent) {
        visit(statement, inventory, edits, switchScope);
      }
    }
    return;
  }

  if (
    node.type === 'ImportDeclaration' ||
    node.type === 'ExportNamedDeclaration' ||
    node.type === 'ExportAllDeclaration'
  ) {
    addStringEdit(node.source, inventory, edits);
  } else if (node.type === 'ImportExpression') {
    addStringEdit(node.source, inventory, edits);
  } else if (node.type === 'TSImportType') {
    addStringEdit(node.argument, inventory, edits);
  } else if (
    (node.type === 'CallExpression' ||
      node.type === 'OptionalCallExpression') &&
    (node.callee?.type === 'Import' ||
      isRequireCall(node) ||
      isJestModuleCall(node, scope))
  ) {
    addStringEdit(node.arguments[0], inventory, edits);
  }

  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) visit(child, inventory, edits, scope);
    } else if (value && typeof value === 'object' && 'type' in value) {
      visit(value, inventory, edits, scope);
    }
  }
}

export function collectModuleCandidates({code, filePath, inventory, text}) {
  const source = text ?? code;
  const ast = parseSync(source, {
    babelrc: false,
    configFile: false,
    filename: filePath,
    parserOpts: {
      plugins: parserPlugins(filePath),
      sourceType: 'unambiguous',
    },
  });
  const edits = [];

  visit(ast, inventory, edits);
  const identities = [...inventory.byOldName.values()].sort(
    (left, right) => right.oldName.length - left.oldName.length,
  );

  return edits.map(edit => ({
    ...edit,
    filePath,
    oldName: identities.find(
      identity =>
        edit.oldValue === identity.oldName ||
        edit.oldValue.startsWith(`${identity.oldName}/`),
    ).oldName,
    specifier: edit.oldValue,
  }));
}
