import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { listReviewThreads, resolveReviewThread, withGraphQLRetry, } from './github-graphql.js';
import { RetryableError } from './retry.js';
/** Build a stub GraphQL client that returns the canned response. */
function stubClient(handler) {
    const fn = (async (query, params) => {
        // Mimic @octokit/graphql: every key except `headers` is collected into a
        // `variables` object, so callers can assert on `params.variables.*`.
        const { headers, ...variables } = params ?? {};
        return handler(query, { ...params, variables, headers });
    });
    return fn;
}
test('listReviewThreads: returns parsed threads from a mocked client response', async () => {
    const client = stubClient((_q, _p) => ({
        repository: {
            pullRequest: {
                reviewThreads: {
                    nodes: [
                        {
                            id: 'PRRT_abc',
                            isResolved: false,
                            isOutdated: false,
                            path: 'src/auth.ts',
                            line: 42,
                            comments: { nodes: [{ body: 'missing null check' }] },
                        },
                        {
                            id: 'PRRT_def',
                            isResolved: true,
                            isOutdated: false,
                            path: 'src/auth.ts',
                            line: 87,
                            comments: { nodes: [{ body: 'use bcrypt' }] },
                        },
                    ],
                },
            },
        },
    }));
    const threads = await listReviewThreads('owner/repo', 42, 'tok', client);
    assert.equal(threads.length, 2);
    assert.deepEqual(threads[0], {
        id: 'PRRT_abc',
        isResolved: false,
        isOutdated: false,
        path: 'src/auth.ts',
        line: 42,
        body: 'missing null check',
    });
    assert.equal(threads[1].id, 'PRRT_def');
    assert.equal(threads[1].isResolved, true);
});
test('listReviewThreads: flattens first comment body and tolerates missing nested fields', async () => {
    const client = stubClient(() => ({
        repository: {
            pullRequest: {
                reviewThreads: {
                    nodes: [
                        {
                            id: 'PRRT_x',
                            isResolved: false,
                            isOutdated: true,
                            path: 'src/x.ts',
                            line: 1,
                            comments: { nodes: [{ body: 'first comment' }, { body: 'second' }] },
                        },
                    ],
                },
            },
        },
    }));
    const [thread] = await listReviewThreads('owner/repo', 1, 'tok', client);
    assert.equal(thread.body, 'first comment');
    assert.equal(thread.isOutdated, true);
});
test('listReviewThreads: returns empty array when nodes is empty', async () => {
    const client = stubClient(() => ({
        repository: {
            pullRequest: {
                reviewThreads: { nodes: [] },
            },
        },
    }));
    const threads = await listReviewThreads('owner/repo', 1, 'tok', client);
    assert.deepEqual(threads, []);
});
test('listReviewThreads: returns empty array when reviewThreads block is missing', async () => {
    const client = stubClient(() => ({ repository: { pullRequest: {} } }));
    const threads = await listReviewThreads('owner/repo', 1, 'tok', client);
    assert.deepEqual(threads, []);
});
test('listReviewThreads: rejects malformed repo string', async () => {
    const client = stubClient(() => ({}));
    await assert.rejects(() => listReviewThreads('not-a-slash', 1, 'tok', client), /Invalid repo/);
});
test('listReviewThreads: passes correct variables (owner, name, number) and auth header', async () => {
    const captured = { query: '', params: {} };
    const client = stubClient((q, p) => {
        captured.query = q;
        captured.params = p;
        return { repository: { pullRequest: { reviewThreads: { nodes: [] } } } };
    });
    await listReviewThreads('octo/cat', 99, 'secret-token', client);
    assert.equal(captured.params.variables.owner, 'octo');
    assert.equal(captured.params.variables.name, 'cat');
    assert.equal(captured.params.variables.number, 99);
    assert.equal(captured.params.headers.authorization, 'bearer secret-token');
    assert.match(captured.query, /reviewThreads/);
});
test('resolveReviewThread: passes the thread ID and ignores the response body', async () => {
    const received = { query: '', params: {} };
    const client = stubClient((q, p) => {
        received.query = q;
        received.params = p;
        return { resolveReviewThread: { thread: { id: 'PRRT_x', isResolved: true } } };
    });
    await resolveReviewThread('PRRT_x', 'tok', client);
    assert.equal(received.params.variables.threadId, 'PRRT_x');
    assert.match(received.query, /resolveReviewThread/);
});
test('resolveReviewThread: throws when the client rejects', async () => {
    const client = stubClient(() => {
        throw new Error('GraphQL error: permissions denied');
    });
    await assert.rejects(() => resolveReviewThread('PRRT_x', 'tok', client), /permissions denied/);
});
/**
 * Build a duck-typed `RequestError`-shaped object that satisfies
 * `isOctokitRequestError`. Avoids the deep import of
 * `@octokit/request-error` (transitive dep) — the shape is stable enough
 * across octokit versions for these tests.
 */
function makeRequestError(status, headers = {}) {
    const err = new Error(`octokit ${status}`);
    err.name = 'HttpError';
    err.status = status;
    err.response = { headers };
    return err;
}
describe('withGraphQLRetry', () => {
    test('withGraphQLRetry: retries once on 429 with Retry-After and succeeds on the second call', async () => {
        let calls = 0;
        const result = await withGraphQLRetry(async () => {
            calls++;
            if (calls === 1)
                throw makeRequestError(429, { 'retry-after': '2' });
            return 'ok';
        }, 2, 1);
        assert.equal(result, 'ok');
        assert.equal(calls, 2);
    });
    test('withGraphQLRetry: retries up to maxRetries then surfaces persistent 5xx as RetryableError', async () => {
        let calls = 0;
        const original = makeRequestError(500);
        await assert.rejects(() => withGraphQLRetry(async () => {
            calls++;
            throw original;
        }, 2, 1), (err) => err instanceof RetryableError &&
            err.status === 500 &&
            err.cause === original);
        assert.equal(calls, 3);
    });
    test('withGraphQLRetry: does not retry on 4xx and propagates the original error unchanged', async () => {
        let calls = 0;
        const original = makeRequestError(401);
        await assert.rejects(() => withGraphQLRetry(async () => {
            calls++;
            throw original;
        }, 2, 1), (err) => err === original);
        assert.equal(calls, 1);
    });
    test('withGraphQLRetry: retries on 429 with unparseable Retry-After header (falls back to default backoff)', async () => {
        let calls = 0;
        const result = await withGraphQLRetry(async () => {
            calls++;
            if (calls === 1)
                throw makeRequestError(429, { 'retry-after': '0.5' });
            return 'ok';
        }, 2, 1);
        assert.equal(result, 'ok');
        assert.equal(calls, 2);
    });
    test('withGraphQLRetry: does not translate plain Error (non-RequestError) and propagates unchanged', async () => {
        let calls = 0;
        const original = new Error('boom');
        await assert.rejects(() => withGraphQLRetry(async () => {
            calls++;
            throw original;
        }, 2, 1), (err) => err === original);
        assert.equal(calls, 1);
    });
    test('withGraphQLRetry: translates a RequestError-shaped error into RetryableError with status and retryAfterMs', async () => {
        const original = makeRequestError(429, { 'retry-after': '2' });
        let calls = 0;
        await assert.rejects(() => withGraphQLRetry(async () => {
            calls++;
            throw original;
        }, 0, 1), (err) => {
            if (!(err instanceof RetryableError))
                return false;
            const cause = err.cause;
            return err.status === 429 && err.retryAfterMs === 2000 && cause === original;
        });
        assert.equal(calls, 1);
    });
});
test('ReviewThreadNode: shape matches the documented contract', () => {
    // Compile-time + runtime guard for the public type contract.
    const sample = {
        id: 'PRRT_1',
        isResolved: false,
        isOutdated: true,
        path: 'src/a.ts',
        line: 10,
        body: 'hello',
    };
    assert.equal(typeof sample.id, 'string');
    assert.equal(typeof sample.isResolved, 'boolean');
    assert.equal(typeof sample.isOutdated, 'boolean');
    assert.equal(typeof sample.path, 'string');
    assert.equal(sample.line, 10);
    assert.equal(typeof sample.body, 'string');
});
