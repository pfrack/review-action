import { describe, it } from 'node:test';
import assert from 'node:assert';
import { formatMetrics } from './metrics.js';
function makeMetrics(overrides = {}) {
    return {
        pr_number: 1,
        model_used: 'test-model',
        findings_count: { critical: 0, warning: 0, suggestion: 0 },
        files_reviewed: 10,
        review_duration_ms: 5000,
        validation_dropped: 0,
        batch_count: 1,
        ...overrides,
    };
}
describe('formatMetrics', () => {
    it('formats basic metrics', () => {
        const output = formatMetrics(makeMetrics());
        assert.ok(output.includes('## Review Metrics'));
        assert.ok(output.includes('test-model'));
        assert.ok(output.includes('10'));
        assert.ok(output.includes('5.0s'));
    });
    it('formats severity breakdown', () => {
        const metrics = makeMetrics({
            findings_count: { critical: 2, warning: 5, suggestion: 3 },
        });
        const output = formatMetrics(metrics);
        assert.ok(output.includes('2'));
        assert.ok(output.includes('5'));
        assert.ok(output.includes('3'));
        assert.ok(output.includes('Critical'));
        assert.ok(output.includes('Warning'));
        assert.ok(output.includes('Suggestion'));
    });
    it('shows validation stats when dropped > 0', () => {
        const output = formatMetrics(makeMetrics({ validation_dropped: 3 }));
        assert.ok(output.includes('3 finding(s) dropped'));
    });
    it('hides validation stats when dropped = 0', () => {
        const output = formatMetrics(makeMetrics({ validation_dropped: 0 }));
        assert.ok(!output.includes('dropped'));
    });
    it('shows batching stats when batch_count > 1', () => {
        const output = formatMetrics(makeMetrics({ batch_count: 3, files_reviewed: 150 }));
        assert.ok(output.includes('3 batches'));
        assert.ok(output.includes('50 files/batch'));
    });
    it('hides batching stats when batch_count = 1', () => {
        const output = formatMetrics(makeMetrics({ batch_count: 1 }));
        assert.ok(!output.includes('batches'));
    });
    it('formats zero duration as N/A', () => {
        const output = formatMetrics(makeMetrics({ review_duration_ms: 0 }));
        assert.ok(output.includes('N/A'));
    });
    it('formats total findings correctly', () => {
        const metrics = makeMetrics({
            findings_count: { critical: 1, warning: 2, suggestion: 3 },
        });
        const output = formatMetrics(metrics);
        assert.ok(output.includes('6'));
    });
});
