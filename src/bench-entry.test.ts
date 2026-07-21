import { describe, it } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deterministicMatch } from './bench-entry.js';
import type { SweBenchEntry } from './bench-reorder.js';

const LEADERBOARD: SweBenchEntry[] = [
  { modelId: 'deepseek-ai/deepseek-v4-pro', score: 0.806, org: 'deepseek' },
  { modelId: 'meta/llama-3.3-70b-instruct', score: 0.62, org: 'meta' },
  { modelId: 'mistralai/mistral-large-3-675b-instruct-2512', score: 0.72, org: 'mistralai' },
  { modelId: 'nvidia/llama-3.3-nemotron-super-49b-v1.5', score: 0.66, org: 'nvidia' },
  { modelId: 'nvidia/nemotron-3-super-120b-a12b', score: 0.68, org: 'nvidia' },
];

describe('deterministicMatch', () => {
  it('matches exact model id', () => {
    const r = deterministicMatch('deepseek-ai/deepseek-v4-pro', LEADERBOARD);
    assert.ok(r);
    assert.strictEqual(r!.strategy, 'exact');
    assert.strictEqual(r!.matchedId, 'deepseek-ai/deepseek-v4-pro');
    assert.strictEqual(r!.score, 0.806);
  });

  it('matches case-insensitively', () => {
    const r = deterministicMatch('DeepSeek-AI/DeepSeek-V4-Pro', LEADERBOARD);
    assert.ok(r);
    assert.strictEqual(r!.strategy, 'case-insensitive');
    assert.strictEqual(r!.matchedId, 'deepseek-ai/deepseek-v4-pro');
  });

  it('matches by normalized id (strip org + instruct suffix)', () => {
    const r = deterministicMatch('meta/llama-3.3-70b', LEADERBOARD);
    assert.ok(r);
    assert.strictEqual(r!.strategy, 'normalized');
    assert.strictEqual(r!.matchedId, 'meta/llama-3.3-70b-instruct');
    assert.strictEqual(r!.score, 0.62);
  });

  it('matches by unique substring on normalized id', () => {
    const r = deterministicMatch('deepseek-v4', LEADERBOARD);
    assert.ok(r);
    assert.strictEqual(r!.strategy, 'substring');
    assert.strictEqual(r!.matchedId, 'deepseek-ai/deepseek-v4-pro');
  });

  it('returns null when no match is plausible', () => {
    const r = deterministicMatch('totally-unrelated/x', LEADERBOARD);
    assert.strictEqual(r, null);
  });

  it('returns null when substring match is ambiguous', () => {
    // "nemotron" appears in two leaderboard entries
    const r = deterministicMatch('nemotron', LEADERBOARD);
    assert.strictEqual(r, null);
  });

  it('strips trailing -it suffix', () => {
    const r = deterministicMatch('meta/llama-3.3-70b-it', LEADERBOARD);
    assert.ok(r);
    assert.strictEqual(r!.matchedId, 'meta/llama-3.3-70b-instruct');
  });
});

describe('BENCH_SCORES_FILE IPC (producer/consumer)', () => {
  // Simulate the producer side of bench-entry.ts:
  //   writeFileSync(scoresFile, JSON.stringify(scores) + '\n')
  // And the consumer side of bench-reorder.ts:
  //   readFileSync(scoresFile, 'utf-8').trim() -> JSON.parse

  it('round-trips scores through a file', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'bench-scores-ipc-'));
    try {
      const scoresFile = join(tmpDir, 'scores.json');
      const scores = { 'new-vendor/new-model': 0.75, 'another/vendor': 0.8 };
      writeFileSync(scoresFile, JSON.stringify(scores) + '\n', 'utf-8');

      const raw = readFileSync(scoresFile, 'utf-8').trim();
      const parsed = JSON.parse(raw) as Record<string, number>;

      assert.deepStrictEqual(parsed, scores);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('handles empty scores object', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'bench-scores-ipc-'));
    try {
      const scoresFile = join(tmpDir, 'scores.json');
      writeFileSync(scoresFile, JSON.stringify({}) + '\n', 'utf-8');

      const parsed = JSON.parse(readFileSync(scoresFile, 'utf-8').trim()) as Record<string, number>;
      assert.deepStrictEqual(parsed, {});
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});