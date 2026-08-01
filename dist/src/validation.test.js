import { describe, it } from 'node:test';
import assert from 'node:assert';
import { validateCodeContext, revalidateFindings } from './validation.js';
import { OpenAIClient } from './openai-client.js';
import { startMockServer } from './test-utils.js';
function makeFinding(overrides = {}) {
    return {
        file: 'src/main.ts',
        severity: 'Warning',
        issue: 'test issue',
        critical_action: 'not applicable',
        warning_action: 'investigate',
        suggestion_action: 'not applicable',
        ...overrides,
    };
}
describe('validateCodeContext', () => {
    const diff = `diff --git a/src/main.ts b/src/main.ts
@@ -10,5 +10,7 @@
 import { fetchData } from './api';
+import { processData } from './utils';
+import type { HTTPRequest, RequestConfig } from './types';
 
 function handleRequest() {
   const data = fetchData();
+  const result = processData(data);
 }`;
    it('passes finding with no code references', () => {
        const finding = makeFinding({ issue: 'This function is too complex' });
        const result = validateCodeContext(finding, diff);
        assert.strictEqual(result.valid, true);
    });
    it('passes finding referencing function that exists in diff', () => {
        const finding = makeFinding({ issue: 'The call to `fetchData` may fail without error handling' });
        const result = validateCodeContext(finding, diff);
        assert.strictEqual(result.valid, true);
    });
    it('warns about missing reference instead of dropping finding (dropUnreferenced=false)', () => {
        const finding = makeFinding({ issue: 'The call to `nonexistentFunc` may fail' });
        const result = validateCodeContext(finding, diff, false);
        assert.strictEqual(result.valid, true);
        assert.ok(result.reason?.includes('nonexistentFunc'));
    });
    it('drops finding with missing backtick reference by default (dropUnreferenced=true)', () => {
        const finding = makeFinding({ issue: 'The call to `nonexistentFunc` may fail' });
        const result = validateCodeContext(finding, diff);
        assert.strictEqual(result.valid, false);
        assert.ok(result.reason?.includes('nonexistentFunc'));
    });
    it('drops finding with missing explicit `function X` reference by default', () => {
        const finding = makeFinding({ issue: 'The function nonexistentFunc is broken' });
        const result = validateCodeContext(finding, diff);
        assert.strictEqual(result.valid, false);
        assert.ok(result.reason?.includes('nonexistentFunc'));
    });
    it('passes finding referencing variable that exists in diff', () => {
        const finding = makeFinding({ issue: 'The variable `data` is not validated' });
        const result = validateCodeContext(finding, diff);
        assert.strictEqual(result.valid, true);
    });
    it('drops finding with missing variable reference by default', () => {
        const finding = makeFinding({ issue: 'The variable `unknownVar` is not validated' });
        const result = validateCodeContext(finding, diff);
        assert.strictEqual(result.valid, false);
        assert.ok(result.reason?.includes('unknownVar'));
    });
    it('passes finding referencing class that exists in diff', () => {
        const finding = makeFinding({ issue: 'The class `HTTPRequest` should implement timeout' });
        const result = validateCodeContext(finding, diff);
        assert.strictEqual(result.valid, true);
    });
    it('passes finding referencing type that exists in diff', () => {
        const finding = makeFinding({ issue: 'The type `RequestConfig` is missing retry fields' });
        const result = validateCodeContext(finding, diff);
        assert.strictEqual(result.valid, true);
    });
    it('ignores short names (<=2 chars) to avoid false positives', () => {
        const finding = makeFinding({ issue: 'The function `ab` is not used' });
        const result = validateCodeContext(finding, diff);
        assert.strictEqual(result.valid, true);
    });
    it('drops finding with missing reference in empty diff by default', () => {
        const finding = makeFinding({ issue: 'The call to `processData` may fail' });
        const result = validateCodeContext(finding, '');
        assert.strictEqual(result.valid, false);
        assert.ok(result.reason?.includes('processData'));
    });
    it('warns (but keeps) finding with missing reference in empty diff when dropUnreferenced=false', () => {
        const finding = makeFinding({ issue: 'The call to `processData` may fail' });
        const result = validateCodeContext(finding, '', false);
        assert.strictEqual(result.valid, true);
        assert.ok(result.reason?.includes('processData'));
    });
    // --- Contradicted negative-claim detection --------------------------------
    const diffWithImport = `diff --git a/src/main.ts b/src/main.ts
@@ -1,3 +1,4 @@
 import { fetchData } from './api';
+import { getSweBenchScore } from './bench-reorder.js';
+import { otherThing } from './other.js';
`;
    it('drops finding whose "X is not imported" claim is contradicted by the diff', () => {
        const finding = makeFinding({
            issue: 'The `getSweBenchScore` function is used but not imported or defined in this file.',
        });
        const result = validateCodeContext(finding, diffWithImport);
        assert.strictEqual(result.valid, false);
        assert.ok(result.reason?.includes('getSweBenchScore'));
        assert.ok(result.reason?.includes('contradicted'));
    });
    it('drops finding whose "Missing import for X" claim is contradicted by the diff', () => {
        const finding = makeFinding({
            issue: 'Missing import for `otherThing` — this file uses it without importing.',
        });
        const result = validateCodeContext(finding, diffWithImport);
        assert.strictEqual(result.valid, false);
        assert.ok(result.reason?.includes('otherThing'));
        assert.ok(result.reason?.includes('contradicted'));
    });
    it('keeps contradicted-claim finding as soft warning when dropUnreferenced=false', () => {
        const finding = makeFinding({
            issue: 'The `getSweBenchScore` function is used but not imported or defined in this file.',
        });
        const result = validateCodeContext(finding, diffWithImport, false);
        assert.strictEqual(result.valid, true);
        assert.ok(result.reason?.includes('contradicted'));
    });
    it('does not flag a negative claim when the named identifier is genuinely absent from the diff', () => {
        // The negative-claim check is a no-op when the claimed-missing name is
        // truly absent: "is not defined" matches, but the name isn't in the
        // diff so no contradiction is recorded. (The backtick-ref check will
        // separately warn about the missing name — that's not what we're
        // testing here.) Use a positive-only sentence to isolate the check.
        const finding = makeFinding({
            issue: '`otherThing` is well-named and used consistently throughout.',
        });
        const result = validateCodeContext(finding, diffWithImport);
        assert.strictEqual(result.valid, true);
        assert.strictEqual(result.reason, undefined);
    });
    it('does not flag a sentence with a negative phrase but no backtick identifier', () => {
        // "A function is used but not imported" has the negative pattern but
        // no backtick subject — we can't verify the claim, so we leave it alone.
        const finding = makeFinding({ issue: 'A function is used but not imported here.' });
        const result = validateCodeContext(finding, diffWithImport);
        assert.strictEqual(result.valid, true);
        assert.strictEqual(result.reason, undefined);
    });
    it('does not pair a backtick ref in one sentence with a negative claim in another', () => {
        // Sentence-scoping: backtick `otherThing` is in sentence 1 (no claim).
        // Negative claim is in sentence 2 but has no backtick subject. They
        // must not be paired up.
        const finding = makeFinding({
            issue: '`otherThing` is well-named. A function is not imported in this file.',
        });
        const result = validateCodeContext(finding, diffWithImport);
        assert.strictEqual(result.valid, true);
        assert.strictEqual(result.reason, undefined);
    });
    it('passes finding when issue has no identifiable references', () => {
        const finding = makeFinding({ issue: 'This code could be more readable' });
        const result = validateCodeContext(finding, diff);
        assert.strictEqual(result.valid, true);
    });
});
describe('revalidateFindings', () => {
    const diff = 'diff --git a/src/main.ts b/src/main.ts\n@@ -10,3 +10,5 @@\n old\n+new1\n+new2\n old2\n';
    const findings = [
        { file: 'src/main.ts', severity: 'Warning', issue: 'Missing error handling', critical_action: 'not applicable', warning_action: 'Add try-catch', suggestion_action: 'not applicable', line_start: 11 },
        { file: 'src/main.ts', severity: 'Critical', issue: 'SQL injection in `query` function', critical_action: 'Fix immediately', warning_action: 'not applicable', suggestion_action: 'not applicable', line_start: 12 },
    ];
    it('returns empty when no findings', async () => {
        const mock = await startMockServer((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { content: '[]' } }] }));
        });
        try {
            const client = new OpenAIClient(mock.url, 'key');
            const result = await revalidateFindings([], diff, client, 'test-model');
            assert.strictEqual(result.valid.length, 0);
            assert.strictEqual(result.dropped, 0);
        }
        finally {
            mock.close();
        }
    });
    it('keeps findings confirmed by LLM', async () => {
        const mock = await startMockServer((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { content: '[true, true]' } }] }));
        });
        try {
            const client = new OpenAIClient(mock.url, 'key');
            const result = await revalidateFindings(findings, diff, client, 'test-model');
            assert.strictEqual(result.valid.length, 2);
            assert.strictEqual(result.dropped, 0);
        }
        finally {
            mock.close();
        }
    });
    it('drops findings rejected by LLM', async () => {
        const mock = await startMockServer((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { content: '[false, true]' } }] }));
        });
        try {
            const client = new OpenAIClient(mock.url, 'key');
            const result = await revalidateFindings(findings, diff, client, 'test-model');
            assert.strictEqual(result.valid.length, 1);
            assert.strictEqual(result.dropped, 1);
            assert.strictEqual(result.valid[0].severity, 'Critical');
        }
        finally {
            mock.close();
        }
    });
    it('passes all findings when JSON.parse fails (fallback)', async () => {
        const mock = await startMockServer((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { content: 'not valid json' } }] }));
        });
        try {
            const client = new OpenAIClient(mock.url, 'key');
            const result = await revalidateFindings(findings, diff, client, 'test-model');
            assert.strictEqual(result.valid.length, 2);
            assert.strictEqual(result.dropped, 0);
        }
        finally {
            mock.close();
        }
    });
    it('passes all findings when client.chat throws (fallback)', async () => {
        const mock = await startMockServer((_req, res) => {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not Found' }));
        });
        try {
            const client = new OpenAIClient(mock.url, 'key');
            const result = await revalidateFindings(findings, diff, client, 'test-model');
            assert.strictEqual(result.valid.length, 2);
            assert.strictEqual(result.dropped, 0);
        }
        finally {
            mock.close();
        }
    });
});
describe('revalidateFindings robustness', () => {
    const diff = 'diff --git a/src/main.ts b/src/main.ts\\n@@ -10,3 +10,5 @@\\n old\\n+new1\\n+new2\\n old2\\n';
    it('passes through findings missing from a short boolean array', async () => {
        const mock = await startMockServer((_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { content: '[true]' } }] }));
        });
        try {
            const client = new OpenAIClient(mock.url, 'key');
            const result = await revalidateFindings(findings, diff, client, 'test-model');
            assert.strictEqual(result.valid.length, 2);
            assert.strictEqual(result.dropped, 0);
        }
        finally {
            mock.close();
        }
    });
    it('truncates finding issues to 200 characters in the prompt', async () => {
        let requestBody = '';
        const mock = await startMockServer((req, res) => {
            req.on('data', chunk => requestBody += chunk);
            req.on('end', () => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ choices: [{ message: { content: '[true]' } }] }));
            });
        });
        try {
            const client = new OpenAIClient(mock.url, 'key');
            const issue = 'A'.repeat(250);
            await revalidateFindings([makeFinding({ issue })], diff, client, 'test-model');
            const payload = JSON.parse(requestBody);
            const prompt = payload.messages[1]?.content ?? '';
            assert.ok(prompt.includes('A'.repeat(200)));
            assert.ok(!prompt.includes('A'.repeat(201)));
        }
        finally {
            mock.close();
        }
    });
});
const diff = 'diff --git a/src/main.ts b/src/main.ts\n@@ -10,3 +10,5 @@\n old\n+new1\n+new2\n old2\n';
const findings = [makeFinding({ issue: 'first' }), makeFinding({ issue: 'second' })];
