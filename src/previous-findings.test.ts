import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatPreviousFindings } from './previous-findings.js';
import type { ReviewThreadNode } from './github-graphql.js';

function mkThread(overrides: Partial<ReviewThreadNode> = {}): ReviewThreadNode {
  return {
    id: 'PRRT_x',
    isResolved: false,
    isOutdated: false,
    path: 'src/a.ts',
    line: 10,
    body: 'hello world',
    ...overrides,
  };
}

test('formatPreviousFindings: returns empty string when given no threads', () => {
  assert.equal(formatPreviousFindings([]), '');
});

test('formatPreviousFindings: returns empty string when all threads are already resolved', () => {
  const threads = [
    mkThread({ isResolved: true }),
    mkThread({ id: 'PRRT_y', isResolved: true }),
  ];
  assert.equal(formatPreviousFindings(threads), '');
});

test('formatPreviousFindings: emits one line per unresolved thread with path:line and body', () => {
  const threads = [
    mkThread({ id: 'PRRT_1', path: 'src/auth.ts', line: 42, body: 'missing null check' }),
    mkThread({ id: 'PRRT_2', path: 'src/auth.ts', line: 87, body: 'use bcrypt' }),
  ];
  const out = formatPreviousFindings(threads);
  assert.match(out, /- src\/auth\.ts:42 — missing null check/);
  assert.match(out, /- src\/auth\.ts:87 — use bcrypt/);
});

test('formatPreviousFindings: emits path only when line is null', () => {
  const out = formatPreviousFindings([mkThread({ line: null, path: 'src/x.ts' })]);
  assert.match(out, /^- src\/x\.ts — /);
});

test('formatPreviousFindings: escapes markdown-special characters in body', () => {
  const out = formatPreviousFindings([
    mkThread({ body: 'has *star* and _under_ and `backtick`' }),
  ]);
  // Star and underscore should be backslash-escaped (literal `\*`, `\_`).
  assert.ok(out.includes('\\*star\\*'), 'stars should be backslash-escaped');
  assert.ok(out.includes('\\_under\\_'), 'underscores should be backslash-escaped');
  // Backtick should be backslash-escaped (literal `\``).
  assert.ok(out.includes('\\`backtick\\`'), 'backticks should be backslash-escaped');
  // No raw (unescaped) backticks in the output.
  const rawBacktickCount = (out.match(/(^|[^\\])`/g) || []).length;
  assert.equal(rawBacktickCount, 0);
});

test('formatPreviousFindings: collapses whitespace in body to single spaces', () => {
  const out = formatPreviousFindings([
    mkThread({ body: 'line1\nline2\n\nline3' }),
  ]);
  assert.match(out, /line1 line2 line3/);
});

test('formatPreviousFindings: truncates at the thread cap with the marker', () => {
  const threads = Array.from({ length: 25 }, (_, i) =>
    mkThread({ id: `PRRT_${i}`, body: `finding ${i}` }),
  );
  const out = formatPreviousFindings(threads, 10);
  const lines = out.split('\n').filter((l) => l.startsWith('- '));
  assert.equal(lines.length, 10);
  assert.match(out, /\[truncated: \d+ more previous findings omitted\]/);
});

test('formatPreviousFindings: truncates at the char cap with the marker when multiple threads exceed it together', () => {
  // Three threads whose combined length exceeds 1500 chars; each is
  // short enough to fit individually, so the first one or two should
  // land and the rest get truncated with the marker.
  const threads = [
    mkThread({ id: 'PRRT_a', body: 'a'.repeat(400) }),
    mkThread({ id: 'PRRT_b', body: 'b'.repeat(400) }),
    mkThread({ id: 'PRRT_c', body: 'c'.repeat(400) }),
    mkThread({ id: 'PRRT_d', body: 'd'.repeat(400) }),
  ];
  const out = formatPreviousFindings(threads, 100, 1500);
  assert.ok(out.length <= 1500, `output length ${out.length} exceeded cap 1500`);
  assert.match(out, /\[truncated: \d+ more previous findings omitted\]/);
});

test('formatPreviousFindings: returns empty when a single thread exceeds the char cap entirely', () => {
  const out = formatPreviousFindings(
    [mkThread({ body: 'x'.repeat(2000) })],
    100,
    1500,
  );
  assert.equal(out, '');
});

test('formatPreviousFindings: keeps order (unresolved threads come back in API order)', () => {
  const threads = [
    mkThread({ id: 'PRRT_first', body: 'first' }),
    mkThread({ id: 'PRRT_second', body: 'second' }),
    mkThread({ id: 'PRRT_third', body: 'third' }),
  ];
  const out = formatPreviousFindings(threads);
  const firstIdx = out.indexOf('first');
  const secondIdx = out.indexOf('second');
  const thirdIdx = out.indexOf('third');
  assert.ok(firstIdx >= 0 && secondIdx > firstIdx && thirdIdx > secondIdx);
});

test('formatPreviousFindings: returns empty when input is not an array', () => {
  assert.equal(formatPreviousFindings(null as unknown as ReviewThreadNode[]), '');
  assert.equal(formatPreviousFindings(undefined as unknown as ReviewThreadNode[]), '');
});