import { type ReviewType, type ReviewFinding } from './review-schema.js';
import { withRetry, RetryableError } from './retry.js';
import { validateCodeContext, revalidateFindings } from './validation.js';
import type { OpenAIClient } from './openai-client.js';
import type { Config } from './config.js';

const diffHeaderRe = /^diff --git a\/(.+?) b\/(.+)$/;

export function parseDiff(raw: string): Record<string, string> {
  const files: Record<string, string> = {};
  const chunks = raw.split('diff --git ');

  for (const chunk of chunks) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;

    const diffText = 'diff --git ' + trimmed;
    const firstLine = diffText.split('\n')[0];
    const m = firstLine.match(diffHeaderRe);
    if (m) {
      files[m[2]] = diffText;
    }
  }

  return files;
}

const hunkHeaderRe = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

export function parseDiffHunks(diffText: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const line of diffText.split('\n')) {
    const m = line.match(hunkHeaderRe);
    if (m) {
      const start = parseInt(m[1], 10);
      const count = m[2] ? parseInt(m[2], 10) : 1;
      ranges.push({ start, end: start + count - 1 });
    }
  }
  return ranges;
}

export function getFileHunks(filesDiff: Record<string, string>): Map<string, Array<{ start: number; end: number }>> {
  const map = new Map<string, Array<{ start: number; end: number }>>();
  for (const [file, diffText] of Object.entries(filesDiff)) {
    map.set(file, parseDiffHunks(diffText));
  }
  return map;
}

export async function validateFindings(
  review: ReviewType,
  filesDiff: Record<string, string>,
  changedFiles: Set<string>,
  client?: OpenAIClient,
  model?: string,
  config?: Pick<Config, 'dropUnreferenced' | 'revalidateFindings'>,
): Promise<{ valid: ReviewType; warnings: string[]; dropped: number }> {
  const warnings: string[] = [];
  const hunks = getFileHunks(filesDiff);
  const validFindings: typeof review.findings = [];
  const dropUnreferenced = config?.dropUnreferenced ?? true;

  for (const f of review.findings) {
    if (!changedFiles.has(f.file)) {
      warnings.push(`Warning: finding references unknown file "${f.file}", dropping`);
      continue;
    }
    if (f.line_end != null && f.line_start == null) {
      warnings.push(`Warning: finding has line_end but no line_start in "${f.file}", dropping`);
      continue;
    }
    if (f.line_start != null && f.line_end != null && f.line_end < f.line_start) {
      warnings.push(`Warning: finding line_end (${f.line_end}) < line_start (${f.line_start}) in "${f.file}", dropping`);
      continue;
    }
    if (f.line_start != null) {
      const fileHunks = hunks.get(f.file) || [];
      // Include findings near hunk edges — AI models often offset line numbers by a few lines.
      // Tolerance scales with hunk size: min 2 lines, grows at 10% of hunk length.
      const overlaps = fileHunks.some(h => {
        const tolerance = Math.max(2, Math.floor((h.end - h.start + 1) * 0.1));
        return f.line_start! <= h.end + tolerance && (f.line_end ?? f.line_start!) >= h.start - tolerance;
      });
      if (!overlaps) {
        warnings.push(`Note: finding line ${f.line_start} outside changed hunks in "${f.file}"`);
        continue;
      }
    }
    const codeContext = validateCodeContext(f, filesDiff[f.file] || '', dropUnreferenced);
    if (!codeContext.valid) {
      warnings.push(`Warning: ${codeContext.reason} in "${f.file}", dropping`);
      continue;
    }
    if (codeContext.reason) {
      warnings.push(`${codeContext.reason} in "${f.file}"`);
    }
    validFindings.push(f);
  }

  // Step 5: Optional LLM re-validation to catch hallucinated findings
  let dropped = 0;
  if (client && model && validFindings.length > 0) {
    const allDiff = Object.keys(filesDiff).map(f => filesDiff[f]).join('\n');
    const revalidated = await revalidateFindings(validFindings, allDiff, client, model);
    validFindings.length = 0;
    validFindings.push(...revalidated.valid);
    dropped = revalidated.dropped;
  }

  if (validFindings.length === 0 && !review.summary) {
    return { valid: { findings: [], summary: 'All findings were invalid — see model output for context.' }, warnings, dropped };
  }

  return { valid: { findings: validFindings, summary: review.summary }, warnings, dropped };
}

export function globMatch(str: string, pattern: string): boolean {
  const regex = new RegExp(
    '^' + pattern.replace(/[-\/\\^$+?.()|[\]{}]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
  );
  return regex.test(str);
}

export function shouldExclude(filePath: string, patterns: string[]): boolean {
  for (const pat of patterns) {
    if (globMatch(filePath, pat)) return true;
    if (globMatch(filePath.split('/').pop() || '', pat)) return true;
  }
  return false;
}

export class DiffTooLargeError extends Error {
  sizeMB: string;
  constructor(sizeMB: string) {
    super(`Diff too large (${sizeMB} MB). Maximum is 5 MB.`);
    this.name = 'DiffTooLargeError';
    this.sizeMB = sizeMB;
  }
}

export async function fetchDiff(repo: string, prNumber: number, token: string): Promise<Record<string, string>> {
  const url = `https://api.github.com/repos/${repo}/pulls/${prNumber}`;
  const resp = await withRetry(async () => {
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3.diff',
      },
      signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new RetryableError(`GitHub API returned ${response.status}: ${body.length > 200 ? '...' + body.slice(-200) : body}`, response.status);
    }
    return response;
  });

  const raw = await resp.text();
  const byteLength = new TextEncoder().encode(raw).byteLength;
  if (byteLength > 5 * 1024 * 1024) {
    throw new DiffTooLargeError((byteLength / 1024 / 1024).toFixed(1));
  }
  return parseDiff(raw);
}

const GITHUB_API_TIMEOUT_MS = 30_000;


