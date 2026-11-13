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
function isOctokitRequestError(err: unknown): err is {
  status: number;
  response?: { headers?: Record<string, string> };
  message: string;
} {
  return (
    typeof err === 'object' &&
    err !== null &&
    err instanceof Error &&
    (err as { name?: unknown }).name === 'HttpError' &&
    typeof (err as { status?: unknown }).status === 'number'
  );
}

/**
 * Pull `Retry-After` from an octokit response headers object. Octokit
 * normalizes keys to lowercase in its typed surface, but real responses
 * occasionally arrive with PascalCase; check both so the parser is
 * case-insensitive without coupling to the exact runtime.
 */
function extractRetryAfterHeader(headers: Record<string, string> | undefined): string | null {
  if (!headers) return null;
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
export async function withGraphQLRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 2,
  delayMs = 1000,
): Promise<T> {
  return withRetry(async () => {
    try {
      return await fn();
    } catch (err) {
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

/**
 * A single review thread on a pull request, flattened from GitHub's
 * GraphQL `PullRequestReviewThread` shape into the fields the action
 * actually consumes (id for resolve; isResolved/isOutdated for
 * filtering; path/line/body for the carry-over context block).
 */
export type ReviewThreadNode = {
  /** GraphQL node ID, used to call resolveReviewThread. */
  id: string;
  /** True when a human (or this action) has already resolved the thread. */
  isResolved: boolean;
  /**
   * True when the comment's anchor no longer matches code at that line
   * in the latest commit. GitHub's own conservative signal — the only
   * auto-resolve condition this action uses.
   */
  isOutdated: boolean;
  /** File path the comment is anchored to. */
  path: string;
  /** Line number the comment is anchored to; null for file-level comments. */
  line: number | null;
  /** Body text of the first comment in the thread. */
  body: string;
};

/**
 * Minimal GraphQL client interface, narrowed from @octokit/graphql's
 * full surface so tests can supply a stub without faking defaults/endpoint.
 */
export type GraphQLClient = {
  <T>(query: string, params?: {
    [key: string]: unknown;
    headers?: Record<string, string>;
  }): Promise<T>;
};

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

type ListThreadsResponse = {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: {
          hasNextPage: boolean;
          endCursor: string | null;
        };
        nodes: Array<{
          id: string;
          isResolved: boolean;
          isOutdated: boolean;
          path: string;
          line: number | null;
          comments: { nodes: Array<{ body: string }> };
        }>;
      };
    };
  };
};

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
export async function listReviewThreads(
  repo: string,
  prNumber: number,
  token: string,
  client: GraphQLClient = graphql as unknown as GraphQLClient,
): Promise<ReviewThreadNode[]> {
  const [owner, name] = repo.split('/');
  if (!owner || !name) {
    throw new Error(`Invalid repo "${repo}", expected "owner/name"`);
  }

  const all: ReviewThreadNode[] = [];
  let cursor: string | null = null;
  let page = 0;
  do {
    const data = await withGraphQLRetry(async () => {
      // @octokit/graphql treats every key except `headers` as a top-level
      // GraphQL variable, so variables are passed flat (not nested under
      // `variables:`, which octokit would forward as a single "variables"
      // variable and leave $owner/$name/$number unprovided).
      return await client<ListThreadsResponse>(LIST_THREADS_QUERY, {
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
export async function resolveReviewThread(
  threadId: string,
  token: string,
  client: GraphQLClient = graphql as unknown as GraphQLClient,
): Promise<void> {
  await withGraphQLRetry(async () => {
    await client(RESOLVE_THREAD_MUTATION, {
      threadId,
      headers: { authorization: `bearer ${token}` },
    });
  });
}
