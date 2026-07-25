import { describe, it } from 'node:test';
import assert from 'node:assert';
import { withAggregateTimeout } from './index.js';
describe('withAggregateTimeout', () => {
    it('returns null when the model chain exceeds the configured duration', async () => {
        const started = Date.now();
        const result = await withAggregateTimeout(() => new Promise(resolve => setTimeout(() => resolve('late'), 50)), 5);
        assert.strictEqual(result, null);
        assert.ok(Date.now() - started < 40);
    });
    it('returns the chain result before the timeout', async () => {
        const result = await withAggregateTimeout(() => Promise.resolve('success'), 100);
        assert.strictEqual(result, 'success');
    });
});
