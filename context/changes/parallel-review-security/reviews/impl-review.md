<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Security Hardening from Parallel Review Findings

- **Plan**: `context/changes/parallel-review-security/plan.md`
- **Scope**: Phases 1 + 2 (full plan — change.md status `implemented`, both phases committed as `323d84c` and `dbd17b7`)
- **Date**: 2026-08-03
- **Verdict**: NEEDS ATTENTION
- **Findings**: 2 critical, 3 warnings, 1 observation

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | FAIL |
| Scope Discipline | WARNING |
| Safety & Quality | FAIL |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | WARNING |

## Findings

### F1 — PR diff interpolated raw into revalidation prompt

- **Severity**: ❌ CRITICAL
- **Impact**: 🔬 HIGH — architectural stakes; think carefully before deciding
- **Dimension**: Safety & Quality
- **Location**: `src/validation.ts:146`
- **Detail**: The revalidation user prompt interpolates `truncatedDiff` directly with no escaping:
  ```ts
  { role: 'user', content: `${prompt}\n\nDiff:\n\`\`\`\n${truncatedDiff}\n\`\`\`` },
  ```
  A PR diff can carry prompt-injection text inside identifiers, comments, or strings, and that text reaches the validator model verbatim. The plan's Verification section explicitly states: *"A PR diff containing prompt-injection text in a backtick identifier cannot influence the revalidation outcome."* Phase 2.2 sanitized only `f.issue` (line 124), not the diff. The diff path was promised, not delivered.
- **Fix**: Either (A) add a clear data-vs-instructions boundary — escape or structurally isolate the diff inside the user message, plus a system instruction that the diff is data — or (B) update the plan's Verification claim to match what was actually built and document the residual risk. Option A is the right call: this is a real injection vector the plan already acknowledged.
  - Strength: Closes the gap the plan already promised to close; removes a known prompt-injection path.
  - Tradeoff: Requires a small structural change to the prompt and a new regression test.
  - Confidence: HIGH — `escapeMarkdown` already exists for this kind of sanitization, and the diff is text.
  - Blind spot: True defense-in-depth also requires a system-side instruction telling the model the diff is data, not commands; we should verify both layers in the test.
- **Decision**: FIXED (Fix A) — `validation.ts:144-150` now wraps `truncatedDiff` in `escapeMarkdown` and adds a system-side instruction that the diff is untrusted data. Regression test at `validation.test.ts:339-368` asserts the system message and code fence boundary. All 480 tests pass.

### F2 — Dual-schema drift detector doesn't actually validate equivalence

- **Severity**: ❌ CRITICAL
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: `src/review-schema.test.ts:277-323`
- **Detail**: Phase 2.4 promised *"a test that parses a sample finding through both `ReviewSchema.safeParse` and validates it against `ReviewJsonSchema` ... fails if the two schemas accept/reject different shapes"*. The implementation constructs drifted schema objects but never validates samples against the drifted `ReviewJsonSchema`, and never compares acceptance results between the two schemas:
  - `zodTypeToJsonTypes` (lines 147-166) is defined but unused.
  - `ReviewFindingSchema` (line 5) is imported but unused.
  - Test 1 (lines 277-288) only asserts `driftedRequired !== undefined` — a tautology.
  - Test 2 (lines 290-323) only asserts that `rogue_field` was inserted into a drifted required list — no validation of any sample against the drifted schema.
  - Meanwhile `ReviewJsonSchema` declares `additionalProperties: false` (`src/review-schema.ts:46`) while `ReviewSchema` strips extra properties — a real acceptance gap the test would miss.
  The drift detector would pass even if the two schemas diverged on a required field, an enum value, or `additionalProperties`.
- **Fix**: Replace the two drift tests with one that uses a real JSON Schema validator (e.g. `ajv`) to validate the same sample through both schemas and asserts identical `success` results, plus deliberate-drift samples where the two schemas MUST disagree and the test asserts disagreement.
  - Strength: Actually catches the drift the test name promises to catch.
  - Tradeoff: Adds a runtime dependency (`ajv` ~17kb) or a hand-rolled walker; one of those is needed to validate against `ReviewJsonSchema`.
  - Confidence: HIGH — `ajv` is the canonical JSON Schema validator and is already a common devDep pattern.
  - Blind spot: Hand-rolled walker would only handle the subset of JSON Schema features used here; `ajv` is the safer choice.
- **Decision**: FIXED — Replaced the two tautological drift tests at `review-schema.test.ts:277-323` with three tests that use `ajv` to actually validate samples through `ReviewJsonSchema` and compare results against `ReviewSchema.safeParse`. Includes a positive test, a negative test, and a deliberate-drift test where the JSON Schema requires a `rogue_field` and the test asserts the sample is rejected. All 481 tests pass.

### F3 — Phase 1.3 appends entire language prompt, not just security focus areas

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Plan Adherence
- **Location**: `src/prompts.ts:226-232`
- **Detail**: The plan's UX spec is explicit: *"we append the language-specific security focus areas, not the entire base prompt"* (line 50). The implementation does the opposite:
  ```ts
  const languageSecurity = language ? languagePrompts[language] : undefined;
  ```
  `languagePrompts[language]` is the full language template assembled at lines 173-190: role, focus areas, anti-patterns, severity calibration, `SEVERITY_GUIDANCE`, and `JSON_SCHEMA_DEFINITION`. The result is then concatenated after `JSON_SCHEMA_DEFINITION` + `SEVERITY_GUIDANCE` (line 232), producing duplicated schema/severity blocks and re-injection of non-security content (role, anti-patterns). The plan's test at line 95 only checked inclusion of "Go security focus areas", which the entire-prompt satisfies — so the test passes despite the contract violation.
- **Fix**: Either extract a `languageSecurityPrompts[language]` that contains only the security focus areas (matching the plan's wording), or amend the plan to permit the current broader injection. The first option matches the documented UX spec.
  - Strength: Honors the plan's explicit UX contract; eliminates duplicate `SEVERITY_GUIDANCE`/`JSON_SCHEMA_DEFINITION` blocks.
  - Tradeoff: One new constant + a test that asserts the duplication is gone.
  - Confidence: HIGH — the plan's wording is unambiguous.
  - Blind spot: The other content (role, anti-patterns) is benign; the cost of the bug is duplicated/verbose prompts, not security.
- **Decision**: FIXED — Added `languageSecurityFocusPrompts[lang]` (only the focus areas, not the full template) and use it in `prompts.ts:226`. New regression test at `prompts.test.ts:142-158` asserts no duplicate `## Severity Classification` block, no `Anti-patterns` block in the security section, and no `expert Go engineer` role duplication. All 482 tests pass.

### F4 — Strict-mode warning text inconsistency

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: `src/validation.ts:178`
- **Detail**: Phase 2.3 contract: each of the three fail-open paths must explicitly state *"security findings may pass unverified."* Two paths use the required phrase (lines 160, 169, 197). The short-array path at line 178 uses *"security findings may be unverified"* instead. Semantically equivalent, but the literal contract was specified.
- **Fix**: Change line 178's wording to `... — security findings may pass unverified.` to match the other two paths.
  - Strength: One-line fix, restores contract uniformity across all three fail-open paths.
  - Tradeoff: None significant.
  - Confidence: HIGH.
  - Blind spot: None significant.
- **Decision**: FIXED — `validation.ts:178` now says "security findings may pass unverified" matching the other two fail-open paths. All 482 tests pass.

### F5 — Undocumented custom-rules injection in replace mode

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Scope Discipline
- **Location**: `src/prompts.ts:230-232`, tested at `src/prompts.test.ts:161-168`
- **Detail**: Before this change, `replace` mode discarded `buildSystemPrompt(language, rules)` entirely (line 224-227 in the original plan quote), so custom rules never reached the prompt. The Phase 1.3 implementation injects `formatRulesForPrompt(rules || [])` even in non-empty-replace mode (line 230). Rules are now pre-filtered by Phase 1.1, so this is safe — but it is a behavior expansion not described in the plan. Previously, users on `replace` mode had to choose between custom rules AND custom prompts; now they get both.
- **Fix A ⭐ Recommended**: Document the new behavior in the plan as an addendum and add a sentence to the Migration Notes ("`replace` mode now also includes custom rules; previously they were dropped"). Keep the change.
  - Strength: Preserves the working behavior; updates the source of truth; users gain a feature they previously couldn't get.
  - Tradeoff: Plan becomes a slightly moving target.
  - Confidence: HIGH — addendum pattern is used elsewhere in this repo's plans.
  - Blind spot: Any downstream doc that says "replace mode ignores custom rules" needs updating.
- **Fix B**: Remove the rule injection from replace mode to match the original plan exactly
  - Strength: Strict scope discipline.
  - Tradeoff: Loses a working feature; users on `replace` mode still can't combine prompts with rules.
  - Confidence: MED — depends on whether anyone relies on this yet.
  - Blind spot: A test was added at `prompts.test.ts:161-168` that exercises this path, so removing it would break a test that codifies the new behavior.
- **Decision**: FIXED (Fix A) — Added an addendum to `plan.md` Migration Notes documenting that `replace` mode now also injects `custom_rules` (previously dropped with the base prompt). Behavior preserved.

### F6 — Progress section not updated for Phase 2

- **Severity**: 📝 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Success Criteria
- **Location**: `context/changes/parallel-review-security/plan.md` (`## Progress` section)
- **Detail**: Phase 2 was implemented (`dbd17b7`) and its automated verifications pass (build green, 479 tests green). However the `## Progress` checkboxes for Phase 2 remain all `[ ]`. Manual checkboxes for both phases also remain unchecked. The change.md status is `implemented`, which is correct — the Progress section is just stale.
- **Fix**: Flip the completed automated checkboxes in `## Progress` for both phases to `[x]` with the relevant commit SHAs; leave the Manual items `[ ]` if they were not actually performed, or perform them.
  - Strength: Restores the Progress section as a faithful record.
  - Tradeoff: None significant.
  - Confidence: HIGH.
  - Blind spot: Manual verification items (Phase 1.7-1.9, 2.7-2.10) may not have been performed; flipping them without doing the work is rubber-stamping.
- **Decision**: FIXED — Phase 2 Automated checkboxes flipped to `[x]` with commit SHA `dbd17b7`. Phase 1 Manual and Phase 2 Manual items left `[ ]` (not rubber-stamped; the impl-review fixes captured in this report cover the broader work done post-implementation).