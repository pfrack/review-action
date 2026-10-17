---
date: 2026-07-25 16:13:28 +0200
researcher: opencode
git_commit: 218582b7827f0a1d1422aaee05672d384c1c661d
branch: main
repository: pfrack/review-action
topic: "Always use a single summary comment instead of inline line comments"
tags: [research, codebase, review-output, inline-comments, summary-comment, dispatch-output]
status: complete
last_updated: 2026-07-25
last_updated_by: opencode
---

# Research: Always Use a Single Summary Comment Instead of Inline Line Comments

**Date**: 2026-07-25 16:13:28 +0200
**Researcher**: opencode
**Git Commit**: 218582b7827f0a1d1422aaee05672d384c1c661d
**Branch**: main
**Repository**: pfrack/review-action

## Research Question

The user wants to avoid many inline comments on individual lines in PR reviews, feeling they create chaos. They prefer a single summary comment instead. Specifically: what happens on re-review when inline comments are used, and how does the current code handle the inline-vs-summary decision?

## Summary

The action currently uses GitHub PR **inline comments** (via the Reviews API) when the number of line-level findings is ≤ 50 (`INLINE_COMMENT_THRESHOLD` at `src/github-review.ts:180`). On re-review (new push/reopen), `cleanupPreviousOutput` (`src/index.ts:37-46`) attempts to delete the previous review, but GitHub may leave inline comments as "outdated" rather than fully removing them, creating visual clutter. A single summary comment (via the Issues Comments API) avoids this because `postComment` (`src/github-review.ts:186-192`) finds and replaces the existing comment atomically.

## Detailed Findings

### 1. Inline vs Summary Comment Decision

**File**: `src/github-review.ts:180-184`

```typescript
export const INLINE_COMMENT_THRESHOLD = 50;

export function shouldUseInlineComments(findings: ReviewFinding[]): boolean {
  return findings.filter(f => f.line_start != null).length <= INLINE_COMMENT_THRESHOLD;
}
```

- Counts only findings where `line_start` is non-null (findings anchored to specific lines).
- Returns `true` (inline comments) if that count is ≤ 50.
- Returns `false` (summary comment) if that count exceeds 50.
- **Default behavior**: For most PRs with ≤50 line-level findings, inline comments are used.

**Called from**: `src/index.ts:308` in `dispatchOutput`.

### 2. How Inline Comments Are Posted

**File**: `src/index.ts:308-319` (inline path)

```typescript
if (shouldUseInlineComments(review.findings)) {
  await cleanupPreviousOutput(repo, prNumber, token);
  let body = `${summaryBody}\n${renderReview(review)}\n`;
  if (truncated) { body += `...`; }
  const reviewId = await createReview(repo, prNumber, commitSha, review.findings, body, token);
}
```

- Uses `createReview()` which POSTs to `https://api.github.com/repos/{repo}/pulls/{prNumber}/reviews` with `event: 'COMMENT'`.
- Each finding with a `line_start` becomes an inline comment anchored to a specific line.
- The full rendered review is also included in the review body.

**File**: `src/github-review.ts:44-103` — `createReview` implementation.

### 3. How Summary Comments Are Posted

**File**: `src/index.ts:320-332` (summary path)

```typescript
else {
  await cleanupPreviousOutput(repo, prNumber, token);
  const sections = [summaryBody, `\n${renderReview(review)}\n`];
  if (truncated) { sections.push(`...`); }
  await postComment(repo, prNumber, token, sections.join('\n'));
}
```

- Uses `postComment()` which POSTs to `https://api.github.com/repos/{repo}/issues/{prNumber}/comments`.
- Posts a single top-level comment with the full rendered review.

**File**: `src/github-review.ts:186-192` — `postComment` implementation.

### 4. What Happens on Re-Review (New Push / Reopen)

**File**: `src/index.ts:37-46` — `cleanupPreviousOutput`

```typescript
async function cleanupPreviousOutput(repo, prNumber, token): Promise<void> {
  const existingReviewId = await findExistingReview(repo, prNumber, token);
  if (existingReviewId) {
    await deleteReview(repo, prNumber, existingReviewId, token);
  }
  const existingCommentId = await findExistingComment(repo, prNumber, token);
  if (existingCommentId) {
    await deleteComment(repo, existingCommentId, token);
  }
}
```

This function is called before every new review/comment is posted. It:

1. **Finds and deletes existing PR reviews** (via `findExistingReview` → `deleteReview`) — matches reviews whose body starts with `### AI Code Review` and posted by the bot.
2. **Finds and deletes existing issue comments** (via `findExistingComment` → `deleteComment`) — matches comments with the same marker.

**The re-review problem with inline comments:**

When inline comments are used (PR Reviews API), GitHub's behavior on deletion is nuanced:

- `deleteReview` sends `DELETE /repos/{repo}/pulls/{prNumber}/reviews/{reviewId}` — this deletes the **review object** itself.
- However, GitHub may display the deleted review's inline comments as **"outdated" comments** on the diff, rather than fully removing them from view.
- On each re-review, a new review with new inline comments is created, while old inline comments may persist as "outdated" — creating visual clutter and confusion.
- The user's concern about "chaos" is valid: multiple re-reviews can stack up outdated inline comments.

**With summary comments (Issues API), this problem doesn't occur:**

- `postComment` calls `findExistingComment` → `deleteComment` → `createComment`.
- `deleteComment` sends `DELETE /repos/{repo}/issues/comments/{commentId}` — this fully removes the comment.
- The new comment replaces the old one atomically.
- No "outdated" comments accumulate.

### 5. Edge Case: All Findings Lack `line_start`

**File**: `src/github-review.ts:55` — `createReview` filters findings:

```typescript
const comments: ReviewComment[] = findings
  .filter(f => f.line_start != null)
  .map(f => { ... });
```

- If all findings lack `line_start` (file-level issues), `shouldUseInlineComments` returns `true` (count is 0 ≤ 50).
- But `createReview` would create a review with **zero inline comments** — all findings only appear in the review body.
- This is a silent no-op for inline comments, which is another reason the user finds it confusing.

### 6. Prior Decisions

From `context/changes/review-improvements/reviews/triage.md`:
- Inline comments were added as the primary path (≤50 findings) with summary comment as fallback (>50 findings).
- The threshold was chosen to balance signal-to-noise on the diff vs. a single long comment.

From `context/changes/improvements-research/research.md` (D3):
- Cleanup failures were previously fatal; now they are best-effort (try/catch with `core.warning`).
- This means if `deleteReview` fails on re-review, the old inline comments persist alongside new ones — compounding the chaos.

## Code References

- `src/github-review.ts:180` — `INLINE_COMMENT_THRESHOLD = 50`
- `src/github-review.ts:182-184` — `shouldUseInlineComments()` — the threshold logic
- `src/github-review.ts:44-103` — `createReview()` — posts inline comments via Reviews API
- `src/github-review.ts:186-192` — `postComment()` — posts summary comment via Issues API
- `src/github-review.ts:257-276` — `createComment()` — actual comment creation (private)
- `src/github-review.ts:105-154` — `findExistingReview()` — finds existing PR review by marker
- `src/github-review.ts:156-178` — `deleteReview()` — deletes PR review via DELETE API
- `src/github-review.ts:213-255` — `findExistingComment()` — finds existing issue comment by marker
- `src/github-review.ts:194-211` — `deleteComment()` — deletes issue comment via DELETE API
- `src/index.ts:37-46` — `cleanupPreviousOutput()` — orchestrates cleanup of both review and comment
- `src/index.ts:287-351` — `dispatchOutput()` — the main dispatch function with the inline/summary decision
- `src/index.ts:308-319` — inline comments path (≤50 findings)
- `src/index.ts:320-332` — summary comment path (>50 findings)
- `src/github-review.ts:7` — `AI_REVIEW_MARKER = '### AI Code Review'` — used to find/replace existing output

## Architecture Insights

1. **Two output channels**: The action uses two different GitHub APIs — PR Reviews API (inline comments) and Issues Comments API (summary comments). The decision is based on a simple count threshold.

2. **Find-and-replace pattern**: Both channels use a find-and-replace pattern: find existing bot output (by marker + bot login), delete it, then post new output. This ensures only one bot review/comment exists at a time.

3. **Inline comments are fragile on re-review**: GitHub's deletion of PR reviews doesn't always fully remove inline comments from the diff view. They may appear as "outdated" comments, accumulating across re-reviews.

4. **Summary comments are clean on re-review**: Issue comments are fully deleted and replaced, leaving no trace of previous versions.

5. **The threshold is hardcoded**: `INLINE_COMMENT_THRESHOLD = 50` is a constant, not configurable. Changing the behavior to always use summary comments would require either lowering the threshold to 0 or adding a config option.

## Historical Context

- `context/changes/review-improvements/reviews/triage.md` — Established the inline comments (≤50) vs summary comment (>50) decision.
- `context/changes/improvements-research/research.md` (D3) — Documented that cleanup failures previously aborted the action; now best-effort.
- `context/changes/daily-benchmark/plan.md` (Phase 4) — Established the `### AI Code Review` marker and find-and-replace pattern.
- `context/changes/severity-based-review-messages/research.md` — Documented the severity-aware rendering (emoji + grouped sections).
- `context/changes/schema-validated-review/` — Established the schema validation + deterministic rendering contract.

## Related Research

- `context/changes/severity-based-review-messages/research.md` — Severity-aware rendering
- `context/changes/schema-validated-review/research.md` — Schema validation and deterministic rendering
- `context/changes/review-improvements/reviews/triage.md` — Inline vs summary comment decision
- `context/changes/improvements-research/research.md` — Cleanup error handling and edge cases

## Open Questions

1. Should the inline-vs-summary decision be configurable (e.g., `inline_comments: true/false` input), or should inline comments be removed entirely?
2. If inline comments are kept as an option, should `cleanupPreviousOutput` also collapse outdated inline comments?
3. Should there be a minimum comment guarantee (always post at least one comment, even with zero findings)?
