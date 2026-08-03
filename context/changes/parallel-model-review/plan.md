# Implementation Plan: Parallel Model Review — Default & Documentation

> **Frame brief**: `context/changes/parallel-model-review/frame.md`
> **Core finding**: The staggered parallel model fallback feature is already
> fully implemented (`action.yml:124-131`, `src/index.ts:234-353`,
> `src/config.ts:133-150`, tested at `src/index.test.ts:414-660`) but is
> off-by-default (`parallel_attempts: 1`) and absent from the README.
> **Decision**: Flip the default to `3` and document it. Cost is insulated by
> staggered starts (3rd sibling fires only at t=80s on double-failure),
> free-tier fallbacks, abort-on-winner, and adaptive token caps.

## What We're NOT Doing

- **Not building parallel model review from scratch.** The feature exists.
- **Not changing the parallel execution algorithm.** The staggered-start /
  winner-take-all / sequential-tail logic in `src/index.ts:234-353` is
  correct and tested; this change only flips a default and documents it.
- **Not changing `parallel_threshold` default.** `40s` is well-tuned for
  default=3: sibling 1 starts at t=40s, sibling 2 at t=80s, just before the
  head's 90s `model_timeout` — parallel fallback kicks in right as the head
  is about to time out.
- **Not touching the `makeConfig` test helper default.** It stays at
  `parallelAttempts: 1` so existing sequential tests remain sequential. The
  production default is verified via `config.test.ts` (env-var-driven), not
  via the test fixture.
- **Not building parallel batch processing (frame dimension 4).** That is a
  separate, genuinely unbuilt change for >50-file PRs. Out of scope here.

## Phase 1: Flip the default (config + action.yml)

### 1.1 `action.yml:124-131`

Update the `parallel_attempts` input:

- **Line 125** (description): Replace `1 = fully sequential (default). 2-5
  enables staggered parallel fallback.` with:
  `Number of models to try in parallel via staggered starts. Default 3 (light parallel). Set to 1 for fully sequential. Range 2-5 enables staggered parallel fallback: the head model starts immediately, and each subsequent model starts after parallel_threshold seconds if no winner has emerged.`
- **Line 127** (default): `'1'` → `'3'`

Leave `parallel_threshold` (lines 128-131) unchanged — default `40` is
correct for the new default of 3.

### 1.2 `src/config.ts:133-140`

Update the `parallelAttempts` parser:

- **Line 134**: `|| '1'` → `|| '3'`
- **Line 137** (warning message): `Defaulting to 1.` → `Defaulting to 3.`
- **Line 138** (fallback return): `return 1;` → `return 3;`

Leave `parallelThreshold` (lines 142-150) unchanged.

### 1.3 Why not the test helper

`src/index.test.ts:228` (`makeConfig`): **leave `parallelAttempts: 1`**.
The sequential test suite (`describe('runModelChainForBatch sequential
fallback')`, line 317) calls `makeConfig()` with no override and asserts
sequential behavior. Bumping the fixture default to 3 would activate the
parallel branch (`parallelEnabled = parallelAttempts > 1 && chain.length >
1`) in those tests, changing call counts and model-selection assertions.
The production default is covered by `config.test.ts` (Phase 2), not by
the fixture.

## Phase 2: Config tests for the new defaults

`src/config.test.ts` has no test block for `parallel_attempts` /
`parallel_threshold`. Add one, mirroring the existing
`describe('loadConfig — timeout fields')` pattern (lines 264-309).

### 2.1 New test block

Insert after the `custom_swe_score` block (after line 360):

```typescript
describe('loadConfig — parallel fields', () => {
  const BASE = {
    INPUT_NIM_API_KEY: 'nim-key',
    INPUT_NIM_BASE_URL: '',
    INPUT_NIM_MODELS: '',
    INPUT_MAX_FILES: '',
    INPUT_EXCLUDE_PATTERNS: '',
    INPUT_NIM_SYSTEM_PROMPT: '',
    INPUT_NIM_PROMPT_MODE: '',
    INPUT_OPENROUTER_API_KEY: '',
    INPUT_OPENROUTER_MODELS: '',
    INPUT_MODEL_TIMEOUT: '',
    INPUT_CHAIN_TIMEOUT: '',
    INPUT_PARALLEL_ATTEMPTS: '',
    INPUT_PARALLEL_THRESHOLD: '',
  };

  it('defaults parallelAttempts to 3 and parallelThreshold to 40', async () => {
    await withEnv({ ...BASE }, async () => {
      const config = await loadConfig();
      assert.strictEqual(config.parallelAttempts, 3);
      assert.strictEqual(config.parallelThreshold, 40);
    });
  });

  it('reads custom valid values', async () => {
    await withEnv({ ...BASE, INPUT_PARALLEL_ATTEMPTS: '2', INPUT_PARALLEL_THRESHOLD: '20' }, async () => {
      const config = await loadConfig();
      assert.strictEqual(config.parallelAttempts, 2);
      assert.strictEqual(config.parallelThreshold, 20);
    });
  });

  it('accepts boundary values 1 and 5 for parallel_attempts', async () => {
    await withEnv({ ...BASE, INPUT_PARALLEL_ATTEMPTS: '1' }, async () => {
      const config = await loadConfig();
      assert.strictEqual(config.parallelAttempts, 1);
    });
    await withEnv({ ...BASE, INPUT_PARALLEL_ATTEMPTS: '5' }, async () => {
      const config = await loadConfig();
      assert.strictEqual(config.parallelAttempts, 5);
    });
  });

  it('accepts boundary values 5 and 120 for parallel_threshold', async () => {
    await withEnv({ ...BASE, INPUT_PARALLEL_THRESHOLD: '5' }, async () => {
      const config = await loadConfig();
      assert.strictEqual(config.parallelThreshold, 5);
    });
    await withEnv({ ...BASE, INPUT_PARALLEL_THRESHOLD: '120' }, async () => {
      const config = await loadConfig();
      assert.strictEqual(config.parallelThreshold, 120);
    });
  });

  it('warns and falls back to 3 for out-of-range or non-numeric parallel_attempts', async () => {
    for (const bad of ['0', '6', '-1', 'abc', '1.5']) {
      await withEnv({ ...BASE, INPUT_PARALLEL_ATTEMPTS: bad }, async () => {
        const config = await loadConfig();
        assert.strictEqual(config.parallelAttempts, 3, `value "${bad}" should fall back to 3`);
      });
    }
  });

  it('warns and falls back to 40 for out-of-range or non-numeric parallel_threshold', async () => {
    for (const bad of ['4', '121', '-1', 'abc', '0']) {
      await withEnv({ ...BASE, INPUT_PARALLEL_THRESHOLD: bad }, async () => {
        const config = await loadConfig();
        assert.strictEqual(config.parallelThreshold, 40, `value "${bad}" should fall back to 40`);
      });
    }
  });
});
```

### 2.2 Update existing BASE blocks

The existing `describe('loadConfig — timeout fields')` (line 264) and
`describe('loadConfig — custom_swe_score')` (line 311) BASE objects don't
set `INPUT_PARALLEL_ATTEMPTS` / `INPUT_PARALLEL_THRESHOLD`. With the new
default, `core.getInput('parallel_attempts')` returns `''` → falls to `|| '3'`
→ returns 3. This doesn't affect the assertions in those blocks (they test
`modelTimeout`, `chainTimeout`, `customSweScore`), so no changes needed
there.

## Phase 3: README documentation

### 3.1 Fix stale model_timeout default

- **README.md:64**: `| model_timeout | 60 |` → `| model_timeout | 90 |`
  (action.yml:115 default is `90`, not `60`; this was flagged in
  `model-chain-resilience/plan.md:35`)
- **README.md:75**: `60s timeout` → `90s timeout`

### 3.2 Add parallel inputs to the Inputs table

Insert two new rows after the `chain_timeout` row (README.md:65), before
`comment_mode`:

```markdown
| `parallel_attempts` | `3` | Number of models to try in parallel via staggered starts. Default 3 (light parallel). Set to 1 for fully sequential. Range 2-5. The head model starts immediately; each subsequent model starts after `parallel_threshold` seconds if no winner has emerged. |
| `parallel_threshold` | `40` | Seconds to wait before starting the next parallel model (when `parallel_attempts` > 1). Range 5-120. |
```

### 3.3 Add "Parallel Model Fallback" section

Insert a new section after the "Model chain" description in the How It Works
area (after README.md:82, before "Output Modes" at line 83). Content:

````markdown
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
````

## Phase 4: Verify

### 4.1 Build

```bash
npm run build
```

### 4.2 Full test suite

```bash
npm test
```

### 4.3 Expected test outcomes

- All existing parallel tests (`index.test.ts:414-472`, `615-660`) pass
  unchanged — they explicitly override `parallelAttempts`.
- All existing sequential tests (`index.test.ts:317-412`) pass unchanged —
  `makeConfig` fixture still defaults `parallelAttempts: 1`.
- New `config.test.ts` parallel-fields block passes (6 new test cases).

## File Change Summary

| File | Change |
|------|--------|
| `action.yml:125,127` | Description + default: `1` → `3` |
| `src/config.ts:134,137-138` | Fallback default + warning: `1` → `3` |
| `src/config.test.ts` (after line 360) | New `describe('loadConfig — parallel fields')` block (6 tests) |
| `README.md:64` | Fix stale `model_timeout` default: `60` → `90` |
| `README.md:65` (insert 2 rows) | Add `parallel_attempts` + `parallel_threshold` to Inputs table |
| `README.md:75` | Fix stale "60s timeout" → "90s timeout" |
| `README.md:82` (insert section) | New "Parallel Model Fallback" section |

**Total: 4 files, ~7 edits, 6 new tests, no new source code.**

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Flip the default (config + action.yml)
#### Automated
- [x] 1.1 Update `action.yml` parallel_attempts description (line 125) and default (line 127): `1` → `3` — 33c4559
- [x] 1.2 Update `src/config.ts` parallelAttempts parser default and warning (lines 134, 137, 138): `1` → `3` — 33c4559
- [x] 1.3 Verify `makeConfig` test helper stays at `parallelAttempts: 1` (do not edit) — 33c4559

### Phase 2: Config tests for the new defaults
#### Automated
- [x] 2.1 Add `loadConfig — parallel fields` test block to `src/config.test.ts` (6 new test cases) — 76853e5
- [x] 2.2 Verify existing BASE blocks in `config.test.ts` still pass with new defaults (no changes needed) — 76853e5

### Phase 3: README documentation
#### Automated
- [x] 3.1 Fix stale `model_timeout` default in README: `60` → `90` (lines 64, 75) — 56d6743
- [x] 3.2 Add `parallel_attempts` and `parallel_threshold` rows to Inputs table (after line 65) — 56d6743
- [x] 3.3 Add "Parallel Model Fallback" section to README (after line 82) — 56d6743

### Phase 4: Verify
#### Automated
- [ ] 4.1 `npm run build` passes
- [ ] 4.2 `npm test` passes
