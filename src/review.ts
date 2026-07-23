import * as core from '@actions/core';
import { JSON_SCHEMA_DEFINITION, type ReviewType, type ReviewFinding } from './review-schema.js';
import { SEVERITY_GUIDANCE } from './prompts.js';
import { withRetry, RetryableError } from './retry.js';

export const BASE_SYSTEM_PROMPT = `You are an expert senior software engineer performing a code review.
Analyse the diff provided for bugs, security issues, performance problems, and style/readability concerns.

${SEVERITY_GUIDANCE}

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
  const promptMode = core.getInput('nim_prompt_mode') || 'append';
  if (promptMode !== 'append' && promptMode !== 'replace') {
    core.warning(`Invalid nim_prompt_mode "${promptMode}", defaulting to "append"`);
  }
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
    promptMode,
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

function escapeMarkdown(text: string): string {
  return text.replace(/[\\*_{}\[\]()#`>+~|!]/g, '\\$&');
}

const SEVERITY_META: Record<ReviewFinding['severity'], { emoji: string; label: string; actionKey: keyof ReviewFinding; tag: string }> = {
  Critical:   { emoji: '🚨', label: 'Critical',   actionKey: 'critical_action',   tag: 'Must-fix' },
  Warning:    { emoji: '⚠️', label: 'Warning',    actionKey: 'warning_action',    tag: 'Investigate' },
  Suggestion: { emoji: '💡', label: 'Suggestion', actionKey: 'suggestion_action', tag: 'Nit' },
};

const SEVERITY_ORDER = ['Critical', 'Warning', 'Suggestion'] as const;

export function severityTally(review: ReviewType): { critical: number; warning: number; suggestion: number } {
  const counts = { critical: 0, warning: 0, suggestion: 0 };
  for (const f of review.findings) {
    if (f.severity === 'Critical') counts.critical++;
    else if (f.severity === 'Warning') counts.warning++;
    else if (f.severity === 'Suggestion') counts.suggestion++;
  }
  return counts;
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

  const lines: string[] = [];
  for (const severity of SEVERITY_ORDER) {
    const meta = SEVERITY_META[severity];
    const bucket = review.findings.filter(f => f.severity === severity);
    if (bucket.length === 0) continue;

    lines.push(`### ${meta.emoji} ${meta.label} (${bucket.length})`);

    const byFile = new Map<string, typeof bucket>();
    for (const f of bucket) {
      const list = byFile.get(f.file) || [];
      list.push(f);
      byFile.set(f.file, list);
    }

    for (const [file, findings] of [...byFile.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`**File:** \`${file}\``);
      for (const f of findings) {
        const lineInfo = f.line_start != null
          ? `  **Line:** ${f.line_start}${f.line_end != null && f.line_end !== f.line_start ? '-' + f.line_end : ''}\n`
          : '';
        const suggestionInfo = f.suggestion ? `\n  **Suggestion:** ${escapeMarkdown(f.suggestion)}` : '';
        const matchAction = f[meta.actionKey as keyof typeof f];
        const actionLine = (typeof matchAction === 'string' && matchAction && matchAction !== 'not applicable')
          ? `\n  - **${meta.tag}:** ${escapeMarkdown(matchAction)}`
          : '';
        lines.push(`- ${meta.emoji} **${meta.label}**\n${lineInfo}  **Issue:** ${escapeMarkdown(f.issue)}${actionLine}${suggestionInfo}`);
      }
      lines.push('');
    }
  }

  if (review.summary) {
    lines.push(`**Summary:** ${escapeMarkdown(review.summary)}`);
  }

  return lines.join('\n');
}

function globMatch(str: string, pattern: string): boolean {
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
      throw new RetryableError(`GitHub API returned ${response.status}: ${body}`, response.status);
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

const COMMENT_MARKER = '### AI Code Review';
const GITHUB_API_TIMEOUT_MS = 30_000;

export async function postComment(repo: string, prNumber: number, token: string, body: string): Promise<void> {
  const existingId = await findExistingComment(repo, prNumber, token);
  if (existingId) {
    await deleteComment(repo, existingId, token);
  }
  await createComment(repo, prNumber, token, body);
}

export async function deleteComment(repo: string, commentId: number, token: string): Promise<void> {
  const url = `https://api.github.com/repos/${repo}/issues/comments/${commentId}`;
  await withRetry(async () => {
    const response = await fetch(url, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
      },
      signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new RetryableError(`GitHub API returned ${response.status}: ${body}`, response.status);
    }
  });
}

export async function findExistingComment(repo: string, prNumber: number, token: string): Promise<number | null> {
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
          signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
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
      signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new RetryableError(`GitHub API returned ${response.status}: ${body}`, response.status);
    }
    return response;
  });
}
