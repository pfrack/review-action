# review-improvements Implementation Plan

## Overview

Comprehensive improvements to the review-action across three dimensions: review quality (new prompts, deep validation), performance (file batching, diff chunking), and features (inline comments, custom rules, analytics). Each phase is independently shippable.

## Current State Analysis

The review-action is a GitHub Action that performs AI-powered code review on PRs using NVIDIA NIM, Mistral, or custom OpenAI-compatible APIs. Key findings from codebase analysis:

- **Prompts**: Language-specific prompts exist in `src/prompts.ts` (Go, Python, TS, Java, Rust, C++) but are never used — `src/index.ts` always uses `BASE_SYSTEM_PROMPT`
- **Validation**: Finding validation (`src/review.ts:122-165`) checks file existence, line consistency, and hunk overlap with 10% tolerance, but no semantic validation
- **Performance**: No caching, no file batching, sequential model fallback with 3-minute timeout per model
- **Comments**: Only top-level PR comments via `/issues/{pr}/comments` API, no inline/line-level comments
- **Rules**: No custom rule support — all review logic is hardcoded in prompts
- **Metrics**: No analytics or metrics collection

## Desired End State

- New, research-backed system prompts with language-aware instructions and improved severity guidance
- Deep validation: AST-aware code context verification + LLM re-validation before posting
- File batching for large PRs (50 files per batch), with diff chunking and parallel processing
- Inline review comments via GitHub Review API, posting findings on specific lines
- Custom rules defined via action inputs, injected into review prompts
- PR-level metrics (findings count, severity distribution, model performance) output to step summary

### Key Discoveries:

- `src/prompts.ts:18` — Language-specific prompts are defined but unused (infrastructure ready)
- `src/review.ts:122` — `validateFindings()` has hunk overlap tolerance but no semantic checks
- `src/openai-client.ts:159` — `chatStream()` exists but is only used by benchmark, not review path
- `src/review.ts:264` — `postComment()` uses find-and-replace pattern with `COMMENT_MARKER`
- `src/model-chain.ts:26` — `buildCombinedChain()` merges providers, sorts by SWE-bench score

## What We're NOT Doing

- Not changing the action.yml input interface (backward compatible)
- Not modifying the model chain logic or benchmark system
- Not implementing A/B testing between models
- Not adding real-time dashboards or external storage for metrics
- Not changing the existing CI workflow

## Implementation Approach

Incremental delivery across 6 phases, each independently shippable. Phases 1-2 focus on quality, Phase 3 on performance, Phases 4-6 on features. Each phase includes tests and manual verification.

---

## Phase 1: Prompt Redesign

### Overview

Replace the current generic system prompt with new, research-backed prompts that include language-specific instructions, improved severity guidance, and better structured output formatting.

### Changes Required:

#### 1. System Prompt Architecture

**File**: `src/prompts.ts`

**Intent**: Redesign the prompt system to be modular and language-aware, with a base prompt that includes core review instructions and language-specific addenda that enhance focus areas.

**Contract**: Export `buildSystemPrompt(language?: string)` function that returns the complete system prompt. The base prompt includes role definition, severity guidance, and JSON schema. Language-specific sections are appended when language is detected.

#### 2. Severity Guidance Enhancement

**File**: `src/prompts.ts`

**Intent**: Rewrite `SEVERITY_GUIDANCE` with clearer definitions, concrete examples, and explicit rules for when to use each severity level. Add anti-patterns to reduce false positives.

**Contract**: `SEVERITY_GUIDANCE` constant includes:
- Critical: Security vulnerabilities, data loss, race conditions, undefined behavior
- Warning: Likely bugs, resource leaks, error handling gaps, maintainability issues
- Suggestion: Style, readability, naming, minor optimizations
- Anti-patterns list: Don't flag imports, don't flag test files for style, don't flag auto-generated code

#### 3. Language-Specific Prompts

**File**: `src/prompts.ts`

**Intent**: Create new language-specific prompt sections that focus on the most impactful issues for each language, reducing noise from low-value findings.

**Contract**: Each language prompt (Go, Python, TS, Java, Rust, C++) includes:
- Top 5 focus areas specific to that language
- Common anti-patterns to check for
- Examples of critical vs warning findings in that language
- Language-specific severity calibration (e.g., `unwrap()` in Rust is Warning, not Critical)

#### 4. Prompt Integration

**File**: `src/index.ts`

**Intent**: Update the review flow to detect file languages and build appropriate prompts. Use the most common language in the diff, or fall back to generic.

**Contract**: In the model chain iteration loop (lines 129-220), replace `BASE_SYSTEM_PROMPT` with `buildSystemPrompt(detectedLanguage)`. Language detection uses `languageForFile()` from prompts.ts.

### Success Criteria:

#### Automated Verification:

- Unit tests pass: `npm test`
- TypeScript compiles: `npm run build`
- Prompt tests validate language detection and prompt structure
- Snapshot tests for prompt output

#### Manual Verification:

- Review a Go PR — findings should focus on goroutines, error handling, resource management
- Review a Python PR — findings should focus on mutable defaults, type hints, async issues
- Review a TypeScript PR — findings should focus on async/await, type safety, promise handling
- Severity classification matches expectations (security issues = Critical, style = Suggestion)

---

## Phase 2: Enhanced Validation

### Overview

Improve finding validation with AST-aware code context verification and an optional LLM re-validation step before posting findings to the PR.

### Changes Required:

#### 1. Code Context Validation

**File**: `src/validation.ts` (new)

**Intent**: Create a validation module that checks findings against actual code context. Verify that referenced function names, variable names, and class names exist in the diff.

**Contract**: `validateCodeContext(finding, diff)` returns `{ valid: boolean, reason?: string }`. Checks:
- If finding references a function call, verify the function name appears in the diff
- If finding references a variable, verify the variable is defined or used in the diff
- If finding references a class/method, verify the class exists in the changed files

#### 2. LLM Re-Validation

**File**: `src/validation.ts`

**Intent**: Add an optional LLM re-validation step that sends findings back to the model for confirmation before posting. This catches hallucinated findings that pass structural validation.

**Contract**: `revalidateFindings(findings, diff, client)` sends a prompt asking the model to confirm each finding is valid. Returns filtered findings. Controlled by `revalidate_findings` input (default: false for performance).

#### 3. Validation Pipeline

**File**: `src/review.ts`

**Intent**: Integrate the new validation steps into the existing `validateFindings()` pipeline. Add code context validation after hunk overlap check, and optional LLM re-validation as the final step.

**Contract**: `validateFindings()` pipeline order:
1. File existence check (existing)
2. Line consistency check (existing)
3. Hunk overlap check (existing)
4. Code context validation (new)
5. LLM re-validation (optional, new)

#### 4. Validation Tests

**File**: `src/validation.test.ts` (new)

**Intent**: Write comprehensive tests for the new validation logic, including edge cases for code context checks and mock LLM responses.

**Contract**: Tests cover:
- Finding with valid function reference → passes
- Finding with hallucinated function name → fails
- Finding with no code references → passes (can't validate)
- LLM re-validation confirms valid finding → passes
- LLM re-validation rejects finding → filtered out

### Success Criteria:

#### Automated Verification:

- Unit tests pass: `npm test`
- TypeScript compiles: `npm run build`
- Validation tests cover all edge cases
- No false rejections on valid findings (manual spot-check)

#### Manual Verification:

- Submit a PR with known issues — findings should pass validation
- Submit a PR with clean code — no hallucinated findings should pass
- Optional LLM re-validation reduces false positives without removing true positives

---

## Phase 3: Performance Optimizations

### Overview

Add file batching for large PRs, diff chunking, and parallel processing to reduce review time and improve reliability.

### Changes Required:

#### 1. File Batching Logic

**File**: `src/batching.ts` (new)

**Intent**: Create a batching module that splits large diffs into manageable chunks. Each batch is reviewed independently, results are merged.

**Contract**: `batchFiles(files, batchSize = 50)` returns `FileBatch[]`. Each batch contains up to `batchSize` files with their diff hunks. Batches are ordered by file path for determinism.

#### 2. Batch Processing

**File**: `src/index.ts`

**Intent**: Update the review flow to process files in batches when the diff exceeds the batch size threshold. Each batch gets its own model chain iteration, results are merged.

**Contract**: In `run()`, after diff construction (line 121):
- If file count > batchSize, split into batches
- Process each batch through the model chain
- Merge results: concatenate findings, deduplicate by file+line
- Post single comment with all findings

#### 3. Diff Chunking

**File**: `src/diff-utils.ts` (new)

**Intent**: Split large file diffs into chunks that fit within token limits. Handle cases where a single file's diff exceeds the context window.

**Contract**: `chunkDiff(diff, maxTokens = 12000)` returns `DiffChunk[]`. Each chunk preserves the `@@` header context. Chunks are processed independently and findings are attributed to the correct file/line.

#### 4. Parallel Model Probing

**File**: `src/model-chain.ts`

**Intent**: When multiple providers are configured, probe models in parallel to find the fastest available model, then use that for the review.

**Contract**: `probeModels(chain)` returns the first responding model. Use `Promise.race()` with timeout for each probe. Fall through to sequential on timeout.

### Success Criteria:

#### Automated Verification:

- Unit tests pass: `npm test`
- TypeScript compiles: `npm run build`
- Batching tests verify correct file splitting and merge logic
- Diff chunking tests verify token-aware splitting

#### Manual Verification:

- PR with 100+ files completes review within 5 minutes (vs current ~10+ minutes)
- Large single-file diffs are chunked and reviewed correctly
- Parallel probing finds fastest model reliably

---

## Phase 4: Inline Comments

### Overview

Post review findings as inline comments on specific lines using the GitHub Review API, replacing the current top-level PR comment approach.

### Changes Required:

#### 1. Review API Client

**File**: `src/github-review.ts` (new)

**Intent**: Create a client for the GitHub Pull Request Reviews API that supports creating reviews with inline comments.

**Contract**: `createReview(pr, commitSha, comments[], body?)` POSTs to `/pulls/{pr}/reviews`. Each comment includes `path`, `line`, `body`, and `side` (RIGHT for new code). Returns review ID.

#### 2. Comment Formatting

**File**: `src/github-review.ts`

**Intent**: Format findings as inline review comments with severity badges, code snippets, and action items.

**Contract**: Each inline comment includes:
- Severity emoji prefix (🚨/⚠️/💡)
- Finding description
- Suggestion (if any)
- Action item for the severity level

#### 3. Review Orchestration

**File**: `src/index.ts`

**Intent**: Update the review flow to use the new Review API instead of the comment API. Post findings as inline comments with a summary review body.

**Contract**: Replace `postComment()` call (line 255) with:
- Create review with inline comments for each finding
- Add summary body with severity tally and model info
- Delete existing review if present (find-and-replace pattern)

#### 4. Fallback for Large Reviews

**File**: `src/index.ts`

**Intent**: When the review exceeds GitHub's inline comment limit (unlimited per review, but performance degrades), fall back to a summary comment with findings grouped by file.

**Contract**: If finding count > 50, post summary comment instead of inline reviews. Include file:line references for navigation.

### Success Criteria:

#### Automated Verification:

- Unit tests pass: `npm test`
- TypeScript compiles: `npm run build`
- Review API tests verify correct payload format
- Mock tests verify comment creation and deletion

#### Manual Verification:

- Findings appear as inline comments on the correct lines
- Summary comment includes severity tally
- Existing review is replaced on re-run
- Large PR with 50+ findings posts summary fallback

---

## Phase 5: Custom Rules

### Overview

Allow users to define custom review rules via action inputs, which are injected into the review prompt to guide the model's focus.

### Changes Required:

#### 1. Rules Input

**File**: `action.yml`

**Intent**: Add a new input for custom review rules as a multi-line string.

**Contract**: New input `custom_rules` (default: `''`):
```yaml
custom_rules:
  description: 'Custom review rules (one per line, e.g., "Always check for SQL injection")'
  required: false
  default: ''
```

#### 2. Rules Parsing

**File**: `src/rules.ts` (new)

**Intent**: Parse the custom rules input into structured rule objects with category, severity, and description.

**Contract**: `parseRules(input)` returns `Rule[]`. Each rule has:
- `category`: string (user-defined or inferred)
- `severity`: 'critical' | 'warning' | 'suggestion'
- `description`: the rule text
- `pattern`: optional regex for matching code patterns

#### 3. Prompt Injection

**File**: `src/prompts.ts`

**Intent**: Modify `buildSystemPrompt()` to accept optional rules and inject them into the system prompt.

**Contract**: `buildSystemPrompt(language?, rules?)` appends a "Custom Rules" section to the prompt. Rules are formatted as numbered instructions with severity context.

#### 4. Rules Validation

**File**: `src/rules.ts`

**Intent**: Validate custom rules to prevent prompt injection and ensure they're well-formed.

**Contract**: `validateRules(rules)` returns `{ valid: boolean, errors: string[] }`. Checks:
- No rules longer than 500 characters
- No rules containing instruction overrides (e.g., "ignore previous instructions")
- Severity is valid if specified

### Success Criteria:

#### Automated Verification:

- Unit tests pass: `npm test`
- TypeScript compiles: `npm run build`
- Rules parsing tests verify correct extraction
- Validation tests catch prompt injection attempts

#### Manual Verification:

- Custom rule "Check for SQL injection" produces findings related to SQL injection
- Multiple rules are all included in the prompt
- Invalid/malicious rules are rejected with clear error
- Empty rules input works correctly (no rules section in prompt)

---

## Phase 6: Analytics & Metrics

### Overview

Collect PR-level metrics on findings, severity distribution, and model performance, outputting results to the GitHub Actions step summary.

### Changes Required:

#### 1. Metrics Collection

**File**: `src/metrics.ts` (new)

**Intent**: Create a metrics module that tracks review outcomes for each PR.

**Contract**: `ReviewMetrics` interface:
- `pr_number`: number
- `model_used`: string
- `findings_count`: { critical: number, warning: number, suggestion: number }
- `files_reviewed`: number
- `review_duration_ms`: number
- `validation_dropped`: number (findings filtered out)
- `batch_count`: number (if batching was used)

#### 2. Metrics Output

**File**: `src/metrics.ts`

**Intent**: Format metrics as a markdown table for GitHub Actions step summary.

**Contract**: `formatMetrics(metrics)` returns markdown string with:
- Summary table (model, duration, files, findings)
- Severity breakdown
- Validation stats (dropped findings)
- Performance stats (batch count, avg per batch)

#### 3. Step Summary Integration

**File**: `src/index.ts`

**Intent**: After posting the review, write metrics to `$GITHUB_STEP_SUMMARY` if available.

**Contract**: At the end of `run()`, if `GITHUB_STEP_SUMMARY` env var is set, append formatted metrics. Use `@actions/core.summary.addRaw()` or direct file write.

#### 4. Metrics Tests

**File**: `src/metrics.test.ts` (new)

**Intent**: Test metrics collection, formatting, and edge cases.

**Contract**: Tests cover:
- Metrics collection with various finding counts
- Markdown table formatting
- Empty metrics (no findings)
- Duration formatting

### Success Criteria:

#### Automated Verification:

- Unit tests pass: `npm test`
- TypeScript compiles: `npm run build`
- Metrics tests verify correct collection and formatting

#### Manual Verification:

- Step summary shows metrics after review completes
- Metrics accurately reflect findings count and severity distribution
- Duration is reasonable (within 10% of actual)
- No metrics output when `$GITHUB_STEP_SUMMARY` is not set

---

## Testing Strategy

### Unit Tests:

- Prompt building and language detection
- Validation pipeline (code context, LLM re-validation)
- File batching and diff chunking
- Review API payload formatting
- Rules parsing and validation
- Metrics collection and formatting

### Integration Tests:

- End-to-end review flow with mocked API responses
- Batch processing with multiple files
- Inline comment creation via mocked GitHub API

### Manual Testing Steps:

1. Review a Go PR — verify language-specific findings
2. Review a large PR (100+ files) — verify batching and performance
3. Review with custom rules — verify rules are applied
4. Check step summary — verify metrics output
5. Verify inline comments appear on correct lines

## Performance Considerations

- File batching reduces prompt size, improving model response quality and speed
- Parallel model probing finds fastest model upfront, reducing total review time
- LLM re-validation adds latency but reduces false positives (configurable)
- Diff chunking prevents token limit issues on large single-file changes

## Migration Notes

- No data migration needed — all changes are additive
- Existing `nim_models` input continues to work
- Custom rules input defaults to empty (no behavior change)
- Inline comments are a new feature (no migration from old format)

## References

- Research: Codebase analysis completed during planning
- Similar implementation: `src/bench-entry.ts` for parallel processing patterns
- GitHub Review API: https://docs.github.com/en/rest/pulls/reviews

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands.

### Phase 1: Prompt Redesign

#### Automated

- [x] 1.1 Prompt tests validate language detection and structure — ee6bc4d
- [x] 1.2 TypeScript compiles without errors — ee6bc4d

#### Manual

- [ ] 1.3 Go PR review focuses on goroutines and error handling
- [ ] 1.4 Python PR review focuses on type hints and async issues
- [ ] 1.5 Severity classification matches expectations

### Phase 2: Enhanced Validation

#### Automated

- [x] 2.1 Validation tests cover all edge cases — 16b06d6
- [x] 2.2 No false rejections on valid findings — 16b06d6

#### Manual

- [ ] 2.3 Known issues are found and pass validation
- [ ] 2.4 Hallucinated findings are rejected

### Phase 3: Performance Optimizations

#### Automated

- [x] 3.1 Batching tests verify correct splitting — 17c39dc
- [x] 3.2 Diff chunking tests verify token limits — 17c39dc

#### Manual

- [ ] 3.3 Large PR (100+ files) completes in under 5 minutes
- [ ] 3.4 Large single-file diffs are chunked correctly

### Phase 4: Inline Comments

#### Automated

- [x] 4.1 Review API tests verify payload format — 41abd40
- [x] 4.2 Mock tests verify comment lifecycle — 41abd40

#### Manual

- [ ] 4.3 Findings appear on correct lines
- [ ] 4.4 Summary comment includes severity tally

### Phase 5: Custom Rules

#### Automated

- [x] 5.1 Rules parsing tests verify extraction — 0cd3a3c
- [x] 5.2 Validation tests catch injection attempts — 0cd3a3c

#### Manual

- [ ] 5.3 Custom rules produce relevant findings
- [ ] 5.4 Empty rules input works correctly

### Phase 6: Analytics & Metrics

#### Automated

- [x] 6.1 Metrics tests verify collection and formatting — a6cb723
- [x] 6.2 Step summary output is valid markdown — a6cb723

#### Manual

- [ ] 6.3 Step summary shows accurate metrics
- [ ] 6.4 No metrics output when env var not set
