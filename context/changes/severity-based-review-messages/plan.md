# Severity-Based Review Messages Implementation Plan

## Overview

`review-action` currently renders every finding the same way — a flat bullet list with `- **Severity:** ${f.severity}` regardless of whether the finding is a release blocker, a maintenance concern, or a stylistic nit. This plan differentiates the rendered comment by severity: the `Critical / Warning / Suggestion` enum from `src/review-schema.ts:5` and `src/review-schema.ts:33` gets three new required action fields, the renderer groups findings into priority buckets with semantic markdown each, the header gains a tally, the prompt tells the LLM exactly what to write per severity, the broken `append` / `replace` prompt mode is fixed at `src/index.ts:139,170`, and the docs + bundle are refreshed.

## Current State Analysis

The full surface was mapped in `context/changes/severity-based-review-messages/research.md`. Key facts the plan builds on:

- **Severity enum is read once** — [`src/review.ts:153`](src/review.ts#L153) interpolates `f.severity` into an identical template for every finding; everything else in `renderReview()` is severity-agnostic.
- **Schema has the enum but no per-severity metadata** — [`src/review-schema.ts:5`](src/review-schema.ts#L5) (Zod) and [`src/review-schema.ts:33`](src/review-schema.ts#L33) (hand-written JSON Schema). `additionalProperties: false` at [`src/review-schema.ts:40`](src/review-schema.ts#L40) prevents the model from smuggling extras.
- **Dual-sync constraint** — [`src/review-schema.ts:21-23`](src/review-schema.ts#L21-L23) explicitly warns that Zod and the hand-written JSON schema must be kept in lockstep.
- **Prompts have no severity-tone guidance** — `severity` does not appear in [`src/prompts.ts:5-117`](src/prompts.ts#L5-L117).
- **`append` / `replace` modes are misnamed** — [`src/index.ts:139`](src/index.ts#L139) and [`src/index.ts:170`](src/index.ts#L170) collapse both via `config.systemPrompt || BASE_SYSTEM_PROMPT`. Anything baked into `BASE_SYSTEM_PROMPT` is silently lost for users supplying a custom prompt.
- **Tests are substring-based** — only file-alphabetical order is locked down at [`src/review.test.ts:295-310`](src/review.test.ts#L295-L310); the rest of the rendering contract is exact-text-flexible.
- **Marker prefix invariant** — `### AI Code Review` at [`src/review.ts:214`](src/review.ts#L214) must remain the literal first line of the comment body so `findExistingComment` ([`src/review.ts:257-260`](src/review.ts#L257-L260)) can match.

## Desired End State

After this plan lands:

- A validated model response now carries `critical_action`, `warning_action`, and `suggestion_action` strings for every finding. The LLM writes the matching severity's `*_action` with a concrete next step.
- The rendered PR comment groups findings into `### 🚨 Critical (n)`, `### ⚠️ Warning (n)`, `### 💡 Suggestion (n)` sections in that priority order, hiding empty buckets.
- Inside each section, findings are grouped under `**File:** \`path\`` headers sorted alphabetically.
- Each finding's bullet becomes `- 🚨 **Critical**` (emoji + tier label). The matching `*_action` renders as a sub-line `  - **Must-fix:** ${value}`, `  - **Investigate:** ${value}`, or `  - **Nit:** ${value}`. If the matching `*_action` is missing/null, the sub-line is gracefully skipped.
- The comment header (right after `<sub>Model: ...</sub>`) gains a severity tally.
- `nim_prompt_mode: append` actually appends; `replace` actually replaces. Users in `append` mode see the new per-severity guidance appended to their custom prompt.
- `README.md` documents the severity rendering; `action.yml` refreshes input descriptions.
- The action still bundles correctly via `npm run build`, regenerating `dist/bundle/index.js`.

### Key Discoveries

- The `additionally_Properties: false` constraint at [`src/review-schema.ts:40`](src/review-schema.ts#L40) — every new field must be declared in the hand-written JSON schema.
- The two `languageForFile()` tests at [`src/prompts.test.ts:6-30`](src/prompts.test.ts#L6-L30) are extension-map only; no test currently asserts any wording, including the new severity guidance.
- The `existing` test at [`src/review.test.ts:295-310`](src/review.test.ts#L295-310) will fail as-is under severity-first ordering — `b.ts:Critical` lands before `a.ts:Warning`, violating `aPos < bPos`. Either the test inputs must be re-ordered or the assertion rephrased.

## What We're NOT Doing

- Adding a 4th severity tier (e.g., `Blocker` or `Major`). The 3-tier enum stays.
- Computing severity counts from the LLM-emitted `summary` string. The renderer derives counts from the `findings` array.
- Changing `postComment` update logic at [`src/review.ts:216-313`](src/review.ts#L216-L313). Already-posted comments will be replaced on next re-run because `### AI Code Review` remains the marker prefix.
- Activating `src/prompts.ts` language specialisation at runtime — it stays dormant dead code outside this plan.
- Changing the diff-fetching pipeline, retry behaviour, model-chain ordering, or model scoring.
- Adding new schema discriminators (`meta.display`, `category`, etc.). That's a separate change if ever pursued.

## Implementation Approach

Four phases in dependency order:

1. **Schema** — declare the three required action fields, mirror them in the hand-written JSON schema, migrate fixtures and schema tests. Everything downstream consumes this contract.
2. **Prompt** — tell the LLM what each `*_action` means and when to populate (only the matching severity's field meaningfully; the other two are short placeholder strings). Mirrored in `BASE_SYSTEM_PROMPT` and the 6 language prompts.
3. **Renderer** — bucket findings by severity, render each section, add `severityTally()` helper, add 1 snapshot test, update the order-sensitive test.
4. **Integration** — wire the tally into `src/index.ts:209-225`, fix real append semantics at `src/index.ts:139,170`, update `README.md` + `action.yml`, regenerate the bundle.

The migration is the only phase where a fixture is structurally broken (`fixture-valid-minimal.json` lacks `*_action`); Phase 1 migrates that fixture in lockstep with the schema change to keep `safeParse` callers green.

## Critical Implementation Details

A few load-bearing constraints the implementer must know before touching code.

- **The hand-written JSON schema must be updated in parallel with the Zod schema.** [`src/review-schema.ts:20-23`](src/review-schema.ts#L20-L23) explicitly forbids using `z.toJSONSchema()` because some providers reject `$schema` metadata and `anyOf`-for-nullability. Every new field is therefore hand-mirrored at [`src/review-schema.ts:24-47`](src/review-schema.ts#L24-L47). Use `type: 'string'` (not nullable — see Open Risks below).
- **The `### AI Code Review` marker must remain the literal first line of the body.** Emoji prefixes and the tally line come *after* the marker — see [`src/index.ts:209`](src/index.ts#L209). Violating this breaks the comment-update lookup at [`src/review.ts:257-260`](src/review.ts#L257-L260) and creates duplicate comments.
- **`promptMode === 'replace'` is currently indistinguishable from `'append'`.** The real append logic must live at the call sites ([`src/index.ts:139`](src/index.ts#L139), [`src/index.ts:170`](src/index.ts#L170)), not behind a config check, so that callers stay correct regardless of which mode name the user picked.
- **Renderer order must be deterministic and stable across re-runs.** `postComment` updates the existing comment on each re-run. Sort bucket order (severity priority) and within-bucket order (file alphabetical) so the diff to the existing comment is minimal when nothing changes.

---

## Phase 1: Schema Migration

### Overview

Add `critical_action`, `warning_action`, `suggestion_action` as required `string` fields on `ReviewFinding`. Mirror them in the hand-written JSON schema. Migrate the two valid fixtures (`fixture-valid-complete.json`, `fixture-valid-minimal.json`) and the truncation fixture to populate the new fields. Update `src/review-schema.test.ts` to cover required-field rejection and acceptance paths. Truncated fixture remains a parse-failure case.

### Changes Required:

#### 1. Zod schema — add 3 required action fields

**File**: `src/review-schema.ts`

**Intent**: Extend `ReviewFindingSchema` so every finding carries three required action strings — the model writes the matching severity's field with a concrete next step and the other two with a brief placeholder.

**Contract**: After the existing `suggestion` field at [`src/review-schema.ts:9`](src/review-schema.ts#L9), add:
- `critical_action: z.string()`
- `warning_action: z.string()`
- `suggestion_action: z.string()`

Update the `required` array at the bottom of the schema object to include all three new names. Order them after `suggestion` so required stays alphabetical-safe.

#### 2. Hand-written JSON schema — mirror the new fields

**File**: `src/review-schema.ts` (the `ReviewJsonSchema` literal object)

**Intent**: Mirror the new fields in the JSON Schema variant used by provider-facing structured-output calls — the `additionalProperties: false` at [`src/review-schema.ts:40`](src/review-schema.ts#L40) would otherwise reject them on the wire.

**Contract**: In the finding `properties` map (the inner object's `properties` between lines 31 and 38), add:
- `critical_action: { type: 'string' }`
- `warning_action: { type: 'string' }`
- `suggestion_action: { type: 'string' }`

Append the three names to the finding `required` array at [`src/review-schema.ts:39`](src/review-schema.ts#L39). No `anyOf`, no nullable unions, no `$schema` key — preserving the existing constraint at [`src/review-schema.ts:21-23`](src/review-schema.ts#L21-L23). `JSON_SCHEMA_DEFINITION` at [`src/review-schema.ts:49-53`](src/review-schema.ts#L49-L53) regenerates automatically via `JSON.stringify` and needs no edit.

#### 3. Migrate fixtures — populate the new fields with realistic content

**File**: `src/__fixtures__/fixture-valid-complete.json`

**Intent**: Each of the 3 findings must now include the three action fields. The matching severity's field gets a concrete remediation; the other two get a short placeholder so the fixture stays valid.

**Contract**: For each of the 3 findings at `lines 5-7` (currently), add the three new keys. Critical's `critical_action` is the only meaningful one; Warning's `warning_action` is the meaningful one; Suggestion's `suggestion_action` is the meaningful one. The other two fields get a short value like `"not applicable"` for that severity.

#### 4. Migrate the minimal fixture and update the schema test for required fields

**File**: `src/__fixtures__/fixture-valid-minimal.json`

**Intent**: The minimal fixture currently has only the 3 originally-required fields (`file`, `severity`, `issue`). Under the new schema that's no longer valid; the fixture is upgraded to its `*_action` minimum.

**Contract**: Add the three new required fields with placeholder content. Severity is `Suggestion` (matching today's fixture), so `suggestion_action` carries the meaningful text, the other two are `"not applicable"`.

**File**: `src/review-schema.test.ts`

**Intent**: The current tests assume only the original 3 fields are required. Add coverage for the new requirement and add a positive case for valid all-populated findings.

**Contract**: Extend the existing `describe('ReviewFindingSchema')` block:
- Add `it('rejects finding missing critical_action')` — verify safeParse returns failure with a path pointing at `critical_action`.
- Add `it('accepts finding with all three action fields populated')` — happy-path regression.
- Existing `it('rejects missing required fields')` (around `src/review-schema.test.ts:67-70`) should be retained but updated to reflect the new requirement count (it may already pass once fixtures are migrated; verify and adjust minimally).

#### 5. Bundle-rebuild pre-flight check

**File**: (none)

**Intent**: Even though Phase 4 owns `npm run build`, run it once at the end of Phase 1 to confirm the schema change typechecks and the bundle still produces a valid output. Catches JSON-schema mistakes before downstream phases build on a broken assumption.

### Success Criteria:

#### Automated Verification:

- `npm run build` completes without TS or schema errors.
- `npm test` passes — including the updated `src/review-schema.test.ts` and the migrated fixtures in `src/openai-client.test.ts` (which currently exercise `ReviewSchema.safeParse` against `fixture-valid-complete.json`).
- `npx tsc --noEmit` exits cleanly.

#### Manual Verification:

- Inspect `dist/bundle/index.js` to confirm the literal `critical_action` / `warning_action` / `suggestion_action` strings are present in the embedded JSON schema (search for one of them).
- Open a representative `fixture-valid-complete.json` after migration and confirm each finding's matching-severity `*_action` reads as a real remediation step; the other two fields read as `"not applicable"`.

**Implementation Note**: After completing Phase 1 and all automated verification passes, pause for manual confirmation that the schema-migration is correct and fixtures are realistic before proceeding to Phase 2.

---

## Phase 2: Prompt Engineering

### Overview

Teach the LLM what `critical_action`, `warning_action`, and `suggestion_action` mean, and instruct it to populate only the matching severity's field meaningfully. Mirror the new instruction in `BASE_SYSTEM_PROMPT` (so custom-prompt users get it via the append fix from Phase 4) and in the six language prompts in `src/prompts.ts`. Add a content test that locks the new guidance in place.

### Changes Required:

#### 1. Update BASE_SYSTEM_PROMPT

**File**: `src/review.ts` (the `BASE_SYSTEM_PROMPT` constant at lines 5-8)

**Intent**: Define the per-field contract before the schema block and tell the model which of the three `*_action` fields to populate meaningfully.

**Contract**: After the existing "Analyse the diff provided for..." paragraph and before `${JSON_SCHEMA_DEFINITION}`, insert a "Severity guidance" block (verbiage from research Option C):

```
Severity guidance — match the issue text and the *_action field to each severity:
- Critical findings: a bug, security hole, data-loss risk, or correctness failure
  that BLOCKS release. Use direct action verbs in the issue text. Populate
  critical_action with the concrete next step required to unblock release.
- Warning findings: an investigative concern, likely bug, or maintainability or
  performance issue that warrants attention but is not blocking. Populate
  warning_action with the next step to investigate.
- Suggestion findings: stylistic, readability, or nit-level improvement. Populate
  suggestion_action with a short optional improvement.

For the two action fields that do not match the severity, write a short placeholder
string such as "not applicable" rather than omitting it — the schema requires all
three on every finding.
```

#### 2. Mirror in language prompts

**File**: `src/prompts.ts` (six language-specific entries: `go` at `:5-22`, `python` at `:24-41`, `typescript` at `:43-60`, `java` at `:62-79`, `rust` at `:81-98`, `cpp` at `:100-117`)

**Intent**: Each language prompt ends with `${JSON_SCHEMA_DEFINITION}` — keep that and add the same severity-guidance block immediately before it in each entry. The instruction reaches providers that pick a language-specific prompt (when the dormant language wiring becomes live).

**Contract**: In each of the six prompts, append the Phase 2.1 severity-guidance text immediately before the `${JSON_SCHEMA_DEFINITION}` interpolation. To avoid duplicating a 200-token block in six places, factor the guidance into a module-level constant (`SEVERITY_GUIDANCE`) at the top of `src/prompts.ts` and interpolate `${SEVERITY_GUIDANCE}` into each entry — keeping the language-specific focus areas above it.

#### 3. Lock the guidance in a content test

**File**: `src/prompts.test.ts`

**Intent**: Currently the file only asserts the extension map at [`src/prompts.test.ts:6-30`](src/prompts.test.ts#L6-L30) — no prompt wording is captured. Add a content test so the new guidance cannot accidentally be removed.

**Contract**: Add a single `it('BASE_SYSTEM_PROMPT and language prompts carry severity guidance')` test that imports `BASE_SYSTEM_PROMPT` from `src/review.ts`, imports each `languagePrompts[key]` from `src/prompts.ts` (or via a new exported `SEVERITY_GUIDANCE` constant), and asserts each string contains the substrings `critical_action`, `warning_action`, `suggestion_action`, and `"not applicable"`. This catches accidental prompt-text regressions for the foreseeable future.

### Success Criteria:

#### Automated Verification:

- `npm run build` and `npm test` pass.
- The new prompt-content test passes against the updated prompts.
- No TS compile errors at the new constant `SEVERITY_GUIDANCE`.

#### Manual Verification:

- Read the final `BASE_SYSTEM_PROMPT` and confirm the severity-guidance block reads cleanly between the existing framing sentence and the JSON-schema block.
- Confirm every language prompt in `src/prompts.ts` carries the same block (or `${SEVERITY_GUIDANCE}` placeholder) — no language prompt left behind.

**Implementation Note**: After completing Phase 2, pause for manual confirmation that prompt wording reads naturally (token-count budget at `src/index.ts:143,176` `maxTokens: 4096` is unaffected since `BASE_SYSTEM_PROMPT` is the `system` role message and doesn't compete for the response budget).

---

## Phase 3: Renderer Rewrite + Snapshot Test

### Overview

`renderReview()` at [`src/review.ts:133-163`](src/review.ts#L133-L163) is currently a flat file-grouped loop. Refactor it to bucket by severity in priority order, render each bucket with a tier-coloured section header, keep file-alphabetical order within each bucket, render the matching-severity `*_action` as a tier-named sub-line (gracefully skipping if missing), and replace `- **Severity:** ${f.severity}` with an emoji-prefixed bullet `- 🚨 **Critical**`. Add `severityTally()` as a pure helper exported for testability. Add one snapshot/golden test that locks the new full-comment rendering. Adjust the existing file-order test so its inputs match severity-priority bucket ordering.

### Changes Required:

#### 1. Add the severity meta + helper

**File**: `src/review.ts`

**Intent**: Centralise severity → emoji and severity → action-field-name lookups so the renderer and the tally helper share one source of truth.

**Contract**: Near the top of the file (above the existing diff-parsing helpers), add:

```ts
const SEVERITY_META: Record<ReviewFinding['severity'], { emoji: string; label: string; actionKey: keyof ReviewFinding; tag: string }> = {
  Critical:   { emoji: '🚨', label: 'Critical',   actionKey: 'critical_action',   tag: 'Must-fix' },
  Warning:    { emoji: '⚠️', label: 'Warning',    actionKey: 'warning_action',    tag: 'Investigate' },
  Suggestion: { emoji: '💡', label: 'Suggestion', actionKey: 'suggestion_action', tag: 'Nit' },
};

const SEVERITY_ORDER = ['Critical', 'Warning', 'Suggestion'] as const;

export function severityTally(review: ReviewType): { critical: number; warning: number; suggestion: number } {
  const counts = { critical: 0, warning: 0, suggestion: 0 };
  for (const f of review.findings) {
    if (f.severity === 'Critical') counts.critical++;
    else if (f.severity === 'Warning') counts.warning++;
    else if (f.severity === 'Suggestion') counts.suggestion++;
  }
  return counts;
}
```

The `actionKey` mapping drives the renderer in step 3; the `tag` drives the `**Must-fix:**` / `**Investigate:**` / `**Nit:**` sub-line prefix.

#### 2. Refactor renderReview() into severity buckets

**File**: `src/review.ts` (the `renderReview` function at lines 133-163)

**Intent**: Make severity the top-level axis, hide empty buckets, keep file-alphabetical order inside each bucket, emit tier-coloured sub-lines for matching `*_action` only.

**Contract**: The function still takes `ReviewType` and returns `string`. Replace the current implementation with the following flow (no other signature changes):

```
For each severity in SEVERITY_ORDER:
  bucket = findings where severity === X
  skip if bucket.length === 0
  header = `### ${SEVERITY_META[X].emoji} ${SEVERITY_META[X].label} (${bucket.length})`
  bucket-by-file = group bucket by file, files sorted alphabetically
  for each file in bucket-by-file:
    push `**File:** \`${file}\``
    for each finding in (incoming order):
      line = `- ${emoji} **${label}**`
      if line_start has a value:
        line range = line_start == line_end  ? line_start : `${line_start}-${line_end}`
        line += `\n  **Line:** ${line_range}`
      line += `\n  **Issue:** ${issue}`
      matchAction = f[SEVERITY_META[X].actionKey]
      if matchAction is a non-empty string AND not the placeholder `'not applicable'`:
        line += `\n  - **${SEVERITY_META[X].tag}:** ${matchAction}`
      if suggestion is a non-empty string:
        line += `\n  **Suggestion:** ${suggestion}`
      push line
```

Notable behaviour preserved (existing tests rely on it):
- The literal word `Warning` still appears in rendered output (test at `src/review.test.ts:291`).
- The literal filename `a.ts` still appears (test at `src/review.test.ts:292`).
- The single-line range rule survives (`-5` not `5-5`, test at `src/review.test.ts:335-342`).
- The empty-summary and empty-findings branches at [`src/review.ts:134-136`](src/review.ts#L134-L136) remain unchanged.

#### 3. Add the snapshot/golden test

**File**: `src/review.test.ts`

**Intent**: Lock the new structure (severity headers + file subgroups + action sub-lines) so future refactors catch regressions.

**Contract**: Add one `it('renders multi-severity review with severity buckets and action sub-lines')` test that calls `renderReview()` against a 3-finding input (one Critical in `b.ts`, one Warning in `a.ts`, one Suggestion in `a.ts`) and asserts the output matches a frozen string written into the test file as a constant. Mark this test with a leading comment explaining its role as a structural snapshot — future renames must update both the test data and the assertion.

#### 4. Adjust the existing file-order test

**File**: `src/review.test.ts` (the `it('groups findings by file')` block at `:295-310`)

**Intent**: Under the new severity-priority ordering, `b.ts:Critical` lands before `a.ts:Warning`, which violates the test's `aPos < bPos` assertion. Rephrase the assertion to assert what the new behaviour actually guarantees: that within the Warning bucket, `a.ts` precedes any other file.

**Contract**: Replace the assertion `assert.ok(aPos < bPos)` with logic that confirms the new invariants: (a) the Critical bucket's file (`b.ts`) appears before the Warning bucket's file (`a.ts`), (b) within the Warning bucket, `a.ts` (the only file) appears correctly, (c) within the Suggestion bucket, `a.ts` (the only file) appears correctly. The substring checks for `issue1`/`issue2`/`issue3` can stay.

### Success Criteria:

#### Automated Verification:

- `npm run build` passes.
- `npm test` passes — including the new snapshot test and the adjusted file-order test.
- Coverage report (if configured) shows `severityTally()` and `renderReview()` branches exercised.

#### Manual Verification:

- Read the snapshot output and confirm: emoji headers in priority order, file subgroups inside, action sub-lines only on matching severity, placeholder `not applicable` does NOT render as a sub-line.
- Spot-check a Critical finding whose `critical_action` is empty string — confirm the sub-line is skipped (graceful handling).
- Confirm the existing tests at [`src/review.test.ts:274-292`](src/review.test.ts#L274-L292) still pass with no behavioral regressions.

**Implementation Note**: After Phase 3, pause for manual confirmation that the renderer output reads cleanly. Phase 4 wires this up to the comment header.

---

## Phase 4: Integration + Append/Replace Fix + Docs + Bundle

### Overview

Connect the new renderer output to the comment body in `src/index.ts` (header tally). Implement real `append` semantics at the two call sites. Refresh `README.md` and `action.yml`. Regenerate the bundle.

### Changes Required:

#### 1. Inject severity tally into the comment header

**File**: `src/index.ts` (the `sections` assembly at lines 208-225)

**Intent**: When `review` exists and has findings, push a tally line under the model sub-header but before the rendered review body. Skip when `review` is null or empty.

**Contract**: Import `severityTally` from `src/review.ts` (added in Phase 3). After the `sections.push(\`### AI Code Review\\n\\n<sub>Model: ${modelShort}</sub>\\n\`)` line at [`src/index.ts:209`](src/index.ts#L209), insert:

```
if (review && review.findings.length > 0) {
  const { critical, warning, suggestion } = severityTally(review);
  const tally = [
    critical ? `🚨 ${critical} critical${critical === 1 ? '' : 's'}` : null,
    warning ? `⚠️ ${warning} warning${warning === 1 ? '' : 's'}` : null,
    suggestion ? `💡 ${suggestion} suggestion${suggestion === 1 ? '' : 's'}` : null,
  ].filter(Boolean).join(' · ');
  sections.push(`\n${tally}\n`);
}
```

Place above the existing `sections.push(\`\\n${renderReview(review)}\`)` so the tally sits between the model header and the bucketed body. The "skip when zero findings" rule falls out naturally since `critical/warning/suggestion` are all zero then, `Boolean` filters them all, and the join is empty (kept as a single newline only).

#### 2. Implement real append semantics

**File**: `src/index.ts` (lines 139 and 170)

**Intent**: Replace the `config.systemPrompt || BASE_SYSTEM_PROMPT` short-circuit with conditional concatenation so `append` mode preserves the new severity guidance while still letting `replace` clear it.

**Contract**: At both call sites, replace:

```ts
{ role: 'system', content: config.systemPrompt || BASE_SYSTEM_PROMPT },
```

with:

```ts
{
  role: 'system',
  content: config.promptMode === 'replace'
    ? (config.systemPrompt || BASE_SYSTEM_PROMPT)
    : (config.systemPrompt
        ? `${BASE_SYSTEM_PROMPT}\n\n${config.systemPrompt}`
        : BASE_SYSTEM_PROMPT),
},
```

This makes `append` (the default) concatenate the default + user prompt, and `replace` swap in the user's full prompt. A user who leaves `systemPrompt` empty gets the default either way — no behaviour change for default users.

#### 3. Update README.md

**File**: `README.md` (the "How It Works" section at lines 51-58, the inputs table around lines 32-49)

**Intent**: Document the new fields, the new rendering, and the real append/replace semantics.

**Contract**: 
- Add a short "Severity rendering" sub-section under "How It Works" (after line 58) explaining 🚨/⚠️/💡 headers, the tally, and the `*_action` fields.
- Update bullet 3 at line 55 to mention `critical_action` / `warning_action` / `suggestion_action` as required output fields.
- Update bullet 6 at line 58 to describe the severity-bucketed markdown.
- Refresh the `nim_prompt_mode` row (around lines 47-48) to clarify: `append` (default) concatenates with the default; `replace` swaps it out entirely.
- Add a brief rendered-example snippet showing a Critical + Warning + Suggestion output.

#### 4. Refresh action.yml

**File**: `action.yml`

**Intent**: The action.yml input descriptions currently misdescribe the modes. Refresh to match the new semantics.

**Contract**: Update the description of `nim_prompt_mode` (around lines 47-49) to honestly describe append vs replace (matching README.md). No schema or output changes; this is documentation alignment only.

#### 5. Regenerate the bundle

**File**: (none — run command)

**Intent**: `action.yml:50-52` runs `dist/bundle/index.js`. The bundle must reflect every source change before deploy.

**Contract**: Run `npm run build` from `package.json:7`. Confirm `dist/bundle/index.js` is updated. Open the file and grep for `critical_action` and `🚨` to confirm the new strings made it into the bundle.

### Success Criteria:

#### Automated Verification:

- `npm run build` completes with no errors.
- `npm test` passes.
- `npx tsc --noEmit` exits cleanly.
- `git diff --stat dist/bundle/index.js` is non-empty (proves the bundle regenerated).
- A grep test in CI-equivalent shell: `grep -c '🚨' dist/bundle/index.js` returns ≥ 1; `grep -c 'critical_action' dist/bundle/index.js` returns ≥ 1.

#### Manual Verification:

- Read the final PR-comment output on a sample review (can be a fixture-driven dry run): emoji headers in priority order, tally visible above the body, action sub-lines present for matching severities only, the marker `### AI Code Review` still the literal first line.
- Spin up a local action run (or replay a fixture through `src/openai-client.test.ts`) to validate the append mode behavior — supply a `systemPrompt` and confirm it appears appended after the severity guidance.

**Implementation Note**: After Phase 4 lands, the change is ready for review and merge. The next step is `/10x-impl-review` (or `/10x-implement` if skipping review).

---

## Testing Strategy

### Unit Tests:

- `src/review-schema.test.ts` (extended in Phase 1.4): new required-field cases.
- `src/prompts.test.ts` (extended in Phase 2.3): one content test for severity guidance.
- `src/review.test.ts` (extended in Phase 3.3-3.4): snapshot test + adjusted file-order test.
- `severityTally()` cases (added with the helper in Phase 3.1): zero findings, single severity, mixed severities.

### Integration Tests:

- Append/replace behavior at `src/index.ts:139,170` — best exercised by extending `src/review.test.ts` or a new `src/index.test.ts` with a mocked client. If the surface area is too risky, document as a manual verification step.
- Header tally wiring at `src/index.ts:209-225` — covered by manual verification (Phase 4.2 manual), since the assembly lives in `index.ts` without a unit-testable seam today.

### Manual Testing Steps:

1. Open the `src/__fixtures__/fixture-valid-complete.json` (after Phase 1 migration) and mentally render it through `renderReview()`; confirm the output matches the new structure.
2. Run `npm run bench:entry` or equivalent to produce one end-to-end review on a fixture PR (or a hand-crafted diff) and confirm the comment reads naturally.
3. With a local action run, exercise `nim_prompt_mode: append` with a custom `systemPrompt` — confirm the user's prompt appears *after* the severity guidance, not replacing it.

## Performance Considerations

The new fields add ~6 characters × 3 = ~18 chars to each finding (empty placeholders are short). Model output tokens grow slightly; the 4096-token `maxTokens` per call at [`src/index.ts:143`](src/index.ts#L143), [`src/index.ts:176`](src/index.ts#L176) is unaffected. Renderer complexity grows by one outer loop and one inner `actionKey` lookup; both O(n) and below threshold for typical PR review sizes (< 100 findings per [`src/review.ts:42`](src/review.ts#L42)`maxFiles`).

No caching layer, no async fan-out, no streaming — performance profile is unchanged.

## Migration Notes

- **Existing PR comments**: when a re-run hits an existing `### AI Code Review` comment, the new emoji-prefixed bucketed rendering replaces the old flat list. This is a one-way edit that PR reviewers will see, but it's bounded — every PR comment changes at most once per re-run, not on every sync.
- **In-flight LLM responses**: if a model has already been trained or is mid-stream to return the old schema (no `*_action` fields), `ReviewSchema.safeParse` will reject the response and the retry path at [`src/index.ts:159-191`](src/index.ts#L159-L191) will skip the model. For NIM/Mistral providers that use `json_schema` / `tools` mode, the response_format enforces the new shape at the wire level — no graceful-degradation expected.
- **Cached fixtures**: `src/__fixtures__/fixture-valid-complete.json` and `fixture-valid-minimal.json` are upgraded in Phase 1. The truncated fixture remains a parse-failure case unchanged.
- **`append` / `replace` mode change**: users who have been relying on `replace` (the broken behavior we fix in Phase 4.2) to silently skip the default guidance will now see it appended. This is a behavior change — flag in `action.yml` description.

## References

- Research: `context/changes/severity-based-review-messages/research.md`
- Related change: `context/changes/severity-conditioned-rendering/change.md` (sibling investigation, empty research.md)
- Related change: `context/changes/schema-validated-review/change.md` (established the deterministic-renderer invariant this plan preserves)
- Schemas: `src/review-schema.ts:3-15,20-53` (binding contract)
- Renderer pre-state: `src/review.ts:133-163` (about to be replaced)
- Index header pre-state: `src/index.ts:208-225` (about to be extended)
- Append/replace bug: `src/index.ts:139,170`, `src/review.ts:42-46`, `action.yml:44-49`

## Open Risks & Assumptions

- **Required fields + "leave others null" conflict**: User picked "required strings" for all three `*_action` fields AND the prompt instruction "Populate matching field, leave others null". This plan resolves the conflict by having the prompt emit `"not applicable"` (or similar short placeholder) for non-matching severities, which keeps the schema strict and provides explicit signal to the renderer to skip the sub-line. If the user prefers truly nullable (so the renderer can show nothing) instead, the schema would change to `z.string().nullable().optional()` for the two non-matching fields and the renderer already handles the null case gracefully. Document the resolution in the PR description.
- **The dormant `prompts.ts` language specialisation**: Phase 2 mirrors the new instruction in all 6 language prompts, but those prompts are currently dead code at runtime (per research). The mirror is forward-looking — when language prompts become runtime-active in a future change, the guidance is already there.
- **LLM consistency**: Even with explicit per-field instructions, models may emit `"not applicable"` for non-matching fields only ~80–95% of the time. The graceful skip in `renderReview()` covers the remaining cases.
- **README rendered example**: a maintained sample rendering could drift from the implementation. The Phase 3 snapshot test is the canonical "what it looks like" — README just shows an excerpt.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Schema Migration

#### Automated

- [x] 1.1 `npm run build` completes without TS or schema errors — 79e5e78
- [x] 1.2 `npm test` passes including updated `src/review-schema.test.ts` and migrated fixtures — 79e5e78
- [x] 1.3 `npx tsc --noEmit` exits cleanly — 79e5e78
- [x] 1.4 `dist/bundle/index.js` contains the literal strings `critical_action` / `warning_action` / `suggestion_action` post-Phase-1 rebuild — 79e5e78

#### Manual

- [ ] 1.5 `fixture-valid-complete.json` after migration: matching-severity `*_action` is a real remediation step; the other two read as `"not applicable"`

### Phase 2: Prompt Engineering

#### Automated

- [x] 2.1 `npm run build` and `npm test` pass
- [x] 2.2 New prompt-content test in `src/prompts.test.ts` passes (asserts `critical_action`, `warning_action`, `suggestion_action`, `"not applicable"` substrings on `BASE_SYSTEM_PROMPT` and each language prompt)

#### Manual

- [ ] 2.3 `BASE_SYSTEM_PROMPT` and every entry in `languagePrompts` in `src/prompts.ts` carry the severity guidance block / `${SEVERITY_GUIDANCE}` interpolation

### Phase 3: Renderer Rewrite + Snapshot Test

#### Automated

- [ ] 3.1 `npm run build` passes
- [ ] 3.2 `npm test` passes including new snapshot test and adjusted `groups findings by file` test
- [ ] 3.3 Coverage report shows `severityTally()` and `renderReview()` branches exercised

#### Manual

- [ ] 3.4 Snapshot output: emoji headers in priority order, file subgroups inside each, action sub-lines only on matching severity, `"not applicable"` placeholders do not render

### Phase 4: Integration + Append/Replace Fix + Docs + Bundle

#### Automated

- [ ] 4.1 `npm run build` completes with no errors
- [ ] 4.2 `npm test` passes
- [ ] 4.3 `npx tsc --noEmit` exits cleanly
- [ ] 4.4 `git diff --stat dist/bundle/index.js` is non-empty
- [ ] 4.5 `grep -c '🚨' dist/bundle/index.js` returns ≥ 1
- [ ] 4.6 `grep -c 'critical_action' dist/bundle/index.js` returns ≥ 1

#### Manual

- [ ] 4.7 Sample-render output: emoji headers in priority order, tally visible above body, action sub-lines on matching severities, `### AI Code Review` remains the literal first line
- [ ] 4.8 With `nim_prompt_mode: append` + a custom `systemPrompt`, the user's prompt appears appended *after* the severity guidance in the actual request to the model
