import { describe, it } from 'node:test';
import assert from 'node:assert';
import { formatFindingComment, shouldUseInlineComments, createReview, findExistingReview, deleteReview, postComment, updateComment, createComment, findExistingComment, cleanupInlineReview } from './github-review.js';
import { AI_REVIEW_MARKER } from './github-review.js';
import { RetryableError } from './retry.js';
function makeFinding(overrides = {}) {
    return {
        file: 'src/main.ts',
        severity: 'Warning',
        issue: 'Potential null dereference',
        critical_action: 'not applicable',
        warning_action: 'Add null check',
        suggestion_action: 'not applicable',
        ...overrides,
    };
}
describe('formatFindingComment', () => {
    it('formats warning finding with emoji', () => {
        const finding = makeFinding();
        const comment = formatFindingComment(finding);
        assert.ok(comment.includes('⚠️'));
        assert.ok(comment.includes('Warning'));
        assert.ok(comment.includes('Potential null dereference'));
    });
    it('formats critical finding with emoji', () => {
        const finding = makeFinding({ severity: 'Critical', critical_action: 'Fix immediately' });
        const comment = formatFindingComment(finding);
        assert.ok(comment.includes('🚨'));
        assert.ok(comment.includes('Critical'));
        assert.ok(comment.includes('Fix immediately'));
    });
    it('formats suggestion finding with emoji', () => {
        const finding = makeFinding({ severity: 'Suggestion', suggestion_action: 'Consider renaming' });
        const comment = formatFindingComment(finding);
        assert.ok(comment.includes('💡'));
        assert.ok(comment.includes('Suggestion'));
    });
    it('includes suggestion when present', () => {
        const finding = makeFinding({ suggestion: 'Use optional chaining' });
        const comment = formatFindingComment(finding);
        assert.ok(comment.includes('Use optional chaining'));
    });
    it('excludes "not applicable" action', () => {
        const finding = makeFinding();
        const comment = formatFindingComment(finding);
        assert.ok(!comment.includes('not applicable'));
    });
    it('includes non-placeholder action', () => {
        const finding = makeFinding({ warning_action: 'Investigate race condition' });
        const comment = formatFindingComment(finding);
        assert.ok(comment.includes('Investigate race condition'));
    });
});
describe('cleanupInlineReview', () => {
    function makeCleanupFetch(opts) {
        const resolveCalls = [];
        const deleteCalls = [];
        const commentDeleteCalls = [];
        const originalFetch = globalThis.fetch;
        // Mutable pools so re-queries reflect prior deletes (mirrors GitHub:
        // a GET returns only what hasn't been deleted yet).
        const reviews = new Set(opts.existingReviewId != null ? [opts.existingReviewId] : []);
        const comments = new Set(opts.aiComments ?? []);
        globalThis.fetch = (async (input, init) => {
            const url = typeof input === 'string' ? input : (input?.url ?? '');
            const method = (init?.method ?? 'GET').toUpperCase();
            const bodyStr = init?.body ? (typeof init.body === 'string' ? init.body : '') : '';
            // GraphQL (listReviewThreads / resolveReviewThread)
            if (url.includes('/graphql')) {
                if (bodyStr.includes('reviewThreads')) {
                    return new Response(JSON.stringify({
                        data: {
                            repository: {
                                pullRequest: {
                                    reviewThreads: {
                                        nodes: opts.threads.map((t) => ({
                                            id: t.id,
                                            isResolved: t.isResolved,
                                            isOutdated: t.isOutdated,
                                            path: t.path ?? 'src/x.ts',
                                            line: t.line ?? null,
                                            comments: { nodes: [{ body: t.body ?? 'body' }] },
                                        })),
                                    },
                                },
                            },
                        },
                    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
                }
                if (bodyStr.includes('resolveReviewThread')) {
                    if (opts.resolveShouldThrow) {
                        return new Response(JSON.stringify({ errors: [{ message: 'permission denied' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
                    }
                    const parsed = JSON.parse(bodyStr);
                    // @octokit/graphql wraps the options object, so threadId nests
                    // under variables.variables.
                    resolveCalls.push(parsed.variables.threadId);
                    return new Response(JSON.stringify({ data: { resolveReviewThread: { thread: { id: parsed.variables.threadId, isResolved: true } } } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
                }
                return new Response('{}', { status: 200 });
            }
            // REST
            if (method === 'GET' && url.includes('/pulls/42/reviews')) {
                return new Response(JSON.stringify([...reviews].map((id) => ({ id, body: `${AI_REVIEW_MARKER}\nprev` }))), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            if (method === 'DELETE' && url.includes('/pulls/42/reviews/')) {
                const id = Number(url.split('/').pop());
                deleteCalls.push(id);
                reviews.delete(id);
                return new Response('', { status: 200 });
            }
            if (method === 'GET' && url.includes('/issues/42/comments')) {
                return new Response(JSON.stringify([...comments].map((id) => ({ id, body: `${AI_REVIEW_MARKER}\nc` }))), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            if (method === 'DELETE' && url.includes('/issues/comments/')) {
                const id = Number(url.split('/').pop());
                commentDeleteCalls.push(id);
                comments.delete(id);
                return new Response('', { status: 200 });
            }
            return new Response('{}', { status: 200 });
        });
        return {
            resolveCalls,
            deleteCalls,
            commentDeleteCalls,
            restore: () => { globalThis.fetch = originalFetch; },
        };
    }
    it('resolves all isOutdated threads, deletes the prior review, returns failed:false', async () => {
        const threads = [
            { id: 'PRRT_a', isResolved: false, isOutdated: true },
            { id: 'PRRT_b', isResolved: false, isOutdated: true },
            { id: 'PRRT_c', isResolved: true, isOutdated: true },
            { id: 'PRRT_d', isResolved: false, isOutdated: false },
        ];
        const mock = makeCleanupFetch({ threads, existingReviewId: 200 });
        try {
            const result = await cleanupInlineReview('owner/repo', 42, 'token');
            assert.deepStrictEqual(result, { resolved: 2, failed: false });
            // Resolve order is non-deterministic under bounded concurrency.
            assert.deepStrictEqual([...new Set(mock.resolveCalls)].sort(), ['PRRT_a', 'PRRT_b']);
            assert.strictEqual(mock.resolveCalls.length, 2);
            assert.deepStrictEqual(mock.deleteCalls, [200]);
        }
        finally {
            mock.restore();
        }
    });
    it('returns failed:true when resolveReviewThread throws', async () => {
        const threads = [
            { id: 'PRRT_a', isResolved: false, isOutdated: true },
            { id: 'PRRT_b', isResolved: false, isOutdated: true },
        ];
        const mock = makeCleanupFetch({ threads, resolveShouldThrow: true, existingReviewId: 200 });
        try {
            const result = await cleanupInlineReview('owner/repo', 42, 'token');
            assert.deepStrictEqual(result, { resolved: 0, failed: true });
            // First resolve attempt failed before delete was attempted.
            assert.deepStrictEqual(mock.deleteCalls, []);
        }
        finally {
            mock.restore();
        }
    });
    it('skips already-resolved threads', async () => {
        const threads = [
            { id: 'PRRT_a', isResolved: false, isOutdated: true },
            { id: 'PRRT_b', isResolved: true, isOutdated: true },
        ];
        const mock = makeCleanupFetch({ threads, existingReviewId: 200 });
        try {
            const result = await cleanupInlineReview('owner/repo', 42, 'token');
            assert.deepStrictEqual(result, { resolved: 1, failed: false });
            assert.deepStrictEqual(mock.resolveCalls, ['PRRT_a']);
        }
        finally {
            mock.restore();
        }
    });
    it('does not resolve non-outdated unresolved threads', async () => {
        const threads = [
            { id: 'PRRT_a', isResolved: false, isOutdated: true },
            { id: 'PRRT_b', isResolved: false, isOutdated: false },
        ];
        const mock = makeCleanupFetch({ threads, existingReviewId: 200 });
        try {
            const result = await cleanupInlineReview('owner/repo', 42, 'token');
            assert.deepStrictEqual(result, { resolved: 1, failed: false });
            assert.deepStrictEqual(mock.resolveCalls, ['PRRT_a']);
        }
        finally {
            mock.restore();
        }
    });
    it('deletes no prior review when none exists but still returns failed:false', async () => {
        const threads = [{ id: 'PRRT_a', isResolved: false, isOutdated: true }];
        const mock = makeCleanupFetch({ threads, existingReviewId: null });
        try {
            const result = await cleanupInlineReview('owner/repo', 42, 'token');
            assert.deepStrictEqual(result, { resolved: 1, failed: false });
            assert.deepStrictEqual(mock.deleteCalls, []);
        }
        finally {
            mock.restore();
        }
    });
    it('drains prior AI body comments and deletes all prior reviews before posting inline', async () => {
        const threads = [
            { id: 'PRRT_a', isResolved: false, isOutdated: true },
        ];
        const mock = makeCleanupFetch({ threads, existingReviewId: 200, aiComments: [500] });
        try {
            const result = await cleanupInlineReview('owner/repo', 42, 'token');
            assert.deepStrictEqual(result, { resolved: 1, failed: false });
            // outdated thread resolved, prior review deleted, AND the stale summary
            // comment that would otherwise linger is removed.
            assert.deepStrictEqual(mock.resolveCalls, ['PRRT_a']);
            assert.deepStrictEqual(mock.deleteCalls, [200]);
            assert.deepStrictEqual(mock.commentDeleteCalls, [500]);
        }
        finally {
            mock.restore();
        }
    });
});
describe('shouldUseInlineComments', () => {
    it('returns true for few line-level findings', () => {
        const findings = [
            makeFinding({ line_start: 10 }),
            makeFinding({ line_start: 20 }),
        ];
        assert.strictEqual(shouldUseInlineComments(findings), true);
    });
    it('returns false for many line-level findings', () => {
        const findings = Array.from({ length: 60 }, (_, i) => makeFinding({ line_start: i + 1 }));
        assert.strictEqual(shouldUseInlineComments(findings), false);
    });
    it('counts only line-level findings', () => {
        const findings = [
            ...Array.from({ length: 40 }, (_, i) => makeFinding({ line_start: i + 1 })),
            ...Array.from({ length: 30 }, () => makeFinding({ line_start: undefined })),
        ];
        assert.strictEqual(shouldUseInlineComments(findings), true);
    });
});
describe('createReview', () => {
    const originalFetch = globalThis.fetch;
    it('posts review with inline comments and returns review ID', async () => {
        let capturedUrl = '';
        let capturedBody;
        globalThis.fetch = (async (url, init) => {
            capturedUrl = url;
            capturedBody = JSON.parse(init?.body || '{}');
            return { ok: true, json: async () => ({ id: 12345 }) };
        });
        try {
            const findings = [
                makeFinding({ file: 'src/main.ts', line_start: 10 }),
                makeFinding({ file: 'src/utils.ts', line_start: 20 }),
            ];
            const reviewId = await createReview('owner/repo', 42, 'abc123', findings, 'Review summary', 'test-token');
            assert.strictEqual(reviewId, 12345);
            assert.ok(capturedUrl.includes('/pulls/42/reviews'));
            assert.strictEqual(capturedBody.event, 'COMMENT');
            assert.strictEqual(capturedBody.comments.length, 2);
            assert.strictEqual(capturedBody.comments[0].path, 'src/main.ts');
            assert.strictEqual(capturedBody.comments[0].line, 10);
            assert.strictEqual(capturedBody.comments[0].side, 'RIGHT');
            assert.strictEqual(capturedBody.body, 'Review summary');
        }
        finally {
            globalThis.fetch = originalFetch;
        }
    });
    it('throws when no token provided', async () => {
        await assert.rejects(createReview('owner/repo', 42, 'abc123', [], undefined, undefined), /GITHUB_TOKEN required/);
    });
    it('filters findings without line_start', async () => {
        let capturedBody;
        globalThis.fetch = (async (_url, init) => {
            capturedBody = JSON.parse(init?.body || '{}');
            return { ok: true, json: async () => ({ id: 999 }) };
        });
        try {
            const findings = [
                makeFinding({ file: 'src/main.ts', line_start: 10 }),
                makeFinding({ file: 'src/main.ts' }),
            ];
            const reviewId = await createReview('owner/repo', 42, 'abc123', findings, undefined, 'token');
            assert.strictEqual(reviewId, 999);
            assert.strictEqual(capturedBody.comments.length, 1);
            assert.strictEqual(capturedBody.comments[0].path, 'src/main.ts');
        }
        finally {
            globalThis.fetch = originalFetch;
        }
    });
});
describe('findExistingReview', () => {
    const originalFetch = globalThis.fetch;
    it('returns review ID when found', async () => {
        globalThis.fetch = async () => ({
            ok: true,
            json: async () => [
                { id: 100, body: 'Some other review' },
                { id: 200, body: '### AI Code Review\nFindings here' },
            ],
        });
        try {
            const reviewId = await findExistingReview('owner/repo', 42, 'token');
            assert.strictEqual(reviewId, 200);
        }
        finally {
            globalThis.fetch = originalFetch;
        }
    });
    it('returns null when no matching review found', async () => {
        globalThis.fetch = async () => ({
            ok: true,
            json: async () => [
                { id: 200, body: 'Some other review' },
            ],
        });
        try {
            const reviewId = await findExistingReview('owner/repo', 42, 'token');
            assert.strictEqual(reviewId, null);
        }
        finally {
            globalThis.fetch = originalFetch;
        }
    });
    it('returns review ID for marker from any bot', async () => {
        globalThis.fetch = async () => ({
            ok: true,
            json: async () => [
                { id: 200, body: '### AI Code Review\nFindings here' },
            ],
        });
        try {
            const reviewId = await findExistingReview('owner/repo', 42, 'token');
            assert.strictEqual(reviewId, 200);
        }
        finally {
            globalThis.fetch = originalFetch;
        }
    });
    it('returns null on 404', async () => {
        globalThis.fetch = async () => ({
            ok: false,
            status: 404,
            text: async () => 'Not Found',
        });
        try {
            const reviewId = await findExistingReview('owner/repo', 42, 'token');
            assert.strictEqual(reviewId, null);
        }
        finally {
            globalThis.fetch = originalFetch;
        }
    });
});
describe('postComment', () => {
    const originalFetch = globalThis.fetch;
    it('posts LGTM comment with correct body', async () => {
        let capturedUrl = '';
        let capturedBody;
        globalThis.fetch = (async (url, init) => {
            if (init?.method === 'POST') {
                capturedUrl = url;
                capturedBody = JSON.parse(init?.body || '{}');
                return { ok: true };
            }
            return { ok: true, json: async () => [] };
        });
        try {
            const summaryBody = '### AI Code Review\n\n<sub>Model: test-model</sub>\n\nNo findings\n';
            await postComment('owner/repo', 42, 'test-token', `${summaryBody}\nNo issues found. LGTM!`);
            assert.ok(capturedUrl.includes('/issues/42/comments'));
            assert.ok(capturedBody.body.includes('### AI Code Review'));
            assert.ok(capturedBody.body.includes('<sub>Model: test-model</sub>'));
            assert.ok(capturedBody.body.includes('No issues found. LGTM!'));
        }
        finally {
            globalThis.fetch = originalFetch;
        }
    });
    it('posts comment with correct auth headers', async () => {
        let capturedHeaders;
        globalThis.fetch = (async (_url, init) => {
            if (init?.method === 'POST') {
                capturedHeaders = init?.headers;
                return { ok: true };
            }
            return { ok: true, json: async () => [] };
        });
        try {
            await postComment('owner/repo', 42, 'my-token', 'test body');
            assert.strictEqual(capturedHeaders['Authorization'], 'Bearer my-token');
            assert.strictEqual(capturedHeaders['Content-Type'], 'application/json');
        }
        finally {
            globalThis.fetch = originalFetch;
        }
    });
    it('updates existing comment instead of delete+create', async () => {
        const calls = [];
        globalThis.fetch = (async (url, init) => {
            if (init?.method === 'PATCH') {
                calls.push({ method: 'PATCH', body: JSON.parse(init?.body || '{}') });
                return { ok: true };
            }
            return { ok: true, json: async () => [{ id: 123, body: '### AI Code Review\nold' }] };
        });
        try {
            await postComment('owner/repo', 42, 'token', '### AI Code Review\nnew');
            assert.strictEqual(calls.length, 1);
            assert.strictEqual(calls[0].method, 'PATCH');
            assert.ok(calls[0].body.body.includes('new'));
        }
        finally {
            globalThis.fetch = originalFetch;
        }
    });
});
describe('updateComment', () => {
    const originalFetch = globalThis.fetch;
    it('sends PATCH request with body', async () => {
        let capturedUrl = '';
        let capturedMethod = '';
        let capturedBody;
        globalThis.fetch = (async (url, init) => {
            capturedUrl = url;
            capturedMethod = init?.method || '';
            capturedBody = JSON.parse(init?.body || '{}');
            return { ok: true };
        });
        try {
            await updateComment('owner/repo', 99, 'token', 'updated body');
            assert.ok(capturedUrl.includes('/issues/comments/99'));
            assert.strictEqual(capturedMethod, 'PATCH');
            assert.strictEqual(capturedBody.body, 'updated body');
        }
        finally {
            globalThis.fetch = originalFetch;
        }
    });
});
describe('deleteReview', () => {
    const originalFetch = globalThis.fetch;
    it('sends DELETE request', async () => {
        let capturedUrl = '';
        let capturedMethod = '';
        globalThis.fetch = (async (url, init) => {
            capturedUrl = url;
            capturedMethod = init?.method || '';
            return { ok: true };
        });
        try {
            await deleteReview('owner/repo', 42, 200, 'token');
            assert.ok(capturedUrl.includes('/pulls/42/reviews/200'));
            assert.strictEqual(capturedMethod, 'DELETE');
        }
        finally {
            globalThis.fetch = originalFetch;
        }
    });
});
describe('createComment', () => {
    const originalFetch = globalThis.fetch;
    it('posts a comment via POST to issues endpoint', async () => {
        let capturedUrl = '';
        let capturedMethod = '';
        globalThis.fetch = (async (url, init) => {
            capturedUrl = url;
            capturedMethod = init?.method || '';
            return { ok: true };
        });
        try {
            await createComment('owner/repo', 42, 'token', 'test body');
            assert.ok(capturedUrl.includes('/issues/42/comments'));
            assert.strictEqual(capturedMethod, 'POST');
        }
        finally {
            globalThis.fetch = originalFetch;
        }
    });
    it('handles 404 gracefully — logs warning and does not throw', async () => {
        globalThis.fetch = (async () => ({
            ok: false,
            status: 404,
            text: async () => 'Not Found',
        }));
        try {
            await createComment('owner/repo', 42, 'token', 'test body');
            // Should not throw
        }
        finally {
            globalThis.fetch = originalFetch;
        }
    });
    it('retries on 500 then succeeds', async () => {
        let callCount = 0;
        globalThis.fetch = (async () => {
            callCount++;
            if (callCount === 1) {
                return {
                    ok: false,
                    status: 500,
                    text: async () => 'Internal Server Error',
                };
            }
            return { ok: true };
        });
        try {
            await createComment('owner/repo', 42, 'token', 'test body');
            assert.strictEqual(callCount, 2, 'should have retried once after 500');
        }
        finally {
            globalThis.fetch = originalFetch;
        }
    });
});
describe('safeParseJsonBody — GitHub .json() guard', () => {
    const originalFetch = globalThis.fetch;
    it('createReview throws RetryableError 502 on non-JSON 200 body', async () => {
        globalThis.fetch = (async () => ({
            ok: true,
            status: 200,
            json: async () => { throw new SyntaxError('Unexpected token <'); },
        }));
        try {
            await assert.rejects(() => createReview('owner/repo', 42, 'abc123', [], 'summary', 'token'), (err) => {
                assert.ok(err instanceof RetryableError);
                assert.strictEqual(err.status, 502);
                assert.ok(err.message.includes('non-JSON'));
                return true;
            });
        }
        finally {
            globalThis.fetch = originalFetch;
        }
    });
    it('findExistingReview throws RetryableError 502 on non-JSON 200 body', async () => {
        globalThis.fetch = (async () => ({
            ok: true,
            status: 200,
            json: async () => { throw new SyntaxError('Unexpected token <'); },
        }));
        try {
            await assert.rejects(() => findExistingReview('owner/repo', 42, 'token'), (err) => {
                assert.ok(err instanceof RetryableError);
                assert.strictEqual(err.status, 502);
                return true;
            });
        }
        finally {
            globalThis.fetch = originalFetch;
        }
    });
    it('findExistingComment throws RetryableError 502 on non-JSON 200 body', async () => {
        globalThis.fetch = (async () => ({
            ok: true,
            status: 200,
            json: async () => { throw new SyntaxError('Unexpected token <'); },
        }));
        try {
            await assert.rejects(() => findExistingComment('owner/repo', 42, 'token'), (err) => {
                assert.ok(err instanceof RetryableError);
                assert.strictEqual(err.status, 502);
                return true;
            });
        }
        finally {
            globalThis.fetch = originalFetch;
        }
    });
});
describe('findExistingReview — pagination', () => {
    const originalFetch = globalThis.fetch;
    it('scans multiple pages and returns the page-2 marker id', async () => {
        let fetches = 0;
        globalThis.fetch = (async (url) => {
            fetches++;
            const reviews = url.includes('page=2')
                ? [{ id: 200, body: '### AI Code Review\nFindings' }]
                : Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i, body: 'other review' }));
            return { ok: true, json: async () => reviews };
        });
        try {
            const reviewId = await findExistingReview('owner/repo', 42, 'token');
            assert.strictEqual(reviewId, 200);
            assert.strictEqual(fetches, 2, 'should have fetched exactly 2 pages');
        }
        finally {
            globalThis.fetch = originalFetch;
        }
    });
    it('returns null when no page contains the marker', async () => {
        let fetches = 0;
        globalThis.fetch = (async (url) => {
            fetches++;
            const reviews = url.includes('page=2')
                ? []
                : Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i, body: 'other review' }));
            return { ok: true, json: async () => reviews };
        });
        try {
            const reviewId = await findExistingReview('owner/repo', 42, 'token');
            assert.strictEqual(reviewId, null);
            assert.strictEqual(fetches, 2, 'page-2 empty terminates the scan');
        }
        finally {
            globalThis.fetch = originalFetch;
        }
    });
});
describe('findExistingComment — pagination', () => {
    const originalFetch = globalThis.fetch;
    it('scans multiple pages and returns the page-2 marker id', async () => {
        let fetches = 0;
        globalThis.fetch = (async (url) => {
            fetches++;
            const comments = url.includes('page=2')
                ? [{ id: 200, body: '### AI Code Review\nFindings' }]
                : Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i, body: 'other comment' }));
            return { ok: true, json: async () => comments };
        });
        try {
            const commentId = await findExistingComment('owner/repo', 42, 'token');
            assert.strictEqual(commentId, 200);
            assert.strictEqual(fetches, 2, 'should have fetched exactly 2 pages');
        }
        finally {
            globalThis.fetch = originalFetch;
        }
    });
    it('returns null when no page contains the marker', async () => {
        let fetches = 0;
        globalThis.fetch = (async (url) => {
            fetches++;
            const comments = url.includes('page=2')
                ? []
                : Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i, body: 'other comment' }));
            return { ok: true, json: async () => comments };
        });
        try {
            const commentId = await findExistingComment('owner/repo', 42, 'token');
            assert.strictEqual(commentId, null);
            assert.strictEqual(fetches, 2, 'page-2 empty terminates the scan');
        }
        finally {
            globalThis.fetch = originalFetch;
        }
    });
});
