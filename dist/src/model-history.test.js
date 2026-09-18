import { describe, it } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadHistory, saveHistory, detectNewModels, detectRemovedModels, updateHistory } from './model-history.js';
describe('loadHistory', () => {
    it('returns empty object when file does not exist', () => {
        const result = loadHistory('/nonexistent/path/history.json');
        assert.deepStrictEqual(result, {});
    });
    it('parses valid JSON file', () => {
        const tmpDir = mkdtempSync(join(tmpdir(), 'history-test-'));
        try {
            const path = join(tmpDir, 'history.json');
            const data = { nim: { models: ['model-a', 'model-b'] } };
            saveHistory(data, path);
            const result = loadHistory(path);
            assert.deepStrictEqual(result, data);
        }
        finally {
            rmSync(tmpDir, { recursive: true, force: true });
        }
    });
    it('returns empty object for empty file', () => {
        const tmpDir = mkdtempSync(join(tmpdir(), 'history-test-'));
        try {
            const path = join(tmpDir, 'history.json');
            writeFileSync(path, '', 'utf-8');
            const result = loadHistory(path);
            assert.deepStrictEqual(result, {});
        }
        finally {
            rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});
describe('saveHistory', () => {
    it('writes pretty-printed JSON', () => {
        const tmpDir = mkdtempSync(join(tmpdir(), 'history-test-'));
        try {
            const path = join(tmpDir, 'history.json');
            const data = { nim: { models: ['model-a'] } };
            saveHistory(data, path);
            const raw = readFileSync(path, 'utf-8');
            assert.ok(raw.includes('\n'));
            assert.deepStrictEqual(JSON.parse(raw), data);
        }
        finally {
            rmSync(tmpDir, { recursive: true, force: true });
        }
    });
    it('round-trips load/save', () => {
        const tmpDir = mkdtempSync(join(tmpdir(), 'history-test-'));
        try {
            const path = join(tmpDir, 'history.json');
            const data = {
                nim: { models: ['a', 'b'] },
                openrouter: { models: ['x:free', 'y:free'] },
            };
            saveHistory(data, path);
            const result = loadHistory(path);
            assert.deepStrictEqual(result, data);
        }
        finally {
            rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});
describe('detectNewModels', () => {
    it('returns models in catalog but not in history', () => {
        const history = { nim: { models: ['model-a', 'model-b'] } };
        const result = detectNewModels(history, 'nim', ['model-a', 'model-b', 'model-c']);
        assert.deepStrictEqual(result, ['model-c']);
    });
    it('returns empty when all models are known', () => {
        const history = { nim: { models: ['model-a'] } };
        const result = detectNewModels(history, 'nim', ['model-a']);
        assert.deepStrictEqual(result, []);
    });
    it('returns all models when provider has no history', () => {
        const history = {};
        const result = detectNewModels(history, 'nim', ['model-a', 'model-b']);
        assert.deepStrictEqual(result, ['model-a', 'model-b']);
    });
    it('preserves order from currentModels', () => {
        const history = { nim: { models: ['model-a'] } };
        const result = detectNewModels(history, 'nim', ['model-c', 'model-b', 'model-a']);
        assert.deepStrictEqual(result, ['model-c', 'model-b']);
    });
});
describe('detectRemovedModels', () => {
    it('returns models in history but not in catalog', () => {
        const history = { nim: { models: ['model-a', 'model-b', 'model-c'] } };
        const result = detectRemovedModels(history, 'nim', ['model-a']);
        assert.deepStrictEqual(result, ['model-b', 'model-c']);
    });
    it('returns empty when all history models are in catalog', () => {
        const history = { nim: { models: ['model-a'] } };
        const result = detectRemovedModels(history, 'nim', ['model-a', 'model-b']);
        assert.deepStrictEqual(result, []);
    });
    it('returns empty when provider has no history', () => {
        const history = {};
        const result = detectRemovedModels(history, 'nim', ['model-a']);
        assert.deepStrictEqual(result, []);
    });
});
describe('updateHistory', () => {
    it('adds provider entry', () => {
        const history = {};
        const result = updateHistory(history, 'nim', ['model-a', 'model-b']);
        assert.deepStrictEqual(result, { nim: { models: ['model-a', 'model-b'] } });
    });
    it('replaces existing provider entry', () => {
        const history = { nim: { models: ['old-model'] } };
        const result = updateHistory(history, 'nim', ['new-model']);
        assert.deepStrictEqual(result, { nim: { models: ['new-model'] } });
    });
    it('does not mutate the original history', () => {
        const history = { nim: { models: ['model-a'] } };
        const result = updateHistory(history, 'openrouter', ['x:free']);
        assert.deepStrictEqual(history, { nim: { models: ['model-a'] } });
        assert.deepStrictEqual(result, {
            nim: { models: ['model-a'] },
            openrouter: { models: ['x:free'] },
        });
    });
});
