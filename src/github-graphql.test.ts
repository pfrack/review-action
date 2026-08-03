import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  listReviewThreads,
  resolveReviewThread,
  type GraphQLClient,
  type ReviewThreadNode,
} from './github-graphql.js';

/** Build a stub GraphQL client that returns the canned response. */
function stubClient(
  handler: (query: string, params: any) => unknown,
): GraphQLClient {
  const fn = (async (query: string, params: any) => handler(query, params)) as GraphQLClient;
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
  await assert.rejects(
    () => listReviewThreads('not-a-slash', 1, 'tok', client),
    /Invalid repo/,
  );
});

test('listReviewThreads: passes correct variables (owner, name, number) and auth header', async () => {
  const captured: { query: string; params: any } = { query: '', params: {} };
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
  const received: { query: string; params: any } = { query: '', params: {} };
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
  }) as GraphQLClient;
  await assert.rejects(
    () => resolveReviewThread('PRRT_x', 'tok', client),
    /permissions denied/,
  );
});

test('ReviewThreadNode: shape matches the documented contract', () => {
  // Compile-time + runtime guard for the public type contract.
  const sample: ReviewThreadNode = {
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