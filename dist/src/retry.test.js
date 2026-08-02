import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseRetryAfter } from './openai-client.js';
import { RetryableError, getRetryDelay, withRetry } from './retry.js';
describe('Retry-After', () => {
    it('parses integer seconds', () => {
        assert.strictEqual(parseRetryAfter('3'), 3000);
    });
    it('parses an HTTP-date relative to the current time', () => {
        const now = Date.parse('Sat, 25 Jul 2026 07:00:00 GMT');
        const retryAt = new Date(now + 5000).toUTCString();
        assert.strictEqual(parseRetryAfter(retryAt, now), 5000);
    });
    it('returns undefined for malformed values', () => {
        assert.strictEqual(parseRetryAfter('not-a-delay'), undefined);
    });
});
describe('getRetryDelay', () => {
    it('uses retryAfterMs when it exceeds exponential backoff (within jitter range)', () => {
        const error = new RetryableError('rate limited', 429, 5000);
        const delay = getRetryDelay(error, 0, 1000);
        assert.ok(delay >= 5000 && delay <= 6000, `expected delay in [5000, 6000], got ${delay}`);
    });
    it('caps retryAfterMs at 60 seconds', () => {
        const error = new RetryableError('rate limited', 429, 120_000);
        const delay = getRetryDelay(error, 0, 1000);
        assert.ok(delay >= 60000 && delay <= 61000, `expected delay in [60000, 61000], got ${delay}`);
    });
    it('returns a value within [base + 0.5x, base + 1.5x] range with symmetric jitter', () => {
        const error = new RetryableError('server error', 500);
        for (let i = 0; i < 10; i++) {
            const delay = getRetryDelay(error, 0, 1000);
            assert.ok(delay >= 1500 && delay <= 2500, `expected delay in [1500, 2500], got ${delay}`);
        }
    });
    it('jitter scales with attempt using symmetric range', () => {
        const error = new RetryableError('rate limited', 429);
        for (let i = 0; i < 10; i++) {
            const delay = getRetryDelay(error, 1, 1000);
            assert.ok(delay >= 2500 && delay <= 3500, `expected delay in [2500, 3500], got ${delay}`);
        }
    });
});
describe('withRetry', () => {
    it('retries on RetryableError with status 500', async () => {
        let attempts = 0;
        const result = await withRetry(() => {
            attempts++;
            if (attempts === 1)
                throw new RetryableError('internal error', 500);
            return Promise.resolve('success');
        }, 2, 1);
        assert.strictEqual(result, 'success');
        assert.strictEqual(attempts, 2);
    });
    it('retries on RetryableError with status 429', async () => {
        let attempts = 0;
        const result = await withRetry(() => {
            attempts++;
            if (attempts === 1)
                throw new RetryableError('rate limited', 429);
            return Promise.resolve('success');
        }, 2, 1);
        assert.strictEqual(result, 'success');
        assert.strictEqual(attempts, 2);
    });
    it('does not retry on RetryableError with status 400', async () => {
        let attempts = 0;
        await assert.rejects(() => withRetry(() => {
            attempts++;
            throw new RetryableError('bad request', 400);
        }, 2, 1), (err) => err instanceof RetryableError && err.status === 400);
        assert.strictEqual(attempts, 1);
    });
    it('retries on TypeError (network error)', async () => {
        let attempts = 0;
        const result = await withRetry(() => {
            attempts++;
            if (attempts === 1)
                throw new TypeError('fetch failed');
            return Promise.resolve('success');
        }, 2, 1);
        assert.strictEqual(result, 'success');
        assert.strictEqual(attempts, 2);
    });
    it('retries up to maxRetries then gives up', async () => {
        let attempts = 0;
        await assert.rejects(() => withRetry(() => {
            attempts++;
            throw new RetryableError('server error', 503);
        }, 2, 1), (err) => err instanceof RetryableError && err.status === 503);
        assert.strictEqual(attempts, 3);
    });
});
