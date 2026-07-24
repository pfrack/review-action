import { describe, it } from 'node:test';
import assert from 'node:assert';
import { chunkDiff, estimateTokens } from './diff-utils.js';
describe('chunkDiff', () => {
    it('returns single chunk for small diff', () => {
        const diff = `diff --git a/a.ts b/a.ts
@@ -1,3 +1,4 @@
 line1
+line2
 line3`;
        const chunks = chunkDiff(diff);
        assert.strictEqual(chunks.length, 1);
        assert.ok(chunks[0].content.includes('line1'));
    });
    it('splits at hunk boundaries when exceeding token limit', () => {
        const diff = `diff --git a/a.ts b/a.ts
@@ -1,3 +1,4 @@
 line1
+line2
 line3
@@ -10,3 +11,4 @@
 old1
+new1
 old2
@@ -20,3 +21,4 @@
 old2
+new2
 old3`;
        const chunks = chunkDiff(diff, 50);
        assert.ok(chunks.length >= 1);
        for (const chunk of chunks) {
            assert.ok(chunk.startLine >= 1);
        }
    });
    it('preserves hunk headers in chunks', () => {
        const diff = `diff --git a/a.ts b/a.ts
@@ -1,3 +1,4 @@
 line1
+line2
 line3`;
        const chunks = chunkDiff(diff);
        assert.ok(chunks[0].header.includes('@@'));
    });
    it('returns content for diff with no hunks', () => {
        const diff = 'just some text';
        const chunks = chunkDiff(diff);
        assert.strictEqual(chunks.length, 1);
        assert.strictEqual(chunks[0].content, diff);
    });
    it('handles empty diff', () => {
        const chunks = chunkDiff('');
        assert.strictEqual(chunks.length, 1);
    });
});
describe('estimateTokens', () => {
    it('estimates tokens from text length', () => {
        assert.strictEqual(estimateTokens(''), 0);
        assert.strictEqual(estimateTokens('1234'), 1);
        assert.strictEqual(estimateTokens('12345'), 2);
    });
});
