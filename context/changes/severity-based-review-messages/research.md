---
date: 2026-07-21T16:04:30Z
researcher: Pawel
git_commit: 6539e3f8adb25241da2a39487a403257fdc6e1f7
branch: feature/model-recheck
repository: review-action
topic: "Different review message per severity of findings"
tags: [research, codebase, severity, rendering, prompts, schema, design-options, external-patterns]
status: complete
last_updated: 2026-07-21
last_updated_by: Pawel
---

# Research: Different Review Message per Severity of Findings

**Date**: 2026-07-21T16:04:30Z
**Researcher**: Pawel
**Git Commit**: `6539e3f8adb25241da2a39487a403257fdc6e1f7`
**Branch**: `feature/model-recheck`
**Repository**: `review-action`

## Research Question

How can `review-action` produce visibly-different review output depending on the severity of each finding (Critical / Warning / Suggestion), across both the per-finding body and the top-of-comment summary? What does the codebase currently do, what are the viable design options, and what conventions do comparable tools follow?

## Summary

The codebase **already has** a 3-tier severity enum (`Critical` / `Warning` / `Suggestion`) defined twice (Zod + hand-written JSON Schema), but **none** of the three integration points — prompt, schema-validation, or markdown rendering — currently differentiates output by severity. Findings are grouped by file, not by severity; each bullet uses the same template `- **Severity:** ${f.severity}` ([`src/review.ts:153`](src/review.ts#L153)); the system prompt contains no per-severity tone guidance; the comment header has no severity tally.

Three end-to-end design options were synthesized (Light / Medium / Heavy) plus one hybrid. The **Light** option — keep the schema, add 🚨 / ⚠️ / 💡 prefixes, add a top-of-comment severity tally, regroup by severity instead of (or alongside) file — is the best fit for this single-comment deterministic Action because it preserves the hand-written JSON schema's provider-compatibility constraint ([`src/review-schema.ts:20-23`](src/review-schema.ts#L20-L23)) and adds zero prompt-token cost.

External surveys of CodeRabbit, Danger.js, CodeQL, Semgrep, Snyk Code, Sourcery, GitHub Copilot, and OSS AI review Actions confirm two dominating conventions worth borrowing: (1) **emoji-prefixed severity on each finding header** (Danger's `fail` / `warn` / `message` echoes this), and (2) **top-of-comment severity tally above per-file detail**. The current `Critical / Warning / Suggestion` 3-tier enum is well-calibrated against the field — it matches CodeQL's `error / warning / recommendation` exactly and sits inside the 3-5 tier norm.

## Detailed Findings

### 1. Current rendering does not differentiate by severity

Severity is **read in exactly one place** during rendering — [`src/review.ts:153`](src/review.ts#L153) interpolates the enum value into the same bullet template for every finding:

```ts
lines.push(`- **Severity:** ${f.severity}\n${lineInfo}**Issue:** ${f.issue}${suggestionInfo}`);
```

Everything else inside `renderReview()` (`src/review.ts:133-163`) is severity-agnostic:
- Empty findings fall back to `review.summary || 'No issues found.'` at [`src/review.ts:134-136`](src/review.ts#L134-L136).
- Findings are grouped **by file** in a `Map<string, typeof review.findings>` at [`src/review.ts:138-143`](src/review.ts#L138-L143).
- Files are alphabetically sorted at [`src/review.ts:146`](src/review.ts#L146).
- Each file header is `**File:** \`${file}\`` at [`src/review.ts:147`](src/review.ts#L147).
- Within a file, findings retain **incoming order** — no severity sort at [`src/review.ts:148-154`](src/review.ts#L148-L154).
- The optional `summary` is appended verbatim at [`src/review.ts:158-160`](src/review.ts#L158-L160).

There is no severity-keyed map, no severity switch, no rank table, no emoji lookup, and no severity filter. The data path model→comment is: `client.chat()` → `ReviewSchema.safeParse()` ([`src/index.ts:159`](src/index.ts#L159)) → `validateFindings()` ([`src/index.ts:197`](src/index.ts#L197), severity-blind) → `renderReview(review)` ([`src/index.ts:212`](src/index.ts#L212)) → joined with the header in [`src/index.ts:208-225`](src/index.ts#L208-L225) → `postComment()` ([`src/index.ts:225`](src/index.ts#L225)) → GitHub PATCH/POST JSON body. `postComment()` itself ([`src/review.ts:216-313`](src/review.ts#L216-L313)) does not inspect severity.

### 2. The schema has the enum but no per-severity data fields

Severity is defined as a 3-value Zod enum at [`src/review-schema.ts:5`](src/review-schema.ts#L5) and mirrored in the hand-written `ReviewJsonSchema` enum at [`src/review-schema.ts:33`](src/review-schema.ts#L33). The hand-written schema's binding constraints are:

- `additionalProperties: false` at [`src/review-schema.ts:40`](src/review-schema.ts#L40) and [`src/review-schema.ts:46`](src/review-schema.ts#L46) — the LLM cannot smuggle extra fields.
- `required: ['file', 'severity', 'issue']` at [`src/review-schema.ts:39`](src/review-schema.ts#L39) — line numbers and suggestion are optional.
- Nullability uses `type: ['<prim>', 'null']` unions (not `anyOf`) at [`src/review-schema.ts:34-37`](src/review-schema.ts#L34-L37) — the explicit maintenance comment at [`src/review-schema.ts:21-23`](src/review-schema.ts#L21-L23) explains why:

  > _Hand-written JSON Schema for maximum provider compatibility. `z.toJSONSchema()` adds `"$schema"` draft metadata and uses `"anyOf"` for nullable fields — both of which some LLM providers reject. IMPORTANT: Keep in sync with `ReviewFindingSchema` and `ReviewSchema` above._

The `JSON_SCHEMA_DEFINITION` constant ([`src/review-schema.ts:49-53`](src/review-schema.ts#L49-L53)) is the **only** place the word `severity` reaches the LLM — it is `JSON.stringify`-d into a fenced block with no natural-language explanation of what each value means. Existing valid fixtures ([`src/__fixtures__/fixture-valid-complete.json:3-7`](src/__fixtures__/fixture-valid-complete.json#L3-L7)) use all three severities with identical neutral declarative prose ("Unused variable declared", "Missing error handling", "Consider extracting"). No tonal differentiation is asserted.

### 3. Prompts contain zero severity-aware guidance

All six language prompts in [`src/prompts.ts:5-117`](src/prompts.ts#L5-L117) follow an identical skeleton (`'Analyse the diff provided for bugs, security issues, performance problems, and style/readability concerns specific to <LANG>.'`) followed by 10 bug-class focus areas. Searching the file confirms the strings `severity`, `Critical`, `Warning`, and `Suggestion` never appear in `src/prompts.ts` outside of the embedded schema block — so no per-severity tone guidance reaches the model in any language.

`BASE_SYSTEM_PROMPT` at [`src/review.ts:5-8`](src/review.ts#L5-L8) is similarly severity-blind. Severity-tone guidance here is implicit at best.

### 4. The `append` / `replace` prompt-override modes do not actually differ

This is a hidden constraint that any severity-aware prompt change must work around. `action.yml:44-49` exposes two inputs (`nim_system_prompt`, `nim_prompt_mode`) advertised as `append` (default) vs `replace`, but the runtime at [`src/index.ts:139`](src/index.ts#L139) and [`src/index.ts:170`](src/index.ts#L170) is:

```ts
{ role: 'system', content: config.systemPrompt || BASE_SYSTEM_PROMPT }
```

The `||` short-circuits to the user string whenever it is non-empty, so both `append` and `replace` modes discard `BASE_SYSTEM_PROMPT` whole. There is no merge strategy. The `promptMode` field is only consulted at [`src/index.ts:215`](src/index.ts#L215) to decide whether to dump **raw** model output on validation failure — not to choose between append/replace. Consequence: any severity-aware instruction baked into `BASE_SYSTEM_PROMPT` is silently lost the moment a user provides a custom `systemPrompt`. Document this in the eventual README/dispatch path.

### 5. `renderReview()` tests are mostly substring-based, not exact-match

The 8 tests in [`src/review.test.ts:274-343`](src/review.test.ts#L274-L343) assert presence of substrings (`'Warning'`, `'a.ts'`, `'fix it'`, `'All done.'`, `'10'`, `'15'`, `'5'`) but **never** lock down:
- The exact `- **Severity:** ${severity}` bullet format.
- The `**File:**` heading format.
- Whether the per-file-per-severity order is alphabetic-by-file vs alphabetic-by-severity-first.
- Whether emoji prefixes exist.
- Whether a severity tally is rendered anywhere.

There is also no golden-file / snapshot test and no `src/index.test.ts` for final comment assembly — so adding emoji, headers, or a tally will generally pass existing tests as long as the literal word `Warning` and the file name `a.ts` remain present. (See open question 4 below — one test does assert file order.)

### 6. The `### AI Code Review` marker must remain the prefix

[`src/review.ts:214`](src/review.ts#L214) defines `const COMMENT_MARKER = '### AI Code Review'`. The constant is consumed by [`src/review.ts:257-260`](src/review.ts#L257-L260) to find the prior comment via `comment.body.startsWith(COMMENT_MARKER)`. Any header redesign must keep `### AI Code Review` as the exact leading text — placing an emoji or severity tally **before** that marker would break update detection and cause the action to create a duplicate comment on every re-run. The markdown prefix may safely grow **after** the marker (e.g. on the next line). Verbatim emission sites of the marker: [`src/index.ts:75-78`](src/index.ts#L75-L78) (diff-too-large), [`src/index.ts:87-89`](src/index.ts#L87-L89) (empty diff), [`src/index.ts:103-105`](src/index.ts#L103-L105) (all excluded), [`src/index.ts:209`](src/index.ts#L209) (normal review).

### 7. Severity-tied fixture data exists but no tonal distinction

[`src/__fixtures__/fixture-valid-complete.json:3-9`](src/__fixtures__/fixture-valid-complete.json#L3-L9) covers all three severities. The tone across the three (`"Unused variable 'temp' declared but never read"`, `"Missing error handling for async call"`, `"Consider extracting this logic into a helper function"`) is **flatly declarative** — there is no observable escalation in force or verb type. This means there's also no fixture demonstrating future severity-tone enforcement; any tonal change would require new fixtures.

### 8. Internal precedent uses emoji-decorated severities (weak precedent only)

`context/changes/schema-validated-review/reviews/impl-review.md` (reviewed earlier in the branch) uses `❌ CRITICAL`, `⚠️ WARNING`, `ℹ️ OBSERVATION` for human readers. This is **not** action output and uses a different label (`Observation` not `Suggestion`), but it weakly hints that the team is comfortable with `❌`/`⚠️`/`ℹ️` or `🚨`/`⚠️`/`💡` style decorations on severity labels.

### 9. Three end-to-end design options

Each option spans schema, prompt, and rendering. All preserve the 3-tier enum.

#### Option A — Lightweight (recommended)

- **Schema ([`src/review-schema.ts`](src/review-schema.ts))**: no changes.
- **Prompt ([`src/review.ts:5-8`](src/review.ts#L5-L8), [`src/prompts.ts`](src/prompts.ts))**: no changes.
- **Rendering ([`src/review.ts:133-163`](src/review.ts#L133-L163))**: introduce a `severityBucket()` step. Iterate severities in priority order `['Critical', 'Warning', 'Suggestion']`, skip empty buckets, emit `### 🚨 Critical (n)` / `### ⚠️ Warning (n)` / `### 💡 Suggestion (n)` headers, then keep file-alphabetical sub-grouping inside each severity. Replace the bullet prefix `- **Severity:** ${f.severity}` with `- ${emoji} **${f.severity}**`.
- **Header ([`src/index.ts:209-225`](src/index.ts#L209-L225))**: below the existing `### AI Code Review\n\n<sub>Model: ...</sub>\n` line, when `review.findings.length > 0`, append a one-line tally, e.g. `🚨 1 critical · ⚠️ 2 warnings · 💡 3 suggestions\n`.
- **Tests ([`src/review.test.ts:274-343`](src/review.test.ts#L274-L343))**: add three new asserts (emoji prefix, severity tally, omitted empty buckets). The single test "groups findings by file" at [`src/review.test.ts:295-310`](src/review.test.ts#L295-L310) becomes file-subgroup within each severity, so it still passes if severity iteration is in alphabetical order (Critical → Warning → Suggestion) and the existing test inputs happen to land in that order (`b.ts` Critical, `a.ts` Warning, `a.ts` Suggestion → first bucket Critical / b.ts comes before a.ts? — verify).
- **Trade-offs**: zero schema risk, zero prompt-token cost, deterministic renderer. Worst case: model still produces flat tone regardless of severity label, but visualisation gives scan speed.
- **Migration risk**: trivial. Fixtures parse unchanged.
- **Effort**: **S** (~50 lines).

#### Option B — Medium

Same as A, plus: add a per-severity writing-style block (~80-120 tokens) to `BASE_SYSTEM_PROMPT` ([`src/review.ts:5-8`](src/review.ts#L5-L8)) instructing the LLM to use action verbs for Critical ("This breaks…", "Release blocker…"), investigative verbs for Warning ("Investigate…", "Consider whether…"), and hedged phrasing for Suggestion ("Nit: …", "Optional: …"). The block must be reinjected on the `config.systemPrompt || BASE_SYSTEM_PROMPT` call sites at [`src/index.ts:139`](src/index.ts#L139) and [`src/index.ts:170`](src/index.ts#L170) for `replace`-mode users, otherwise they lose the guidance (constraint #4 above).

- **Trade-offs**: model-inconsistency tax — LLMs routinely ignore tone guidance. Worst case: extra prompt cost, no visible improvement in tone. Mitigation: the enum stays strict, so parsing still catches the worst miscategorisation.
- **Effort**: **S-M** (~120 lines including a small `severityTally()` helper for testability in `src/review.ts`).

#### Option C — Heavy

Add three new optional fields to `ReviewFinding`: `critical_action`, `warning_action`, `suggestion_action` — each `z.string().nullable().optional()`. **Must** be mirrored in the hand-written `ReviewJsonSchema` at [`src/review-schema.ts:24-47`](src/review-schema.ts#L24-L47) — the dual-sync warning at [`src/review-schema.ts:21-23`](src/review-schema.ts#L21-L23) becomes load-bearing. Renderer reads only the field matching `f.severity` and emits `- **Must-fix:** …` / `- **Investigate:** …` / `- **Nit:** …`.

- **Trade-offs**: schema bloat + recurring two-place maintenance tax + model is asked to write **more** text per finding. Worst case: optional fields are usually empty (model skips them), so the visual benefit is inconsistent. Only justified if downstream tooling will consume the structured actions.
- **Effort**: **L** (~200 lines, plus fixture migration, plus README).

#### Option D — Hybrid

Add one optional `meta.display: 'blocking' | 'warning' | 'nit'` field with severity-derived default. Lets future users override the bucket without coupling it to the severity enum.

- **Trade-offs**: small schema footprint, one enum, one nullable hand-written entry. Worst case: rarely used escape hatch.
- **Effort**: **S** (~60 lines). Useful only after Option A is shipped.

### 10. External conventions worth mirroring

Survey of 8 comparable tools (`CodeRabbit`, `Sourcery`, `GitHub Copilot code review`, `Danger.js`, `Snyk Code`, `CodeQL`, `Semgrep`, OSS AI review Actions). Patterns appearing 3+ times:

1. **3-5 tier severity ladders are the norm** — CodeRabbit 5, Semgrep 5, Snyk 4, Danger 4, CodeQL 3. The current `Critical / Warning / Suggestion` 3-tier sits exactly on CodeQL and inside the norm.
2. **Emoji-prefixed severity on each header** — `🔴` Major/`🟠` etc. (CodeRabbit), `❌`/`⚠️`/`📝` (Danger's `fail`/`warn`/`message`), implicit in AI Actions. Maps cleanly to `🚨` / `⚠️` / `💡` for this Action.
3. **Top-of-comment summary + per-line inline detail** — CodeRabbit's "PR Walkthrough" + inline comments; Sourcery's "PR Summary" + "Individual Comments"; Copilot's overall + per-line. Top is the only place a severity tally belongs.
4. **Verb-led action language** — `fail` / `warn` / `message` (Danger), `/fp` / `/open` (Semgrep triage), "Suggested change" (Copilot), "Apply and Go To Next" (Copilot CLI). For a non-blocking review comment, distinguishing "must fix" / "consider" / "nit" works without adding schema fields.
5. **"Comment" not "Request changes" is the default merge behaviour** — Copilot explicit, AI Actions conventionally. Severity-aware rendering here is purely informational, does not flip the GitHub review state.
6. **Triage state is orthogonal to severity** — Semgrep's `severity × triage_status` axis; Danger's `fail × markdown` axis. Maps to a future `meta.display` (Option D) cleanly.

### 11. Why the existing 3-tier enum should be preserved

CodeQL's `error / warning / recommendation` is the closest peer — a 3-tier enum living inside a provider-strict JSON schema. Adding a 4th tier (e.g. `Major`) would force a schema rewrite, a `__fixtures__/fixture-valid-*.json` migration, and a re-publish that breaks every LLM provider that has already cached the prompt ([`src/review-schema.ts:20-23`](src/review-schema.ts#L20-L23)). The pragmatic right move: lean on the existing 3 values, do visual differentiation in the markdown renderer, reserve any future granularity (e.g. a separate `category` axis à la CodeRabbit) for a schema v2.

## Code References

### Severity touched during rendering (read paths)

- [`src/review.ts:153`](src/review.ts#L153) — single runtime read of `f.severity` in the renderer, identical template for every value.
- [`src/review.ts:133-163`](src/review.ts#L133-L163) — `renderReview()` body, severity-agnostic everywhere except line 153.
- [`src/index.ts:212`](src/index.ts#L212) — sole production call site of `renderReview(review)`.
- [`src/review.ts:257-260`](src/review.ts#L257-L260) — marker-prefix detection in `postComment` (must keep `### AI Code Review` exact).
- [`dist/bundle/index.js:35511-35536`](dist/bundle/index.js#L35511-L35536) — generated bundle that Action actually runs (regenerate via `npm run build` per [`package.json:7`](package.json#L7) when source changes).

### Severity defined (write paths)

- [`src/review-schema.ts:5`](src/review-schema.ts#L5) — Zod enum: `severity: z.enum(['Critical', 'Warning', 'Suggestion'])`.
- [`src/review-schema.ts:33`](src/review-schema.ts#L33) — hand-written JSON schema duplicate: `severity: { type: 'string', enum: ['Critical', 'Warning', 'Suggestion'] }`.
- [`src/review-schema.ts:49-53`](src/review-schema.ts#L49-L53) — `JSON_SCHEMA_DEFINITION` — only place the enum reaches the LLM (stringified into a fenced block).
- [`src/review-schema.test.ts:16-23`](src/review-schema.test.ts#L16-L23), [`src/review-schema.test.ts:60-65`](src/review-schema.test.ts#L60-L65), [`src/review-schema.test.ts:72-83`](src/review-schema.test.ts#L72-L83) — tests covering severity: parses "Critical", rejects "Blocker", accepts nullable optionals alongside "Warning".

### Severity-blind integration points (must change for any option)

- [`src/prompts.ts:5-117`](src/prompts.ts#L5-L117) — six language prompts. No severity-tone guidance.
- [`src/review.ts:5-8`](src/review.ts#L5-L8) — `BASE_SYSTEM_PROMPT`. No severity-tone guidance.
- [`src/index.ts:139`](src/index.ts#L139), [`src/index.ts:170`](src/index.ts#L170) — `config.systemPrompt || BASE_SYSTEM_PROMPT` short-circuits for both `append` and `replace` modes.
- [`src/index.ts:209-225`](src/index.ts#L209-L225) — `sections` array assembly; only the model sub-header is rendered today.
- [`src/__fixtures__/fixture-valid-complete.json:3-9`](src/__fixtures__/fixture-valid-complete.json#L3-L9) — uses all three severities with identical neutral prose.

### Existing render tests (substring-based, not exact-match)

- [`src/review.test.ts:274-343`](src/review.test.ts#L274-L343) — `describe('renderReview')` block, 8 tests, mostly `assert.ok(output.includes(...))`.
- [`src/review.test.ts:295-310`](src/review.test.ts#L295-L310) — "groups findings by file" — only test sensitive to ordering.

### Marker / update-detection invariants

- [`src/review.ts:214`](src/review.ts#L214) — `const COMMENT_MARKER = '### AI Code Review'` definition.
- [`src/review.ts:257-260`](src/review.ts#L257-L260) — `comment.body.startsWith(COMMENT_MARKER)` lookup; marker must remain the literal prefix.
- Emission sites: [`src/index.ts:75-78`](src/index.ts#L75-L78), [`src/index.ts:87-89`](src/index.ts#L87-L89), [`src/index.ts:103-105`](src/index.ts#L103-L105), [`src/index.ts:209`](src/index.ts#L209).

## Architecture Insights

1. **Strict schema + dual sync is the binding constraint.** The repository deliberately hand-writes `ReviewJsonSchema` ([`src/review-schema.ts:24-47`](src/review-schema.ts#L24-L47)) instead of using `z.toJSONSchema()` because Mistral and some NIM providers reject the `$schema` metadata and `anyOf`-for-nullability. Every field exists in two places, and `additionalProperties: false` ([`src/review-schema.ts:40`](src/review-schema.ts#L40)) prevents the model from smuggling extras. Any design that needs new fields (Options C and D) inherits this sync burden; Options A and B do not.

2. **Render determinism is operational, not aspirational.** The README ([`README.md:5`](README.md#L5), [`README.md:57-58`](README.md#L57-L58)) advertises deterministic markdown rendering. `postComment` ([`src/review.ts:216-313`](src/review.ts#L216-L313)) finds an existing comment by exact `### AI Code Review` prefix and updates it via PATCH. This means stable rendering is part of the contract — diffs across re-runs must minimise churn so as not to clutter a PR's conversation history. Per-severity grouping must therefore be **stable**: same input set → same output bytes (achieved trivially by sorting findings within each severity bucket).

3. **`renderReview()` is pure, `index.ts` is the integrator.** `renderReview()` ([`src/review.ts:133-163`](src/review.ts#L133-L163)) takes a validated `Review` object, returns a string. The header (`### AI Code Review` + model sub + tally + body) is assembled in [`src/index.ts:208-225`](src/index.ts#L208-L225) by joining arrays of strings. This makes `renderReview()` easy to unit-test in isolation (which it already is at [`src/review.test.ts:274-343`](src/review.test.ts#L274-L343)) and means a severity-tally helper, if introduced, should also be pure and exported for the same testing reason.

4. **Mistral `tools`-mode vs NIM `json_schema`-mode share one schema.** Both providers consume the same `ReviewJsonSchema` ([`src/review-schema.ts:24-47`](src/review-schema.ts#L24-L47)) via [`src/index.ts:123-126`](src/index.ts#L123-L126) and [`src/openai-client.ts:91-108`](src/openai-client.ts#L91-L108). Any field addition must be syntactically valid as a strict function-tool schema for Mistral — same constraint as the Zod↔JSON schema dual sync. This further argues for keeping the schema minimal (Option A or D over C).

5. **`prompts.ts` language-specialisation is dormant dead code at runtime.** `languageForFile()` ([`src/prompts.ts:120-137`](src/prompts.ts#L120-L137)) returns `'go'`/`'python'`/etc. but only the unit test at [`src/prompts.test.ts:6-30`](src/prompts.test.ts#L6-L30) actually exercises it. There is no per-file prompt selection at runtime in `src/index.ts`; only `BASE_SYSTEM_PROMPT` ([`src/review.ts:5-8`](src/review.ts#L5-L8)) is sent. So any severity-tone guidance added to `src/prompts.ts` is **currently unreachable** from production. (Verify against [`src/index.ts:139`](src/index.ts#L139), [`src/index.ts:170`](src/index.ts#L170).) This is a separate bug independent of this change but worth flagging in `lessons.md`.

6. **`append` vs `replace` is misnamed.** The `nim_prompt_mode` input defaults to `append` but behaves identically to `replace` ([`src/index.ts:139`](src/index.ts#L139)). Any user with a custom `systemPrompt` cannot selectively preserve the default's severity guidance. A follow-up should either (a) implement real append semantics — concatenate `BASE_SYSTEM_PROMPT` + user text inside the call sites — or (b) rename the input honestly to "replace".

## Historical Context (from prior changes)

- `context/changes/schema-validated-review/` — adds the current Zod/JSON schema and explicit pipeline stage "Deterministically render markdown from the validated object". This prior change established that **all** differentiation between findings is renderer-derived; the schema only carries the severity enum. Any future severity-aware rendering must respect the "deterministic renderer from validated object" contract.
- `context/changes/severity-conditioned-rendering/` — a sibling change folder created on the same day (`2026-07-21`, status `preparing`) titled "Per-severity review-message investigation" with an empty `research.md`. **Same intent as this folder**, mine was derived independently. The two should either be merged under one folder or kept separate with cross-links. Recommendation: keep this folder (`severity-based-review-messages`) as the implementation change and treat the older folder as historical/superseded.
- `context/changes/schema-validated-review/reviews/impl-review.md` — uses `❌ CRITICAL` / `⚠️ WARNING` / `ℹ️ OBSERVATION` for human reviewers. Weak precedent for emoji-prefixed severities in the team. Note that `OBSERVATION` is not in the action's enum (which uses `Suggestion`) — the precedent is decorative only.

## Related Research

- `context/changes/schema-validated-review/change.md` — established the deterministic-renderer contract and the validated-object invariant that constrains per-severity differentiation.
- `context/changes/severity-conditioned-rendering/change.md` — sibling investigation folder with an empty placeholder `research.md`. Same intent, started in parallel.
- `context/archive/` — to be searched for prior severity discussions once archived.

## Open Questions

1. **Severity-priority order vs file-alphabetical order inside each bucket.** The current renderer ([`src/review.ts:138-143`](src/review.ts#L138-L143)) sorts files alphabetically. Regrouping by severity preserves that sub-sort. But for a single-file review, the user just sees `### 🚨 Critical (1)\n- ...`. Confirm this matches user expectations; an alternative is severity-grouped × file-grouped (two-level header hierarchy).
2. **Should a severity tally be shown when there are zero findings of that severity?** Today's flat design omits zero-severity entirely. Many code review tools show "0 critical / 0 warnings / 5 suggestions" to communicate "we looked". Decision: render zeros (Option B/C) or hide them (Option A).
3. **Replace `**Severity:**` label with emoji-only badge?** Current label is verbose; an emoji + tier name (e.g. `🚨 Critical`) carries the same information. Test impact: [`src/review.test.ts:291`](src/review.test.ts#L291) asserts `output.includes('Warning')` — survives as long as we keep the word.
4. **Does test at [`src/review.test.ts:295-310`](src/review.test.ts#L295-L310) survive severity-first regrouping?** With inputs `b.ts:Critical`, `a.ts:Warning`, `a.ts:Suggestion` and severity-first iteration `Critical → Warning → Suggestion`, the resulting order is:
   - `### 🚨 Critical (1)` → `**File:** \`b.ts\`` → `...`
   - `### ⚠️ Warning (1)` → `**File:** \`a.ts\`` → `...`
   - `### 💡 Suggestion (1)` → `**File:** \`a.ts\`` → `...`
   
   The assertion `aPos < bPos` ([`src/review.test.ts:306`](src/review.test.ts#L306)) would **fail** because `b.ts` now appears before `a.ts`. The test must be updated, or severity iteration must be alphabetical-by-file-first within each severity bucket.
5. **How to surface the hidden `append`/`replace` bug?** Out of scope for this change but documented as a separate cleanup. It blocks any Option B (prompt-tone) change from reaching `replace`-mode users.
6. **Should `<details>` collapse be used for `Suggestion`?** CodeRabbit, Sourcery, and several AI Actions collapse low-severity sections to reduce noise. With 3 tiers and GitHub's markdown engine being permissive, collapsible blocks are a viable rendering enhancement on top of Option A.
7. **Add `meta.category` separately from severity (CodeRabbit-style 6-axis breakdown)?** Out of scope for this change — would require both schema fields and a renderer pass. Worth a follow-up change folder.

## Recommendations

### Pick: **Option A** (Lightweight, schema unchanged) for the first iteration

Reasons, in order of weight:

1. **Zero schema risk.** It avoids the dual Zod↔JSON-Schema sync burden that [`src/review-schema.ts:21-23`](src/review-schema.ts#L21-L23) warns about, and survives provider compatibility unchanged.
2. **Zero prompt cost.** No regression in the 4 096-token `maxTokens` budget at [`src/index.ts:143`](src/index.ts#L143), [`src/index.ts:176`](src/index.ts#L176).
3. **Pure deterministic rendering.** Same `findings` array always produces the same markdown bytes, including after `postComment` re-runs — preserves the existing conversation-history stability contract.
4. **Matches the dominant external convention.** Emoji-prefixed severities + top-of-comment tally + per-file inline detail is what Danger.js, CodeRabbit, Sourcery, and the AI Actions converge on.

### Recipe

- **Schema** ([`src/review-schema.ts`](src/review-schema.ts)): no changes.
- **Renderer** ([`src/review.ts:133-163`](src/review.ts#L133-L163)): add a `severityMeta` constant `Record<Severity, { emoji: string }>` and a `SEVERITY_ORDER = ['Critical', 'Warning', 'Suggestion']`. Inside `renderReview()`, bucket findings by severity in priority order; for each non-empty bucket, emit `### ${emoji} ${label}${count>1?'s':''} (${count})` then the existing file-alphabetical sub-loop restricted to that bucket.
- **Header** ([`src/index.ts:209-225`](src/index.ts#L209-L225)): when `review && review.findings.length > 0`, push a `\n🚨 ${nCritical} critical${nCritical===1?'':'s'} · ⚠️ ${nWarning} warning${nWarning===1?'':'s'} · 💡 ${nSuggestion} suggestion${nSuggestion===1?'':'s'}\n` line right after the model subheader. Skip the line when zero findings or when `review == null` (model-failed path).
- **Bullet prefix** ([`src/review.ts:153`](src/review.ts#L153)): drop `- **Severity:** ${f.severity}`; replace with `- ${emoji} **${f.severity}**`. Keeps the literal word `Warning` for `review.test.ts:291`.
- **Order inside each severity bucket**: keep file-alphabetical so the existing test at [`src/review.test.ts:295-310`](src/review.test.ts#L295-L310) survives verbatim (every severity bucket its files alphabetically, and within the `Warning` and `Suggestion` buckets the test's `a.ts` entries stay ahead of `b.ts`).
- **Tests** ([`src/review.test.ts`](src/review.test.ts)): add `renders emoji prefix per severity`, `renders severity tally in header` (requires a tiny tally helper exported from `review.ts` for unit-testability), `omits severity buckets with zero findings`, `renders severe findings in priority order regardless of input order`.
- **Doc**: update [`README.md:53-58`](README.md#L53-L58) (the "Structured output" + "Render" sections) with a note that severities surface as emoji-prefixed headers and a tally.

### Build

After the change, run `npm run build` ([`package.json:7`](package.json#L7)) to regenerate `dist/bundle/index.js` — the action runs the bundle, not the TypeScript source.

### Follow-ups to consider (separate change folders)

- **Option B / D** once there is concrete user feedback that the LLM tone doesn't match the severity label.
- **A real `append`/`replace` mode** ([`src/index.ts:139`](src/index.ts#L139), [`src/index.ts:170`](src/index.ts#L170)) so future Option-B prompt changes reach `replace`-mode users.
- **`prompts.ts` runtime activation** (currently dead code at runtime).
