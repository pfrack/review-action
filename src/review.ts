import * as core from '@actions/core';
import { JSON_SCHEMA_DEFINITION, type ReviewType } from './review-schema.js';
import { withRetry, RetryableError } from './retry.js';

export const BASE_SYSTEM_PROMPT = `You are an expert senior software engineer performing a code review.
Analyse the diff provided for bugs, security issues, performance problems, and style/readability concerns.

Severity guidance — match the issue text and the *_action field to each severity:
- Critical findings: a bug, security hole, data-loss risk, or correctness failure
  that BLOCKS release. Use direct action verbs in the issue text. Populate
  critical_action with the concrete next step required to unblock release.
- Warning findings: an investigative concern, likely bug, or maintainability or
  performance issue that warrants attention but is not blocking. Populate
  warning_action with the next step to investigate.
- Suggestion findings: stylistic, readability, or nit-level improvement. Populate
  suggestion_action with a short optional improvement.

For the two action fields that do not match the severity, write a short placeholder
string such as "not applicable" rather than omitting it — the schema requires all
three on every finding.

${JSON_SCHEMA_DEFINITION}`;

export interface Config {
  baseURL: string;
  apiKey: string;
  models: string[];
  mistralApiKey: string;
  mistralBaseUrl: string;
  mistralModels: string[];
  customApiUrl: string;
  customModel: string;
  customApiKey: string;
  maxFiles: number;
  excludePatterns: string[];
  systemPrompt: string;
  promptMode: string;
}

function splitCSV(s: string): string[] {
  return s.split(',').map(item => item.trim()).filter(item => item !== '');
}

export function loadConfig(): Config {
  return {
    baseURL: core.getInput('nim_base_url') || 'https://integrate.api.nvidia.com/v1',
    apiKey: core.getInput('nim_api_key'),
    models: splitCSV(core.getInput('nim_models')),
    mistralApiKey: core.getInput('mistral_api_key') || '',
    mistralBaseUrl: core.getInput('mistral_base_url') || 'https://api.mistral.ai/v1',
    mistralModels: splitCSV(core.getInput('mistral_models') ||
      'mistral-medium-3.5,mistral-large-2512,mistral-small-2603,codestral-2508'),
    customApiUrl: core.getInput('custom_api_url') || '',
    customModel: core.getInput('custom_model') || '',
    customApiKey: core.getInput('custom_api_key') || '',
    maxFiles: parseInt(core.getInput('max_files') || '100', 10) || 100,
    excludePatterns: splitCSV(core.getInput('exclude_patterns') || '*.lock,*.md,*.txt,*.svg,*.png,*.sum,*.json,*.yaml,*.yml,*.toml,*.mod,*.sum,.mimocode/*,go.sum,go.mod'),
    systemPrompt: core.getInput('nim_system_prompt'),
    promptMode: core.getInput('nim_prompt_mode') || 'append',
  };
}

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

export function validateFindings(
  review: ReviewType,
  filesDiff: Record<string, string>,
  changedFiles: Set<string>,
): { valid: ReviewType; warnings: string[] } {
  const warnings: string[] = [];
  const hunks = getFileHunks(filesDiff);
  const validFindings: typeof review.findings = [];

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
      const overlaps = fileHunks.some(h => f.line_start! <= h.end && (f.line_end ?? f.line_start!) >= h.start);
      if (!overlaps) {
        warnings.push(`Warning: finding line ${f.line_start} outside changed hunks in "${f.file}", dropping`);
        continue;
      }
    }
    validFindings.push(f);
  }

  if (validFindings.length === 0 && !review.summary) {
    return { valid: { findings: [], summary: 'All findings were invalid — see model output for context.' }, warnings };
  }

  return { valid: { findings: validFindings, summary: review.summary }, warnings };
}

export function renderReview(review: ReviewType): string {
  if (review.findings.length === 0) {
    return review.summary || 'No issues found.';
  }

  const byFile = new Map<string, typeof review.findings>();
  for (const f of review.findings) {
    const list = byFile.get(f.file) || [];
    list.push(f);
    byFile.set(f.file, list);
  }

  const lines: string[] = [];
  for (const [file, findings] of [...byFile.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`**File:** \`${file}\``);
    for (const f of findings) {
      const lineInfo = f.line_start != null
        ? `**Line:** ${f.line_start}${f.line_end != null && f.line_end !== f.line_start ? '-' + f.line_end : ''}\n`
        : '';
      const suggestionInfo = f.suggestion ? `\n**Suggestion:** ${f.suggestion}` : '';
      lines.push(`- **Severity:** ${f.severity}\n${lineInfo}**Issue:** ${f.issue}${suggestionInfo}`);
    }
    lines.push('');
  }

  if (review.summary) {
    lines.push(`**Summary:** ${review.summary}`);
  }

  return lines.join('\n');
}

function globMatch(str: string, pattern: string): boolean {
  const regex = new RegExp(
    '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
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
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new RetryableError(`GitHub API returned ${response.status}: ${body}`, response.status);
    }
    return response;
  });

  const raw = await resp.text();
  if (raw.length > 5 * 1024 * 1024) {
    throw new DiffTooLargeError((raw.length / 1024 / 1024).toFixed(1));
  }
  return parseDiff(raw);
}

const COMMENT_MARKER = '### AI Code Review';

export async function postComment(repo: string, prNumber: number, token: string, body: string): Promise<void> {
  // Try to find and update an existing review comment
  const existingId = await findExistingComment(repo, prNumber, token);

  if (existingId) {
    await updateComment(repo, existingId, token, body);
  } else {
    await createComment(repo, prNumber, token, body);
  }
}

async function findExistingComment(repo: string, prNumber: number, token: string): Promise<number | null> {
  let page = 1;
  const perPage = 100;
  const maxPages = 50;

  while (page <= maxPages) {
    const url = `https://api.github.com/repos/${repo}/issues/${prNumber}/comments?per_page=${perPage}&page=${page}`;
    let resp: Response;
    try {
      resp = await withRetry(async () => {
        const response = await fetch(url, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json',
          },
          signal: AbortSignal.timeout(30_000),
        });

        if (!response.ok) {
          const body = await response.text();
          throw new RetryableError(`GitHub API returned ${response.status}: ${body}`, response.status);
        }
        return response;
      });
    } catch (err) {
      // 404 means PR doesn't exist or token lacks access — skip comment update
      if (err instanceof RetryableError && err.status === 404) return null;
      throw err;
    }

    const comments = await resp.json() as { id: number; body: string }[];
    for (const comment of comments) {
      if (comment.body.startsWith(COMMENT_MARKER)) {
        return comment.id;
      }
    }

    if (comments.length < perPage) break;
    page++;
  }

  return null;
}

async function updateComment(repo: string, commentId: number, token: string, body: string): Promise<void> {
  const url = `https://api.github.com/repos/${repo}/issues/comments/${commentId}`;
  const resp = await withRetry(async () => {
    const response = await fetch(url, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github+json',
      },
      body: JSON.stringify({ body }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new RetryableError(`GitHub API returned ${response.status}: ${body}`, response.status);
    }
    return response;
  });
}

async function createComment(repo: string, prNumber: number, token: string, body: string): Promise<void> {
  const url = `https://api.github.com/repos/${repo}/issues/${prNumber}/comments`;
  const resp = await withRetry(async () => {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github+json',
      },
      body: JSON.stringify({ body }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new RetryableError(`GitHub API returned ${response.status}: ${body}`, response.status);
    }
    return response;
  });
}
