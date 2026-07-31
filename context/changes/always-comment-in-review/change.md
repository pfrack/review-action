---
change_id: always-comment-in-review
created: 2026-07-25
updated: 2026-07-25
status: preparing
title: "Always use a single summary comment instead of inline line comments"
researcher: opencode
---

# Always Use Summary Comment Instead of Inline Comments

## Problem

The action currently posts inline comments on individual lines when ≤50 findings have line numbers (`shouldUseInlineComments` at `src/github-review.ts:182`). On re-review (new push/reopen), `cleanupPreviousOutput` deletes the previous review, but GitHub may leave inline comments as "outdated" rather than fully removing them, creating visual clutter and chaos.

## Goal

Always use a single summary comment (Issues API) instead of inline line comments (Reviews API), so that re-reviews cleanly replace the previous comment without accumulating outdated inline comments.
