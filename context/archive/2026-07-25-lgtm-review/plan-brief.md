# Post LGTM Comment When No Review Findings — Plan Brief

> Full plan: `context/changes/lgtm-review/plan.md`

## What & Why

When the AI code review finds zero issues, the action currently deletes any previous review/comment and posts nothing. This plan adds a positive "No issues found. LGTM!" comment so PR authors and reviewers get clear feedback that the review passed cleanly.

## Starting Point

The `dispatchOutput` function in `src/index.ts` (lines 285-335) handles all output. When `review.findings.length === 0`, it calls `cleanupPreviousOutput`, logs "Deleted previous review (no issues found)", and returns early — no comment is posted. When findings exist, it posts a comment via `postComment` with the full review. The `createReview` function (github-review.ts:44) supports GitHub PR review events but is unused in the main flow.

## Desired End State

When the AI review finds zero issues, the action posts a comment with the same header format as findings comments (`### AI Code Review` marker + model name + tally), followed by "No issues found. LGTM!". The comment replaces any previous review output.

## Key Decisions Made

| Decision | Choice | Why | Source |
|---|---|---|---|
| Output type | Post a comment | Consistent with current behavior; minimal code change | Plan |
| Message | "No issues found. LGTM!" | Clear, friendly, actionable | Plan |
| Re-run behavior | Delete old, post LGTM | Keeps PR clean; matches existing cleanup pattern | Plan |
| Comment format | Include model + tally | Consistent with findings comments | Plan |
| Testing | Unit test + manual verification | Catches regressions; follows existing patterns | Plan |

## Scope

**In scope:**
- Modify `dispatchOutput` no-findings branch in `src/index.ts`
- Add unit test in `src/github-review.test.ts`

**Out of scope:**
- GitHub PR review (approve) support
- Configuration options for the LGTM message
- Changes to `createReview` function or its tests
- Changes to behavior when findings exist

## Architecture / Approach

Single-file change in `dispatchOutput` (index.ts:296-304). Replace the early return with a `postComment` call using the existing `summaryBody` format. The `summaryBody` already includes the `AI_REVIEW_MARKER`, model name, and tally. The LGTM message is appended after it.

## Phases at a Glance

| Phase | What it delivers | Key risk |
|---|---|---|
| 1. Post LGTM Comment | Modify no-findings branch + add test | Regression on existing findings path |

**Prerequisites:** None — no dependencies or access needed
**Estimated effort:** ~15 minutes, single developer

## Open Risks & Assumptions

- The `summaryBody` variable is constructed before the no-findings check (line 294), so it's available in the branch — no ordering issue
- `postComment` is already imported in `index.ts` (line 6), so no new imports needed

## Success Criteria (Summary)

- LGTM comment posts when no findings found
- Old comment replaced on re-run (no duplicates)
- No regression on PRs with findings
- Unit tests pass
