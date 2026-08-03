import { escapeMarkdown } from './utils.js';
import type { ReviewThreadNode } from './github-graphql.js';

/**
 * Format a list of previous review threads into a compact text block
 * suitable for inclusion in the model prompt's system message. The
 * block is fenced and treated as untrusted data by the model (see
 * buildSystemMessage for the boundary annotation).
 *
 * Capping rules (whichever hits first wins):
 *   - At most `maxThreads` entries are included.
 *   - The total output is at most `maxChars` characters.
 *
 * Truncation appends a marker line so the model knows data was dropped.
 */
export function formatPreviousFindings(
  threads: ReviewThreadNode[],
  maxThreads = 20,
  maxChars = 4000,
): string {
  if (!Array.isArray(threads) || threads.length === 0) {
    return '';
  }

  // Drop already-resolved threads — they have no carry-over value.
  // isOutdated threads are kept: the new model may decide the issue
  // is fixed even if the anchor is still valid, and carry-over helps.
  const unresolved = threads.filter((t) => !t.isResolved);

  if (unresolved.length === 0) {
    return '';
  }

  const lines: string[] = [];
  let omitted = 0;

  for (const thread of unresolved) {
    if (lines.length >= maxThreads) {
      omitted = unresolved.length - lines.length;
      break;
    }
    const loc = thread.line != null ? `${thread.path}:${thread.line}` : thread.path;
    const body = escapeMarkdown(thread.body).replace(/\s+/g, ' ').trim();
    const line = `- ${loc} — ${body}`;
    const candidate = lines.length === 0 ? line : `\n${line}`;
    if ((lines.join('') + candidate).length > maxChars) {
      omitted = unresolved.length - lines.length;
      break;
    }
    lines.push(line);
  }

  if (lines.length === 0) {
    return '';
  }

  let block = lines.join('\n');
  if (omitted > 0) {
    block += `\n[truncated: ${omitted} more previous findings omitted]`;
  }
  return block;
}