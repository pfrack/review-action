import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createServer } from 'node:http';
import { validateCodeContext, revalidateFindings } from './validation.js';
import { OpenAIClient } from './openai-client.js';
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
    it('warns about missing reference instead of dropping finding', () => {
        const finding = makeFinding({ issue: 'The call to `nonexistentFunc` may fail' });
        const result = validateCodeContext(finding, diff);
        assert.strictEqual(result.valid, true);
        assert.ok(result.reason?.includes('nonexistentFunc'));
    });
    it('passes finding referencing variable that exists in diff', () => {
        const finding = makeFinding({ issue: 'The variable `data` is not validated' });
        const result = validateCodeContext(finding, diff);
        assert.strictEqual(result.valid, true);
    });
    it('warns about missing variable reference instead of dropping finding', () => {
        const finding = makeFinding({ issue: 'The variable `unknownVar` is not validated' });
        const result = validateCodeContext(finding, diff);
        assert.strictEqual(result.valid, true);
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
    it('warns about missing reference with empty diff but keeps finding', () => {
        const finding = makeFinding({ issue: 'The call to `processData` may fail' });
        const result = validateCodeContext(finding, '');
        assert.strictEqual(result.valid, true);
        assert.ok(result.reason?.includes('processData'));
    });
    it('passes finding when issue has no identifiable references', () => {
        const finding = makeFinding({ issue: 'This code could be more readable' });
        const result = validateCodeContext(finding, diff);
        assert.strictEqual(result.valid, true);
    });
});
function startMockServer(handler) {
    return new Promise((resolve) => {
        const server = createServer(handler);
        server.unref();
        server.listen(0, () => {
            const addr = server.address();
            const port = typeof addr === 'string' ? 0 : addr.port;
            resolve({ url: `http://localhost:${port}`, close: () => server.close() });
        });
    });
}
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
