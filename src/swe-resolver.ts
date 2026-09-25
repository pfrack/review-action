import { readFileSync, writeFileSync } from 'node:fs';
import { withRetry, RetryableError } from './retry.js';
import { safeParseJsonBody } from './utils.js';
import { deterministicMatch as benchDeterministicMatch } from './bench-entry.js';
import { patchScoresTable } from './bench-reorder.js';
import type { SweBenchEntry } from './bench-reorder.js';

export { patchScoresTable };

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
    if (!r.ok) throw new RetryableError(`SWE-bench API returned ${r.status}`, r.status);
    return r;
  });
  const data = await safeParseJsonBody(resp, 'SWE-bench API') as { models?: Array<{ model_id: string; score: number; organization_id?: string }> };
  return (data.models || [])
    .filter(m => typeof m.score === 'number' && m.model_id)
    .sort((a, b) => b.score - a.score)
    .map(m => ({ modelId: m.model_id, score: m.score, org: m.organization_id || '' }));
}

function deterministicMatch(modelId: string, leaderboard: SweBenchEntry[]): { score: number; strategy: string; matchedId: string } | null {
  return benchDeterministicMatch(modelId, leaderboard);
}

export function resolveScores(
  currentScores: Record<string, number>,
  leaderboard: SweBenchEntry[],
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

  return { resolved, unresolved };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const sourceIdx = args.indexOf('--source');
  const sourcePath = sourceIdx !== -1 ? args[sourceIdx + 1] : 'src/bench-reorder.ts';
  const sectionArg = args.indexOf('--section');
  const section = sectionArg !== -1 ? args[sectionArg + 1] as 'openrouter' | 'kilo' : undefined;

  process.stderr.write(`Fetching leaderboard...\n`);
  const leaderboard = await fetchLeaderboard();
  process.stderr.write(`Leaderboard has ${leaderboard.length} models\n`);

  const content = readFileSync(sourcePath, 'utf-8');
  const scoresMatch = content.match(/export const SWE_BENCH_SCORES[^=]*=\s*(\{[\s\S]*?\});/);
  if (!scoresMatch) {
    console.error('Could not find SWE_BENCH_SCORES table in', sourcePath);
    process.exit(1);
  }

  const currentScores = parseScoresLiteral(scoresMatch[1]);

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
    const count = patchScoresTable(sourcePath, resolved, section);
    process.stderr.write(`\nPatched ${count} score(s) into ${sourcePath}\n`);
  } else {
    process.stderr.write('\nNo scores to patch\n');
  }
}

function parseScoresLiteral(literal: string): Record<string, number> {
  let json = literal
    .replace(/(\s*\/\/[^\n]*)/g, '')
    .replace(/'([^']*)'/g, '"$1"')
    .replace(/,\s*}/g, '}')
    .replace(/,\s*]/g, ']');
  return JSON.parse(json) as Record<string, number>;
}

const isMainModule = process.argv[1]?.endsWith('swe-resolver.js');
if (isMainModule) {
  main().catch(err => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}
