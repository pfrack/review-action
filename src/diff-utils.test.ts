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

  it('splits into one chunk per hunk for large maxTokens', () => {
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
    const chunks = chunkDiff(diff, 5000);
    assert.strictEqual(chunks.length, 3, 'should produce exactly one chunk per hunk');
    assert.deepStrictEqual(chunks.map(c => c.startLine), [1, 11, 21]);
    assert.ok(chunks[0].content.includes('diff --git'), 'preamble must be in first chunk');
    assert.ok(chunks[0].content.includes('@@ -1,3 +1,4 @@'), 'first chunk keeps its hunk header');
    for (const chunk of chunks) {
      assert.ok(chunk.content.includes('@@'), 'each chunk must include its own hunk header');
    }
  });

  it('splits mid-hunk when maxTokens is tiny', () => {
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
    const chunks = chunkDiff(diff, 1);
    assert.ok(chunks.length > 3, 'tiny maxTokens should force mid-hunk splitting');
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
