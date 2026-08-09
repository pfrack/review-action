import * as core from '@actions/core';
import { graphql } from '@octokit/graphql';
import { withRetry, RetryableError } from './retry.js';
import { parseRetryAfter } from './openai-client.js';
/**
 * Detect errors thrown by `@octokit/graphql` (= `RequestError` from
 * `@octokit/request-error`). Octokit stamps these with `name = 'HttpError'`
 * and a numeric `status`; plain errors lack both. We duck-type rather than
 * import `@octokit/request-error` directly: it's a transitive dep, and the
 * shape is stable enough across versions for a 4-line check.
 */
function isOctokitRequestError(err) {
    return (typeof err === 'object' &&
        err !== null &&
        err instanceof Error &&
        err.name === 'HttpError' &&
        typeof err.status === 'number');
}
/**
 * Pull `Retry-After` from an octokit response headers object. Octokit
 * normalizes keys to lowercase in its typed surface, but real responses
 * occasionally arrive with PascalCase; check both so the parser is
 * case-insensitive without coupling to the exact runtime.
 */
function extractRetryAfterHeader(headers) {
    if (!headers)
        return null;
    return headers['retry-after'] ?? headers['Retry-After'] ?? null;
}
/**
 * Wrap a `client<T>(...)` thunk so that transient HTTP failures thrown by
 * `@octokit/graphql` (status 429 or >= 500) surface as `RetryableError`
 * and are picked up by `withRetry`'s existing backoff. Non-transient errors
 * (4xx, GraphQL `errors` array without an HTTP failure, plain `Error`s,
 * `TypeError`s) propagate unchanged so they reach the existing call-site
 * handlers and the summary fallback.
 */
export async function withGraphQLRetry(fn, maxRetries = 2, delayMs = 1000) {
    return withRetry(async () => {
        try {
            return await fn();
        }
        catch (err) {
            if (isOctokitRequestError(err) && (err.status === 429 || err.status >= 500)) {
                const retryAfterMs = err.status === 429
                    ? parseRetryAfter(extractRetryAfterHeader(err.response?.headers))
                    : undefined;
                const retryable = new RetryableError(err.message, err.status, retryAfterMs);
                retryable.cause = err;
                throw retryable;
            }
            throw err;
        }
    }, maxRetries, delayMs);
}
const LIST_THREADS_QUERY = `
  query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $cursor) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            isResolved
            isOutdated
            path
            line
            comments(first: 1) {
              nodes {
                body
              }
            }
          }
        }
      }
    }
  }
`;
const RESOLVE_THREAD_MUTATION = `
  mutation($threadId: ID!) {
    resolveReviewThread(input: {threadId: $threadId}) {
      thread {
        id
        isResolved
      }
    }
  }
`;
/**
 * Maximum number of GraphQL pages `listReviewThreads` will walk before
 * bailing out with a warning, mirroring the `maxPages = 50` bound the
 * REST list helpers already use. GitHub caps `reviewThreads` at 100 nodes
 * per page, so this ceiling bounds worst-case API pressure and memory.
 */
const MAX_THREAD_PAGES = 50;
/**
 * List every review thread on a pull request (across all GraphQL pages),
 * flattened for the action's consumers. Walks `pageInfo`/`endCursor` until
 * `hasNextPage` is false, bounded by `MAX_THREAD_PAGES`. Throws on GraphQL
 * errors (caller handles) — no error is swallowed mid-pagination, so an
 * incomplete set never silently reaches the callers.
 */
export async function listReviewThreads(repo, prNumber, token, client = graphql) {
    const [owner, name] = repo.split('/');
    if (!owner || !name) {
        throw new Error(`Invalid repo "${repo}", expected "owner/name"`);
    }
    const all = [];
    let cursor = null;
    let page = 0;
    do {
        const data = await withGraphQLRetry(async () => {
            // @octokit/graphql treats every key except `headers` as a top-level
            // GraphQL variable, so variables are passed flat (not nested under
            // `variables:`, which octokit would forward as a single "variables"
            // variable and leave $owner/$name/$number unprovided).
            return await client(LIST_THREADS_QUERY, {
                owner,
                name,
                number: prNumber,
                cursor,
                headers: { authorization: `bearer ${token}` },
            });
        });
        const rt = data?.repository?.pullRequest?.reviewThreads;
        const nodes = rt?.nodes;
        if (Array.isArray(nodes)) {
            for (const node of nodes) {
                all.push({
                    id: node.id,
                    isResolved: node.isResolved,
                    isOutdated: node.isOutdated,
                    path: node.path,
                    line: node.line,
                    body: node.comments?.nodes?.[0]?.body ?? '',
                });
            }
        }
        const pageInfo = rt?.pageInfo;
        cursor = pageInfo?.hasNextPage ? (pageInfo?.endCursor ?? null) : null;
        page++;
        if (page >= MAX_THREAD_PAGES && cursor) {
            core.warning(`listReviewThreads: hit max page limit (${MAX_THREAD_PAGES}) — some threads may be unprocessed`);
            cursor = null;
        }
    } while (cursor);
    return all;
}
/**
 * Mark a review thread as resolved via the GraphQL resolveReviewThread
 * mutation. Throws on GraphQL errors (caller handles).
 */
export async function resolveReviewThread(threadId, token, client = graphql) {
    await withGraphQLRetry(async () => {
        await client(RESOLVE_THREAD_MUTATION, {
            threadId,
            headers: { authorization: `bearer ${token}` },
        });
    });
}
