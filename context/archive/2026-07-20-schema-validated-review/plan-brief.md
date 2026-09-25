# Schema-Validated Review — Plan Brief

> Full plan: `context/changes/schema-validated-review/plan.md`
> Frame brief: `context/changes/schema-validated-review/frame.md`

## What & Why

**The action has no schema enforcement on LLM output.** Reviews are posted verbatim regardless of shape — malformed markdown, refusals, and truncations all look identical to a legitimate review. No test surface catches quality regressions.

We fix this by adding a Zod-typed `Review`/`Finding` schema, requesting JSON output from models, validating deterministically against the PR diff, and rendering markdown only from the validated object.

## Starting Point

Current state: `NimClient.chat()` returns a raw `.trim()` string (`nim-client.ts:89`). Prompts ask for markdown with `**Severity:**` / `**File:**` / `**Line:**` blocks but the action never inspects them. Tests mock LLM responses with `'test response'`. `finish_reason: 'length'` is defined but silently dropped. Per-file review path (`review.ts:211-251`) is dead code. Orphan `src/prompts/*.txt` files are dead.

## Desired End State

Every review response is parsed into a typed `Review` object. Schema-parse failures are treated as model failures (fall through the chain). Findings are validated against the actual PR changed files and hunks. The PR comment is rendered from the validated object. Truncation (`finish_reason: 'length'`) causes a model skip, not a silent partial review. Golden-file fixtures in tests catch quality regressions.

## Key Decisions Made

| Decision | Choice | Why | Source |
| --- | --- | --- | --- |
| Library | Zod (not BAML) | ~17 KB gzipped, zero codegen, ncc-compatible, industry standard | Frame |
| Mistral JSON path | Tools/function-calling | Same JSON guarantee as NIM's `response_format`; Mistral already supports the tools API | Plan |
| Schema strictness | Required fields + optional line/suggestion | Covers all prompt requirements while allowing line-less (file-wide) findings | Plan |
| Truncation (`length`) | Skip output, try next model | Cleaner UX — one complete review from one model, not a partial + fallback mix | Plan |
| Per-file review path | Delete dead code | Unused since `b2391e6` (Jul 2026); the combined-diff path is better quality | Plan |

## Scope

**In scope:** Review schema (`src/review-schema.ts`), NimClient JSON mode, Mistral tools mode, deterministic diff validation, markdown renderer, golden-file tests, dead code cleanup.

**Out of scope:** BAML or any native-runtime library, prompt-as-code DSLs, streaming schema validation, diff-size guard (deferred — existing F7 WARNING), per-language prompt content refactoring, daily benchmark integration.

## Architecture / Approach

```
LLM response (JSON / tools call)
  → NimClient parses content
  → Zod ReviewSchema.safeParse()
    → parse success: validate against PR diff (file exists, lines in hunk)
    → parse failure or diff-validation failure: retry once with error appended
    → retry failure: treat as model failure → fall through chain
  → validated Review object → TopicRenderer.markdown() → postComment()
```

Zod's `.safeParse()` handles type validation. A deterministic `validateReview()` function handles diff-level checks. The fallback chain (`model-chain.ts`) is unchanged — schema failures are injected into the existing "model failed" catch path.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Schema + Parse Layer | `Review` type, Zod schema, `response_format` / tools extensions in NimClient, retry-on-fail, prompt updates | Mistral tools API shape differs from NIM JSON mode — must branch correctly |
| 2. Diff Validation | Each finding's file/line checked against PR changed hunks | Edge case: findings without line numbers can't be validated at hunk level |
| 3. Markdown Renderer + Cleanup | Rendered PR comments from validated objects; dead code removed | Comment header/marker must stay identical so `findExistingComment` still works |
| 4. Golden-File Tests | Fixtures for valid/malformed/refusal/truncated, regression assertions | None low risk |

**Prerequisites:** `zod@^4` npm install (adds ~17 KB to bundle)
**Estimated effort:** ~2-3 sessions across 4 phases

## Open Risks & Assumptions

- NIM's `response_format: { type: 'json_schema', strict: true }` works as documented (untested in this repo)
- Mistral's tools API accepts `function` calls with JSON schemas and returns function-call JSON (confirmed by docs, untested directly)
- Diff line ranges are available from the parsed diff (the current `parseDiff` returns file→diffRaw strings; line numbers must be extracted from `@@ ... @@` hunk headers)
- All six language prompts can share one schema with one prompt JSON-format instruction (verified: they all use the same `**Severity:**` / `**File:**` / `**Line:**` / `**Issue:**` / `**Suggestion:**` shape)

## Success Criteria (Summary)

- All existing tests pass unchanged
- New schema tests pass with valid, malformed, refusal, and truncated fixtures
- NIM and Mistral models produce parseable JSON output
- PR comments are rendered from validated Review objects with identical header/marker
- Dead code (per-file review path, orphan .txt prompts) is removed
