import { describe, it } from 'node:test';
import assert from 'node:assert';
import { resolveScores, patchScoresTable } from './swe-resolver.js';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const LEADERBOARD = [
    { modelId: 'nemotron-3-super-120b-a12b', score: 0.5373, org: 'nvidia' },
    { modelId: 'nemotron-3-ultra-550b-a55b', score: 0.707, org: 'nvidia' },
    { modelId: 'step-3.5-flash', score: 0.744, org: 'stepfun' },
    { modelId: 'deepseek-v4-pro-max', score: 0.806, org: 'deepseek' },
];
describe('resolveScores', () => {
    it('resolves models at 0.5 via normalized match', () => {
        const currentScores = {
            'nvidia/nemotron-3-super-120b-a12b:free': 0.5,
            'nvidia/nemotron-3-ultra-550b-a55b:free': 0.5,
            'inclusionai/ling-3.0-flash:free': 0.5,
        };
        const { resolved, unresolved } = resolveScores(currentScores, LEADERBOARD);
        assert.strictEqual(resolved.length, 2);
        assert.ok(resolved.find(r => r.model === 'nvidia/nemotron-3-super-120b-a12b:free' && r.score === 0.5373));
        assert.ok(resolved.find(r => r.model === 'nvidia/nemotron-3-ultra-550b-a55b:free' && r.score === 0.707));
        assert.strictEqual(unresolved.length, 1);
        assert.strictEqual(unresolved[0].model, 'inclusionai/ling-3.0-flash:free');
    });
    it('does not resolve models already above 0.5', () => {
        const currentScores = {
            'deepseek-ai/deepseek-v4-pro': 0.806,
        };
        const { resolved, unresolved } = resolveScores(currentScores, LEADERBOARD);
        assert.strictEqual(resolved.length, 0);
        assert.strictEqual(unresolved.length, 0);
    });
    it('returns empty for empty scores', () => {
        const { resolved, unresolved } = resolveScores({}, LEADERBOARD);
        assert.strictEqual(resolved.length, 0);
        assert.strictEqual(unresolved.length, 0);
    });
});
describe('patchScoresTable', () => {
    it('inserts resolved scores into a source file', () => {
        const tmpDir = mkdtempSync(join(tmpdir(), 'resolver-test-'));
        try {
            const srcPath = join(tmpDir, 'test.ts');
            const content = `export const SWE_BENCH_SCORES: Record<string, number> = {
  'deepseek-ai/deepseek-v4-pro': 0.806,
  // OpenRouter free-tier models (estimated scores)
  'deepseek/deepseek-r1:free': 0.65,
};`;
            writeFileSync(srcPath, content, 'utf-8');
            const count = patchScoresTable(srcPath, [
                { model: 'new/model:free', score: 0.707 },
            ]);
            assert.strictEqual(count, 1);
            const result = readFileSync(srcPath, 'utf-8');
            assert.ok(result.includes("'new/model:free': 0.707"));
            assert.ok(result.includes("'deepseek/deepseek-r1:free': 0.65"));
        }
        finally {
            rmSync(tmpDir, { recursive: true, force: true });
        }
    });
    it('returns 0 when marker not found', () => {
        const tmpDir = mkdtempSync(join(tmpdir(), 'resolver-test-'));
        try {
            const srcPath = join(tmpDir, 'test.ts');
            writeFileSync(srcPath, 'const x = {};', 'utf-8');
            const count = patchScoresTable(srcPath, [{ model: 'a/b', score: 0.5 }]);
            assert.strictEqual(count, 0);
        }
        finally {
            rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});
