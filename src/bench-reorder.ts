/**
 * bench-reorder.ts
 *
 * After a benchmark run, this script:
 * 1. Reads benchmark results from stdin (markdown table from bench-entry.ts)
 * 2. Ranks models by SWE-bench score with latency penalty
 * 3. Updates nim_models in action.yml
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { withRetry } from './retry.js';

export interface SweBenchEntry {
  modelId: string;
  score: number;
  org: string;
}

interface SweBenchApiResponse {
  results: Array<{
    model_id: string;
    score: number;
    organization_id?: string;
  }>;
}

/**
 * Parse SWE-bench API response into sorted entries.
 * Filters to score > 0.5, sorts by score descending, returns top 30.
 */
export function parseSweBenchResponse(data: SweBenchApiResponse): SweBenchEntry[] {
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
export async function fetchSweBenchScores(): Promise<SweBenchEntry[]> {
  const url = process.env.SWE_BENCH_API_URL || 'https://api.zeroeval.com/leaderboard/benchmarks/swe-bench-verified/details';
  try {
    const resp = await withRetry(async () => {
      const r = await fetch(url, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!r.ok) throw new Error(`SWE-bench API returned ${r.status}`);
      return r;
    });

    const data = await resp.json() as SweBenchApiResponse;
    sweBenchFetchFailures = 0;
    return parseSweBenchResponse(data);
  } catch (err) {
    sweBenchFetchFailures++;
    if (sweBenchFetchFailures >= SWE_BENCH_FAIL_WARN_THRESHOLD) {
      process.stderr.write(`\n*** ALERT: SWE-bench API at ${url} has failed ${sweBenchFetchFailures} time(s). Rankings will use fallback scores only. Last error: ${err}\n\n`);
    } else {
      process.stderr.write(`Warning: could not fetch SWE-bench scores from ${url}: ${err}\n`);
    }
    return [];
  }
}

export interface ParsedRow {
  model: string;
  ttftMs: number;
  latencyMs: number;
  tokensPerSec: number;
  errors: number;
}

/**
 * Parse the markdown table output from bench-entry.ts
 */
export function parseMarkdownTable(table: string): ParsedRow[] {
  const lines = table.trim().split('\n');
  const rows: ParsedRow[] = [];

  for (const line of lines) {
    if (!line.startsWith('|') || line.includes('---') || line.includes('Model')) continue;

    const cells = line.split('|').map(c => c.trim()).filter(c => c !== '');
    if (cells.length < 5) continue;

    const model = cells[0].replace(/`/g, '');
    const ttftMs = parseDuration(cells[1]);
    const latencyMs = parseDuration(cells[2]);
    const tokensPerSec = parseFloat(cells[3]) || 0;
    const errors = parseInt(cells[4], 10) || 0;

    rows.push({ model, ttftMs, latencyMs, tokensPerSec, errors });
  }

  return rows;
}

function parseDuration(s: string): number {
  s = s.trim();
  if (s === 'N/A') return Infinity;
  if (s.endsWith('μs')) return parseFloat(s) / 1000;
  if (s.endsWith('ms')) return parseFloat(s);
  if (s.endsWith('s')) return parseFloat(s) * 1000;
  return parseFloat(s) || Infinity;
}

/**
 * Known SWE-bench Verified scores for models available on NIM.
 * Source: https://llm-stats.com/benchmarks/swe-bench-verified
 */
export const SWE_BENCH_SCORES: Record<string, number> = {
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
};

/**
 * Get SWE-bench score for a model. Returns 0.5 (neutral) if unknown.
 * If fetchedScores is provided, checks it before the hardcoded table.
 */
export function getSweBenchScore(model: string, fetchedScores?: Map<string, number>): number {
  return fetchedScores?.get(model) ?? SWE_BENCH_SCORES[model] ?? 0.5;
}

/**
 * Effective score = SWE-bench score × latency multiplier.
 * - Under 60s: no penalty (1.0)
 * - 60-120s: linear penalty (1.0 → 0.7)
 * - Over 120s: heavy penalty (0.5)
 */
export const DEFAULT_MAX_LATENCY_MS = 60_000;

export function getEffectiveScore(model: string, latencies?: Record<string, number>, maxLatencyMs = DEFAULT_MAX_LATENCY_MS, fetchedScores?: Map<string, number>): number {
  const swe = getSweBenchScore(model, fetchedScores);
  if (!latencies || !(model in latencies)) return swe;

  const lat = latencies[model];
  if (lat <= maxLatencyMs) return swe;
  if (lat <= maxLatencyMs * 2) {
    const ratio = (lat - maxLatencyMs) / maxLatencyMs;
    return swe * (1.0 - 0.3 * ratio);
  }
  return swe * 0.5;
}

/**
 * Rank models by effective score (SWE-bench + latency penalty).
 * Only includes models that worked today (tokensPerSec > 0).
 */
export function rankModels(
  rows: ParsedRow[],
  latencies?: Record<string, number>,
  fetchedScores?: Map<string, number>,
): string[] {
  const alive = rows.filter(r => r.tokensPerSec > 0 || r.errors === 0);

  return alive
    .map(r => r.model)
    .sort((a, b) => {
      const effA = getEffectiveScore(a, latencies, DEFAULT_MAX_LATENCY_MS, fetchedScores);
      const effB = getEffectiveScore(b, latencies, DEFAULT_MAX_LATENCY_MS, fetchedScores);
      if (effB !== effA) return effB - effA;
      // Tiebreaker: faster today wins
      const latA = latencies?.[a] ?? Infinity;
      const latB = latencies?.[b] ?? Infinity;
      return latA - latB;
    });
}

type ActionTarget = 'nim_models' | 'mistral_models';

const TARGET_CONFIG: Record<ActionTarget, { pattern: RegExp; label: string }> = {
  nim_models: {
    pattern: /(nim_models:\n\s+description:[^\n]*\n\s+default:\s*')([^']*)(')/,
    label: 'nim_models',
  },
  mistral_models: {
    pattern: /(mistral_models:\n\s+description:[^\n]*\n\s+default:\s*')([^']*)(')/,
    label: 'mistral_models',
  },
};

/**
 * Update action.yml with new model order for the given target.
 */
export function updateActionYml(actionPath: string, orderedModels: string[], target: ActionTarget = 'nim_models'): void {
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
    } else {
      const snippet = content.substring(idx, idx + 200);
      console.warn(`Warning: could not match ${config.label} pattern in ${actionPath}`);
      console.warn(`Content around '${key}':\n${snippet}`);
    }
    return;
  }

  const updated = content.replace(config.pattern, (_, p1: string, _p2: string, p3: string) => p1 + modelString + p3);

  if (updated === content) {
    console.log(`${config.label} models already in desired order, no changes needed`);
    return;
  }

  writeFileSync(actionPath, updated, 'utf-8');
}

export function updateActionYmlMistral(actionPath: string, orderedModels: string[]): void {
  updateActionYml(actionPath, orderedModels, 'mistral_models');
}

/**
 * Read fetched scores from BENCH_SCORES_FILE (preferred) or stdin HTML comment.
 * Returns the parsed scores map (empty if neither source yields a value).
 * Exported for testability.
 */
export function readFetchedScores(
  rawInput: string,
  scoresFile: string | undefined,
): Map<string, number> {
  const fetchedScores = new Map<string, number>();
  if (scoresFile && existsSync(scoresFile)) {
    try {
      const fileContent = readFileSync(scoresFile, 'utf-8').trim();
      const scoresObj = JSON.parse(fileContent) as Record<string, number>;
      for (const [k, v] of Object.entries(scoresObj)) {
        fetchedScores.set(k, v);
      }
    } catch (err) {
      console.warn(`Warning: could not parse ${scoresFile}: ${err}`);
    }
    return fetchedScores;
  }

  // Fallback: HTML comment on its own line. Anchored with ^…$ and `m` flag
  // so we never accidentally match a fragment in the markdown table body.
  const scoresMatch = rawInput.match(/^<!-- FETCHED_SCORES: (\{[\s\S]*?\}) -->$/m);
  if (scoresMatch) {
    try {
      const scoresObj = JSON.parse(scoresMatch[1]) as Record<string, number>;
      for (const [k, v] of Object.entries(scoresObj)) {
        fetchedScores.set(k, v);
      }
    } catch {
      console.warn('Warning: could not parse FETCHED_SCORES comment');
    }
  }
  return fetchedScores;
}

/**
 * Strip FETCHED_SCORES HTML-comment lines from the stdin text so the remainder
 * is a clean markdown table. No-op when scores came from BENCH_SCORES_FILE.
 */
export function stripFetchedScoresComment(rawInput: string, scoresFile: string | undefined): string {
  if (scoresFile) return rawInput;
  return rawInput.replace(/^<!-- FETCHED_SCORES: [\s\S]*? -->$\n?/gm, '');
}

/**
 * Main entry point — reads table from stdin, ranks, updates action.yml.
 */
async function main(): Promise<void> {
  const actionPath = process.env.ACTION_PATH || 'action.yml';
  const target = (process.env.ACTION_TARGET || 'nim_models') as ActionTarget;

  if (!(target in TARGET_CONFIG)) {
    console.error(`Unknown ACTION_TARGET: '${target}'. Expected 'nim_models' or 'mistral_models'.`);
    process.exit(1);
  }

  // Read benchmark table from stdin
  const chunks: Buffer[] = [];
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
    console.error('Could not parse any rows from benchmark output');
    process.exit(1);
  }

  // Extract latencies
  const latencies: Record<string, number> = {};
  for (const row of rows) {
    if (row.latencyMs !== Infinity && row.latencyMs > 0) {
      latencies[row.model] = row.latencyMs;
    }
  }

  const fetchedScoresMap = fetchedScores.size > 0 ? fetchedScores : undefined;
  const ranked = rankModels(rows, latencies, fetchedScoresMap);

  console.log(`Model ranking for ${target} (SWE-bench × latency):`);
  for (const model of ranked) {
    const lat = latencies[model] ? `${Math.round(latencies[model])}ms` : 'N/A';
    const swe = getSweBenchScore(model, fetchedScoresMap).toFixed(3);
    const eff = getEffectiveScore(model, latencies, DEFAULT_MAX_LATENCY_MS, fetchedScoresMap).toFixed(3);
    console.log(`  ${model}: SWE=${swe} eff=${eff} lat=${lat}`);
  }

  updateActionYml(actionPath, ranked, target);
  console.log(`\naction.yml updated (${target}) with ${ranked.length} models.`);
}

// Only run when executed directly
const isMainModule = process.argv[1]?.endsWith('bench-reorder.js');
if (isMainModule) {
  main().catch(err => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}
