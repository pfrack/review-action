import * as core from '@actions/core';
import type { OpenAIClient } from './openai-client.js';
import type { ReviewFinding, ReviewType } from './review-schema.js';

interface CodeContextResult {
  valid: boolean;
  reason?: string;
}

export function validateCodeContext(finding: ReviewFinding, diff: string): CodeContextResult {
  const issue = finding.issue;
  const warnings: string[] = [];

  function nameInDiff(name: string): boolean {
    const MAX_NAME_LENGTH = 80;
    const safeName = name.length > MAX_NAME_LENGTH ? name.slice(0, MAX_NAME_LENGTH) : name;
    const lowerDiff = diff.toLowerCase();
    const lowerName = safeName.toLowerCase();
    let idx = 0;
    while (true) {
      idx = lowerDiff.indexOf(lowerName, idx);
      if (idx === -1) return false;
      const before = idx === 0 || !/\w/.test(diff[idx - 1]);
      const after = idx + lowerName.length >= lowerDiff.length || !/\w/.test(diff[idx + lowerName.length]);
      if (before && after) return true;
      idx += 1;
    }
  }

  const backtickRefs = issue.match(/(?<!\\)`(\w+)`/g) ?? issue.match(/`(\w+)`/g);
  if (backtickRefs) {
    for (const ref of backtickRefs) {
      const name = ref.slice(1, -1);
      if (name.length > 2 && !nameInDiff(name)) {
        warnings.push(`Note: referenced identifier \`${name}\` not found in diff — may exist in broader file context`);
      }
    }
  }

  const explicitRef = issue.match(/(?:function|variable|field|param|class|struct|type|interface)\s+(\w+)/i);
  if (explicitRef) {
    const name = explicitRef[1];
    if (name.length > 2 && !nameInDiff(name)) {
      warnings.push(`Note: referenced \`${name}\` not found in diff — may exist in broader file context`);
    }
  }

  return { valid: true, reason: warnings.length > 0 ? warnings.join('; ') : undefined };
}

function parseHunkRanges(diffLines: string[]): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const re = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
  for (const line of diffLines) {
    const m = line.match(re);
    if (m) {
      const start = parseInt(m[1], 10);
      const count = m[2] ? parseInt(m[2], 10) : 1;
      ranges.push({ start, end: start + count - 1 });
    }
  }
  return ranges;
}

function strictOverlapsHunks(
  lineStart: number,
  lineEnd: number | null,
  hunks: Array<{ start: number; end: number }>,
): boolean {
  const end = lineEnd ?? lineStart;
  return hunks.some(h => lineStart <= h.end && end >= h.start);
}

export async function revalidateFindings(
  findings: ReviewFinding[],
  filesDiff: Record<string, string>,
  client: OpenAIClient,
  model: string,
): Promise<{ valid: ReviewFinding[]; dropped: number }> {
  if (findings.length === 0) return { valid: [], dropped: 0 };

  const findingsText = findings.map((f, i) =>
    `[${i}] ${f.severity} in ${f.file}:${f.line_start ?? 'file-level'}: ${f.issue}`
  ).join('\n');

  const prompt = `You are a code review validator. A reviewer produced these findings for a code diff.
For each finding, determine if it is a REAL issue or a HALLUCINATION (not supported by the code).

Findings:
${findingsText}

Respond with ONLY a JSON array of booleans, one per finding, where true = valid, false = hallucination.
Example: [true, false, true]`;

  const MAX_DIFF_LENGTH = 8000;
  let allDiff = Object.keys(filesDiff).map(f => filesDiff[f]).join('\n');
  let truncatedDiff = allDiff;
  if (allDiff.length > MAX_DIFF_LENGTH) {
    const lastNewline = allDiff.slice(0, MAX_DIFF_LENGTH).lastIndexOf('\n');
    truncatedDiff = allDiff.slice(0, lastNewline > 0 ? lastNewline : MAX_DIFF_LENGTH) + '\n... (truncated)';
  }

  const fileHunksCache = new Map<string, Array<{ start: number; end: number }>>();
  function getFileHunks(file: string): Array<{ start: number; end: number }> {
    if (!fileHunksCache.has(file)) {
      const fileDiff = filesDiff[file] || '';
      fileHunksCache.set(file, parseHunkRanges(fileDiff.split('\n')));
    }
    return fileHunksCache.get(file)!;
  }

  function strictMechanicalFilter(): { valid: ReviewFinding[]; dropped: number } {
    const valid: ReviewFinding[] = [];
    let dropped = 0;
    for (const f of findings) {
      if (f.line_start != null) {
        const hunks = getFileHunks(f.file);
        if (!strictOverlapsHunks(f.line_start!, f.line_end ?? null, hunks)) {
          dropped++;
          continue;
        }
      }
      valid.push(f);
    }
    return { valid, dropped };
  }

  try {
    const result = await client.chat(model, [
      { role: 'system', content: 'You are a validation assistant. Respond only with a JSON array of booleans.' },
      { role: 'user', content: `${prompt}\n\nDiff:\n\`\`\`\n${truncatedDiff}\n\`\`\`` },
    ], {
      temperature: 0,
      maxTokens: 256,
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.content);
    } catch {
      core.warning('LLM revalidation failed: could not parse model response. Applying strict mechanical filter.');
      return strictMechanicalFilter();
    }

    if (!Array.isArray(parsed)) {
      core.warning('LLM revalidation returned non-array. Applying strict mechanical filter.');
      return strictMechanicalFilter();
    }

    const valid: ReviewFinding[] = [];
    let dropped = 0;
    for (let i = 0; i < findings.length; i++) {
      if (parsed[i] === true) {
        valid.push(findings[i]);
      } else {
        dropped++;
      }
    }
    return { valid, dropped };
  } catch {
    core.warning('LLM revalidation failed: model call threw an error. Applying strict mechanical filter.');
    return strictMechanicalFilter();
  }
}