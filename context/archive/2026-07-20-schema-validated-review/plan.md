# Schema-Validated Review Implementation Plan

## Overview

Add typed structured-output validation to the review loop. Define a Zod-typed `Review`/`Finding` schema, request JSON output from models (NIM uses `response_format`, Mistral uses tools/function-calling), validate deterministically against the PR diff, render markdown only from the validated object. Truncation and parse failures cause model skips through the existing fallback chain.

## Current State Analysis

The action posts free-text markdown to PR comments with no schema enforcement. `NimClient.chat()` returns a raw `.trim()` string (`nim-client.ts:89`). `finish_reason: 'length'` is defined (`nim-client.ts:41`) but silently dropped (`index.ts:121`). Per-file review path (`review.ts:211-251`) is dead code (unused since `b2391e6`). Orphan `src/prompts/*.txt` files are duplicated in the bundle. No golden-file tests exist. Refusals and malformed responses are posted verbatim.

## Desired End State

Every review response is parsed into a typed `Review` object via Zod. Schema-parse failures are treated as model failures (fall through to the next model in the chain). Findings are validated against actual PR changed files and hunks. The PR comment is rendered from the validated object. Truncation (`finish_reason: 'length'`) causes a model skip rather than a silent partial review. Golden-file fixtures catch quality regressions. Dead code (per-file path, orphan `.txt` prompts) is removed.

### Key Discoveries:

- `src/nim-client.ts:58-93` — `chat()` currently drops `finish_reason` and returns `content` only
- `src/nim-client.ts:30-36` — `ChatRequest` has no `response_format` or `tools` field
- `src/index.ts:99-145` — review loop assembles one combined diff and iterates the chain
- `src/review.ts:211-251` — `reviewFile`/`reviewFileWithFallback` is dead code (unused since combined-diff change)
- `src/prompts.ts:3-159` — 6 language prompts all use the same markdown output specification; all can share one JSON schema + one JSON-format instruction change
- `src/prompts/*.txt` — 6 orphan files, duplicates of inline strings, waste ~6 KB in bundle
- `src/review.ts:58-75` — `parseDiff()` splits raw diff into file→diffText map; usable for hunk-level validation with minor extension
- `package.json:11-13` — zero runtime deps beyond `@actions/core`

## What We're NOT Doing

- **BAML or any native-runtime structured-output library** — the reframe settled this (frame.md).
- **Prompt-as-code DSL** — prompts stay as TS string literals; only the output format instruction changes.
- **Diff-size guard** — deferred (existing F7 WARNING, `context/changes/nodejs-rewrite/reviews/impl-review.md:104-116`).
- **Streaming schema validation** — schemas are validated on the final response; streaming stays as-is.
- **Per-language prompt content refactoring** — language-specific focus areas are out of scope.
- **Daily benchmark integration** — schema does not change model ranking.
- **`custom_` header support** (for Kilo `x-kilocode-mode`) — out of scope.

## Implementation Approach

1. **Schema + parse layer**: Add Zod. Define `Review`/`Finding` types. Extend `NimClient.chat()` to accept a `responseFormat` enum that injects `response_format` (NIM) or `tools` (Mistral) into the payload. Update prompts to request JSON matching the schema. Parse with `safeParse()`; retry once with validation error appended as a user message. Treat parse failures as model failures.

2. **Diff validation**: Extract hunk-line ranges from diff `@@ ... @@` headers. Validate each finding's `file` exists in the PR's changed files set and `line_start..line_end` falls inside a changed hunk. Findings that fail validation are dropped with a warning log.

3. **Markdown renderer + cleanup**: New `renderReview(review, modelShort, truncated, maxFiles, skippedCount)` function produces the PR comment body. Replace the raw-`review` assembly in `index.ts:137-145`. Delete `reviewFile` and `reviewFileWithFallback` from `review.ts`. Delete `src/prompts/*.txt`.

4. **Golden-file tests**: Add fixture JSON files under `src/__fixtures__/`. Test `safeParse()` on valid, malformed, refusal, truncated, and empty fixtures. Test `validateFindings()`. Test `renderReview()` diff stability.

---

## Phase 1: Schema & Parse Layer

### Overview

Define the Zod types, extend `NimClient` for structured-output requests, update prompts, wire parsing and retry into the review loop.

### Changes Required:

#### 1. New dependency

**File**: `package.json`

**Intent**: Add `zod` as a runtime dep. Required for the Review schema and automatic type inference.

**Contract**: `"zod": "^4.4.3"` in `dependencies`.

---

#### 2. New file: Review schema

**File**: `src/review-schema.ts`

**Intent**: Single source of truth for the structured review output. Exports a Zod schema, an inferred TypeScript type, and a NIM-API-safe JSON Schema representation for use in `response_format: { type: 'json_schema', schema: ... }`.

**Contract**:

- `ReviewFinding` — Zod object:
  - `file: string` (required)
  - `severity: z.enum(['Critical', 'Warning', 'Suggestion'])` (required)
  - `line_start: number | null` (optional — null for file-wide findings)
  - `line_end: number | null` (optional — null for file-wide findings)
  - `issue: string` (required)
  - `suggestion: string | null` (optional)
- `Review` — Zod object:
  - `findings: ReviewFinding[]` (required; empty array = "no issues found")
  - `summary: string | null` (optional)
- `ReviewSchema` — the Zod object, exported.
- `ReviewType` — `z.infer<typeof ReviewSchema>`, exported.
- `ReviewJsonSchema` — a JSON Schema object (derivable from Zod `.describe()` or hand-written) for NIM's `response_format.schema` field.
- `codeReviewSchemaDef` — the JSON Schema definition stringified, for embedding in prompts: "Respond in JSON matching this schema: \`\`\`json\n{...}\n\`\`\`"

---

#### 3. NimClient structured-output support

**File**: `src/nim-client.ts`

**Intent**: Extend `chat()` to optionally request structured JSON output. NIM endpoints use `response_format: { type: 'json_schema', strict: true, schema }`. Mistral uses `tools: [{ function: { name: 'review', parameters: schema }, type: 'function' }], tool_choice: 'required'`. The caller selects the mode per provider.

**Contract**:

- Add `ResponseFormat` type: `'json_schema' | 'tools' | 'text'` (default `'text'`).
- Add `structuredSchema` field to `ChatOptions`: `{ schema?: object, format?: ResponseFormat }`.
- When `opts.schema` and `opts.format` are set:
  - `'json_schema'`: add `response_format: { type: 'json_schema', strict: true, json_schema: { name: 'review', schema: opts.schema } }` to the payload.
  - `'tools'`: add `tools: [{ type: 'function', function: { name: 'review_for_code_diff', description: '...', parameters: opts.schema } }], tool_choice: { type: 'function', function: { name: 'review_for_code_diff' } }`.
  - response extraction: if `data.choices[0].message.tool_calls` exists, extract `tool_calls[0].function.arguments` as the content (parse as JSON). Otherwise fall back to `message.content`.
- Keep `finish_reason` — return it in `ChatResult` (add `finishReason: string | undefined`). Required for Phase 2's truncation handling.
- Keep the existing provider-label detection (`nim-client.ts:80-82`) in error messages; it's already correct.

---

#### 4. Updated prompts

**File**: `src/prompts.ts` and `src/review.ts`

**Intent**: Replace the markdown output specification in `BASE_SYSTEM_PROMPT` and all 6 language prompts with a JSON-output instruction pointing to the schema. All prompts use the same JSON shape, so the change is a single text replacement per template.

**Contract**:

- `BASE_SYSTEM_PROMPT` in `review.ts:6-15`: Change the output format instruction from:
  ```
  Respond in concise markdown with findings for each file. For each finding use:
  - **File:** path
  - **Severity:** Critical | Warning | Suggestion
  ...
  If the code looks fine, say "No issues found."
  ```
  to: `Respond in JSON matching this schema: [JSON Schema inline]. Include a "findings" array. If the code looks fine, respond with an empty findings array.`

  The schema is emitted inline as a compact JSON string to keep the prompt self-contained.

- Each language prompt in `prompts.ts:3-159`: Same change — replace the `Respond in concise markdown...` paragraph with the JSON instruction. Keep the language-specific focus area text unchanged.

- Export `JSON_SCHEMA_DEFINITION` from `src/review-schema.ts` and reference it when building system prompts.

---

#### 5. Review loop: parse + retry

**File**: `src/index.ts`

**Intent**: After `client.chat()` returns, parse the response through `ReviewSchema.safeParse()`. On failure, retry once by appending the Zod validation error as a user message and calling `client.chat()` again. On second failure, treat as model failure (continue the chain). On success, validate findings (Phase 2) and render.

**Contract**:

- After line 119 (`const result = await client.chat(...)`), before line 121 (`if (result.content && result.content.trim())`):
  1. If `result.finishReason === 'length'`, skip this model (log `core.info('...truncated, trying next...')`; continue loop).
  2. `ReviewSchema.safeParse(JSON.parse(result.content))`.
  3. On parse failure: append the Zod error as a user message `"Your previous response was not valid JSON matching the required schema. Errors: ...\nPrevious response: ...\nPlease respond with valid JSON."` and re-call `client.chat()` with the new messages array.  
  4. On second failure: `core.info('...JSON validation failed after retry, trying next...')`; continue loop.
  5. On parse success: pass the typed `Review` to the diff validator (Phase 2) before breaking.

- The `promptMode: 'replace'` case (user-supplied custom prompt): If the user replaces the system prompt, their prompt may not ask for JSON. The action should still try `safeParse` on the response — if it fails, fall back to emitting the raw text as an unstructured review with a `**Note:** The model's response did not match the expected JSON schema; showing raw output.` warning.

---

#### 6. Model-chain selection logic (minor)

**File**: `src/index.ts` (lines 110-131)

**Intent**: When calling `client.chat()`, pass the appropriate `responseFormat` and schema based on `tagged.provider`:
- `'nim'` or `'custom'`: `format: 'json_schema'`, schema = `ReviewJsonSchema`
- `'mistral'`: `format: 'tools'`, schema = `ReviewJsonSchema`

**Contract**: Add a `providerToFormat(provider): ResponseFormat` helper that maps provider → format. The `chat()` call becomes:
```ts
const result = await client.chat(tagged.id, [...], {
  temperature: 0.2,
  maxTokens: 4096,
  schema: ReviewJsonSchema,
  format: providerToFormat(tagged.provider),
});
```

---

### Success Criteria:

#### Automated Verification:

- `npm run build` succeeds with `zod` bundled
- `npm test` — new schema tests pass for valid/malformed/refusal/truncated fixtures
- `npm run typecheck` — no type errors from new `ReviewType` usage
- All existing tests continue to pass (the NimClient interface is extended, not changed)
- `safeParse` rejects empty-string input and non-JSON responses
- `safeParse` accepts all-strict-minimal and all-fields fixtures

#### Manual Verification:

- Run a PR review against a test PR with the new code; verify JSON output is parsed and renders correctly
- Verify Mistral fallback produces parseable JSON (test with a PR using `mistral-only` config)
- Verify `custom` endpoint JSON mode works (test with `custom_api_url` pointing to a known OpenAI-compatible endpoint)
- Verify that a model returning "I cannot review" (refusal) causes a model skip, not a posted refusal text

---

## Phase 2: Diff Validation

### Overview

Validate each finding against the actual PR diff. Ensure `file` exists in the changed file set and `line_start..line_end` falls within a changed hunk. This prevents hallucinations (fabricated files/lines) from reaching the PR comment.

### Changes Required:

#### 1. Hunk-range extraction utility

**File**: `src/review.ts` (new function near `parseDiff`)

**Intent**: Parse `@@ ... @@` hunk headers from the diff text to extract per-file changed line ranges. Used by the finding validator.

**Contract**:
- `parseDiffHunks(diffText: string): Array<{ start: number; end: number }>` — extracts line ranges from `@@ -oldStart,oldCount +newStart,newCount @@` headers. Returns the NEW-side ranges (`newStart` to `newStart + newCount - 1`). Returns empty array if no hunks found or no `+` side lines changed.
- `getFileHunks(filesDiff: Record<string, string>): Map<string, Array<{ start: number; end: number }>>` — maps each file→hunk ranges.

---

#### 2. Finding validator

**File**: `src/review.ts` (new function)

**Intent**: Validate a `Review` object against the parsed diff. Each finding's `file` must exist in the changed set. If `line_start` is set, `line_start..line_end` must overlap at least one hunk in that file.

**Contract**:

- `validateFindings(review: ReviewType, filesDiff: Record<string, string>, changedFiles: Set<string>): { valid: ReviewType; warnings: string[] }`:
  - Removes findings where `!changedFiles.has(finding.file)` — logs `'Warning: finding references unknown file "${finding.file}", dropping'`.
  - Removes findings where `line_start` is set but falls outside any hunk in that file (log warning).
  - Keeps findings with `line_start === null` (file-wide concerns are accepted — e.g., "This file lacks tests").
  - If no valid findings remain after filtering, adds a warning finding: `{ file: '<global>', severity: 'Suggestion', issue: 'All findings were invalid — see model output for context', ... }`.
  - Returns `{ valid: validated Review object (matching ReviewType), warnings: string[] }`.

---

#### 3. Wire validation into the review loop

**File**: `src/index.ts` (after Phase 1's schema parse, before `break`)

**Intent**: After `safeParse` succeeds, run `validateFindings()` with the parsed diff + changed file set. If no valid findings remain (`valid.findings.length === 0` and `review.summary` is also empty), treat as "no issues found" and emit the "no issues" message rather than the warning-finding blob.

**Contract**:

```ts
const changedFiles = new Set(reviewableFiles);
const validated = validateFindings(review, filesDiff, changedFiles);
for (const w of validated.warnings) core.warning(w);
if (validated.valid.findings.length === 0 && !validated.valid.summary) {
  review = ''; // will fall through to "no issues" render
} else {
  review = validated.valid; // typed object for renderer
}
```

---

### Success Criteria:

#### Automated Verification:

- `validateFindings()` drops finding with non-existent file
- `validateFindings()` drops finding with line range outside changed hunks
- `validateFindings()` keeps file-wide findings (null line_start)
- `validateFindings()` emits warnings for dropped findings
- Empty diff → all findings dropped, warning finding inserted
- All existing tests pass (no interface changes to exported functions)

#### Manual Verification:

- Run a test PR where the model hallucinates a file path; verify the finding is silently dropped and logged
- Run a test PR where the model gives a correct line number; verify the finding passes

---

## Phase 3: Markdown Renderer + Cleanup

### Overview

Render a validated `Review` object into the PR comment markdown format. Remove the dead per-file code path. Delete orphan prompt files.

### Changes Required:

#### 1. Review renderer

**File**: `src/review.ts` (new function)

**Intent**: Convert a validated `Review` object into the markdown string that `postComment` expects. Produces the same header (`### AI Code Review`) and model attribution that `index.ts` currently constructs, plus file-grouped findings.

**Contract**:

- `renderReview(review: ReviewType, opts: { modelName: string; truncated?: boolean; maxFiles?: number; skippedCount?: number }): string`:
  - Header: `### AI Code Review\n\n<sub>Model: ${modelShort}</sub>\n`
  - Body: Group findings by file (alphabetical). For each file: `**File:** \`path\`` then each finding as a sub-list:
    - `**Severity:** ${sev}\n**Issue:** ${issue}` (if suggestion: `\n**Suggestion:** ${suggestion}`) (if line: `**Line:** ${line_start}${line_end ? '-' + line_end : ''}`)
  - No findings → `No issues found.`
  - If `opts.summary`, append after findings: `**Summary:** ${summary}`
  - If `opts.truncated`, append: `\n\n---\nReached max file limit (${maxFiles}); ${skippedCount} files skipped.`
  - Output must start with `### AI Code Review` — required by `findExistingComment` (`review.ts:143`).

---

#### 2. Wire renderer into index.ts

**File**: `src/index.ts`

**Intent**: Replace the raw-string assembly (`lines 137-145`) with `renderReview()`.

**Contract**:

```ts
// Remove lines 137-145, replace with:
const reviewBody = review
  ? renderReview(review, {
      modelName: usedModel,
      truncated,
      maxFiles: config.maxFiles,
      skippedCount: truncated ? reviewableFiles.length - config.maxFiles : 0,
    })
  : '### AI Code Review\n\nNo issues found.';
await postComment(repo, prNumber, token, reviewBody);
```

The `review` variable changes from `string` to `ReviewType | null`. The "No review content returned from any model." fallback at line 134 becomes `review = null` and renders as the error message (which stays the same format: free text under the standard header).

---

#### 3. Remove dead code: per-file review path

**File**: `src/review.ts`

**Intent**: `reviewFile()` (lines 211-227) and `reviewFileWithFallback()` (lines 229-251) are dead code — unused since the combined-diff change at `b2391e6`. Removing them eliminates maintenance burden and tells future readers the call path is the one true path.

**Contract**: Delete lines 211-251 (both functions). Remove the now-unused imports: `TaggedModel`, `Provider`, `ChatMessage` if they become unused after the deletion. Keep `NimClient` import (used by `resolveSystemPrompt`'s type).

---

#### 4. Remove orphan prompt files

**File**: `src/prompts/go.txt`, `python.txt`, `typescript.txt`, `java.txt`, `rust.txt`, `cpp.txt`

**Intent**: These 6 `.txt` files are character-for-character duplicates of the inline TS strings (`prompts.ts:3-159`). They were left behind after `254896c` inlined them to work around an ncc ESM bug. They waste ~6 KB in the bundle and drift from the source of truth.

**Contract**: Delete all 6 `.txt` files. Remove the `cp -r src/prompts dist/prompts` step from `package.json:7,9` (both `build` and `package` scripts).

---

### Success Criteria:

#### Automated Verification:

- `renderReview()` with 2 findings across 2 files produces correct markdown
- `renderReview()` with empty findings produces `No issues found.`
- `renderReview()` with `truncated: true` includes the skip footer
- `renderReview()` with `summary` includes the summary text
- The output of `renderReview()` starts with `### AI Code Review`
- `npm test` passes (review.test.ts fixtures updated)
- `npm run build` succeeds without orphan `.txt` copies
- `npm run typecheck` passes after removing dead functions

#### Manual Verification:

- Run a full PR review and verify the comment format is identical (except structured output, which is better)
- Verify the `### AI Code Review` marker is still present so `findExistingComment` matches
- Verify the model attribution line still exists

---

## Phase 4: Golden-File Tests

### Overview

Add fixture-based regression tests for the schema parser, diff validator, and markdown renderer. Each fixture is a raw model response that exercises one path in the parse-validate-render pipeline.

### Changes Required:

#### 1. Fixture files

**File**: `src/__fixtures__/` (new directory)

**Intent**: Provide stable, version-controlled response fixtures that capture the contract between models and the action. Each fixture is a JSON object `{ rawResponse: string, expectedParsed?: ReviewType, shouldParse: boolean, notes?: string }`.

**Fixture list**:

- `fixture-valid-complete.json` — Full findings across 2+ files, all fields populated
- `fixture-valid-minimal.json` — Findings with only required fields (no suggestion, no line numbers)
- `fixture-valid-empty.json` — `{"findings": []}` — models' "no issues" response
- `fixture-malformed-not-json.json` — Returns plain text prose instead of JSON
- `fixture-malformed-wrong-schema.json` — Returns JSON but with wrong field names/types
- `fixture-refusal.json` — "I cannot review this code" or similar refusal
- `fixture-truncated-json.json` — Valid JSON prefix but truncated mid-object (simulates `finish_reason: 'length'`)
- `fixture-inline-schema.json` — (optional) Tests prompt-inlined JSON schema text for difference

---

#### 2. Schema parser tests

**File**: `src/review-schema.test.ts`

**Intent**: Test `ReviewSchema.safeParse()` with each fixture. Also test `safeParse` with edge inputs (empty string, whitespace-only, null/undefined via wrapper, deeply nested objects).

**Contract**:

- `describe('ReviewSchema')`:
  - `it('parses valid complete response')` — `safeParse(JSON.parse(fixtureValid.response)).success === true`
  - `it('parses minimal valid response')` — `safeParse(...).success === true`
  - `it('parses empty findings as valid')` — `safeParse({"findings":[]}).success === true`
  - `it('rejects non-JSON string')` — wrap `JSON.parse` tries, assert safeParse called on parsed content
  - `it('rejects wrong schema structure')` — e.g., `{"file":"x"}` at top level when findings array expected
  - `it('rejects invalid severity values')` — `severity: 'Blocker'` should fail enum validation
  - `it('rejects missing required fields')` — `{}` should fail `file` and `issue` required
  - `it('accepts null optional fields')` — `line_start: null, line_end: null, suggestion: null` should pass
  - `it('rejects truncated JSON')` — `safeParse(JSON.parse(partialString))` may throw on parse; test wrapper handles that

---

#### 3. Diff validation tests

**File**: `src/review.test.ts` (extend existing)

**Intent**: Test `validateFindings()` against known diff inputs.

**Contract**:

- `describe('validateFindings')`:
  - `it('drops finding for file not in changed set')`
  - `it('drops finding with line outside all hunks')`
  - `it('keeps finding with line inside hunk')`
  - `it('keeps file-wide finding (no line)')`
  - `it('inserts warning finding when all findings dropped')`
  - `it('returns empty valid finding for clean file')`

---

#### 4. Renderer tests

**File**: `src/review.test.ts` (extend)

**Intent**: Test `renderReview()` output against known markdown expectations.

**Contract**:

- `describe('renderReview')`:
  - `it('starts with comment marker')` — `renderReview(...).startsWith('### AI Code Review')`
  - `it('renders model name in header')` — Includes `<sub>Model: </sub>`
  - `it('groups findings by file')` — Two findings in one file produce one `**File:**` block with two sub-items
  - `it('renders no-issues for empty findings')` — Contains `No issues found.`
  - `it('includes truncation footer')` — `truncated: true` appends skip message
  - `it('includes summary when present')` — Summary text appears after findings

---

### Success Criteria:

#### Automated Verification:

- All fixture tests pass: `npm test`
- Code coverage for `safeParse`, `validateFindings`, `renderReview` is >90%
- No tests depend on network (fixtures are local JSON files)

#### Manual Verification:

- Add a new fixture in the future and verify it catches a prompt-change regression

---

## Testing Strategy

### Unit Tests:

- `src/review-schema.test.ts` (Phase 4): Schema parsing with fixtures, edge cases
- `src/review.test.ts` (Phases 2, 3, 4): `validateFindings`, `renderReview`, `parseDiffHunks`
- `src/nim-client.test.ts` (Phase 1): `response_format` and `tools` payload generation, `tool_calls` response extraction

### Integration Tests:

- `src/index.ts` review loop with mocked `NimClient` returning structured JSON (extend `review.test.ts`)

### Manual Testing Steps:

1. Run the action against a test PR with `NIM_API_KEY` set → verify JSON output parses, renders correctly
2. Run with `MISTRAL_API_KEY` only → verify `tools` path works on Mistral
3. Send a model a prompt that triggers a refusal → verify skip, not a posted refusal
4. Send a model a prompt with a truncated response → verify skip, not a partial review

## Performance Considerations

- **Bundle**: `zod@^4` adds ~17 KB gzipped to the 980 KB bundle — negligible.
- **Latency**: Schema parsing is sub-millisecond. Diff validation scans hunk headers (O(files × hunks)). Retry-on-failure adds one extra API call per parse-failure (rare with `response_format: strict: true`).
- **Retry overhead**: If every model fails JSON parsing, the chain retries each once (doubling calls). This is bounded by the fallback chain length (7 NIM + 4 Mistral = 11 models worst case, 22 total calls). Realistically, strict JSON mode means near-zero parse failures on NIM and Mistral.

## Migration Notes

- Existing PR comments are unaffected (this is a forward change, no comment migration needed).
- The `### AI Code Review` marker stays identical, so `findExistingComment` (which updates the same comment on re-reviews) continues to work.
- Users of `custom_api_key` + any generic OpenAI-compatible endpoint: JSON mode depends on the endpoint supporting `response_format: { type: 'json_schema', strict: true }`. If the endpoint does not support it, the model will likely ignore the format instruction and produce free text, which will fail `safeParse` → retry → fall through to the next model. Users of non-JSON-mode endpoints should see no regression (the chain falls through gracefully).
- Users of `promptMode: 'replace'` (custom system prompt): The structured JSON instruction is embedded in the base prompt. If the custom prompt replaces it, the model may not produce JSON. The action handles this by trying `safeParse` and falling back to raw text with a warning (per Phase 1, item 5).

## References

- Frame brief: `context/changes/schema-validated-review/frame.md`
- Research/codebase audit: three parallel sub-agents (codebase audit, BAML fit, alternatives comparison)
- Key source files: `src/index.ts:99-145`, `src/nim-client.ts:30-93`, `src/review.ts:6-15,58-75,111-251`, `src/prompts.ts:3-183`
- Prior related change: `context/changes/baml-prompts/` (abandoned)

## Progress

### Phase 1: Schema & Parse Layer

#### Automated

- [x] 1.1 npm install `zod@^4` as runtime dependency — 4bbf932
- [x] 1.2 `src/review-schema.ts` — Zod schema, ReviewType, JSON Schema export — 4bbf932
- [x] 1.3 `src/nim-client.ts` — ResponseFormat type, `structuredSchema` in ChatOptions, `json_schema` and `tools` payload injection, `tool_calls` response extraction, `finishReason` in ChatResult — 4bbf932
- [x] 1.4 `src/prompts.ts` and `src/review.ts` — Update BASE_SYSTEM_PROMPT + 6 language prompts to request JSON matching the schema — 4bbf932
- [x] 1.5 `src/index.ts` — Wrap `client.chat()` call with `safeParse()`, retry once, treat failures as model skips; add `providerToFormat()` mapping — 4bbf932
- [x] 1.6 `src/index.ts` — Handle `finish_reason: 'length'` as model skip — 4bbf932
- [x] 1.7 `src/index.ts` — Handle `promptMode: 'replace'` fallback to raw text with warning — 4bbf932
- [x] 1.8 All existing tests pass, type checking passes, build succeeds with zod bundled — 4bbf932

#### Manual

- [ ] 1.9 Test PR review with NIM API key — verify JSON parsing renders correct PR comment
- [ ] 1.10 Test PR review with Mistral-only config — verify `tools` path works
- [ ] 1.11 Test custom endpoint that doesn't support JSON mode — verify graceful fallthrough

### Phase 2: Diff Validation

#### Automated

- [x] 2.1 `src/review.ts` — `parseDiffHunks()` and `getFileHunks()` utilities — 3b812a7
- [x] 2.2 `src/review.ts` — `validateFindings()` function — 3b812a7
- [x] 2.3 `src/index.ts` — Wire `validateFindings()` after schema parse, before `break` — 3b812a7
- [x] 2.4 Unit tests pass for hunk parsing and finding validation — 3b812a7

#### Manual

- [ ] 2.5 Test with a model that hallucinates a file path — verify drop + log
- [ ] 2.6 Test with a model that uses correct line numbers — verify pass

### Phase 3: Markdown Renderer & Cleanup

#### Automated

- [x] 3.1 `src/review.ts` — `renderReview()` function — b7f2f26
- [x] 3.2 `src/index.ts` — Replace raw-string assembly with `renderReview()` call — b7f2f26
- [x] 3.3 `src/review.ts` — Delete `reviewFile()` and `reviewFileWithFallback()` — b7f2f26
- [x] 3.4 Delete orphan `src/prompts/*.txt` files; remove `cp -r src/prompts dist/prompts` from `package.json` — b7f2f26
- [x] 3.5 All tests pass, build succeeds, type checking passes — b7f2f26

#### Manual

- [ ] 3.6 Run full PR review and verify comment format matches expected output
- [ ] 3.7 Verify `findExistingComment` still matches the `### AI Code Review` prefix

### Phase 4: Golden-File Tests

#### Automated

- [x] 4.1 Create `src/__fixtures__/` with 7 fixture files (valid-complete, valid-minimal, valid-empty, malformed-not-json, malformed-wrong-schema, refusal, truncated-json) — a02a21b
- [x] 4.2 `src/review-schema.test.ts` — Schema parser tests for all fixtures + edge cases — a02a21b
- [x] 4.3 `src/review.test.ts` — Diff validation tests for `validateFindings()` — a02a21b
- [x] 4.4 `src/review.test.ts` — Renderer tests for `renderReview()` — a02a21b
- [x] 4.5 `npm test` — all fixture tests pass — a02a21b

#### Manual

- [ ] 4.6 Verify adding a new fixture and breaking the schema causes a test failure (regression detection proof)

---

## Addenda (discovered during implementation review)

These changes were made during implementation but were not part of the original plan. Recorded here so the plan stays the source of truth.

- **`.github/workflows/benchmark.yml`** — Added a separate Mistral benchmarking job and reordered Mistral models. Beneficial CI change, unrelated to schema validation.
- **`action.yml`** — Added Mistral-specific inputs (`mistral_api_key`, `mistral_base_url`, `mistral_models`) to support the Mistral provider path referenced in Phase 1.
- **Build/test config fix** — `tsconfig.json` (`rootDir` → `.`, include tests/fixtures) and `package.json` (test glob `dist/**/*.test.js`, fixture copy path `dist/src/__fixtures__`) corrected so compiled test modules and fixtures resolve. Required to make Phase 1–4 automated verification runnable.
- **`src/retry.ts`** (new) — `RetryableError` class + `withRetry()` helper (exponential backoff on 5xx/429). Wired into `nim-client.ts` (`chat`) and `review.ts` (`fetchDiff`, `findExistingComment`, `updateComment`, `createComment`). Complements the model fallback chain by retrying transient failures on the same provider before falling through.
- **`findExistingComment` pagination** — Raised page cap from 10 to 50 (1000 → 5000 comments) to reduce risk of missing the existing review comment on very large PRs.
