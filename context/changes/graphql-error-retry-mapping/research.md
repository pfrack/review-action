# Research — graphql-error-retry-mapping

## Problem

`src/github-graphql.ts` wraps `@octokit/graphql` calls in `withRetry`
(`src/retry.ts:19`). `withRetry` only retries `RetryableError` instances whose
`status >= 500 || status === 429`, plus network `TypeError`s
(`retry.ts:29`). However, `@octokit/graphql` throws plain `RequestError`
objects (`@octokit/request-error`) on HTTP failures — these are **not**
`RetryableError`, so transient `429`/`5xx`/network blips on
`listReviewThreads` / `resolveReviewThread` are not retried; they abort
`cleanupInlineReview`, which returns `{ failed: true }` and `dispatchOutput`
falls back to summary mode (`src/index.ts:573-574`).

## Affected callers

- `listReviewThreads` (`src/github-graphql.ts:95`) — used by Phase 2 carry-over
  load (`src/index.ts:687`) and Phase 3 `cleanupInlineReview`.
- `resolveReviewThread` (`src/github-graphql.ts:130`) — used by Phase 3
  `cleanupInlineReview` to resolve `isOutdated` threads.

## Options

1. **Map octokit errors → RetryableError at the wrapper layer.** In
   `src/github-graphql.ts`, catch `@octokit/graphql`'s thrown `RequestError`,
   read `status` + `response.headers['retry-after']`, and rethrow as
   `RetryableError`. Pro: minimal, localized, reuses `withRetry`'s existing
   backoff/jitter, and benefits every future GraphQL caller automatically.
2. **Custom retry loop inside the GraphQL helpers.** Wrap `client(...)` in a
   bespoke retry with its own backoff. Con: duplicates `withRetry` logic and
   drift risk.
3. **Accept the current behavior** (summary fallback covers transient
   failures). Con: stale-outdated threads aren't resolved until a later
   successful run; re-review hygiene degrades under transient GitHub blips.

## Recommended

Option 1. Smallest blast radius, highest leverage, matches the existing
`withRetry` pattern used by the REST callers in `src/github-review.ts`.

## Success criteria (proposed)

- `npm test` passes, including a new test: a mocked `429` on the GraphQL
  mutation is retried (and succeeds on retry), and a persistent `5xx`
  ultimately surfaces so `cleanupInlineReview` falls back to summary.
- `npx tsc --noEmit` passes.
