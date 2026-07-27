# NIM Code Review

AI-powered code review for GitHub PRs using NVIDIA NIM, Mistral, OpenRouter, Kilo, and custom OpenAI-compatible models with automatic fallback.

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
| `groq_models` | see below | Comma-separated Groq fallback chain |
| `openrouter_api_key` | `''` | OpenRouter API key |
| `openrouter_base_url` | `https://openrouter.ai/api/v1` | OpenRouter endpoint |
| `openrouter_models` | `''` (auto-fetches free models) | Comma-separated OpenRouter fallback chain. When empty, fetches all free-tier models from OpenRouter. |
| `openrouter_free_only` | `false` | Filter OpenRouter models to only use free-tier models |
| `kilocode_api_key` | `''` | Kilo Gateway API key |
| `kilocode_base_url` | `https://api.kilo.ai/api/gateway` | Kilo Gateway endpoint |
| `kilocode_models` | `''` (auto-fetches free models) | Comma-separated Kilo fallback chain. When empty, fetches all free-tier models from Kilo. |
| `kilocode_free_only` | `false` | Filter Kilo models to only use free-tier models |
| `custom_api_url` | `''` | Custom OpenAI-compatible endpoint (tried before NIM models) |
| `custom_model` | `''` | Model name for the custom endpoint |
| `custom_api_key` | `''` | API key for the custom endpoint (empty for local/keyless) |
| `custom_models` | `''` | Comma-separated custom model IDs (multiple models enable fallback) |
| `custom_models_base_url` | `custom_api_url` | Base URL for custom_models (defaults to custom_api_url) |
| `max_files` | `100` | Max files to review per PR |
| `exclude_patterns` | `*.lock,*.md,...` | Glob patterns to skip |
| `nim_system_prompt` | `''` | Custom system prompt to override or append |
| `nim_prompt_mode` | `append` | How to use custom prompt: `append` or `replace` |

At least one of `nim_api_key`, `mistral_api_key`, `groq_api_key`, `openrouter_api_key`, `kilocode_api_key`, or `custom_api_url` + `custom_model`/`custom_models` is required. When multiple providers are configured, models are merged into a single fallback chain sorted by SWE-bench score. Free-tier models (:free suffix) rank last in the chain.

## How It Works

1. **Diff fetch** — Downloads the PR diff from GitHub. Skips reviews for diffs >5 MB.
2. **Model chain** — Tries each model in the fallback chain (custom → NIM → Mistral → Groq → OpenRouter → Kilo, sorted by SWE-bench score, with free-tier models forced to rank last).
3. **Structured output** — Each model is prompted to respond in JSON matching a Zod-validated `Review` schema with typed `Finding` objects (file, severity, line range, issue, suggestion, plus per-severity action fields: `critical_action`, `warning_action`, `suggestion_action`).
4. **Parse + retry** — Responses are validated via `safeParse()`. On failure, the action retries once with the validation error appended. Parse failures cause a model skip (next model in chain).
5. **Diff validation** — Each finding is checked: `file` must exist in the PR's changed files, `line_start..line_end` must overlap a changed hunk. Hallucinated findings are dropped with a warning.
6. **Render** — The validated `Review` object is rendered into a deterministic markdown PR comment with severity-bucketed sections.

### Severity Rendering

Findings are grouped into priority-ordered severity sections:

- **Critical** (🚨) — bugs, security holes, data-loss risks, correctness failures that block release
- **Warning** (⚠️) — investigative concerns, likely bugs, maintainability issues
- **Suggestion** (💡) — stylistic, readability, or nit-level improvements

The comment header includes a severity tally (e.g. `🚨 1 critical · ⚠️ 2 warnings · 💡 3 suggestions`). Each finding renders with an emoji-prefixed severity badge, and a concrete next-step action line for the matching severity tier.

## Mistral Support

Use Mistral models directly via the Mistral API (no NIM proxy needed):

```yaml
- uses: pfrack/review-action@v1
  with:
    mistral_api_key: ${{ secrets.MISTRAL_API_KEY }}
```

### Mistral-only Mode

When only `mistral_api_key` is set, the action uses Mistral models exclusively:

```yaml
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pfrack/review-action@v1
        with:
          mistral_api_key: ${{ secrets.MISTRAL_API_KEY }}
          mistral_models: 'mistral-medium-3.5,codestral-2508'
```

### Combined Mode (NIM + Mistral)

When both keys are provided, all models are merged into a single fallback chain sorted by SWE-bench Verified score:

```yaml
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pfrack/review-action@v1
        with:
          nim_api_key: ${{ secrets.NIM_API_KEY }}
          mistral_api_key: ${{ secrets.MISTRAL_API_KEY }}
```

In combined mode, the action tries the highest-scoring model first (regardless of provider) and falls through on failure. For example, with default model lists the combined chain might be: `deepseek-v4-pro(nim)` → `minimax-m3(nim)` → `mistral-medium-3.5(mistral)` → `glm-5.2(nim)` → ...

### Default Mistral Models

1. `mistral-medium-3.5` — SWE-bench: 0.776 (best for code review)
2. `mistral-large-2512` — SWE-bench: 0.720
3. `mistral-small-2603` — SWE-bench: 0.680
4. `codestral-2508` — SWE-bench: 0.650 (code specialist)

## OpenRouter Support

Use OpenRouter models directly (free-tier models used by default):

```yaml
- uses: pfrack/review-action@v1
  with:
    openrouter_api_key: ${{ secrets.OPENROUTER_API_KEY }}
```

### OpenRouter-only Mode

When only `openrouter_api_key` is set, the action uses OpenRouter free-tier models exclusively:

```yaml
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pfrack/review-action@v1
        with:
          openrouter_api_key: ${{ secrets.OPENROUTER_API_KEY }}
```

### Combined Mode (OpenRouter + NIM/Mistral/Groq)

When set alongside other provider keys, OpenRouter models are merged into the same fallback chain sorted by SWE-bench score. Free-tier models (IDs ending with `:free`) rank last in the chain after non-free models.

### Auto-Fetched Free-Tier Models

When `openrouter_models` is left empty, the action fetches all free-tier models from OpenRouter automatically. This ensures the fallback chain always uses currently available models without manual updates.

### Free-Only Filter

When you specify custom model lists for OpenRouter or Kilo, you can enforce free-only usage with the `openrouter_free_only` and `kilocode_free_only` inputs. When enabled, any model without `free` in its name is dropped from the chain:

```yaml
- uses: pfrack/review-action@v1
  with:
    openrouter_api_key: ${{ secrets.OPENROUTER_API_KEY }}
    openrouter_models: 'deepseek/deepseek-r1:free,meta-llama/llama-4-maverick,google/gemini-2.0-flash-exp:free'
    openrouter_free_only: 'true'
```

This would filter out `meta-llama/llama-4-maverick` (no `free` in name) from OpenRouter, keeping only free-tier models.

## Kilo Gateway Support

Use Kilo Gateway models -- **note the privacy caveat described below**:

```yaml
- uses: pfrack/review-action@v1
  with:
    kilocode_api_key: ${{ secrets.KILO_API_KEY }}
```

### Kilo-only Mode

When only `kilocode_api_key` is set, the action uses Kilo free-tier models exclusively.

### Auto-Fetched Free-Tier Models

When `kilocode_models` is left empty, the action fetches all free-tier models from Kilo automatically.

### Privacy Warning

Kilo Gateway free-tier models may route to providers that log prompts for training purposes. Since this action ingests PR diffs -- which may contain sensitive logic, credentials, or architectural details -- consider the privacy implications before enabling Kilo as a provider. The paid tiers do not have this concern. Only use Kilo free-tier on PRs from open-source/public repositories unless you explicitly trust the downstream providers.

### Combined Mode (Kilo + NIM/Mistral/Groq/OpenRouter)

Kilo models are merged into the same quality-first fallback chain. Free-tier models rank last after non-free provider models.

## Multiple Custom Models

Use the `custom_models` input to specify multiple custom-slot models (all tried before provider models):

```yaml
- uses: pfrack/review-action@v1
  with:
    custom_api_url: 'http://localhost:11434/v1'
    custom_models: 'llama3.1:70b,mistral:7b'
    custom_api_key: ''  # empty for local/keyless endpoints
```

`custom_models` is a CSV string. Each entry creates a separate model in the fallback chain -- all prefixed before NIM/Mistral/Groq/OpenRouter/Kilo models. `custom_models_base_url` defaults to `custom_api_url` if not set separately.

## Custom API Endpoint

Point the action at any OpenAI-compatible endpoint (local LLM, proxy, etc.):

```yaml
- uses: pfrack/review-action@v1
  with:
    custom_api_url: 'http://localhost:11434/v1'
    custom_model: 'llama3'
    custom_api_key: ''  # empty for local/keyless endpoints
```

The custom model is tried before NIM and Mistral models in the fallback chain. If the endpoint supports `response_format: { type: 'json_schema' }`, structured output is used automatically.

## Default NIM Fallback Chain

1. `deepseek-ai/deepseek-v4-flash` (DeepSeek)
2. `z-ai/glm-5.2` (Zhipu AI)
3. `stepfun-ai/step-3.7-flash` (StepFun)
4. `mistralai/mistral-nemotron` (Mistral via NIM)
5. `minimaxai/minimax-m3` (MiniMax)
6. `deepseek-ai/deepseek-v4-pro` (DeepSeek)
7. `mistralai/mistral-medium-3.5-128b` (Mistral via NIM)

Models are tried in order. On error (rate limit, 500, timeout, network failure), the next model is tried. Transient failures are retried once with exponential backoff before falling through.

## Setup

1. Get an API key from [build.nvidia.com](https://build.nvidia.com) and/or [console.mistral.ai](https://console.mistral.ai)
2. Add `NIM_API_KEY` and/or `MISTRAL_API_KEY` as repository secrets
3. Add the workflow file above

## Local Development

```bash
npm install
npm run build
npm test
```

## Per-Language Prompts

The action automatically detects the language of each file and uses a specialized review prompt:

- **Go** — goroutine leaks, race conditions, error handling, resource management
- **Python** — mutable defaults, bare excepts, resource management, type hints
- **TypeScript/JavaScript** — async/await, type safety, memory leaks, promise handling
- **Java** — resource management, thread safety, null safety, stream API
- **Rust** — unsafe code, lifetime issues, unwrap calls, error handling
- **C/C++** — memory safety, undefined behavior, smart pointers, RAII

Unknown file extensions fall back to the base review prompt.

## Custom Prompts

Override the default system prompt via environment variables:

```yaml
- uses: pfrack/review-action@v1
  with:
    nim_api_key: ${{ secrets.NIM_API_KEY }}
    nim_system_prompt: "Focus on security vulnerabilities and OWASP Top 10"
    nim_prompt_mode: append  # or replace
```

- **`append`** (default): The default system prompt (including severity guidance) is sent first, followed by your custom prompt appended after it.
- **`replace`**: Your prompt completely replaces the default. Note: the action will still attempt to parse the response as JSON; if parsing fails, raw output is shown with a warning.

## Benchmarking

Use the benchmark tool to compare model speeds:

```bash
npm run build
export NIM_API_KEY=your-key
export NIM_BENCH_ITERATIONS=5        # default: 5
export NIM_BENCH_PROMPT="..."        # optional custom prompt
node dist/bench-entry.js
```

For OpenRouter models:

```bash
export NIM_API_KEY=your-openrouter-key
export NIM_BASE_URL='https://openrouter.ai/api/v1'
export NIM_MODELS='deepseek/deepseek-r1:free,google/gemini-2.0-flash-exp:free'
node dist/bench-entry.js
```

For Kilo models:

```bash
export NIM_API_KEY=your-kilo-key
export NIM_BASE_URL='https://api.kilo.ai/api/gateway'
export NIM_MODELS='kilo-auto/balanced:free,kilo-auto/frontier:free'
node dist/bench-entry.js
```

Output is a markdown table with TTFT, latency, and tokens/sec per model. When run in GitHub Actions, results are written to `$GITHUB_STEP_SUMMARY`.
