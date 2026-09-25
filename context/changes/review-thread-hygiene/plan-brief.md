# Review Thread Hygiene — Plan Brief

> Full plan: `context/changes/review-thread-hygiene/plan.md`
> Frame brief: `context/changes/review-thread-hygiene/frame.md`

## What & Why

> **The actual problem to plan around is**: the action previously chose
> "always summary" because inline threads accumulate as outdated and
> become noise. The user now wants to **re-offer inline mode behind an
> opt-in flag**, with two additions that make it viable: (a) auto-
> resolve `isOutdated` threads on re-review using GitHub's own GraphQL
> signal (cheap, conservative, no false positives), and (b) carry
> previous review findings into the new prompt so the model has
> context. Carry-over is in scope; sentinel commands are out.

## Starting Point

- Inline review comments were the default until commit `5fe7b95`
  (2026-07-25) removed them — the inline branch was deleted from
  `dispatchOutput` because stale threads accumulate as "outdated" on
  re-review, creating PR noise.
- `createReview` (`src/github-review.ts:43-94`) is still implemented
  and tested, but nothing calls it from `dispatchOutput`. It comes
  back to life here.
- `cleanupPreviousOutput` (`src/index.ts:34-51`) deletes the prior
  review wholesale — the cause of the stale-thread accumulation.
- No GraphQL usage anywhere. All GitHub API calls are raw `fetch` +
  `withRetry`. Adding the first GraphQL surface (via
  `@octokit/graphql`).
- An abandoned change folder (`context/changes/always-comment-in-review`)
  documents the trade-off; this plan supersedes it.

## Desired End State

Downstream users set `comment_mode: inline` in their workflow YAML.
The bot posts line-anchored review comments. On the next push, the
bot lists existing threads via GraphQL, auto-resolves any GitHub marks
`isOutdated`, and posts the new review. Stale threads disappear
automatically; still-valid threads remain for human resolution via
the GitHub UI. Previous findings are included in the new prompt's
system message as context (escaped, marked as untrusted data). If
the GraphQL call fails, the bot logs a warning and falls back to
summary mode for that run. Users who do not set `comment_mode` get
exactly today's behavior.

## Key Decisions Made

| Decision | Choice | Why | Source |
| --- | --- | --- | --- |
| Thread-resolution scope | Auto-resolve only GitHub's `isOutdated` threads | Conservative; matches convention; zero false positives | Frame |
| Non-outdated thread resolution | Humans resolve via GitHub UI | Sentinel-comment UX is anti-pattern for third-party actions | Frame |
| Carry-over context scope | In scope, system message, escaped as data | Improves model re-judgment; compatible with anchor-based resolve | Frame + Plan |
| Output-mode toggle | New `comment_mode: summary \| inline` input, default `summary` | Preserves existing user behavior | Frame |
| GraphQL client | `@octokit/graphql` (new runtime dep) | Battle-tested; ~30KB bundle cost; user chose over hand-rolled | Plan |
| Carry-over prompt slot | System message, fenced block with explicit "data, not instructions" instruction | Cleanest semantic boundary; inherits parallel-review-security contract | Plan |
| GraphQL failure handling | Fall back to summary mode for that run | Users always get output; never a silent skip | Plan |
| Carry-over text sanitization | `escapeMarkdown` + fenced boundary + explicit annotation | Inherits security contract from parallel-review-security | Plan |
| Atomic Phase 3 | Input + dispatcher branch + cleanup ship together | Never expose inline mode without hygiene; that caused the 2026-07-25 revert | Plan |
| Token budget for carry-over | 20 unresolved threads AND 4000 chars (whichever first) | Bounded worst-case input growth | Plan |
| Safety threshold for inline | Keep `shouldUseInlineComments` 50-finding fallback | Prevents pathological 100-comment reviews | Plan |

## Scope

**In scope:**

- New `comment_mode` action input + Config field + dispatcher branch
- GraphQL helper module (`listReviewThreads`, `resolveReviewThread`)
  via `@octokit/graphql`
- Carry-over context in system message (capped, escaped)
- Re-review cleanup that resolves `isOutdated` threads
- Failure fallback to summary mode on GraphQL error
- README + permissions docs
- Archive of abandoned `always-comment-in-review` change

**Out of scope:**

- Content-similarity matching for non-outdated threads
- Sentinel comment commands (`/ai-resolve`, etc.)
- Per-severity or per-model comment splits
- Auto-resolving non-outdated threads
- Changing the default behavior
- Migrating existing summary comments to inline mode

## Architecture / Approach

```
                  action.yml (new comment_mode input)
                          |
                          v
                   Config (commentMode field)
                          |
                          v
                 dispatchOutput branch
                  /                  \
        commentMode='inline'      else (summary, unchanged)
                  |                       |
                  v                       v
      cleanupInlineReview:        postComment (existing)
        listReviewThreads            ↑
        (GraphQL)                    |
        resolve isOutdated           |
        deleteReview                 |
                  |                  |
                  v                  |
            createReview (existing dead code, re-connected)
                  ↑
                  |
            carry-over: listReviewThreads → formatPreviousFindings
                  ↓
            buildSystemMessage(..., previousFindings)
                  ↓
            attemptModel (per-batch)
```

The two new infra pieces (`github-graphql.ts` and
`previous-findings.ts`) sit alongside the existing
`github-review.ts`. The dispatcher change is a single `if/else` in
`dispatchOutput`. No changes to the model chain, retry logic, or
prompt schema.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. GraphQL helper | `listReviewThreads` + `resolveReviewThread` with `@octokit/graphql`; first dep add | Bundle size (~30KB); client mocking shape for tests |
| 2. Carry-over context | Previous findings in system message (works in summary mode) | Token budget vs quality tradeoff; anchoring bias |
| 3. `comment_mode` + inline + cleanup | The atomic UX change (input, branch, hygiene all together) | Atomic shape is non-negotiable; must not expose inline without cleanup |
| 4. Docs + housekeeping | README, permissions note, archive `always-comment-in-review` | None (housekeeping) |

**Prerequisites:** Frame brief locked. `@octokit/graphql` v8+ on npm.
GitHub Actions token with `pull-requests: write` (for downstream
users who opt in to inline mode).

**Estimated effort:** ~3-4 sessions. Each phase ships independently;
the bundle ships after Phase 3 lands (Phase 4 is docs only).

## Open Risks & Assumptions

- **Carry-over anchoring bias**: the new model may re-raise old
  findings verbatim, which makes the carry-over block useless for
  re-judgment but harmless for `isOutdated`-based resolution. Mitigated
  because resolve is anchor-based, not text-based.
- **`@octokit/graphql` bundle size**: ~30KB is acceptable but worth
  noting. If size becomes a concern, can hand-roll later.
- **GraphQL permissions in downstream repos**: some repos install
  GitHub Actions with read-only tokens. The fallback handles this,
  but users get silent downgrades. Worth a one-line README note.
- **`isOutdated` accuracy**: GitHub's signal is conservative (only
  fires when the anchor truly no longer matches code at that line).
  We trust it. If GitHub changes behavior, the only consequence is
  that some stale threads remain — graceful degradation, not failure.
- **Existing `always-comment-in-review` decision impact**: archiving
  it may remove useful history. The `change.md` inside the archive
  retains the trade-off writeup; only the action status moves.

## Success Criteria (Summary)

- Downstream users can opt into inline mode via `comment_mode: inline`
  in their workflow YAML.
- Inline mode posts line-anchored comments; on re-review, outdated
  threads are auto-resolved and still-valid threads remain.
- Existing users (no `comment_mode` set) see zero behavior change.
- Carry-over context improves the model's re-judgment without
  introducing false findings.
- GraphQL failures degrade gracefully to summary mode with a warning.
- All 527+ existing tests continue to pass.
- README documents the new input + permission requirement.
- `always-comment-in-review` is archived with a supersedes pointer.