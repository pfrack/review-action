import * as core from '@actions/core';
import { withRetry, RetryableError } from './retry.js';
import { escapeMarkdown } from './utils.js';
const GITHUB_API_TIMEOUT_MS = 30_000;
export const AI_REVIEW_MARKER = '### AI Code Review';
export const BOT_LOGIN = process.env.GITHUB_ACTOR || 'github-actions';
export function formatFindingComment(finding) {
    const emoji = finding.severity === 'Critical' ? '🚨'
        : finding.severity === 'Warning' ? '⚠️'
            : '💡';
    const parts = [`${emoji} **${finding.severity}**`];
    parts.push(escapeMarkdown(finding.issue));
    if (finding.suggestion) {
        parts.push(`**Suggestion:** ${escapeMarkdown(finding.suggestion)}`);
    }
    const action = finding.severity === 'Critical' ? finding.critical_action
        : finding.severity === 'Warning' ? finding.warning_action
            : finding.suggestion_action;
    if (action && action !== 'not applicable') {
        parts.push(`**Action:** ${escapeMarkdown(action)}`);
    }
    return parts.join('\n\n');
}
export async function createReview(repo, prNumber, commitSha, findings, body, token) {
    if (!token)
        throw new Error('GITHUB_TOKEN required for review creation');
    const comments = findings
        .filter(f => f.line_start != null)
        .map(f => {
        const isMultiLine = f.line_end != null && f.line_end !== f.line_start;
        const comment = {
            path: f.file,
            line: isMultiLine ? f.line_end : f.line_start,
            body: formatFindingComment(f),
            side: 'RIGHT',
        };
        if (isMultiLine) {
            const start = f.line_start;
            const end = f.line_end;
            if (start != null && end > start) {
                comment.start_line = start;
            }
        }
        return comment;
    });
    const payload = {
        event: 'COMMENT',
        comments,
        commit_id: commitSha,
    };
    if (body)
        payload.body = body;
    const url = `https://api.github.com/repos/${repo}/pulls/${prNumber}/reviews`;
    const resp = await withRetry(async () => {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'Accept': 'application/vnd.github+json',
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
        });
        if (!response.ok) {
            const errBody = await response.text();
            throw new RetryableError(`GitHub API returned ${response.status}: ${errBody}`, response.status);
        }
        return response;
    });
    const data = await resp.json();
    return data.id;
}
export async function findExistingReview(repo, prNumber, token) {
    let page = 1;
    const perPage = 100;
    const maxPages = 50;
    while (page <= maxPages) {
        const url = `https://api.github.com/repos/${repo}/pulls/${prNumber}/reviews?per_page=${perPage}&page=${page}`;
        let resp;
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
        }
        catch (err) {
            if (err instanceof RetryableError && err.status === 404)
                return null;
            throw err;
        }
        const reviews = await resp.json();
        for (const review of reviews) {
            if (review.body?.startsWith(AI_REVIEW_MARKER) && review.user.login === BOT_LOGIN) {
                return review.id;
            }
        }
        if (reviews.length < perPage)
            break;
        page++;
    }
    if (page > maxPages) {
        core.warning(`findExistingReview: hit max page limit (${maxPages}) without finding a matching review`);
    }
    return null;
}
export async function deleteReview(repo, prNumber, reviewId, token) {
    const url = `https://api.github.com/repos/${repo}/pulls/${prNumber}/reviews/${reviewId}`;
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
export const INLINE_COMMENT_THRESHOLD = 50;
export function shouldUseInlineComments(findings) {
    return findings.filter(f => f.line_start != null).length <= INLINE_COMMENT_THRESHOLD;
}
