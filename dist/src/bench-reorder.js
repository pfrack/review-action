/**
 * bench-reorder.ts
 *
 * After a benchmark run, this script:
 * 1. Reads benchmark results from stdin (markdown table from bench-entry.ts)
 * 2. Ranks models by SWE-bench score with latency penalty
 * 3. Updates nim_models in action.yml
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { withRetry, RetryableError } from './retry.js';
import { safeParseJsonBody } from './utils.js';
/**
 * Parse SWE-bench API response into sorted entries.
 * Filters to score > 0.5, sorts by score descending, returns top 30.
 */
export function parseSweBenchResponse(data) {
    return (data.results || [])
        .filter(m => m.score > 0.5)
        .sort((a, b) => b.score - a.score)
        .slice(0, 30)
        .map(m => ({
        modelId: m.model_id,
        score: m.score,
        org: m.organization_id || '',
    }));
}
// Module-level counter used to escalate the warning once consecutive
// fetch failures pile up. This is intentionally process-local: bench-reorder
// is invoked as a single CLI per workflow run, so there is no concurrency
// to worry about. If this module is ever reused in a server context,
// replace this with a per-request counter passed through fetchSweBenchScores.
let sweBenchFetchFailures = 0;
const SWE_BENCH_FAIL_WARN_THRESHOLD = 3;
/**
 * Fetch SWE-bench Verified scores from the leaderboard API.
 * Returns top ~30 models by score, filtered to score > 0.5.
 */
export async function fetchSweBenchScores() {
    const url = process.env.SWE_BENCH_API_URL || 'https://api.zeroeval.com/leaderboard/benchmarks/swe-bench-verified/details';
    try {
        const resp = await withRetry(async () => {
            const r = await fetch(url, {
                signal: AbortSignal.timeout(30_000),
            });
            if (!r.ok)
                throw new RetryableError(`SWE-bench API returned ${r.status}`, r.status);
            return r;
        });
        const data = await safeParseJsonBody(resp, 'SWE-bench API');
        sweBenchFetchFailures = 0;
        return parseSweBenchResponse(data);
    }
    catch (err) {
        sweBenchFetchFailures++;
        if (sweBenchFetchFailures >= SWE_BENCH_FAIL_WARN_THRESHOLD) {
            process.stderr.write(`\n*** ALERT: SWE-bench API at ${url} has failed ${sweBenchFetchFailures} time(s). Rankings will use fallback scores only. Last error: ${err}\n\n`);
        }
        else {
            process.stderr.write(`Warning: could not fetch SWE-bench scores from ${url}: ${err}\n`);
        }
        return [];
    }
}
/**
 * Parse the markdown table output from bench-entry.ts
 */
export function parseMarkdownTable(table) {
    const lines = table.trim().split('\n');
    const rows = [];
    for (const line of lines) {
        if (!line.startsWith('|') || line.includes('---') || line.includes('Model'))
            continue;
        const cells = line.split('|').map(c => c.trim()).filter(c => c !== '');
        if (cells.length < 5)
            continue;
        const model = cells[0].replace(/`/g, '');
        const ttftMs = parseDuration(cells[1]);
        const latencyMs = parseDuration(cells[2]);
        const tokensPerSec = parseFloat(cells[3]) || 0;
        const errors = parseInt(cells[4], 10) || 0;
        rows.push({ model, ttftMs, latencyMs, tokensPerSec, errors });
    }
    return rows;
}
function parseDuration(s) {
    s = s.trim();
    if (s === 'N/A')
        return Infinity;
    if (s.endsWith('μs'))
        return parseFloat(s) / 1000;
    if (s.endsWith('ms'))
        return parseFloat(s);
    if (s.endsWith('s'))
        return parseFloat(s) * 1000;
    return parseFloat(s) || Infinity;
}
/**
 * Known SWE-bench Verified scores for models available on NIM, Groq,
 * OpenRouter, and Kilo.
 * Source: https://llm-stats.com/benchmarks/swe-bench-verified
 *
 * Free-tier entries (IDs ending with :free) are estimated scores; they
 * should be replaced with measured values once benchmark data is available.
 * Free models are forced to rank last in the fallback chain.
 *
 * Model identifiers are provider-specific — Groq uses different IDs than
 * NIM for the same underlying models (e.g. moonshotai/kimi-k2-instruct vs
 * moonshotai/kimi-k2.6). If provider catalogs change, entries may drift;
 * configured models without a score entry return 0.5 and rank lower.
 */
export const SWE_BENCH_SCORES = {
    'deepseek-ai/deepseek-v4-pro': 0.806,
    'deepseek-ai/deepseek-v4-flash': 0.790,
    'minimaxai/minimax-m3': 0.805,
    'minimaxai/minimax-m2.7': 0.802,
    'moonshotai/kimi-k2.6': 0.802,
    'z-ai/glm-5.2': 0.778,
    'mistralai/mistral-medium-3.5-128b': 0.776,
    'qwen/qwen3.5-397b-a17b': 0.764,
    'stepfun-ai/step-3.7-flash': 0.744,
    'qwen/qwen3.5-122b-a10b': 0.734,
    'bytedance/seed-oss-36b-instruct': 0.735,
    'mistralai/mistral-large-3-675b-instruct-2512': 0.720,
    'mistralai/mistral-nemotron': 0.720,
    'qwen/qwen3-next-80b-a3b-instruct': 0.720,
    'openai/gpt-oss-120b': 0.720,
    'moonshotai/kimi-k2-instruct': 0.802,
    'nvidia/llama-3.1-nemotron-ultra-253b-v1': 0.700,
    'mistralai/mistral-large': 0.700,
    'mistralai/mistral-large-2-instruct': 0.700,
    'nvidia/nemotron-3-ultra-550b-a55b': 0.700,
    'nvidia/nemotron-3-super-120b-a12b': 0.680,
    'mistralai/mistral-small-4-119b-2603': 0.680,
    'nvidia/llama-3.3-nemotron-super-49b-v1.5': 0.660,
    'nvidia/llama-3.3-nemotron-super-49b-v1': 0.650,
    'nvidia/nemotron-4-340b-instruct': 0.650,
    'openai/gpt-oss-20b': 0.650,
    'meta/llama-4-maverick-17b-128e-instruct': 0.650,
    'thinkingmachines/inkling': 0.650,
    'meta/llama-3.3-70b-instruct': 0.620,
    'llama-3.3-70b-versatile': 0.620,
    'nvidia/llama-3.1-nemotron-70b-instruct': 0.620,
    'nvidia/llama-3.1-nemotron-51b-instruct': 0.620,
    'meta/llama-3.1-70b-instruct': 0.600,
    'poolside/laguna-xs-2.1': 0.600,
    'abacusai/dracarys-llama-3.1-70b-instruct': 0.600,
    'microsoft/phi-3.5-moe-instruct': 0.580,
    'databricks/dbrx-instruct': 0.550,
    'ai21labs/jamba-1.5-large-instruct': 0.550,
    // Direct Mistral API model IDs
    'mistral-medium-3.5': 0.776,
    'mistral-medium-latest': 0.776,
    'mistral-large-2512': 0.720,
    'mistral-large-latest': 0.720,
    'mistral-small-2603': 0.680,
    'mistral-small-latest': 0.680,
    'codestral-2508': 0.650,
    'codestral-latest': 0.650,
    // OpenRouter free-tier models (measured/estimated scores)
    'z-ai/glm-5.2:free': 0.778, // measured — matches glm-5, rank 24
    'dots-studio/dots-3-note-preview:free': 0.45, // estimated — small free tier
    'google/gemma-4-31b-it:free': 0.45, // estimated — 31B class, no Verified entry
    'liquid/lfm-2.5-2.6b:free': 0.25, // estimated — 2.6B params
    'nvidia/nemotron-3.5-lightning:free': 0.516, // measured — matches nemotron-3.5-lightning-30b-a3b, rank 94
    'inclusionai/ling-3.0-tiny:free': 0.30, // estimated — tiny model
    'tencent/hy3:free': 0.78, // measured — rank 21
    'google/gemma-4-26b-a4b-it:free': 0.40, // estimated — 26B MoE
    'nvidia/nemotron-3-nano-30b-a3b:free': 0.388, // measured — rank 103
    'nvidia/nemotron-nano-12b-v2-vl:free': 0.35, // estimated — 12B nano
    'nvidia/nemotron-nano-9b-v2:free': 0.30, // estimated — 9B nano
    'openai/gpt-oss-20b:free': 0.30, // estimated — 20B open source
    'cohere/north-mini-code:free': 0.676, // measured — matches north-mini-code-1.0, rank 74
    'kilo-auto/free': 0.5, // routing model — neutral default
    'stepfun/step-3.7-flash:free': 0.744, // measured — matches step-3.5-flash, rank 40
    'inclusionai/ling-3.0-flash:free': 0.50, // estimated — flash variant, unbenchmarked
    'poolside/laguna-s-2.1:free': 0.75, // estimated — 118B; S benchmarks 78.5% Multilingual
    'poolside/laguna-xs-2.1:free': 0.709, // measured — rank 59
    'nvidia/nemotron-3.5-content-safety:free': 0.5, // specialized model, not on coding leaderboard
    'nvidia/nemotron-3-ultra-550b-a55b:free': 0.707, // measured — rank 61
    'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free': 0.40, // estimated — nano reasoning variant
    'poolside/laguna-m.1:free': 0.72, // estimated — 225B-A23B, largest in Laguna family
    'nvidia/nemotron-3-super-120b-a12b:free': 0.5373, // measured — rank 92
    'openrouter/free': 0.5, // routing model — neutral default
    'deepseek/deepseek-r1:free': 0.65, // estimated — free tier, quantized
    'meta-llama/llama-4-maverick:free': 0.55, // estimated — Llama 4, free tier
    'google/gemini-2.0-flash-exp:free': 0.60, // estimated — experimental free tier
    // Kilo free-tier models (estimated scores)
    'kilo-auto/balanced:free': 0.55, // estimated — free auto tier
    'kilo-auto/frontier:free': 0.60, // estimated — free tier, frontier routing
    // NousResearch free-tier models (measured — SWE-bench Verified leaderboard)
    // hy3: rank 21, laguna-xs-2.1: rank 59, solar-pro4: rank 62
    // step-3.7-flash: matches step-3.5-flash rank 40, longcat: matches longcat-flash-thinking-2601 rank 64
    'upstage/solar-pro4:free': 0.706, // measured — SWE-bench Verified rank 62
    'meituan/longcat-2.0:free': 0.70, // measured — matches longcat-flash-thinking-2601, rank 64
};
/**
 * Get SWE-bench score for a model. Returns 0.5 (neutral) if unknown.
 * If fetchedScores is provided, checks it before the hardcoded table.
 */
export function getSweBenchScore(model, fetchedScores) {
    return fetchedScores?.get(model) ?? SWE_BENCH_SCORES[model] ?? 0.5;
}
/**
 * Effective score = SWE-bench score × latency multiplier.
 * - Under 60s: no penalty (1.0)
 * - 60-120s: linear penalty (1.0 → 0.7)
 * - Over 120s: heavy penalty (0.5)
 */
export const DEFAULT_MAX_LATENCY_MS = 60_000;
export function getEffectiveScore(model, latencies, maxLatencyMs = DEFAULT_MAX_LATENCY_MS, fetchedScores) {
    const swe = getSweBenchScore(model, fetchedScores);
    if (!latencies || !(model in latencies))
        return swe;
    const lat = latencies[model];
    if (lat <= maxLatencyMs)
        return swe;
    if (lat <= maxLatencyMs * 2) {
        const ratio = (lat - maxLatencyMs) / maxLatencyMs;
        return swe * (1.0 - 0.3 * ratio);
    }
    return swe * 0.5;
}
/**
 * Rank models by effective score (SWE-bench × latency penalty) descending.
 * Models with partial errors are included as long as at least one iteration
 * produced tokens (tokensPerSec > 0). No separate latency tiebreaker is
 * applied — the latency penalty encoded in getEffectiveScore already
 * demotes slow models.
 */
export function rankModels(rows, latencies, fetchedScores) {
    const alive = rows.filter(r => r.tokensPerSec > 0);
    return alive
        .map(r => r.model)
        .sort((a, b) => {
        const effA = getEffectiveScore(a, latencies, DEFAULT_MAX_LATENCY_MS, fetchedScores);
        const effB = getEffectiveScore(b, latencies, DEFAULT_MAX_LATENCY_MS, fetchedScores);
        return effB - effA;
    });
}
/**
 * Two-tier ranking: known models (in SWE_BENCH_SCORES) sorted by effective score
 * (SWE-bench × latency penalty) descending, then new models (not in
 * SWE_BENCH_SCORES) sorted by latency ascending. Known models always rank
 * above new models.
 */
export function rankModelsTwoTier(rows, knownModels, latencies, fetchedScores) {
    const alive = rows.filter(r => r.tokensPerSec > 0);
    const known = [];
    const unknown = [];
    for (const model of alive.map(r => r.model)) {
        if (knownModels.has(model)) {
            known.push(model);
        }
        else {
            unknown.push(model);
        }
    }
    known.sort((a, b) => {
        const effA = getEffectiveScore(a, latencies, DEFAULT_MAX_LATENCY_MS, fetchedScores);
        const effB = getEffectiveScore(b, latencies, DEFAULT_MAX_LATENCY_MS, fetchedScores);
        return effB - effA;
    });
    unknown.sort((a, b) => {
        const latA = latencies?.[a] ?? Infinity;
        const latB = latencies?.[b] ?? Infinity;
        return latA - latB;
    });
    return [...known, ...unknown];
}
function buildTargetPattern(targetKey) {
    return new RegExp(`(${targetKey}:\\n\\s+description:[^\\n]*\\n\\s+default:\\s*')([^']*)(')`);
}
const TARGET_CONFIG = {
    nim_models: { pattern: buildTargetPattern('nim_models'), label: 'nim_models' },
    mistral_models: { pattern: buildTargetPattern('mistral_models'), label: 'mistral_models' },
    groq_models: { pattern: buildTargetPattern('groq_models'), label: 'groq_models' },
    openrouter_models: { pattern: buildTargetPattern('openrouter_models'), label: 'openrouter_models' },
    kilocode_models: { pattern: buildTargetPattern('kilocode_models'), label: 'kilocode_models' },
    nousresearch_models: { pattern: buildTargetPattern('nousresearch_models'), label: 'nousresearch_models' },
};
/**
 * Update action.yml with new model order for the given target.
 */
export function updateActionYml(actionPath, orderedModels, target = 'nim_models') {
    const content = readFileSync(actionPath, 'utf-8');
    const modelString = orderedModels.join(',');
    const config = TARGET_CONFIG[target];
    console.log(`Reading ${actionPath} for ${config.label} (${content.length} bytes)`);
    if (!config.pattern.test(content)) {
        // Show context around the target key for debugging
        const key = config.label + ':';
        const idx = content.indexOf(key);
        if (idx === -1) {
            console.warn(`Warning: '${key}' not found in ${actionPath}`);
        }
        else {
            const snippet = content.substring(idx, idx + 200);
            console.warn(`Warning: could not match ${config.label} pattern in ${actionPath}`);
            console.warn(`Content around '${key}':\n${snippet}`);
        }
        return;
    }
    const updated = content.replace(config.pattern, (_, p1, _p2, p3) => p1 + modelString + p3);
    if (updated === content) {
        console.log(`${config.label} models already in desired order, no changes needed`);
        return;
    }
    writeFileSync(actionPath, updated, 'utf-8');
}
export function updateActionYmlMistral(actionPath, orderedModels) {
    updateActionYml(actionPath, orderedModels, 'mistral_models');
}
export function updateActionYmlOpenRouter(actionPath, orderedModels) {
    updateActionYml(actionPath, orderedModels, 'openrouter_models');
}
export function updateActionYmlKilocode(actionPath, orderedModels) {
    updateActionYml(actionPath, orderedModels, 'kilocode_models');
}
export function updateActionYmlNousResearch(actionPath, orderedModels) {
    updateActionYml(actionPath, orderedModels, 'nousresearch_models');
}
/**
 * Read fetched scores from BENCH_SCORES_FILE (preferred) or stdin HTML comment.
 * Returns the parsed scores map (empty if neither source yields a value).
 * Exported for testability.
 */
export function readFetchedScores(rawInput, scoresFile) {
    const fetchedScores = new Map();
    if (scoresFile && existsSync(scoresFile)) {
        try {
            const fileContent = readFileSync(scoresFile, 'utf-8').trim();
            const scoresObj = JSON.parse(fileContent);
            for (const [k, v] of Object.entries(scoresObj)) {
                fetchedScores.set(k, v);
            }
        }
        catch (err) {
            console.warn(`Warning: could not parse ${scoresFile}: ${err}`);
        }
        return fetchedScores;
    }
    // Fallback: HTML comment on its own line. Anchored with ^…$ and `m` flag
    // so we never accidentally match a fragment in the markdown table body.
    const scoresMatch = rawInput.match(/^<!-- FETCHED_SCORES: (\{[\s\S]*?\}) -->$/m);
    if (scoresMatch) {
        try {
            const scoresObj = JSON.parse(scoresMatch[1]);
            for (const [k, v] of Object.entries(scoresObj)) {
                fetchedScores.set(k, v);
            }
        }
        catch {
            console.warn('Warning: could not parse FETCHED_SCORES comment');
        }
    }
    return fetchedScores;
}
/**
 * Strip FETCHED_SCORES HTML-comment lines from the stdin text so the remainder
 * is a clean markdown table. No-op when scores came from BENCH_SCORES_FILE.
 */
export function stripFetchedScoresComment(rawInput, scoresFile) {
    if (scoresFile)
        return rawInput;
    return rawInput.replace(/^<!-- FETCHED_SCORES: [\s\S]*? -->$\n?/gm, '');
}
/**
 * Read current models from action.yml for the given target.
 */
function readCurrentModelsFromAction(actionPath, target) {
    const content = readFileSync(actionPath, 'utf-8');
    const pattern = new RegExp(`${target}:\\n\\s+description:[^\\n]*\\n\\s+default:\\s*'([^']*)'`);
    const match = content.match(pattern);
    if (!match)
        return [];
    return match[1].split(',').map(s => s.trim()).filter(s => s !== '');
}
/**
 * Main entry point — reads table from stdin, ranks, updates action.yml.
 * With --two-tier, uses two-tier ranking (known models first, then new by latency).
 */
async function main() {
    const actionPath = process.env.ACTION_PATH || 'action.yml';
    const target = (process.env.ACTION_TARGET || 'nim_models');
    const twoTier = process.argv.includes('--two-tier');
    if (!(target in TARGET_CONFIG)) {
        console.error(`Unknown ACTION_TARGET: '${target}'. Expected 'nim_models', 'mistral_models', 'groq_models', 'openrouter_models', 'kilocode_models', or 'nousresearch_models'.`);
        process.exit(1);
    }
    // Read benchmark table from stdin
    const chunks = [];
    for await (const chunk of process.stdin) {
        chunks.push(chunk);
    }
    const rawInput = Buffer.concat(chunks).toString('utf-8');
    // Extract fetched scores from BENCH_SCORES_FILE (preferred) or stdin comment.
    const scoresFile = process.env.BENCH_SCORES_FILE;
    const fetchedScores = readFetchedScores(rawInput, scoresFile);
    if (fetchedScores.size > 0) {
        const source = scoresFile && existsSync(scoresFile) ? scoresFile : 'stdin comment';
        console.log(`Parsed ${fetchedScores.size} fetched score(s) from ${source}`);
    }
    const table = stripFetchedScoresComment(rawInput, scoresFile);
    if (!table.trim()) {
        console.error('No benchmark output received on stdin');
        process.exit(1);
    }
    const rows = parseMarkdownTable(table);
    if (rows.length === 0) {
        console.warn('No benchmark data rows found — all models may have failed. Skipping reorder.');
        process.exit(0);
    }
    // Extract latencies
    const latencies = {};
    for (const row of rows) {
        if (row.latencyMs !== Infinity && row.latencyMs > 0) {
            latencies[row.model] = row.latencyMs;
        }
    }
    const fetchedScoresMap = fetchedScores.size > 0 ? fetchedScores : undefined;
    let ranked;
    if (twoTier) {
        const knownModels = new Set(readCurrentModelsFromAction(actionPath, target));
        ranked = rankModelsTwoTier(rows, knownModels, latencies, fetchedScoresMap);
        const knownCount = ranked.filter(m => knownModels.has(m)).length;
        const newCount = ranked.length - knownCount;
        console.log(`Two-tier ranking for ${target}: ${knownCount} known + ${newCount} new = ${ranked.length} total`);
    }
    else {
        ranked = rankModels(rows, latencies, fetchedScoresMap);
        console.log(`Model ranking for ${target} (SWE-bench score):`);
    }
    const summaryLines = [
        `\n## Model Ranking (${target})\n`,
        '| # | Model | SWE | Effective | Latency |',
        '|---|-------|-----|-----------|---------|',
    ];
    ranked.forEach((model, index) => {
        const lat = latencies[model] ? `${Math.round(latencies[model])}ms` : 'N/A';
        const swe = getSweBenchScore(model, fetchedScoresMap).toFixed(3);
        const eff = getEffectiveScore(model, latencies, DEFAULT_MAX_LATENCY_MS, fetchedScoresMap).toFixed(3);
        console.log(`  ${model}: SWE=${swe} eff=${eff} lat=${lat}`);
        summaryLines.push(`| ${index + 1} | \`${model}\` | ${swe} | ${eff} | ${lat} |`);
    });
    const summaryPath = process.env.GITHUB_STEP_SUMMARY;
    if (summaryPath) {
        try {
            appendFileSync(summaryPath, summaryLines.join('\n') + '\n');
        }
        catch (err) {
            console.warn(`Warning: could not write to GITHUB_STEP_SUMMARY: ${err}`);
        }
    }
    updateActionYml(actionPath, ranked, target);
    console.log(`\naction.yml updated (${target}) with ${ranked.length} models.`);
}
/**
 * Output new models (not in SWE_BENCH_SCORES) as JSON for the workflow
 * to auto-add with default score 0.5.
 */
export function discoverNewModels(models) {
    return models
        .filter(m => !(m in SWE_BENCH_SCORES))
        .map(m => ({ model: m, score: 0.5 }));
}
/**
 * Insert new model entries into a SWE_BENCH_SCORES table in a source file.
 * Finds the table by marker comment and inserts before the closing brace.
 */
export function patchScoresTable(sourcePath, entries, section) {
    const content = readFileSync(sourcePath, 'utf-8');
    // Section label used to pick the right comment. We match by a STABLE
    // prefix of the table comment (the function-level text uses "(estimated)"
    // while the real table uses "(measured/estimated scores)", so an exact
    // marker equals no table match).
    const sectionPrefix = section === 'kilo'
        ? '// Kilo free-tier models'
        : section === 'openrouter'
            ? '// OpenRouter free-tier models'
            : entries.some(e => e.model.startsWith('kilo-auto/'))
                ? '// Kilo free-tier models'
                : '// OpenRouter free-tier models';
    // Confine the search to the SWE_BENCH_SCORES table so we never match the
    // quoted string literal of the `sectionPrefix` ternary INSIDE this
    // function (that is exactly how stray bare-statement lines used to get
    // spliced into the function body, producing TS1005 on the next build).
    // A leading `//` (after trimming whitespace) identifies a real comment
    // line; the in-function literal `? '// Kilo ...'` trims to `? '//`, i.e.
    // it starts with `?` not `//`, so it is excluded.
    const tableOpenMarker = 'SWE_BENCH_SCORES: Record<string, number> = {';
    const tableStart = content.indexOf(tableOpenMarker);
    if (tableStart === -1)
        return 0;
    // tableEnd: find the closing `};` that terminates the table object. The
    // table is a flat literal, so the first `\n};` at column 0 after the
    // opening is its close.
    const tableEnd = content.indexOf('\n};', tableStart + tableOpenMarker.length);
    if (tableEnd === -1)
        return 0;
    const tableSlice = content.substring(tableStart, tableEnd);
    const tableLines = tableSlice.split('\n');
    let insertLine = -1;
    for (let i = 0; i < tableLines.length; i++) {
        const line = tableLines[i];
        if (line.trimStart().startsWith('//') && line.trimStart().startsWith(sectionPrefix)) {
            insertLine = i;
            break;
        }
    }
    if (insertLine === -1)
        return 0;
    // Insert the new entries right after the section marker comment, before
    // the existing entries of that section.
    const newLines = entries.map(e => `  '${e.model}': ${e.score},`);
    tableLines.splice(insertLine + 1, 0, ...newLines);
    const before = content.substring(0, tableStart);
    const after = content.substring(tableEnd);
    const updated = before + tableLines.join('\n') + after;
    writeFileSync(sourcePath, updated, 'utf-8');
    return newLines.length;
}
// Only run when executed directly
const isMainModule = process.argv[1]?.endsWith('bench-reorder.js');
if (isMainModule) {
    if (process.argv.includes('--discover-new')) {
        const chunks = [];
        for await (const chunk of process.stdin) {
            chunks.push(chunk);
        }
        const rawInput = Buffer.concat(chunks).toString('utf-8');
        const rows = parseMarkdownTable(stripFetchedScoresComment(rawInput, process.env.BENCH_SCORES_FILE));
        const models = rows.map(r => r.model);
        const newEntries = discoverNewModels(models);
        console.log(JSON.stringify(newEntries));
        process.exit(0);
    }
    if (process.argv.includes('--patch-scores')) {
        const srcPath = process.argv[process.argv.indexOf('--patch-scores') + 1];
        const chunks = [];
        for await (const chunk of process.stdin) {
            chunks.push(chunk);
        }
        const newEntries = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        const count = patchScoresTable(srcPath, newEntries);
        console.log(`Added ${count} new model(s) to scores table`);
        process.exit(0);
    }
    main().catch(err => {
        console.error(`Error: ${err.message}`);
        process.exit(1);
    });
}
