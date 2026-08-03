import { graphql } from '@octokit/graphql';
import { withRetry } from './retry.js';

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
    variables?: Record<string, unknown>;
    headers?: Record<string, string>;
  }): Promise<T>;
};

const LIST_THREADS_QUERY = `
  query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewThreads(first: 100) {
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
 * List up to 100 review threads on a pull request, flattened for the
 * action's consumers. Throws on GraphQL errors (caller handles).
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
  const data = await withRetry(async () => {
    return await client<ListThreadsResponse>(LIST_THREADS_QUERY, {
      variables: { owner, name, number: prNumber },
      headers: { authorization: `bearer ${token}` },
    });
  });

  const threads = data?.repository?.pullRequest?.reviewThreads?.nodes;
  if (!Array.isArray(threads)) {
    return [];
  }
  return threads.map((node) => ({
    id: node.id,
    isResolved: node.isResolved,
    isOutdated: node.isOutdated,
    path: node.path,
    line: node.line,
    body: node.comments?.nodes?.[0]?.body ?? '',
  }));
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
  await withRetry(async () => {
    await client(RESOLVE_THREAD_MUTATION, {
      variables: { threadId },
      headers: { authorization: `bearer ${token}` },
    });
  });
}