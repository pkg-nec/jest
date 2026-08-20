/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

const dispositions = new Set(['published', 'verified-existing']);

export function publicationProgressLine(event) {
  if (!dispositions.has(event?.disposition)) {
    throw new TypeError('Invalid publication progress disposition');
  }
  return `[${event.order}/${event.total}] ${event.name}@${event.version}: ${event.disposition}`;
}

export function publicationSummary({journal, ledger}) {
  const selected = new Set(ledger.packages.map(entry => entry.name));
  if (journal.packages.length > selected.size) {
    throw new Error('Completed publication count exceeds release ledger total');
  }

  const completed = new Set();
  let published = 0;
  let verifiedExisting = 0;
  for (const entry of journal.packages) {
    if (!selected.has(entry.name) || completed.has(entry.name)) {
      throw new Error(`Invalid publication summary entry: ${entry.name}`);
    }
    if (!dispositions.has(entry.disposition)) {
      throw new Error(`Invalid publication disposition: ${entry.disposition}`);
    }
    completed.add(entry.name);
    if (entry.disposition === 'published') published += 1;
    else verifiedExisting += 1;
  }
  return {
    completed: completed.size,
    published,
    total: ledger.packages.length,
    verifiedExisting,
  };
}

export function publicationSummaryMarkdown(input) {
  const {completed, published, total, verifiedExisting} =
    publicationSummary(input);
  return (
    '# pkg-nec publication summary\n\n' +
    `- Total selected packages: ${total}\n` +
    `- Completed: ${completed}\n` +
    `- Published: ${published}\n` +
    `- Verified existing: ${verifiedExisting}\n`
  );
}
