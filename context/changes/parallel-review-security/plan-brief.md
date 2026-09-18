# Security Hardening — Plan Brief

> Full plan: `context/changes/parallel-review-security/plan.md`
> Research: `context/changes/parallel-review-findings/research.md`

## What & Why

The parallel code review uncovered two CRITICAL and four HIGH security gaps in `review-action`: prompt-injection defenses that only warn but don't act, a `replace` prompt mode that silently discards all language-specific security guidance, stored XSS in PR comments via raw LLM output, unsanitized finding text re-injected into revalidation prompts, fail-open revalidation that passes security findings unverified, and a dual Zod/JSON schema kept in sync only by a comment.

This is **Change 1 of 3** from the parallel-review-findings umbrella. Security ships first — highest risk, smallest blast radius, fastest to verify.

## Starting Point

The codebase already has solid SSRF defense (`validateProviderUrl`), secret redaction (`sanitizeErrorBody`), and prompt-injection *detection* (`validateRules` with 11 patterns). The gaps are in the *response* to detected threats: detection without action (advisory-only), bypass paths (`replace` mode), and unsanitized data flows (raw output → comment, finding text → revalidation prompt).

## Desired End State

All user-controlled input paths (custom rules, custom prompts, PR diff content surfaced as findings) have defense-in-depth against prompt injection. Raw LLM output is escaped before reaching PR comments. Revalidation cannot silently pass all findings. Schema drift is caught at test time. A malicious PR diff cannot influence revalidation, a malicious custom rule cannot inject instructions, and `replace` mode users still get security checks.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
|----------|--------|-------------------|--------|
| Injection rule handling | Block entirely (filter out) | Advisory-only warnings leave the injection vector open. | Plan |
| `replace` mode security guidance | Append language-specific security focus to user prompt | Preserves `replace` intent (custom focus) while not dropping security checks. | Plan |
| `lastRawContent` XSS | HTML-escape via existing `escapeMarkdown` | Reuses existing utility that already escapes `<>&`. | Plan |
| Revalidation prompt injection | Sanitize finding text with `escapeMarkdown` before slicing | Strips injection-relevant characters before LLM re-injection. | Plan |
| Fail-open revalidation | Explicit warning + configurable `strictRevalidation` flag (default off) | Keeps CI-friendliness while surfacing the risk; opt-in strict mode for security-sensitive repos. | Plan |
| Dual-schema drift | Runtime test comparing Zod vs JSON Schema | No compile-time option (hand-written JSON Schema for provider compat), test-time is the next best guard. | Plan |
| Scope split | 3 changes (security, hardening, testing) | Security ships fast independently; hardening and testing are larger and lower-risk. | Plan |

## Scope

**In scope:**
- Block injection-pattern custom rules (filter, not warn) — `index.ts`, `rules.ts`
- Preserve security guidance in `replace` mode — `prompts.ts`
- HTML-escape `lastRawContent` in PR comments — `index.ts`
- Sanitize finding text in revalidation prompt — `validation.ts`
- Configurable fail-closed revalidation — `validation.ts`, `config.ts`
- Dual-schema drift test — `review-schema.test.ts`

**Out of scope:**
- Retry/timeout hardening, parallel calls safety, probe redesign, GitHub/config cleanup (Change 2)
- Testing debt: withRetry, diff-utils, run() coverage, dedup (Change 3)
- Unicode homoglyph / DAN-style injection pattern expansion (follow-up)

## Architecture / Approach

Two phases by severity. Phase 1 (CRITICAL): close the two prompt-injection vectors — rule blocking + `replace` mode security preservation. Phase 2 (HIGH): close the four data-integrity issues — XSS escaping, revalidation sanitization, fail-open hardening, schema drift test. Every fix ships with a test proving the attack vector is closed.

## Phases at a Glance

| Phase | What it delivers | Key risk |
|-------|-----------------|----------|
| 1. Critical Security Fixes | Injection rules blocked; `replace` mode keeps security guidance | `replace` mode behavior change for existing users — they'll see new security findings (intended fix, but needs communication) |
| 2. High-Severity Security Fixes | XSS escaped; revalidation sanitized + strict mode; schema drift test | `strictRevalidation` config addition must not break existing CI (defaults to off) |

**Prerequisites:** None — this is the first change from the research.
**Estimated effort:** ~1-2 sessions across 2 phases (6 source-file changes + 5 test additions)

## Open Risks & Assumptions

- `replace` mode users who relied on *not* getting security findings will see behavior change — this is the intended fix but should be documented in release notes
- The `blockedRules` index-based filtering assumes `validateRules` returns stable indices — must verify the implementation preserves rule order
- `escapeMarkdown` on finding text in the revalidation prompt changes what the revalidation model sees — the model's real/hallucination judgment should be unaffected by HTML-entity escaping, but this is an assumption worth verifying in manual testing

## Success Criteria (Summary)

- A custom rule containing "Ignore previous instructions" is blocked, not injected into the prompt
- `replace` mode with a custom prompt still flags a Go goroutine leak
- Raw LLM output with `<script>` tags renders as escaped text in the PR comment
- `strictRevalidation=true` drops all findings when revalidation fails, instead of passing them through
- Schema drift test fails when Zod and JSON Schema disagree
