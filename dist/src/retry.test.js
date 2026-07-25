import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseRetryAfter } from './openai-client.js';
import { RetryableError, getRetryDelay } from './retry.js';
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
    it('uses retryAfterMs when it exceeds exponential backoff', () => {
        const error = new RetryableError('rate limited', 429, 5000);
        assert.strictEqual(getRetryDelay(error, 0, 1000), 5000);
    });
    it('caps retryAfterMs at 60 seconds', () => {
        const error = new RetryableError('rate limited', 429, 120_000);
        assert.strictEqual(getRetryDelay(error, 0, 1000), 60_000);
    });
});
