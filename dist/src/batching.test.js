import { describe, it } from 'node:test';
import assert from 'node:assert';
import { batchFiles, mergeFindings } from './batching.js';
function makeFinding(overrides = {}) {
    return {
        file: 'a.ts',
        severity: 'Warning',
        issue: 'test issue',
        critical_action: 'not applicable',
        warning_action: 'investigate',
        suggestion_action: 'not applicable',
        ...overrides,
    };
}
describe('batchFiles', () => {
    it('returns single batch for small file set', () => {
        const filesDiff = {
            'a.ts': 'diff a',
            'b.ts': 'diff b',
        };
        const batches = batchFiles(filesDiff, 50);
        assert.strictEqual(batches.length, 1);
        assert.strictEqual(batches[0].files.length, 2);
        assert.ok(batches[0].files.includes('a.ts'));
        assert.ok(batches[0].files.includes('b.ts'));
    });
    it('splits into multiple batches when exceeding batch size', () => {
        const filesDiff = {};
        for (let i = 0; i < 120; i++) {
            filesDiff[`file${i}.ts`] = `diff ${i}`;
        }
        const batches = batchFiles(filesDiff, 50);
        assert.strictEqual(batches.length, 3);
        assert.strictEqual(batches[0].files.length, 50);
        assert.strictEqual(batches[1].files.length, 50);
        assert.strictEqual(batches[2].files.length, 20);
    });
    it('returns empty array for empty input', () => {
        const batches = batchFiles({}, 50);
        assert.strictEqual(batches.length, 0);
    });
    it('preserves file-diff associations', () => {
        const filesDiff = {
            'a.ts': 'diff a',
            'b.ts': 'diff b',
        };
        const batches = batchFiles(filesDiff, 50);
        assert.strictEqual(batches[0].diffs['a.ts'], 'diff a');
        assert.strictEqual(batches[0].diffs['b.ts'], 'diff b');
    });
    it('sorts files deterministically', () => {
        const filesDiff = {
            'z.ts': 'diff z',
            'a.ts': 'diff a',
            'm.ts': 'diff m',
        };
        const batches = batchFiles(filesDiff, 50);
        assert.deepStrictEqual(batches[0].files, ['a.ts', 'm.ts', 'z.ts']);
    });
});
describe('mergeFindings', () => {
    it('merges findings from multiple batches', () => {
        const results = [
            { findings: [makeFinding({ file: 'a.ts', issue: 'x' }), makeFinding({ file: 'b.ts', issue: 'y' })] },
            { findings: [makeFinding({ file: 'c.ts', issue: 'z' })] },
        ];
        const merged = mergeFindings(results);
        assert.strictEqual(merged.findings.length, 3);
    });
    it('deduplicates findings by file+line', () => {
        const results = [
            { findings: [makeFinding({ file: 'a.ts', line_start: 10, issue: 'x' })] },
            { findings: [makeFinding({ file: 'a.ts', line_start: 10, issue: 'x' })] },
        ];
        const merged = mergeFindings(results);
        assert.strictEqual(merged.findings.length, 1);
    });
    it('keeps distinct findings on same file', () => {
        const results = [
            { findings: [makeFinding({ file: 'a.ts', line_start: 10, issue: 'x' })] },
            { findings: [makeFinding({ file: 'a.ts', line_start: 20, issue: 'y' })] },
        ];
        const merged = mergeFindings(results);
        assert.strictEqual(merged.findings.length, 2);
    });
    it('concatenates summaries from all batches', () => {
        const results = [
            { findings: [], summary: 'Summary 1' },
            { findings: [], summary: 'Summary 2' },
        ];
        const merged = mergeFindings(results);
        assert.strictEqual(merged.summary, 'Summary 1\n\nSummary 2');
    });
    it('handles empty results', () => {
        const merged = mergeFindings([]);
        assert.strictEqual(merged.findings.length, 0);
        assert.strictEqual(merged.summary, null);
    });
});
