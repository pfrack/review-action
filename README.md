# NIM Code Review

AI-powered code review for GitHub PRs using NVIDIA NIM, Mistral, and custom OpenAI-compatible models with automatic fallback.

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
| `custom_api_url` | `''` | Custom OpenAI-compatible endpoint (tried first) |
| `custom_model` | `''` | Model name for custom endpoint |
| `custom_api_key` | `''` | API key for custom endpoint (empty for local/keyless) |
| `max_files` | `100` | Max files to review per PR |
| `exclude_patterns` | `*.lock,*.md,...` | Glob patterns to skip |
| `nim_system_prompt` | `''` | Custom system prompt to override or append |
| `nim_prompt_mode` | `append` | How to use custom prompt: `append` or `replace` |

At least one of `nim_api_key`, `mistral_api_key`, or `custom_api_url` is required. When multiple providers are configured, models are merged into a single fallback chain sorted by SWE-bench score.

## How It Works

1. **Diff fetch** — Downloads the PR diff from GitHub. Skips reviews for diffs >5 MB.
2. **Model chain** — Tries each model in the fallback chain (custom → NIM → Mistral, sorted by SWE-bench score).
3. **Structured output** — Each model is prompted to respond in JSON matching a Zod-validated `Review` schema with typed `Finding` objects (file, severity, line range, issue, suggestion).
4. **Parse + retry** — Responses are validated via `safeParse()`. On failure, the action retries once with the validation error appended. Parse failures cause a model skip (next model in chain).
5. **Diff validation** — Each finding is checked: `file` must exist in the PR's changed files, `line_start..line_end` must overlap a changed hunk. Hallucinated findings are dropped with a warning.
6. **Render** — The validated `Review` object is rendered into a deterministic markdown PR comment.

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

1. `z-ai/glm-5.2` (Zhipu AI)
2. `minimaxai/minimax-m2.7` (MiniMax)
3. `qwen/qwen3.5-397b-a17b` (Alibaba)
4. `minimaxai/minimax-m3` (MiniMax)
5. `stepfun-ai/step-3.7-flash` (StepFun)
6. `mistralai/mistral-nemotron` (Mistral via NIM)
7. `deepseek-ai/deepseek-v4-pro` (DeepSeek)

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

- **`append`** (default): Your prompt is prepended to the language-specific template
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

For Mistral models:

```bash
export MISTRAL_API_KEY=your-mistral-key
export NIM_MODELS=mistral-medium-3.5,codestral-2508
node dist/bench-entry.js
```

Output is a markdown table with TTFT, latency, and tokens/sec per model. When run in GitHub Actions, results are written to `$GITHUB_STEP_SUMMARY`.
