# Frame Brief: review-thread-hygiene

> Framing step before /10x-plan. Captures what is *actually* at issue,
> separated from what was initially assumed.

## Reported Observation

The user wants to discuss three intertwined items before any plan:

1. How the action should write inline (line-anchored) review comments.
2. On re-review (new push to a PR), close previously-posted inline
   comments that are no longer valid.
3. A flag to toggle between posting **one** summary comment vs. posting
   inline comments anchored to lines.

A fourth item was added during the narrowing round: include the previous
review's findings in the new prompt so the model has carry-over context
when judging what is still valid.

## Initial Framing (preserved)

- **User's stated cause or approach**: inline comments cause chaos on
  re-review (stale "outdated" threads accumulate); a surgical close
  should replace the wholesale delete; a flag lets users opt into the
  inline experience; carry-over context helps the model re-judge.
- **User's proposed direction**: build (a) surgical thread resolution on
  re-review, (b) a `comment_mode: summary | inline` flag, (c) feed
  previous findings into the prompt.
- **Pre-dispatch narrowing**:
  - Q1 → **(a)** Preserve threads whose issue still exists; resolve the
    ones whose issue is gone.
  - Q2 → **(c)** Close when the anchored line is gone from the new diff
    **or** the new model did not re-raise the same issue.
  - Q3 → Toggle between one summary comment and inline comments.
  - Q4 → Tentative: also send previous review messages into the new
    review's prompt.

## Dimension Map

The observation could originate at any of these dimensions. The user's
initial framing pins at dimensions 2 + 3 + 4 together.

1. **Output-mode toggle (`comment_mode`)** — a new `action.yml` input +
   `Config` field + dispatcher branch in `dispatchOutput` that calls
   `createReview` again. Pure product/UX decision.
2. **Re-review hygiene — thread resolution** — for inline mode, list
   existing review threads, decide which to resolve, resolve via
   GitHub GraphQL `resolveReviewThread`. Adds the **first** GraphQL
   dependency to the action.
3. **Re-review hygiene — thread tracking** — for inline mode, decide
   when a new finding "matches" an old one. **Resolved decision**: use
   GitHub's GraphQL `PullRequestReviewThread.isOutdated` instead of
   building matching logic ourselves. GitHub already does conservative
   anchor-stability detection.
4. **Prompt carry-over (Q4)** — previous findings appended to the
   `userMsg` in `attemptModel` so the model can judge what changed.
   **Resolved decision**: in scope; carry-over is compatible with
   `isOutdated`-only resolution because anchoring bias cannot defeat
   anchor-based auto-resolution.
5. **Permissions** — inline mode + thread resolution needs the
   `pull-requests: write` permission. Standard for posting review
   comments; GitHub Actions tokens have it by default. Document it.
6. **Sentinel-comment UX** — explicitly rejected. A third-party GitHub
   Action cannot expose slash commands to downstream repos; users in
   downstream repos don't have a way to discover or type `/ai-resolve`.
   The action must own the lifecycle or stay out of the way.
7. **Prior `always-comment-in-review` change** — still in `preparing`
   since 2026-07-25; superseded by this change. Should be archived with
   a pointer.

## Hypothesis Investigation

| Hypothesis | Evidence | Verdict |
| --- | --- | --- |
| **(2) Thread resolution is the load-bearing piece** | Without it, inline mode reproduces the 2026-07-25 chaos (outdated threads accumulate) that caused the explicit revert in commit `5fe7b95` (see "Remove the inline comment branch from dispatchOutput"). With it, inline mode becomes viable again. | **STRONG** |
| **(1) Output-mode toggle is needed** | User's Q3 explicitly asks for the flag. No existing flag (`action.yml`, `src/config.ts`) controls this. Today's `dispatchOutput` is summary-only (line 564: `await postComment(...)`). | **STRONG** |
| **(3) Thread-matching via content similarity** | Content similarity adds complexity and threshold tuning for a benefit (auto-resolve non-outdated threads) that conflicts with carry-over (Q4). **Resolved**: use GitHub's `isOutdated` only; humans resolve the "fixed but anchored" case. | **RESOLVED — drop in favor of `isOutdated`** |
| **(4) Prompt carry-over conflicts with full auto-resolve** | Carry-over creates anchoring bias that defeats unmatched-thread resolution. **Resolved**: narrow auto-resolve to `isOutdated` only. Carry-over stays in scope; the two are compatible when resolution is anchor-based. | **RESOLVED — keep carry-over, narrow resolve scope** |
| **(5) Sentinel comments work in third-party actions** | Counter-evidence: third-party GitHub Actions don't expose UX surfaces (slash commands, autocomplete, docs link) to downstream repos. Users won't discover or type `/ai-resolve`. | **REJECTED — UX anti-pattern for generic action** |
| **(6) Permissions are a blocker** | `pull-requests: write` is standard for posting review comments; GitHub Actions tokens have it by default for the triggering PR. Resolving threads requires the same permission. Not a real blocker; document it. | NONE |
| **(7) Archive `always-comment-in-review`** | The change has been `preparing` for 9 days and was explicitly superseded by the 2026-07-25 inline-removal commit; its research.md already documents the tradeoffs. Leaving it dangling creates confusion. | STRONG (housekeeping) |

## Narrowing Signals

- The 2026-07-25 revert is decisive: **inline mode was killed because
  re-review hygiene was bad**. Adding the hygiene is what makes the
  re-offer viable.
- Q3 (toggle) is unambiguous: a flag selecting between one summary
  comment and inline comments. Not a per-severity or per-model split.
- Q4 (carry-over) — locked IN, after the cross-system check showed it
  only conflicts with content-similarity matching, which we dropped.
- The thread-matching algorithm hotspot was resolved by accepting
  GitHub's `isOutdated` as the source of truth for "anchor no longer
  valid". No custom matching logic needed.

## Cross-System Convention

How is this class of observation handled elsewhere?

- **GitHub Copilot Pull Request Review**, **CodeRabbit**, **Sourcery**:
  all post inline comments AND carry over previous findings into the
  next review (model context includes prior thread state). Resolution
  is left to the human reviewer; the bot does not auto-resolve by
  default.
- **CodeRabbit** offers an opt-in "resolve when fixed" toggle that
  uses anchor + content heuristics; it can be enabled per-repo.
- **GitHub's own "Suggested changes"** does not auto-resolve; humans
  resolve by clicking "Resolve conversation".
- **Convention**: auto-resolution of *outdated* threads is uncommon
  but defensible — it cleans up clearly dead threads without making
  any judgment calls about whether an issue is "still relevant".
  Auto-resolution of *non-outdated* threads (the "model didn't re-raise"
  case) is rare and risky. Our design respects the convention: auto
  outdated, human everything else.

## Reframed Problem Statement

> **The actual problem to plan around is**: the action previously chose
> "always summary" because inline threads accumulate as outdated and
> become noise. The user now wants to **re-offer inline mode behind an
> opt-in flag**, with two additions that make it viable: (a) auto-
> resolve `isOutdated` threads on re-review using GitHub's own GraphQL
> signal (cheap, conservative, no false positives), and (b) carry
> previous review findings into the new prompt so the model has
> context. Carry-over is in scope; sentinel commands are out.

In other words: this is **not** "add a flag" — it is **"make inline
mode viable again, behind a flag, with the hygiene the prior
implementation lacked, with carry-over context, and no magic commands"**.

If addressed, the action would: (a) accept a `comment_mode` input
defaulting to `summary`, (b) when `inline`, post line-anchored comments
and on re-review list existing threads via GraphQL, resolve the ones
GitHub marks `isOutdated`, and post the new review without first
calling `deleteReview`, (c) include previous findings (only unresolved
threads, capped at N for token budget) in the new model prompt as
context, (d) leave human-driven resolution of non-outdated threads to
the GitHub UI.

## Confidence

- **HIGH** — strong evidence on dimensions 1–2, the design hotspot
  resolved with a defensible choice (use GitHub's `isOutdated`), the
  carry-over / auto-resolve conflict resolved by narrowing resolve
  scope, the sentinel anti-pattern ruled out by the third-party-
  action constraint. Only unknowns left are implementation details
  (GraphQL client shape, token-budget cap for carry-over, test
  fixtures) — all of which belong in /10x-plan.

## What Changes for /10x-plan

The plan should focus on:

1. `comment_mode` action input (`summary` | `inline`, default
   `summary`) + `Config` field + validation in `loadConfig`.
2. New GraphQL helper module (`src/github-graphql.ts` or extension of
   `github-review.ts`): `listReviewThreads(repo, prNumber, token)` →
   `[{ id, isResolved, isOutdated, path, line, body }]`, and
   `resolveReviewThread(threadId, token)`.
3. Carry-over context: helper `formatPreviousFindings(threads)` that
   produces a compact text block (capped at, say, 20 threads / 4k
   chars) listing unresolved threads with file:line and body excerpt.
   Wired into `attemptModel` so the system/user message includes
   "Previous review found:" + the block before the new diff.
4. Update `dispatchOutput` so that when `comment_mode=inline`:
   - On re-review, list threads via the new helper.
   - Resolve each thread where `isOutdated === true`.
   - Skip `deleteReview` / `cleanupPreviousOutput` for resolved threads
     (they're already terminal); still need it for the body summary
     comment, if any.
   - Post the new review via `createReview` (the existing dead path
     comes back to life).
5. Keep summary mode as the default and unaffected (no behavior
   change for users not setting `comment_mode`).
6. Preserve all security hardening from `parallel-review-security`:
   any carry-over text must go through the same escaping/validation
   pipeline as user-supplied data; the system-vs-user boundary stays
   strict.
7. README + `action.yml` description update documenting
   `comment_mode` and the `pull-requests: write` permission note for
   inline mode.
8. Archive the abandoned `always-comment-in-review` change with a
   pointer to the new change-id.

Out of scope (do not build):

- Content-similarity matching for non-outdated threads.
- Sentinel comment commands.
- Per-severity / per-model comment splits.
- Auto-resolving non-outdated threads.

## References

- Source files:
  - `src/github-review.ts:43-94` — `createReview` (currently unused by
    dispatcher; dead path that comes back to life)
  - `src/github-review.ts:104-153` — `findExistingReview`
  - `src/github-review.ts:155-178` — `deleteReview` (wholesale; bypass
    in inline mode)
  - `src/github-review.ts:180-184` — `shouldUseInlineComments` (unused
    in dispatcher; keep as safety fallback for >50 comments)
  - `src/github-review.ts:186-284` — `postComment` summary path
  - `src/index.ts:34-51` — `cleanupPreviousOutput` (wholesale wipe)
  - `src/index.ts:514-516` — `safeCleanup` (best-effort wrapper)
  - `src/index.ts:520-575` — `dispatchOutput` (summary-only today;
    needs the inline branch reconnected)
  - `src/index.ts:221-223` — `userMsg` (where carry-over context slots
    in)
  - `src/config.ts` — `Config` interface (no `commentMode` field)
  - `src/prompts.ts:231-243` — `buildSystemMessage` (alternative slot
    for carry-over context as a system-message section)
  - `action.yml` — input list (no `comment_mode` input)
- Prior decisions:
  - Commit `5fe7b95` (2026-07-25): "fix: always post summary comment
    instead of inline line comments" — removed the inline branch and
    the rationale ("chaos of outdated inline comments on re-review").
    This change re-offers inline mode behind a flag.
  - `context/changes/always-comment-in-review/change.md` — the
    abandoned change whose scope this one supersedes. To be archived.
  - `context/changes/always-comment-in-review/research.md` — full
    trade-off writeup.
  - `context/archive/2026-07-22-review-improvements/plan.md:250-291` —
    original inline-comments plan (Phase 3 of review-improvements).
- Related research:
  - `context/changes/severity-based-review-messages/` — severity
    rendering (orthogonal).
  - `context/changes/parallel-review-security/` — recent prompt
    hardening (orthogonal but relevant: any carry-over text must
    preserve the same escaping/validation guarantees).
- External references:
  - GitHub GraphQL `PullRequestReviewThread` exposes `isOutdated: Boolean!`
    and `isResolved: Boolean!` directly. Mutation
    `resolveReviewThread(input: {threadId: ID!})` requires the
    thread's `node_id` (from the GraphQL `id` field).