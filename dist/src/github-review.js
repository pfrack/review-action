import * as core from '@actions/core';
import { withRetry, RetryableError } from './retry.js';
import { escapeMarkdown, safeParseJsonBody } from './utils.js';
import { listReviewThreads, resolveReviewThread } from './github-graphql.js';
const GITHUB_API_TIMEOUT_MS = 30_000;
export const AI_REVIEW_MARKER = '### AI Code Review';
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
            throw new RetryableError(`GitHub API returned ${response.status}: ${errBody.length > 200 ? '...' + errBody.slice(-200) : errBody}`, response.status);
        }
        return response;
    });
    const data = await safeParseJsonBody(resp, 'GitHub');
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
                    throw new RetryableError(`GitHub API returned ${response.status}: ${body.length > 200 ? '...' + body.slice(-200) : body}`, response.status);
                }
                return response;
            });
        }
        catch (err) {
            if (err instanceof RetryableError && err.status === 404)
                return null;
            throw err;
        }
        const reviews = await safeParseJsonBody(resp, 'GitHub');
        for (const review of reviews) {
            if (review.body?.startsWith(AI_REVIEW_MARKER)) {
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
    try {
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
                throw new RetryableError(`GitHub API returned ${response.status}: ${body.length > 200 ? '...' + body.slice(-200) : body}`, response.status);
            }
        });
    }
    catch (err) {
        if (err instanceof RetryableError && err.status === 404) {
            core.warning('Review not found (404) when deleting — skipping');
            return;
        }
        throw err;
    }
}
export const INLINE_COMMENT_THRESHOLD = 50;
export function shouldUseInlineComments(findings) {
    return findings.filter(f => f.line_start != null).length <= INLINE_COMMENT_THRESHOLD;
}
/**
 * List existing review threads on the PR, resolve any that GitHub has
 * marked `isOutdated`, then delete the (now-empty) prior review so the
 * resolved threads disappear from view. Non-outdated threads remain
 * unresolved for human resolution via the GitHub UI.
 *
 * Returns `{ resolved, failed: false }` on full success, or
 * `{ resolved, failed: true }` if any step threw (caller falls back to
 * summary mode for that run).
 */
export async function cleanupInlineReview(repo, prNumber, token) {
    let threads = [];
    let resolved = 0;
    try {
        threads = await listReviewThreads(repo, prNumber, token);
    }
    catch (err) {
        core.warning(`cleanupInlineReview: failed to list threads: ${err instanceof Error ? err.message : String(err)}`);
        return { resolved: 0, failed: true };
    }
    const outdatedUnresolved = threads.filter((t) => !t.isResolved && t.isOutdated);
    // Resolve outdated threads with bounded concurrency (GitHub's resolveReviewThread
    // is a per-thread mutation with no batch API). Caps in-flight requests so re-review
    // latency doesn't scale linearly with the number of outdated threads.
    const CONCURRENCY = 5;
    let idx = 0;
    const worker = async () => {
        while (idx < outdatedUnresolved.length) {
            const thread = outdatedUnresolved[idx++];
            try {
                await resolveReviewThread(thread.id, token);
                resolved++;
            }
            catch (err) {
                core.warning(`cleanupInlineReview: failed to resolve thread ${thread.id}: ${err instanceof Error ? err.message : String(err)}`);
                return false;
            }
        }
        return true;
    };
    const ok = await Promise.all(Array.from({ length: Math.min(CONCURRENCY, outdatedUnresolved.length) }, () => worker())).then((results) => results.every(Boolean));
    if (!ok) {
        return { resolved, failed: true };
    }
    // Delete ALL prior AI reviews (not just the first) in a loop, so any
    // stale review objects from a previous run are removed before posting the
    // new inline review. `findExistingReview` is re-queried each iteration;
    // `deleteReview` returns without throwing on 404, so a missing review is safe.
    try {
        let reviewId;
        while ((reviewId = await findExistingReview(repo, prNumber, token)) !== null) {
            await deleteReview(repo, prNumber, reviewId, token);
        }
    }
    catch (err) {
        core.warning(`cleanupInlineReview: failed to delete prior review: ${err instanceof Error ? err.message : String(err)}`);
        return { resolved, failed: true };
    }
    // Drain any prior AI body comments too, so switching from summary mode
    // (or a prior run) leaves no stale `### AI Code Review` comment sitting
    // alongside the new inline review. Each is re-queried until none remain.
    try {
        let commentId;
        while ((commentId = await findExistingComment(repo, prNumber, token)) !== null) {
            await deleteComment(repo, commentId, token);
        }
    }
    catch (err) {
        core.warning(`cleanupInlineReview: failed to delete prior comments: ${err instanceof Error ? err.message : String(err)}`);
        return { resolved, failed: true };
    }
    return { resolved, failed: false };
}
export async function postComment(repo, prNumber, token, body) {
    const existingId = await findExistingComment(repo, prNumber, token);
    if (existingId) {
        await updateComment(repo, existingId, token, body);
    }
    else {
        await createComment(repo, prNumber, token, body);
    }
}
export async function updateComment(repo, commentId, token, body) {
    const url = `https://api.github.com/repos/${repo}/issues/comments/${commentId}`;
    await withRetry(async () => {
        const response = await fetch(url, {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'Accept': 'application/vnd.github+json',
            },
            body: JSON.stringify({ body }),
            signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
        });
        if (!response.ok) {
            const responseBody = await response.text();
            throw new RetryableError(`GitHub API returned ${response.status}: ${responseBody.length > 200 ? '...' + responseBody.slice(-200) : responseBody}`, response.status);
        }
    });
}
export async function deleteComment(repo, commentId, token) {
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
            throw new RetryableError(`GitHub API returned ${response.status}: ${body.length > 200 ? '...' + body.slice(-200) : body}`, response.status);
        }
    });
}
export async function findExistingComment(repo, prNumber, token) {
    let page = 1;
    const perPage = 100;
    const maxPages = 50;
    while (page <= maxPages) {
        const url = `https://api.github.com/repos/${repo}/issues/${prNumber}/comments?per_page=${perPage}&page=${page}`;
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
                    throw new RetryableError(`GitHub API returned ${response.status}: ${body.length > 200 ? '...' + body.slice(-200) : body}`, response.status);
                }
                return response;
            });
        }
        catch (err) {
            // 404 means PR doesn't exist or token lacks access — skip comment update
            if (err instanceof RetryableError && err.status === 404)
                return null;
            throw err;
        }
        const comments = await safeParseJsonBody(resp, 'GitHub');
        for (const comment of comments) {
            if (comment.body.startsWith(AI_REVIEW_MARKER)) {
                return comment.id;
            }
        }
        if (comments.length < perPage)
            break;
        page++;
    }
    return null;
}
export async function createComment(repo, prNumber, token, body) {
    const url = `https://api.github.com/repos/${repo}/issues/${prNumber}/comments`;
    try {
        await withRetry(async () => {
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
                const responseBody = await response.text();
                throw new RetryableError(`GitHub API returned ${response.status}: ${responseBody.length > 200 ? '...' + responseBody.slice(-200) : responseBody}`, response.status);
            }
        });
    }
    catch (err) {
        if (err instanceof RetryableError && err.status === 404) {
            core.warning(`PR ${repo}#${prNumber} not found (404) when posting comment — skipping`);
            return;
        }
        throw err;
    }
}
