# NIM Code Review

AI-powered code review for GitHub PRs using NVIDIA NIM, Mistral, Groq, OpenRouter, Kilo, NousResearch, and custom OpenAI-compatible models with automatic fallback.

Reviews are schema-validated: model responses are parsed into a typed `Review`/`Finding` structure via Zod, validated against the actual PR diff (file existence, hunk line ranges), and rendered deterministically from the validated object. Parse failures and hallucinated findings are caught before reaching the PR comment.

## Usage

Add this to your repo's `.github/workflows/nim-code-review.yml`:

```yaml
name: NIM Code Review
on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pfrack/review-action@v1
        with:
          nim_api_key: ${{ secrets.NIM_API_KEY }}
```

## Inputs

| Input | Default | Description |
|-------|---------|-------------|
| `nim_api_key` | `''` | NVIDIA NIM API key |
| `nim_base_url` | `https://integrate.api.nvidia.com/v1` | NIM endpoint |
| `nim_models` | see below | Comma-separated NIM fallback chain |
| `mistral_api_key` | `''` | Mistral API key |
| `mistral_base_url` | `https://api.mistral.ai/v1` | Mistral endpoint |
| `mistral_models` | see below | Comma-separated Mistral fallback chain |
| `groq_api_key` | `''` | Groq API key |
| `groq_base_url` | `https://api.groq.com/openai/v1` | Groq endpoint |
| `groq_models` | `openai/gpt-oss-120b,llama-3.3-70b-versatile` | Comma-separated Groq fallback chain |
| `openrouter_api_key` | `''` | OpenRouter API key |
| `openrouter_base_url` | `https://openrouter.ai/api/v1` | OpenRouter endpoint |
| `openrouter_models` | `''` (auto-fetches free models) | Comma-separated OpenRouter fallback chain. When empty, fetches all free-tier models from OpenRouter. |
| `openrouter_free_only` | `false` | Filter OpenRouter models to only use free-tier models |
| `kilocode_api_key` | `''` | Kilo Gateway API key |
| `kilocode_base_url` | `https://api.kilo.ai/api/gateway` | Kilo Gateway endpoint |
| `kilocode_models` | see below | Comma-separated Kilo fallback chain. When empty, fetches all free-tier models from Kilo. |
| `kilocode_free_only` | `false` | Filter Kilo models to only use free-tier models |
| `nousresearch_api_key` | `''` | NousResearch inference API key |
| `nousresearch_base_url` | `https://inference-api.nousresearch.com/v1` | NousResearch inference endpoint |
| `nousresearch_models` | see below | Comma-separated NousResearch model fallback chain (defaults to all free-tier models from provider when empty) |
| `nousresearch_free_only` | `false` | Filter NousResearch models to only use free-tier models |
| `custom_api_url` | `''` | Custom OpenAI-compatible endpoint (tried before provider models) |
| `custom_model` | `''` | Model name for the custom endpoint |
| `custom_api_key` | `''` | API key for the custom endpoint (empty for local/keyless) |
| `custom_models` | `''` | Comma-separated custom model IDs (multiple models enable fallback) |
| `custom_models_base_url` | `custom_api_url` | Base URL for custom_models (defaults to custom_api_url) |
| `max_files` | `100` | Max files to review per PR (1–500) |
| `exclude_patterns` | `*.lock,*.md,*.txt,*.svg,*.png,*.sum,*.json,*.yaml,*.yml,*.toml,*.mod,*.sum,.mimocode/*,go.sum,go.mod,dist/*` | Glob patterns to skip |
| `nim_system_prompt` | `''` | Custom system prompt to override or append |
| `nim_prompt_mode` | `append` | How to use custom prompt: `append` or `replace` |
| `custom_rules` | `''` | Custom review rules (one per line, supports severity prefixes) |
| `revalidate_findings` | `false` | Re-validate findings with LLM before posting (reduces false positives, adds latency) |
| `drop_unreferenced` | `true` | Drop findings whose backtick-wrapped identifier or explicit `function X` / `variable X` reference is not present in the diff. Set `false` to keep them as soft `Note:` warnings (legacy behavior). |
| `model_timeout` | `90` | Timeout in seconds for each individual model call (0 = no per-model limit) |
| `chain_timeout` | `0` | Overall timeout in seconds for the full model chain (0 = unlimited, keeps trying all models) |
| `parallel_attempts` | `3` | Number of models to try in parallel via staggered starts. Default 3 (light parallel). Set to 1 for fully sequential. Range 2-5. The head model starts immediately; each subsequent model starts after `parallel_threshold` seconds if no winner has emerged. |
| `parallel_threshold` | `40` | Seconds to wait before starting the next parallel model (when `parallel_attempts` > 1). Range 5-120. |
| `comment_mode` | `summary` | Output mode: `summary` (one PR comment, default) or `inline` (line-anchored review comments via the GitHub Reviews API). Inline mode requires `pull-requests: write` and auto-resolves `isOutdated` review threads on re-review. |

At least one of `nim_api_key`, `mistral_api_key`, `groq_api_key`, `openrouter_api_key`, `kilocode_api_key`, `nousresearch_api_key`, or `custom_api_url` + `custom_model`/`custom_models` is required. When multiple providers are configured, models are merged into a single fallback chain sorted by SWE-bench Verified score. Free-tier models (`:free` suffix) rank last in the chain.

## How It Works

1. **Diff fetch** — Downloads the PR diff from GitHub. Skips reviews for diffs >5 MB.
2. **Model probing** — Probes models in the chain (batches of 3, 10s timeout). The probe is diagnostic only: it never reorders the chain. The chain order always stays sorted by SWE-bench Verified score, so a faster model cannot leapfrog a higher-scoring head.
3. **Batching** — If the PR has >50 files, splits them into batches of 50 and reviews each batch independently.
4. **Model chain** — Tries each model in the combined fallback chain (custom → providers sorted by SWE-bench score, free-tier forced last). Each individual model call has a 90s timeout (`model_timeout`); if a model doesn't respond in time, it's skipped immediately. By default, the chain runs until a model succeeds or all models are exhausted (no aggregate limit). Set `chain_timeout` to impose a hard cap.
5. **Structured output** — Each model is prompted to respond in JSON matching a Zod-validated `Review` schema with typed `Finding` objects (file, severity, line range, issue, suggestion, plus per-severity action fields).
6. **Parse + retry** — Responses are validated via `safeParse()`. On failure, the action retries once with the validation error appended. Parse failures cause a model skip (next model in chain).
7. **Diff validation** — Each finding is checked: `file` must exist in the PR's changed files, `line_start..line_end` must overlap a changed hunk (with adaptive tolerance). Hallucinated findings are dropped with a warning.
8. **Code context validation** — Backtick-wrapped identifiers and explicit references in findings are checked against the diff text.
9. **LLM revalidation** (optional) — When `revalidate_findings: true`, findings are re-validated by asking the model which are real vs hallucinated.
10. **Render** — The validated `Review` object is rendered into a deterministic markdown PR comment with severity-bucketed sections. Previous AI review comments/reviews are cleaned up before posting.

### Parallel Model Fallback

By default, the action runs **light parallel** (`parallel_attempts: 3`):
after a configurable delay, fallback models start in parallel with the head
model. The first model to return validated findings wins; in-flight siblings
are aborted. This cuts wall-clock latency when the head model is slow or
fails, without paying for parallel calls in the happy path.

**How staggering works** (with defaults `parallel_attempts: 3`,
`parallel_threshold: 40s`):

| Sibling | Starts at | Fires only if |
|---------|-----------|--------------|
| Head (model 0) | t=0s | always |
| Sibling 1 | t=40s | head hasn't returned valid findings yet |
| Sibling 2 | t=80s | head AND sibling 1 haven't returned yet |

If the head model succeeds in under 40s, **no siblings start** — you get
latency insurance for zero additional cost.

**Cost insulation**: parallel mode multiplies calls only in the
slow/failure case, not the happy path. Siblings are provider fallback
models (free-tier by default); the `AbortController` cancels in-flight
siblings the moment a winner emerges; and each call's output is bounded by
the adaptive token cap (4,096–16,384 tokens). Set `parallel_attempts: 1`
for fully sequential execution.

```yaml
- uses: pfrack/review-action@v1
  with:
    nim_api_key: ${{ secrets.NIM_API_KEY }}
    parallel_attempts: 1   # opt out of parallel, run fully sequential
```

### Output Modes

- **Summary mode** (default) — Posts a single PR comment with findings grouped by severity, including a severity tally header.
- **LGTM** — When no findings survive validation, posts a clean "LGTM" comment.
- **Inline mode** (`comment_mode: inline`) — Posts one line-anchored review comment per finding via the GitHub Reviews API, so each issue is attached to the exact file:line it was raised on. Inline mode requires the `pull-requests: write` permission (the example workflow above already grants it). If that permission is missing, or the re-review cleanup call fails, the action automatically falls back to summary mode for that run — you always get output, never a silent skip.

#### Re-review hygiene (inline mode)

On each run in inline mode, the action lists the PR's existing review threads via the GitHub GraphQL API and resolves any that GitHub has marked `isOutdated` (e.g. the anchored line was edited or deleted in a later commit). Threads that are still valid are left for humans to resolve through the GitHub UI. This prevents the "outdated comment" clutter that used to accumulate on re-review.

#### Previous-review context

Regardless of mode, the unresolved findings from the previous review of the PR are included in the model's system prompt as a clearly delimited, explicitly untrusted data block. The model uses them only to judge whether an issue was already fixed — they are capped at 20 threads and 4000 characters and never acted on as instructions.

#### Inline mode example

```yaml
      - uses: pfrack/review-action@v1
        with:
          nim_api_key: ${{ secrets.NIM_API_KEY }}
          comment_mode: inline   # post line-anchored review comments
```

### Severity Rendering

Findings are grouped into priority-ordered severity sections:

- **Critical** (🚨) — bugs, security holes, data-loss risks, correctness failures that block release
- **Warning** (⚠️) — investigative concerns, likely bugs, maintainability issues
- **Suggestion** (💡) — stylistic, readability, or nit-level improvements

The comment header includes a severity tally (e.g. `🚨 1 critical · ⚠️ 2 warnings · 💡 3 suggestions`). Each finding renders with an emoji-prefixed severity badge and a concrete action line.

## Custom Rules

Add project-specific review rules that get injected into the system prompt:

```yaml
- uses: pfrack/review-action@v1
  with:
    nim_api_key: ${{ secrets.NIM_API_KEY }}
    custom_rules: |
      [critical] Security: Always check for SQL injection in database queries
      [warning] Performance: Flag N+1 queries in ORM code
      [suggestion] Style: Prefer early returns over nested conditionals
```

Rules support severity prefixes (`[critical]`, `[warning]`, `[suggestion]`) and category prefixes (`Security:`, `Performance:`). Rules are validated for length (max 500 chars) and scanned for prompt injection patterns.

## LLM Revalidation

Reduces false positives by asking the model to classify each finding as real or hallucinated:

```yaml
- uses: pfrack/review-action@v1
  with:
    nim_api_key: ${{ secrets.NIM_API_KEY }}
    revalidate_findings: 'true'
```

This adds one extra LLM call after initial review but filters out findings the model itself identifies as unsupported by the actual code.

## Mistral Support

Use Mistral models directly via the Mistral API:

```yaml
- uses: pfrack/review-action@v1
  with:
    mistral_api_key: ${{ secrets.MISTRAL_API_KEY }}
```

When both NIM and Mistral keys are provided, all models are merged into a single fallback chain sorted by SWE-bench score.

### Default Mistral Models

1. `mistral-medium-3.5` — SWE-bench: 0.776
2. `mistral-large-2512` — SWE-bench: 0.720
3. `mistral-small-2603` — SWE-bench: 0.680
4. `codestral-2508` — SWE-bench: 0.650

## Groq Support

Use Groq models via the Groq API:

```yaml
- uses: pfrack/review-action@v1
  with:
    groq_api_key: ${{ secrets.GROQ_API_KEY }}
```

### Default Groq Models

1. `openai/gpt-oss-120b` — SWE-bench: 0.720
2. `llama-3.3-70b-versatile` — SWE-bench: 0.620

## OpenRouter Support

Use OpenRouter models (free-tier models auto-fetched by default):

```yaml
- uses: pfrack/review-action@v1
  with:
    openrouter_api_key: ${{ secrets.OPENROUTER_API_KEY }}
```

When `openrouter_models` is left empty, the action fetches all free-tier models from OpenRouter automatically. When set alongside other provider keys, OpenRouter models are merged into the same fallback chain sorted by SWE-bench score. Free-tier models rank last.

### Free-Only Filter

```yaml
- uses: pfrack/review-action@v1
  with:
    openrouter_api_key: ${{ secrets.OPENROUTER_API_KEY }}
    openrouter_models: 'deepseek/deepseek-r1:free,meta-llama/llama-4-maverick,google/gemini-2.0-flash-exp:free'
    openrouter_free_only: 'true'
```

When enabled, any model without `free` in its name is dropped from the chain.

## Kilo Gateway Support

Use Kilo Gateway models — **note the privacy caveat below**:

```yaml
- uses: pfrack/review-action@v1
  with:
    kilocode_api_key: ${{ secrets.KILO_API_KEY }}
```

### Default Kilo Models

```
nvidia/nemotron-3.5-content-safety:free, inclusionai/ling-3.0-flash:free,
openrouter/free, nvidia/nemotron-3-super-120b-a12b:free, kilo-auto/free,
stepfun/step-3.7-flash:free, nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free,
poolside/laguna-s-2.1:free, poolside/laguna-xs-2.1:free,
nvidia/nemotron-3-ultra-550b-a55b:free, poolside/laguna-m.1:free,
cohere/north-mini-code:free
```

### Privacy Warning

Kilo Gateway free-tier models may route to providers that log prompts for training purposes. Since this action ingests PR diffs — which may contain sensitive logic, credentials, or architectural details — consider the privacy implications before enabling Kilo as a provider. Only use Kilo free-tier on PRs from open-source/public repositories unless you explicitly trust the downstream providers.

## NousResearch Support

Use NousResearch inference API — free-tier models are auto-configured by default:

```yaml
- uses: pfrack/review-action@v1
  with:
    nousresearch_api_key: ${{ secrets.NOUSRESEARCH_API_KEY }}
```

### Default NousResearch Free Models

```
poolside/laguna-s-2.1:free, poolside/laguna-xs-2.1:free, tencent/hy3:free,
stepfun/step-3.7-flash:free, upstage/solar-pro4:free, meituan/longcat-2.0:free
```

### Free-Only Filter

```yaml
- uses: pfrack/review-action@v1
  with:
    nousresearch_api_key: ${{ secrets.NOUSRESEARCH_API_KEY }}
    nousresearch_models: 'nousresearch/hermes-4-70b,upstage/solar-pro4:free'
    nousresearch_free_only: 'true'
```

When enabled, any model without `free` in its name is dropped from the chain. Note that the default model list already contains only free-tier models — the `--free` mode is useful when you explicitly list paid models alongside free ones and want to filter to free only.

### Privacy Note

The NousResearch gateway aggregates models from multiple providers. If you use specific model IDs (rather than relying on the free-tier defaults), verify the model's origin and privacy terms before sending PR diffs that may contain sensitive code.

## Multiple Custom Models

Use the `custom_models` input to specify multiple custom-slot models (all tried before provider models):

```yaml
- uses: pfrack/review-action@v1
  with:
    custom_api_url: 'http://localhost:11434/v1'
    custom_models: 'llama3.1:70b,mistral:7b'
    custom_api_key: ''
```

Each entry creates a separate model in the fallback chain — all prefixed before NIM/Mistral/Groq/OpenRouter/Kilo models. `custom_models_base_url` defaults to `custom_api_url` if not set separately.

## Custom API Endpoint

Point the action at any OpenAI-compatible endpoint (local LLM, proxy, etc.):

```yaml
- uses: pfrack/review-action@v1
  with:
    custom_api_url: 'http://localhost:11434/v1'
    custom_model: 'llama3'
    custom_api_key: ''
```

The custom model is tried before provider models in the fallback chain. Custom endpoints must use HTTPS (HTTP allowed for localhost only).

## Default NIM Fallback Chain

The default NIM fallback chain is auto-ranked daily by the benchmark workflow. The current order in `action.yml` is always the source of truth. Models are sorted by SWE-bench Verified score with a latency penalty — slower models are ranked lower even if their SWE-bench score is higher, but they are not dropped entirely (only models that fail the probe or are absent from the provider catalog are excluded).

```bash
# Read the current default chain:
yq '.inputs.nim_models.default' action.yml
```

## SWE-bench Scoring

The fallback chain is ordered by [SWE-bench Verified](https://www.swebench.com/) scores — a benchmark measuring real-world software engineering ability. The action maintains a hardcoded score table updated daily by the benchmark workflow, plus supports fetching live scores from the leaderboard API.

The `resolve-swe` script (`npm run resolve-swe`) automatically resolves models at the default 0.5 score against the live SWE-bench leaderboard using deterministic matching (exact, normalized, substring strategies).

## Model Probing

Before sending the review request, the action probes models in the chain in batches of 3 with a 10-second timeout. The probe result is logged for observability but does **not** change the chain order — the SWE-bench-sorted chain head is always tried first. The `PROBE_PROMOTE_MAX_HEAD_GAP` (0.02) cap gates only the probe logging output, not reordering. This preserves the SWE-bench ordering while giving visibility into model responsiveness.

## Per-Language Prompts

The action automatically detects the dominant language of changed files and uses a specialized review prompt:

- **Go** — goroutine leaks, race conditions, error handling, resource management
- **Python** — mutable defaults, bare excepts, resource management, type hints
- **TypeScript/JavaScript** — async/await, type safety, memory leaks, promise handling
- **Java** — resource management, thread safety, null safety, stream API
- **Rust** — unsafe code, lifetime issues, unwrap calls, error handling
- **C/C++** — memory safety, undefined behavior, smart pointers, RAII

Each language prompt includes focus areas, anti-patterns to avoid flagging, and severity calibration examples. Unknown file extensions fall back to the generic review prompt.

## Custom Prompts

Override the default system prompt:

```yaml
- uses: pfrack/review-action@v1
  with:
    nim_api_key: ${{ secrets.NIM_API_KEY }}
    nim_system_prompt: "Focus on security vulnerabilities and OWASP Top 10"
    nim_prompt_mode: append
```

- **`append`** (default): The default system prompt (including severity guidance and JSON schema) is sent first, followed by your custom prompt.
- **`replace`**: Your prompt replaces the default. The JSON schema and severity guidance are still appended as framework guidance to ensure parseable output.

## Setup

1. Get an API key from [build.nvidia.com](https://build.nvidia.com), [console.mistral.ai](https://console.mistral.ai), [console.groq.com](https://console.groq.com), [openrouter.ai](https://openrouter.ai), or [kilo.ai](https://kilo.ai)
2. Add the key as a repository secret (`NIM_API_KEY`, `MISTRAL_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, or `KILO_API_KEY`)
3. Add the workflow file above

## Local Development

```bash
npm install
npm run build
npm test
```

Tests use Node.js built-in test runner (`node --test`). The build step compiles TypeScript and bundles with `@vercel/ncc`.

## Benchmarking

A daily benchmark workflow runs all configured models and reorders `action.yml` based on SWE-bench score + latency:

```bash
npm run build
export BENCH_API_KEY=your-key
export BENCH_ITERATIONS=5              # default: 2
export BENCH_PROMPT="..."              # optional custom prompt
export BENCH_CONCURRENCY=3             # optional: parallel models (default: 1 = sequential)
node dist/src/bench-entry.js
```

For auto-discovering free models from a provider:

```bash
export BENCH_API_KEY=your-key
export BENCH_BASE_URL='https://openrouter.ai/api/v1'
export BENCH_AUTO_FREE=true
node dist/src/bench-entry.js
```

Or specify models explicitly:

```bash
export BENCH_API_KEY=your-key
export BENCH_MODELS='model-a,model-b,model-c'
node dist/src/bench-entry.js
```

Output is a markdown table with TTFT, latency, and tokens/sec per model. When run in GitHub Actions, results are written to `$GITHUB_STEP_SUMMARY`.

### Reorder Script

After benchmarking, pipe results into the reorder script to update `action.yml`:

```bash
node dist/src/bench-reorder.js < benchmark-output.txt
```

Supports `--two-tier` mode (known models ranked by SWE score first, new models ranked by latency second) and targets any provider via `ACTION_TARGET=nim_models|mistral_models|groq_models|openrouter_models|kilocode_models`.

### Model History Tracking

The benchmark tracks model availability over time via `*-model-history.json` files. New models are detected automatically, and removed models are logged to `removed-*.txt` files.
