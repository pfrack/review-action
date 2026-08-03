import { graphql } from '@octokit/graphql';
import { withRetry } from './retry.js';
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
/**
 * List up to 100 review threads on a pull request, flattened for the
 * action's consumers. Throws on GraphQL errors (caller handles).
 */
export async function listReviewThreads(repo, prNumber, token, client = graphql) {
    const [owner, name] = repo.split('/');
    if (!owner || !name) {
        throw new Error(`Invalid repo "${repo}", expected "owner/name"`);
    }
    const data = await withRetry(async () => {
        return await client(LIST_THREADS_QUERY, {
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
export async function resolveReviewThread(threadId, token, client = graphql) {
    await withRetry(async () => {
        await client(RESOLVE_THREAD_MUTATION, {
            variables: { threadId },
            headers: { authorization: `bearer ${token}` },
        });
    });
}
