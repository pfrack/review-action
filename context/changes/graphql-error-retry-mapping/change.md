---
change_id: graphql-error-retry-mapping
title: "Retry transient GraphQL failures from @octokit/graphql"
status: new
created: 2026-08-03
updated: 2026-08-03
archived_at: null
---

## Notes

Seeded from the implementation review of `review-thread-hygiene`: finding F4
flagged that `@octokit/graphql` HTTP failures surface as plain `RequestError`
(not `RetryableError`), so `withRetry` (`src/retry.ts:29`) never retries `429`
/ `5xx` on GraphQL calls. The inline-mode re-review path depends on
`listReviewThreads` / `resolveReviewThread` (`src/github-graphql.ts`), so a
single transient failure aborts cleanup and degrades to summary mode.

The fallback already keeps output flowing, but the reliability gap is a
recurring pattern worth fixing at the retry layer. Captured as a rule in
`context/foundation/lessons.md`.
