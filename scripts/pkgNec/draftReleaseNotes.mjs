/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {validateReleasePlan} from './releasePlanSchema.mjs';

function markdownCode(value, name) {
  if (
    typeof value !== 'string' ||
    value.includes('`') ||
    /[\u0000-\u001F\u007F]/u.test(value)
  ) {
    throw new Error(`${name} cannot be represented as Markdown code`);
  }
  return `\`${value}\``;
}

export function renderDraftRelease({plan, sourceCommit}) {
  validateReleasePlan(plan);
  if (!/^[0-9a-f]{40}$/u.test(sourceCommit)) {
    throw new Error('sourceCommit must be a full 40-hex commit');
  }

  const packageLines = plan.packages.map(
    entry => `- ${markdownCode(`${entry.name}@${entry.toVersion}`, 'package')}`,
  );
  const requested =
    plan.rootImpact.requested === null
      ? 'not provided'
      : plan.rootImpact.requested;
  const notes = [
    `# ${plan.anchor.tag}`,
    '',
    `- Source commit: ${markdownCode(sourceCommit, 'sourceCommit')}`,
    `- Release plan: ${markdownCode(plan.planPath, 'planPath')}`,
    `- Previous published release: ${markdownCode(plan.previousRelease.tag, 'previousRelease.tag')}`,
    '',
    '## Packages',
    '',
    ...packageLines,
    '',
    '## Root impact',
    '',
    `- Requested: ${markdownCode(requested, 'rootImpact.requested')}`,
    `- Applied: ${markdownCode(plan.rootImpact.applied, 'rootImpact.applied')}`,
    `- Ambiguous files: ${markdownCode(String(plan.changedFiles.root.ambiguous.length), 'ambiguous count')}`,
    `- All-package files: ${markdownCode(String(plan.changedFiles.root.allPackages.length), 'all-package count')}`,
    '',
    '## Maintainer notes',
    '',
    '<!-- Add release narrative here before publishing this draft. Keep the source commit and package list unchanged. -->',
    '',
  ].join('\n');

  return {notes, title: plan.anchor.tag};
}
