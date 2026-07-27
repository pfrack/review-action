import { readFileSync, writeFileSync } from 'node:fs';
import { withRetry } from './retry.js';
import { normalizeModelId } from './bench-entry.js';
import type { SweBenchEntry } from './bench-reorder.js';

interface ResolvedScore {
  model: string;
  score: number;
  strategy: 'exact' | 'normalized' | 'substring' | 'llm';
}

interface UnresolvedModel {
  model: string;
  reason: 'not_found' | 'ambiguous' | 'api_error';
}

interface ResolveResult {
  resolved: ResolvedScore[];
  unresolved: UnresolvedModel[];
}

const SWE_BENCH_API_URL = 'https://api.zeroeval.com/leaderboard/benchmarks/swe-bench-verified/details';

export async function fetchLeaderboard(): Promise<SweBenchEntry[]> {
  const url = process.env.SWE_BENCH_API_URL || SWE_BENCH_API_URL;
  const resp = await withRetry(async () => {
    const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`SWE-bench API returned ${r.status}`);
    return r;
  });
  const data = await resp.json() as { models?: Array<{ model_id: string; score: number; organization_id?: string }> };
  return (data.models || [])
    .filter(m => m.score > 0.5)
    .sort((a, b) => b.score - a.score)
    .map(m => ({ modelId: m.model_id, score: m.score, org: m.organization_id || '' }));
}

function deterministicMatch(modelId: string, leaderboard: SweBenchEntry[]): { score: number; strategy: string; matchedId: string } | null {
  const lc = modelId.toLowerCase();

  const exact = leaderboard.find(e => e.modelId === modelId);
  if (exact) return { score: exact.score, strategy: 'exact', matchedId: exact.modelId };

  const ci = leaderboard.find(e => e.modelId.toLowerCase() === lc);
  if (ci) return { score: ci.score, strategy: 'case-insensitive', matchedId: ci.modelId };

  const norm = normalizeModelId(modelId);
  const normMatches = leaderboard.filter(e => normalizeModelId(e.modelId) === norm);
  if (normMatches.length === 1) {
    return { score: normMatches[0].score, strategy: 'normalized', matchedId: normMatches[0].modelId };
  }

  return null;
}

export function resolveScores(
  currentScores: Record<string, number>,
  leaderboard: SweBenchEntry[],
  options: { llmClient?: undefined; matcherModel?: string } = {},
): ResolveResult {
  const resolved: ResolvedScore[] = [];
  const unresolved: UnresolvedModel[] = [];

  const modelsAtDefault = Object.entries(currentScores)
    .filter(([, score]) => score === 0.5)
    .map(([model]) => model);

  for (const model of modelsAtDefault) {
    const match = deterministicMatch(model, leaderboard);
    if (match) {
      resolved.push({ model, score: match.score, strategy: match.strategy as ResolvedScore['strategy'] });
      process.stderr.write(`  ${model} → ${match.matchedId} (${match.strategy}) score=${match.score}\n`);
    } else {
      unresolved.push({ model, reason: 'not_found' });
      process.stderr.write(`  ${model} → not found on leaderboard\n`);
    }
  }

  void options.matcherModel;
  return { resolved, unresolved };
}

export function patchScoresTable(sourcePath: string, entries: { model: string; score: number }[]): number {
  const content = readFileSync(sourcePath, 'utf-8');
  const marker = entries.some(e => e.model.startsWith('kilo-auto/'))
    ? '// Kilo free-tier models (estimated scores)'
    : '// OpenRouter free-tier models (estimated scores)';
  const idx = content.indexOf(marker);
  if (idx === -1) return 0;

  const before = content.substring(0, idx);
  const after = content.substring(idx);
  const lines = after.split('\n');
  let insertLine = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('  //') || lines[i].startsWith('  \'')) {
      insertLine = i;
      break;
    }
  }

  const newLines = entries.map(e => `  '${e.model}': ${e.score},`);
  lines.splice(insertLine, 0, ...newLines);
  const updated = before + lines.join('\n');
  writeFileSync(sourcePath, updated, 'utf-8');
  return newLines.length;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const sourceIdx = args.indexOf('--source');
  const sourcePath = sourceIdx !== -1 ? args[sourceIdx + 1] : 'src/bench-reorder.ts';

  process.stderr.write(`Fetching leaderboard...\n`);
  const leaderboard = await fetchLeaderboard();
  process.stderr.write(`Leaderboard has ${leaderboard.length} models\n`);

  const content = readFileSync(sourcePath, 'utf-8');
  const scoresMatch = content.match(/export const SWE_BENCH_SCORES[^=]*=\s*(\{[\s\S]*?\});/);
  if (!scoresMatch) {
    console.error('Could not find SWE_BENCH_SCORES table in', sourcePath);
    process.exit(1);
  }

  const currentScores = eval('(' + scoresMatch[1] + ')') as Record<string, number>;

  const { resolved, unresolved } = resolveScores(currentScores, leaderboard);

  process.stderr.write(`\nResolved: ${resolved.length}\n`);
  process.stderr.write(`Unresolved: ${unresolved.length}\n`);

  if (resolved.length > 0) {
    process.stderr.write('\nResolved scores:\n');
    for (const r of resolved) {
      process.stderr.write(`  ${r.model}: ${r.score} (${r.strategy})\n`);
    }
  }

  if (unresolved.length > 0) {
    process.stderr.write('\nUnresolved (kept at 0.5):\n');
    for (const u of unresolved) {
      process.stderr.write(`  ${u.model} (${u.reason})\n`);
    }
  }

  if (dryRun) {
    process.stderr.write('\n--dry-run: no changes made\n');
    process.exit(0);
  }

  if (resolved.length > 0) {
    const count = patchScoresTable(sourcePath, resolved);
    process.stderr.write(`\nPatched ${count} score(s) into ${sourcePath}\n`);
  } else {
    process.stderr.write('\nNo scores to patch\n');
  }
}

const isMainModule = process.argv[1]?.endsWith('swe-resolver.js');
if (isMainModule) {
  main().catch(err => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}
