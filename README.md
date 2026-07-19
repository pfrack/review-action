# NIM Code Review

AI-powered code review for GitHub PRs using NVIDIA NIM and Mistral models with automatic fallback.

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
| `mistral_models` | see below | Comma-separated Mistral fallback chain |
| `max_files` | `100` | Max files to review per PR |
| `exclude_patterns` | `*.lock,*.md,*.txt,*.svg,*.png,*.sum` | Glob patterns to skip |
| `nim_system_prompt` | (empty) | Custom system prompt to override or append |
| `nim_prompt_mode` | `append` | How to use custom prompt: `append` or `replace` |

At least one of `nim_api_key` or `mistral_api_key` is required. When both are provided, models from both providers are merged into a single fallback chain sorted by SWE-bench score.

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

## Default NIM Fallback Chain

1. `deepseek-ai/deepseek-v4-pro` (DeepSeek)
2. `minimaxai/minimax-m3` (MiniMax)
3. `deepseek-ai/deepseek-v4-flash` (DeepSeek)
4. `z-ai/glm-5.2` (Zhipu AI)
5. `qwen/qwen3.5-397b-a17b` (Alibaba)
6. `stepfun-ai/step-3.7-flash` (StepFun)
7. `mistralai/mistral-nemotron` (Mistral via NIM)

Models are tried in order. On error (rate limit, 500, timeout), the next model is tried.

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
- **`replace`**: Your prompt completely replaces the default

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
export NIM_API_KEY=your-mistral-key
export NIM_BASE_URL=https://api.mistral.ai/v1
export NIM_MODELS=mistral-medium-3.5,codestral-2508
node dist/bench-entry.js
```

Output is a markdown table with TTFT, latency, and tokens/sec per model. When run in GitHub Actions, results are written to `$GITHUB_STEP_SUMMARY`.
