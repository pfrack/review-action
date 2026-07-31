# Review Lifecycle Research

Complete trace of the review-action codebase from entry point through output dispatch.

## 1. Entry Point — `run()` in `src/index.ts:365`

**File:** `src/index.ts:365-416`

The `run()` function orchestrates the entire review lifecycle in these phases:

1. **Config loading & validation** (`src/index.ts:366-368`)
   - `loadConfig()` reads all GitHub Action inputs (`src/config.ts:28-64`)
   - `validateConfig()` checks API keys, URL schemes, and security constraints (`src/index.ts:163-192`)

2. **Client & chain construction** (`src/index.ts:369-370`)
   - `buildClients()` creates `OpenAIClient` instances per provider (`src/index.ts:194-202`)
   - `buildCombinedChain()` assembles the model fallback chain, sorted by SWE-bench score (`src/model-chain.ts:33-66`)

3. **Event loading** (`src/index.ts:371-378`)
   - `loadEvent()` reads `GITHUB_EVENT_PATH` for PR number and commit SHA (`src/event.ts:10-29`)

4. **Rules parsing** (`src/index.ts:380-383`)
   - `parseRules()` parses custom review rules from `custom_rules` input (`src/rules.ts:7-30`)
   - `validateRules()` checks for prompt injection and length (`src/rules.ts:51-67`)

5. **Diff fetching** (`src/index.ts:386-395`)
   - `fetchDiff()` fetches the PR diff from GitHub API (`src/review.ts:135-159`)
   - Throws `DiffTooLargeError` if diff exceeds 5MB (`src/review.ts:126-133`)

6. **File filtering** (`src/index.ts:396-402`)
   - `shouldExclude()` filters files by glob patterns (`src/review.ts:118-124`)
   - `maxFiles` limit truncates the file list, setting `truncated` flag (`src/index.ts:401-402`)

7. **Language detection** (`src/index.ts:404-405`)
   - `detectLanguage()` picks the dominant language from file extensions (`src/index.ts:204-213`)

8. **Model prioritization** (`src/index.ts:406`)
   - `prioritizeChain()` probes all models for latency, moves fastest to front (`src/index.ts:215-229`)

9. **Batching** (`src/index.ts:409-411`)
   - `batchFiles()` splits files into 50-file batches when >50 files (`src/batching.ts:8-29`)

10. **System message construction** (`src/index.ts:412`)
    - `buildSystemMessage()` assembles language-specific prompt + custom rules (`src/prompts.ts:222-236`)

11. **Review execution** (`src/index.ts:413`)
    - `executeReview()` runs the model chain across batches (`src/index.ts:231-271`)

12. **Output dispatch** (`src/index.ts:414`)
    - `dispatchOutput()` posts findings as inline review comments or summary comment (`src/index.ts:287-351`)

13. **Metrics writing** (`src/index.ts:415`)
    - `writeMetrics()` appends metrics to `GITHUB_STEP_SUMMARY` (`src/index.ts:353-363`)

---

## 2. Diff Fetching — `fetchDiff` in `src/review.ts:135`

**File:** `src/review.ts:135-159`

```typescript
export async function fetchDiff(repo: string, prNumber: number, token: string): Promise<Record<string, string>>
```

**Flow:**
1. Constructs GitHub API URL: `https://api.github.com/repos/${repo}/pulls/${prNumber}`
2. Uses `withRetry()` wrapper (`src/retry.ts:18-37`) — retries on 5xx, 429, and network errors
3. Sets `Accept: application/vnd.github.v3.diff` header to get raw diff format
4. Uses `AbortSignal.timeout(GITHUB_API_TIMEOUT_MS)` where `GITHUB_API_TIMEOUT_MS = 30_000` (`src/review.ts:161`)
5. On non-OK response, throws `RetryableError` with status code (`src/review.ts:148`)
6. After receiving response text, checks byte length against 5MB limit (`src/review.ts:154-157`)
7. Throws `DiffTooLargeError` if exceeded (`src/review.ts:156`)
8. Calls `parseDiff(raw)` to split into per-file diffs

**Diff parsing** (`src/review.ts:8-25`):
- Splits raw diff on `diff --git ` markers
- Extracts filename from `diff --git a/path b/path` header using regex `diffHeaderRe = /^diff --git a\/(.+?) b\/(.+)$/`
- Returns `Record<string, string>` mapping filename → full diff text

**Error handling in `run()` (`src/index.ts:388-395`):**
- If `DiffTooLargeError`, posts a comment explaining the diff is too large and returns early
- Other errors are re-thrown, causing `core.setFailed()`

---

## 3. File Filtering & Batching

### `shouldExclude` — `src/review.ts:118-124`

```typescript
export function shouldExclude(filePath: string, patterns: string[]): boolean
```

**Logic:**
1. For each pattern in `patterns`:
   - Checks if `globMatch(filePath, pat)` matches the full path
   - Also checks `globMatch(filePath.split('/').pop() || '', pat)` — matches against basename only
2. Returns `true` if any pattern matches

**Glob matching** (`src/review.ts:111-116`):
- Converts glob pattern to regex: `*` → `.*`, `?` → `.`
- Escapes all other regex special characters
- Anchors with `^...$` for full-string match

**Default exclude patterns** (`src/config.ts:58`):
```
*.lock,*.md,*.txt,*.svg,*.png,*.sum,*.json,*.yaml,*.yml,*.toml,*.mod,*.sum,.mimocode/*,go.sum,go.mod
```

### `batchFiles` — `src/batching.ts:8-29`

```typescript
export function batchFiles(filesDiff: Record<string, string>, batchSize: number = 50): FileBatch[]
```

**Logic:**
1. Sorts file keys alphabetically for deterministic ordering
2. Slices into chunks of `batchSize` (default 50)
3. Each `FileBatch` contains `files: string[]` and `diffs: Record<string, string>`
4. Returns empty array for empty input

**Trigger condition** (`src/index.ts:409`):
```typescript
const batches = filesToReview.length > 50 ? batchFiles(filesDiffMap, 50) : [];
```
Only batches when more than 50 files are being reviewed.

### `mergeFindings` — `src/batching.ts:31-54`

**Deduplication key** (`src/batching.ts:43-45`):
- For line-level findings: `${file}:${line_start}:${line_end ?? 'none'}:${severity}:${issue.toLowerCase()}:${suggestion.toLowerCase()}`
- For file-level findings: `${file}:file:${severity}:${issue.toLowerCase()}:${suggestion.toLowerCase()}`

---

## 4. Model Chain Execution

### `executeReview` — `src/index.ts:231-271`

```typescript
async function executeReview(
  chain: TaggedModel[],
  clients: Record<Provider, OpenAIClient | null>,
  filesToReview: string[],
  filesDiffMap: Record<string, string>,
  batches: FileBatch[],
  systemMessage: string,
  config: Config,
): Promise<{ review: ReviewType; usedModel: string; lastRawContent: string; validationDropped: number; batchCount: number }>
```

**Logic:**
1. If `batches.length > 1`, processes each batch sequentially
2. Otherwise, processes all files as a single batch
3. Each batch wrapped in `withAggregateTimeout()` with `CHAIN_TIMEOUT_MS = 120_000` (`src/index.ts:18`)
4. Calls `runModelChainForBatch()` for each batch
5. If multiple batches, calls `mergeFindings()` to deduplicate across batches
6. Returns combined review, first used model, first raw content, total dropped count, and batch count

### `runModelChainForBatch` — `src/index.ts:60-161`

```typescript
export async function runModelChainForBatch(
  chain: TaggedModel[],
  clients: Record<Provider, OpenAIClient | null>,
  batch: FileBatch,
  systemMessage: string,
  responseFormat: ResponseFormat,
  config: Config,
): Promise<BatchResult>
```

**Logic (per model in chain):**
1. Constructs combined diff from batch files (`src/index.ts:68-69`)
2. For each `tagged` model in the chain:
   a. Gets client for provider (`src/index.ts:77-78`)
   b. Skips if client is null
   c. Calls `client.chat()` with system + user messages (`src/index.ts:82-90`)
      - Temperature: 0.2, MaxTokens: 4096
      - Schema: `ReviewJsonSchema`
      - Format: `providerToFormat()` — `'tools'` for mistral, `'json_schema'` for others (`src/index.ts:56-58`)
   d. If `finishReason === 'length'` (truncated), logs and tries next model (`src/index.ts:92-95`)
   e. If empty content, logs and tries next model (`src/index.ts:96-99`)
   f. Parses JSON with `safeParseJson()` then validates with `ReviewSchema.safeParse()` (`src/index.ts:101`)
   g. **Schema validation retry** (`src/index.ts:102-132`):
      - If schema fails, sends truncated content as assistant message + correction prompt
      - Retries once; if still fails, moves to next model
   h. Calls `validateFindings()` to validate findings against diff (`src/index.ts:136-142`)
   i. Logs warnings, sets batch result, breaks chain
3. Returns `BatchResult` with findings, summary, used model, raw content, dropped count

### `withAggregateTimeout` — `src/index.ts:20-35`

```typescript
export async function withAggregateTimeout<T>(operation: () => Promise<T>, timeoutMs = CHAIN_TIMEOUT_MS): Promise<T | null>
```
- Races the operation against a timeout promise
- Returns `null` on timeout (logged as warning)
- Cleans up timer in `finally` block

### `OpenAIClient.chat()` — `src/openai-client.ts:91-178`

**Request construction:**
- POST to `${baseURL}/chat/completions`
- Payload includes model, messages, temperature, max_tokens, stream=false
- For `json_schema` format: sets `response_format` with strict JSON schema (`src/openai-client.ts:107-112`)
- For `tools` format (Mistral): sets `tools` array with function definition (`src/openai-client.ts:113-123`)

**Retry logic:**
- Uses `withRetry()` with 2 retries, 1000ms base delay
- Retries on 5xx, 429 (with `Retry-After` header parsing), and network errors
- 180-second timeout per request

**Response parsing:**
- For tool-call format: extracts `tool_calls[0].function.arguments` as content
- For standard format: uses `choices[0].message.content`
- Returns `ChatResult` with content, usage, latency, finishReason

### `providerToFormat` — `src/index.ts:56-58`

```typescript
function providerToFormat(provider: Provider, responseFormat: ResponseFormat): ResponseFormat {
  return provider === 'mistral' ? 'tools' : responseFormat;
}
```
Mistral uses function-calling (tools) format instead of JSON schema, since some Mistral models don't support strict JSON schema.

---

## 5. Finding Validation — `validateFindings` in `src/review.ts:50`

**File:** `src/review.ts:50-109`

```typescript
export async function validateFindings(
  review: ReviewType,
  filesDiff: Record<string, string>,
  changedFiles: Set<string>,
  client?: OpenAIClient,
  model?: string,
): Promise<{ valid: ReviewType; warnings: string[]; dropped: number }>
```

**Validation steps (per finding):**

1. **File existence check** (`src/review.ts:62-65`):
   - Drops finding if `f.file` not in `changedFiles` set
   - Warning: `finding references unknown file "${f.file}", dropping`

2. **Line field consistency** (`src/review.ts:66-73`):
   - Drops if `line_end` is set but `line_start` is null
   - Drops if `line_end < line_start`

3. **Hunk overlap check** (`src/review.ts:74-86`):
   - Only for findings with `line_start` set
   - Parses hunk ranges from diff using `getFileHunks()` (`src/review.ts:42-48`)
   - Tolerance: `Math.max(2, Math.floor((h.end - h.start + 1) * 0.1))` — min 2 lines, grows at 10% of hunk length
   - Finding must overlap with any hunk (within tolerance)
   - Drops if no overlap; warning includes line number

4. **Code context validation** (`src/review.ts:87-91`):
   - Calls `validateCodeContext()` from `src/validation.ts:10-51`
   - Checks if identifiers referenced in finding issue text exist in the diff
   - Does NOT drop findings — only adds warnings
   - Checks backtick-wrapped identifiers: `` `name` ``
   - Checks explicit references: `function X`, `variable X`, `class X`, etc.
   - Names ≤2 chars are ignored (avoids false positives)

5. **LLM re-validation** (`src/review.ts:94-102`):
   - Only if `client` and `model` are provided (i.e., `config.revalidateFindings` is true)
   - Calls `revalidateFindings()` from `src/validation.ts:53-119`
   - Sends all valid findings + combined diff to LLM with prompt asking for JSON boolean array
   - Drops findings where LLM returns `false`
   - Falls back gracefully: if JSON parse fails or model throws, all findings pass through

6. **Empty result fallback** (`src/review.ts:104-106`):
   - If all findings dropped and no summary, returns summary: `'All findings were invalid — see model output for context.'`

### `validateCodeContext` — `src/validation.ts:10-51`

**Identifier matching logic:**
- `nameInDiff()` function does case-insensitive search
- Checks word boundaries: character before and after must not be `\w`
- Truncates names >80 chars to avoid regex issues
- Returns `valid: true` always — only provides `reason` for warnings

### `revalidateFindings` — `src/validation.ts:53-119`

**Prompt structure:**
```
You are a code review validator. A reviewer produced these findings for a code diff.
For each finding, determine if it is a REAL issue or a HALLUCINATION (not supported by the code).

Findings:
[0] Warning in src/main.ts:11: Missing error handling
...

Respond with ONLY a JSON array of booleans, one per finding, where true = valid, false = hallucination.
Example: [true, false, true]
```

**Diff truncation:** `MAX_DIFF_LENGTH = 8000` chars, truncated at last newline before limit

**Robustness:**
- If `JSON.parse` fails: returns all findings, 0 dropped
- If response is not an array: returns all findings, 0 dropped
- If array is shorter than findings: missing entries pass through as `true`
- If `client.chat()` throws: returns all findings, 0 dropped

---

## 6. Output Dispatch — `dispatchOutput` in `src/index.ts:287`

**File:** `src/index.ts:273-351`

```typescript
interface DispatchContext {
  repo: string;
  prNumber: number;
  commitSha: string;
  token: string;
  config: Config;
  review: ReviewType;
  reviewableFiles: string[];
  filesToReview: string[];
  truncated: boolean;
  usedModel: string;
  lastRawContent: string;
}
```

**Flow:**

1. **Severity tally** (`src/index.ts:290-296`):
   - Calls `severityTally()` from `src/render.ts:12-20`
   - Counts Critical/Warning/Suggestion findings
   - Builds tally string with emojis: `🚨 N critical · ⚠️ N warning · 💡 N suggestion`

2. **Summary body** (`src/index.ts:296`):
   - `AI_REVIEW_MARKER` = `'### AI Code Review'` (`src/github-review.ts:7`)
   - Includes model name: `<sub>Model: ${modelShort}</sub>`
   - `modelShort` = last path segment of model ID (e.g., `deepseek-v4-pro` from `deepseek-ai/deepseek-v4-pro`)

3. **Empty findings** (`src/index.ts:298-306`):
   - If `review.findings.length === 0`:
   - Calls `cleanupPreviousOutput()` to delete any previous review/comment
   - Returns early with severity counts

4. **Inline comments path** (`src/index.ts:308-319`):
   - Condition: `shouldUseInlineComments(review.findings)` returns `true`
   - Calls `cleanupPreviousOutput()` first
   - Renders review with `renderReview()` (`src/render.ts:22-64`)
   - If `truncated`, appends truncation notice
   - Calls `createReview()` to create GitHub review with inline comments (`src/github-review.ts:44-103`)
   - Logs review ID

5. **Summary comment path** (`src/index.ts:320-332`):
   - Condition: `shouldUseInlineComments()` returns `false` (too many line-level findings)
   - Calls `cleanupPreviousOutput()` first
   - Renders review as a single comment via `postComment()` (`src/github-review.ts:186-192`)
   - Logs that findings exceed inline threshold

6. **Fallback outputs** (`src/index.ts:334-348`):
   - If `!usedModel` (no model succeeded): posts "No review content returned" comment
   - If `promptMode === 'replace'` and `lastRawContent` exists: posts raw model output in a code block
   - Both paths call `cleanupPreviousOutput()` first

### `shouldUseInlineComments` — `src/github-review.ts:182-184`

```typescript
export const INLINE_COMMENT_THRESHOLD = 50;

export function shouldUseInlineComments(findings: ReviewFinding[]): boolean {
  return findings.filter(f => f.line_start != null).length <= INLINE_COMMENT_THRESHOLD;
}
```

**Logic:**
- Counts only findings with `line_start` set (line-level findings)
- Returns `true` if count ≤ 50
- File-level findings (no `line_start`) don't count toward the threshold
- When `false`, falls back to summary comment instead of inline review

### `cleanupPreviousOutput` — `src/index.ts:37-46`

```typescript
async function cleanupPreviousOutput(repo: string, prNumber: number, token: string): Promise<void>
```

**Logic:**
1. Calls `findExistingReview()` to find previous AI review by marker + bot login (`src/github-review.ts:105-154`)
2. If found, calls `deleteReview()` to delete it (`src/github-review.ts:156-178`)
3. Calls `findExistingComment()` to find previous AI comment (`src/github-review.ts:213-255`)
4. If found, calls `deleteComment()` to delete it (`src/github-review.ts:194-211`)

Both `findExistingReview` and `findExistingComment` paginate through up to 50 pages of 100 items, matching on:
- `body.startsWith(AI_REVIEW_MARKER)` (`'### AI Code Review'`)
- `user.login === BOT_LOGIN` (from `GITHUB_ACTOR` env var or `'github-actions'`)

### `createReview` — `src/github-review.ts:44-103`

**Inline comment construction** (`src/github-review.ts:54-72`):
- Filters findings to only those with `line_start != null`
- For each finding:
  - `isMultiLine = f.line_end != null && f.line_end !== f.line_start`
  - `line` = `line_end` for multi-line, `line_start` for single-line
  - `start_line` = `line_start` for multi-line (only if `end > start`)
  - `side` = `'RIGHT'` (always)
  - `body` = `formatFindingComment(f)` (`src/github-review.ts:25-42`)

**API call** (`src/github-review.ts:74-102`):
- POST to `https://api.github.com/repos/${repo}/pulls/${prNumber}/reviews`
- Payload: `{ event: 'COMMENT', comments, commit_id, body? }`
- Uses `withRetry()` for 5xx/429/network errors
- 30-second timeout

### `formatFindingComment` — `src/github-review.ts:25-42`

**Structure:**
```
{emoji} **{severity}**

{escaped issue}

**Suggestion:** {escaped suggestion}    (if present)
**Action:** {escaped action}            (if non-"not applicable")
```

Emoji mapping: Critical → 🚨, Warning → ⚠️, Suggestion → 💡

Action field selection:
- Critical: `critical_action`
- Warning: `warning_action`
- Suggestion: `suggestion_action`

### `renderReview` — `src/render.ts:22-64`

**Rendering order:**
1. Groups findings by severity (Critical → Warning → Suggestion)
2. Within each severity bucket, groups by file (alphabetical)
3. For each finding:
   - Line info: `**Line:** ${line_start}${line_end && line_end !== line_start ? '-' + line_end : ''}`
   - Issue: `**Issue:** ${escapeMarkdown(f.issue)}`
   - Action: `- **{tag}:** {action}` (only if non-"not applicable" and non-empty)
   - Suggestion: `**Suggestion:** {suggestion}` (if present)

Severity tags: Critical → "Must-fix", Warning → "Investigate", Suggestion → "Nit"

### `postComment` — `src/github-review.ts:186-192`

**Logic:**
1. Calls `findExistingComment()` to check for existing AI comment
2. If found, calls `deleteComment()` to remove it
3. Calls `createComment()` to post new comment

### `createComment` — `src/github-review.ts:257-276`

POST to `https://api.github.com/repos/${repo}/issues/${prNumber}/comments` with `{ body }`.

---

## 7. Metrics Writing — `writeMetrics` in `src/index.ts:353`

**File:** `src/index.ts:353-363`

```typescript
async function writeMetrics(metrics: ReviewMetrics): Promise<void>
```

**Logic:**
1. Reads `GITHUB_STEP_SUMMARY` env var
2. If not set, returns early (no-op)
3. Imports `node:fs` dynamically
4. Appends `formatMetrics(metrics)` to the step summary file
5. Catches and logs errors as warnings

### `ReviewMetrics` interface — `src/metrics.ts:1-9`

```typescript
export interface ReviewMetrics {
  pr_number: number;
  model_used: string;
  findings_count: { critical: number; warning: number; suggestion: number };
  files_reviewed: number;
  review_duration_ms: number;
  validation_dropped: number;
  batch_count: number;
}
```

### `formatMetrics` — `src/metrics.ts:11-50`

**Output format:**
```markdown
## Review Metrics

| Metric | Value |
|--------|-------|
| Model | `model_used` |
| Files reviewed | N |
| Duration | X.Xs |
| Total findings | N |

### Severity Breakdown

| Severity | Count |
|----------|-------|
| 🚨 Critical | N |
| ⚠️ Warning | N |
| 💡 Suggestion | N |
```

**Conditional sections:**
- Validation dropped: shown only if `validation_dropped > 0`
- Batching: shown only if `batch_count > 1` (includes files/batch average)

**Duration formatting:** `>0` → `${(ms/1000).toFixed(1)}s`, `0` → `'N/A'`

### Metrics construction in `run()` — `src/index.ts:415`

```typescript
await writeMetrics({
  pr_number: prNumber,
  model_used: result.usedModel.split('/').pop() || result.usedModel,
  findings_count: counts,
  files_reviewed: filesToReview.length,
  review_duration_ms: Date.now() - reviewStartTime,
  validation_dropped: result.validationDropped,
  batch_count: result.batchCount,
});
```

---

## 8. `INLINE_COMMENT_THRESHOLD` & `shouldUseInlineComments`

### `INLINE_COMMENT_THRESHOLD` — `src/github-review.ts:180`

```typescript
export const INLINE_COMMENT_THRESHOLD = 50;
```

**Purpose:** Maximum number of line-level findings before switching from inline review comments to a summary comment. GitHub reviews with too many inline comments can be unwieldy.

### `shouldUseInlineComments` — `src/github-review.ts:182-184`

```typescript
export function shouldUseInlineComments(findings: ReviewFinding[]): boolean {
  return findings.filter(f => f.line_start != null).length <= INLINE_COMMENT_THRESHOLD;
}
```

**Key behaviors:**
- Only counts findings with `line_start != null` (line-level findings)
- File-level findings (no `line_start`) do NOT count toward the threshold
- When `true`: creates a GitHub review with inline comments on specific lines
- When `false`: posts a single summary comment with all findings rendered as markdown

**Test coverage** (`src/github-review.test.ts:61-84`):
- 2 line-level findings → `true`
- 60 line-level findings → `false`
- 40 line-level + 30 file-level → `true` (file-level don't count)

---

## 9. The `truncated` Flag (max_files limit)

### Setting the flag — `src/index.ts:401-402`

```typescript
const filesToReview = reviewableFiles.slice(0, config.maxFiles);
const truncated = reviewableFiles.length > config.maxFiles;
```

**Logic:**
1. `reviewableFiles` = all files after exclusion filtering
2. `filesToReview` = first `config.maxFiles` files (default 100, max 500)
3. `truncated` = `true` when `reviewableFiles.length > config.maxFiles`

### Config validation — `src/config.ts:49-57`

```typescript
maxFiles: (() => {
  const raw = core.getInput('max_files') || '100';
  const parsed = Number.parseInt(raw, 10);
  if (!/^[+]?\d+$/.test(raw.trim()) || !Number.isInteger(parsed) || parsed <= 0 || parsed > 500) {
    core.warning(`Invalid max_files "${raw}", must be 1-500. Defaulting to 100.`);
    return 100;
  }
  return parsed;
})(),
```

- Default: 100
- Valid range: 1-500
- Invalid values fall back to 100 with a warning

### Truncation notice in output — `src/index.ts:315-317` and `src/index.ts:327-329`

Both inline review and summary comment paths append:
```
---
Reached max file limit (${config.maxFiles}); ${reviewableFiles.length - config.maxFiles} files skipped.
```

**Important:** The truncation notice shows the count of skipped files (`reviewableFiles.length - config.maxFiles`), not just the fact that truncation occurred.

---

## 10. Complete Data Flow Summary

```
run() [src/index.ts:365]
  │
  ├── loadConfig() [src/config.ts:28]
  │     └── Reads 15+ GitHub Action inputs (API keys, model lists, max_files, exclude_patterns, etc.)
  │
  ├── validateConfig() [src/index.ts:163]
  │     └── Checks API keys, URL schemes, SSRF protection via validateProviderUrl()
  │
  ├── buildClients() [src/index.ts:194]
  │     └── Creates OpenAIClient per provider (nim, mistral, groq, custom)
  │
  ├── buildCombinedChain() [src/model-chain.ts:33]
  │     └── Merges provider models, sorts by SWE-bench score, custom model first
  │
  ├── loadEvent() [src/event.ts:10]
  │     └── Reads GITHUB_EVENT_PATH for PR number + commit SHA
  │
  ├── parseRules() + validateRules() [src/rules.ts:7,51]
  │     └── Parses custom rules, checks for prompt injection
  │
  ├── fetchDiff() [src/review.ts:135]
  │     ├── GET https://api.github.com/repos/{repo}/pulls/{pr}
  │     ├── Accept: application/vnd.github.v3.diff
  │     ├── withRetry() (2 retries, 1000ms base delay)
  │     ├── 30s timeout
  │     ├── 5MB size check → DiffTooLargeError
  │     └── parseDiff() → Record<filename, diffText>
  │
  ├── shouldExclude() [src/review.ts:118]
  │     └── Glob match on full path + basename
  │
  ├── slice(0, maxFiles) + truncated flag [src/index.ts:401-402]
  │
  ├── detectLanguage() [src/index.ts:204]
  │     └── Counts file extensions, picks dominant language
  │
  ├── prioritizeChain() [src/index.ts:215]
  │     └── Probes all models, moves fastest to front of chain
  │
  ├── batchFiles() [src/batching.ts:8]
  │     └── Splits >50 files into 50-file batches
  │
  ├── buildSystemMessage() [src/prompts.ts:222]
  │     └── Language-specific prompt + custom rules + JSON schema
  │
  ├── executeReview() [src/index.ts:231]
  │     └── For each batch:
  │           └── runModelChainForBatch() [src/index.ts:60]
  │                 └── For each model in chain:
  │                     ├── client.chat() [src/openai-client.ts:91]
  │                     │     ├── POST /chat/completions
  │                     │     ├── withRetry() (2 retries, 1000ms base, 180s timeout)
  │                     │     ├── JSON schema or tools format
  │                     │     └── Returns content + finishReason
  │                     ├── safeParseJson() + ReviewSchema.safeParse() [src/index.ts:101]
  │                     ├── Schema retry (1 retry with correction prompt) [src/index.ts:102-132]
  │                     └── validateFindings() [src/review.ts:50]
  │                           ├── File existence check
  │                           ├── Line field consistency
  │                           ├── Hunk overlap check (tolerance = max(2, 10% of hunk size))
  │                           ├── validateCodeContext() [src/validation.ts:10]
  │                           │     └── Checks if referenced identifiers exist in diff
  │                           └── revalidateFindings() [src/validation.ts:53] (optional)
  │                                 └── LLM validation with boolean array response
  │                     └── mergeFindings() [src/batching.ts:31] (if multiple batches)
  │                           └── Dedup by file:line:severity:issue:suggestion
  │
  ├── dispatchOutput() [src/index.ts:287]
  │     ├── severityTally() [src/render.ts:12]
  │     ├── cleanupPreviousOutput() [src/index.ts:37]
  │     │     ├── findExistingReview() [src/github-review.ts:105]
  │     │     ├── deleteReview() [src/github-review.ts:156]
  │     │     ├── findExistingComment() [src/github-review.ts:213]
  │     │     └── deleteComment() [src/github-review.ts:194]
  │     ├── shouldUseInlineComments() [src/github-review.ts:182]
  │     │     └── Count line-level findings ≤ 50
  │     ├── If inline: createReview() [src/github-review.ts:44]
  │     │     └── POST /pulls/{pr}/reviews with inline comments
  │     └── If summary: postComment() [src/github-review.ts:186]
  │           └── POST /issues/{pr}/comments
  │
  └── writeMetrics() [src/index.ts:353]
        └── Append to GITHUB_STEP_SUMMARY
```

---

## 11. Key Constants & Defaults

| Constant | Value | Location |
|----------|-------|----------|
| `CHAIN_TIMEOUT_MS` | 120,000 (120s) | `src/index.ts:18` |
| `GITHUB_API_TIMEOUT_MS` (review.ts) | 30,000 (30s) | `src/review.ts:161` |
| `GITHUB_API_TIMEOUT_MS` (github-review.ts) | 30,000 (30s) | `src/github-review.ts:6` |
| `INLINE_COMMENT_THRESHOLD` | 50 | `src/github-review.ts:180` |
| `PROBE_TIMEOUT_MS` | 10,000 (10s) | `src/model-chain.ts:68` |
| `maxFiles` default | 100 | `src/config.ts:50` |
| `maxFiles` range | 1-500 | `src/config.ts:52` |
| Batch size | 50 | `src/index.ts:409` |
| Diff max size | 5MB | `src/review.ts:155` |
| Chat timeout | 180,000 (180s) | `src/openai-client.ts:135` |
| Chat max_tokens | 4096 | `src/index.ts:87` |
| Chat temperature | 0.2 | `src/index.ts:86` |
| Revalidation max diff | 8000 chars | `src/validation.ts:74` |
| Revalidation max finding issue | 200 chars | `src/validation.ts:62` |
| Retry max attempts | 2 | `src/retry.ts:18` |
| Retry base delay | 1000ms | `src/retry.ts:18` |
| Retry max delay | 60,000ms | `src/retry.ts:15` |
| SWE-bench unknown model default | 0.5 | `src/bench-reorder.ts:186` |

---

## 12. Test Coverage Summary

| Test File | Lines | Coverage |
|-----------|-------|----------|
| `src/review.test.ts` | 449 | parseDiff, shouldExclude, parseDiffHunks, getFileHunks, validateFindings, renderReview, severityTally, loadConfig |
| `src/batching.test.ts` | 111 | batchFiles (single/multiple/empty/sorting), mergeFindings (merge/dedup/summaries/empty) |
| `src/index.test.ts` | 99 | buildSystemMessage, OpenAIClient integration, severityTally, validateFindings edge cases |
| `src/github-review.test.ts` | 227 | formatFindingComment, shouldUseInlineComments, createReview, findExistingReview, deleteReview |
| `src/validation.test.ts` | 221 | validateCodeContext (12 tests), revalidateFindings (7 tests + 3 robustness) |
| `src/metrics.test.ts` | 73 | formatMetrics (basic, severity, validation, batching, duration, total) |
| `src/model-chain.test.ts` | 183 | buildCombinedChain (11 scenarios: NIM-only, Mistral-only, combined, Groq, empty, custom, scores) |
| `src/bench-reorder.test.ts` | — | (not read) |
| `src/diff-utils.test.ts` | — | (not read) |
| `src/retry.test.ts` | — | (not read) |
| `src/rules.test.ts` | — | (not read) |
| `src/prompts.test.ts` | — | (not read) |
| `src/openai-client.test.ts` | — | (not read) |
| `src/reliability.test.ts` | — | (not read) |
| `src/security.test.ts` | — | (not read) |
| `src/removed-models.test.ts` | — | (not read) |
| `src/bench.test.ts` | — | (not read) |
| `src/bench-entry.test.ts` | — | (not read) |
