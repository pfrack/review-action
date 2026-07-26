# Simplify Test Data — Implementation Plan

## Overview

Simplify test data in `src/github-review.test.ts` by removing the `user.login` field from test fixtures, since the code no longer checks `user.login` when matching AI review comments.

## Current State Analysis

The fix in PR #17 changed `findExistingReview` and `findExistingComment` to match only on the `AI_REVIEW_MARKER` prefix (`### AI Code Review`), without checking `user.login`. However, the test data still includes `user: { login: 'github-actions[bot]' }` which is now unnecessary and misleading.

## Desired End State

Test data is simplified — `user.login` is removed from test fixtures where it's not needed, making the tests clearer and less brittle.

## What We're NOT Doing

- Not changing the matching logic (already done in PR #17)
- Not adding new tests
- Not modifying production code

## Implementation Approach

Remove the `user.login` field from test fixtures in `findExistingReview` and `findExistingComment` test cases where the login is no longer checked.

## Phase 1: Simplify Test Data

### Overview

Remove unnecessary `user.login` from test fixtures.

### Changes Required:

#### 1. Test file

**File**: `src/github-review.test.ts`

**Intent**: Remove `user: { login: 'github-actions[bot]' }` from test data where the login is no longer checked by the matching logic.

**Contract**: The test data objects for `findExistingReview` and `findExistingComment` should only include fields that are actually used by the code being tested. Since `user.login` is no longer checked, it can be removed from the matching test cases.

### Success Criteria:

#### Automated Verification:

- Tests pass: `npm test`
- TypeScript compiles: `npx tsc --noEmit`

#### Manual Verification:

- Test data is simpler and clearer
- No test failures related to the removed fields

## Progress

### Phase 1: Simplify Test Data

#### Automated

- [x] 1.1 Remove user.login from findExistingReview test data
- [x] 1.2 Remove user.login from findExistingComment test data
- [x] 1.3 Tests pass
- [x] 1.4 TypeScript compiles

#### Manual

- [x] 1.5 Verify test data is clearer
