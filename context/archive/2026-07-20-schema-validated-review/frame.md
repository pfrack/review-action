# Frame Brief: Structured-Output Validation for review-action

> Framing step before /10x-plan. This document captures what is *actually*
> at issue, separated from what was initially assumed.

## Reported Observation

"BAML or other library usage for better LLM usage" in `review-action`, with
the user narrowing outcome to **review quality & trust** (more reliable,
structured, machine-checkable review output) and scope to **review loop +
prompt management** (`src/review.ts`, `src/index.ts` review path,
`src/prompts.ts`).

## Initial Framing (preserved)

- **User's stated cause or approach**: (not stated) — only the outcome was
  pinned ("review quality & trust")
- **User's proposed direction**: "BAML or other library" — initial leaning
  toward BAML specifically
- **Pre-dispatch narrowing**:
  - Pain point: "Not separated yet" → open-ended investigation required
  - Outcome: review quality & trust (structured, machine-checkable output)
  - Scope: review loop + prompt management (`src/prompts.ts` + the review
    call site in `src/index.ts:107-131`)

## Dimension Map

The observation could originate at any of these dimensions:

1. **Output shape problem** — The action posts free-text markdown to PR
   comments with no schema enforcement; the contract lives entirely in the
   prompt text. **← user's framing lives here.**
2. **Defensive handling gap** — Malformed / refusal / truncated responses
   are posted verbatim; `finish_reason: 'length'` is silently dropped.
3. **Bundle / distribution constraint** — `@vercel/ncc` produces a single
   ~980 KB `dist/bundle/index.js`; ESM-only source (`package.json:5`).
4. **Multi-model fallback architecture** — NIM/Mistral/custom chain in
   `src/model-chain.ts:26-54` must keep working through any new layer.
5. **Test surface gap** — No golden-file or schema-enforcement tests exist;
   review quality regressions are invisible to CI.
6. **Prompt-as-code opportunity** — `src/prompts.ts` is plain string
   literals; typed function signatures could improve iteration.
7. **Library-fit (BAML specifically)** — Whether BAML's schema-first DSL +
   Rust runtime is the right tool for this size project.

## Hypothesis Investigation

| Hypothesis | Evidence | Verdict |
| --- | --- | --- |
| **1. Output shape problem is real** | Zero parsing of LLM content anywhere (`nim-client.ts:89` returns `.trim()`); no schema deps in `package.json`; PRD doesn't cover review-output quality (`context/foundation/prd.md:1-144`); orphan `.txt` prompts are dead code (`src/prompts/*.txt`); existing `6870d9d fix: exclude dist/ from code review (ncc bundle false positives)` proves the no-schema approach produces low-quality noise | **STRONG** |
| **2. Defensive handling is missing** | `finish_reason: 'length'` defined at `nim-client.ts:41` but never inspected; refusal responses posted verbatim; malformed markdown (missing `**Severity:**`) posted verbatim; no diff-size guard (flagged F7 WARNING in `context/changes/nodejs-rewrite/reviews/impl-review.md:104-116`, still unfixed) | **STRONG** |
| **3. Bundle/ESM constraint is binding** | `dist/bundle/index.js` = 979.8 KB; `ncc build` per `package.json:7`; Node 24 runner (`action.yml:51`); `"type": "module"` (`package.json:5`); `@actions/core` is the only runtime dep; `254896c` had to inline prompts to dodge ncc ESM dynamic-import bugs | **STRONG** |
| **4. Multi-model fallback must survive** | `src/model-chain.ts:26-54` merges NIM + Mistral by SWE-bench score, prepends custom; the chain is dynamic and user-configurable via action inputs; any layer that constrains to a single model breaks the chain | **STRONG** |
| **5. Test surface gap is real** | `src/review.test.ts:261-276, 311-330` mocks return `'test response'` strings; `src/prompts.test.ts` asserts substring presence; no golden-file tests; no schema assertions | **STRONG** |
| **6. Prompt-as-code is secondary** | `src/prompts.ts` is 6 hand-written templates × ~25 lines each; not large enough by itself to justify a new DSL; the schema/parser is the materially valuable part | **WEAK** (would matter at 10× scale, not now) |
| **7. BAML is the wrong fit** | `@boundaryml/baml@0.223.0` ships a Rust `napi-rs` native addon (61.6 MB on Linux x64); requires `npx baml-cli generate` codegen step; ESM ncc output fails with `__filename is not defined in ES module scope`; 153 versions in <24 months (frequent breaking changes); pre-1.0; **abandoned `context/changes/baml-prompts/`** folder shows this was already considered and dropped | **STRONG** (independent verification: two separate agents converge) |

## Narrowing Signals

Decisive observations from the investigation that narrowed the hypothesis
space:

- **BAML-specific blockers are binding, not nice-to-have.** A napi-rs native
  binary literally cannot be inlined into a single `dist/bundle/index.js` —
  this is a hard architectural mismatch with the project's distribution
  model (`package.json:7`, `action.yml:51`), not a stylistic preference.
- **The `baml-prompts/` abandoned folder is independent evidence.** A
  previous scoping effort reached the same conclusion without writing a
  record of why. The "no record of why it was dropped" pattern is itself
  the lesson.
- **Zod + OpenAI `response_format` is independently verified to fit** by
  two agents: ~17 KB gzipped, zero deps, `tsc && ncc` build unchanged,
  bundle stays ~980 KB, schema lives in one new file.
- **Schema-valid ≠ trustworthy.** Even with BAML or Zod, the action still
  needs deterministic diff-level validation (file exists in PR, line range
  is in a changed hunk, no prompt injection in the diff). This work is
  library-agnostic and unavoidable.

## Cross-System Convention

How is "review quality & trust" typically handled in GitHub Action LLM
projects?

- **Convention A: schema-validated structured output + render-to-markdown.**
  Most production code-review bots (CodeRabbit, Sourcery, Bito AI) use a
  typed intermediate representation with JSON schema or similar; the PR
  comment is rendered from the validated object. The action's current
  write-only-markdown approach is the outlier.
- **Convention B: explicit truncation / refusal handling.** Production
  code-review tools always check `finish_reason` and handle refusals as a
  distinct signal, not as a review. The action currently posts both.
- **Convention C: deterministic post-validation.** File/line/scope checks
  are run against the PR diff before posting, not trusted to the model.
  This layer is missing entirely from the action.
- **Convention D: golden-file or fixture regression tests.** Prompt
  revisions are validated against a fixed corpus of expected outputs.

The leading hypothesis (Dimension 1 + 2 + 5) matches Conventions A, B, C,
D simultaneously — the action is missing all four. Adding only one (e.g.,
schema validation without truncation handling) would close part of the
gap but not the whole. This shapes the plan.

## Reframed (or Confirmed) Problem Statement

> **The actual problem to plan around is**: the action has no schema
> enforcement on LLM output and no deterministic validation of the review
> against the PR diff. Reviews are posted verbatim regardless of shape —
> malformed markdown, refusals, and truncations all look identical to a
> legitimate review. There is no test surface that would catch a regression
> in review quality.

This is what "review quality & trust" actually means in this codebase. The
user's framing — "BAML or other library" — names the *proposed solution*
(layered on top of the schema concept), not the *underlying problem*.

The choice of library is downstream of deciding to fix the underlying
problem. Once "we need schema-validated review output with deterministic
diff validation" is the agreed problem, the library question is forced:

- **BAML**: 3 architectural blockers (native addon, codegen step, ESM/CJS
  conflict). Wrong scale for a 200-LOC review call.
- **Zod + OpenAI JSON mode**: ~17 KB gzipped, zero codegen, fits the ncc
  bundle, preserves the multi-model fallback chain. Right scale.
- **Instructor**: 12-month-stale TS port, brings `openai` SDK that
  duplicates `NimClient`. Wrong tool.
- **TypeChat**: `typescript` peer dep balloons bundle to ~8 MB, single-
  model architecture. Wrong tool.
- **Hand-rolled**: viable, but Zod adds a few KB and gives `z.infer<>`
  for free.

## Confidence

- **HIGH** — three independent investigations converge on the same
  diagnosis and the same library verdict. The bundle constraint is
  mechanically verified (ncc + ESM + 980 KB target). The gap inventory is
  grounded in 10 specific file:line references.

## What Changes for /10x-plan

The plan should be **two layers of work, in this order**:

1. **Schema + parse layer (library-light)**: Add Zod-typed `Review` /
   `Finding` schema in `src/review-schema.ts`; extend `nim-client.ts` with
   a `response_format: { type: 'json_schema', strict: true, schema }`
   option (NIM/custom endpoints); use `tools` calling for Mistral. Parse
   the response with `ReviewSchema.safeParse()`; retry once with the
   validation error appended on failure. Treat schema-parse failures as
   model failures (continue down the chain).

2. **Deterministic diff validation layer (no library)**: Before posting,
   validate each finding's `file` exists in the PR's changed files and
   each `line_start..line_end` is inside a changed hunk. Drop or flag
   out-of-scope findings.

3. **Test surface (no library)**: Add golden-file fixtures of raw model
   responses (valid, malformed, refusal, truncated) and assert
   `safeParse()` behavior + diff validation outcomes.

4. **Markdown rendering (no library)**: Change `index.ts:138-145` from
   `sections.push(\`\n${review}\`)` to a small renderer that takes the
   validated `Review` object and produces the comment body.

BAML is not part of v1. If a follow-up change wants to explore BAML's
schema-aligned parser, prompt playground, or generated-client workflow, it
should be a narrowly scoped spike on a separate branch — not a replacement
for the Zod path.

## References

- **Source files**:
  - `src/index.ts:99-145` — review loop, output assembly, `postComment` call
  - `src/review.ts:6-15` — `BASE_SYSTEM_PROMPT` markdown contract
  - `src/review.ts:113-209` — `postComment`, `findExistingComment`, `resolveSystemPrompt`
  - `src/review.ts:211-251` — `reviewFile`, `reviewFileWithFallback` (dead code)
  - `src/nim-client.ts:38-93` — request shape, response parsing, `finish_reason` defined but unused
  - `src/prompts.ts:3-159` — 6 inline language templates
  - `src/prompts.ts:161-183` — `languageForFile`, `languageForTemplate`
  - `src/prompts/*.txt` — orphan prompts (dead)
  - `src/model-chain.ts:26-54` — `buildCombinedChain`
  - `package.json:5,7` — ESM, ncc build
  - `action.yml:43,51` — exclude patterns, node24 runtime
- **Prior decisions / related**:
  - `context/changes/baml-prompts/` — abandoned (no record kept)
  - `context/changes/nodejs-rewrite/reviews/impl-review.md:104-116` — F7 WARNING on diff size
  - `context/foundation/prd.md:1-144` — covers model ranking, not review quality
  - `context/changes/mistral-support/` — provider-promotion precedent
  - `context/changes/custom-api-support/` — provider-promotion precedent
- **External** (independently consulted):
  - npm `@boundaryml/baml@0.223.0` — napi-rs keywords, Rust binary payload
  - npm `zod@4.4.3` — 234M weekly downloads, 0 deps, ~17 KB gzipped
  - npm `@instructor-ai/instructor@1.7.0` — last published Aug 2025
  - npm `typechat@0.1.2` — `typescript` peer dep
  - npm `dspy.ts@2.2.0` — community port, 144 weekly downloads
  - context7 docs for BAML (TS guide, `openai-generic`), Instructor, TypeChat, Outlines, DSPy
- **Investigation tasks**: three parallel `general` sub-agents (codebase audit,
  BAML fit, alternatives comparison)