import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readRemovedModels, writeRemovedModels, appendRemovedModels, cleanupRemovedModels } from './removed-models.js';
let testDir;
let testPath;
describe('removed-models helpers', () => {
    beforeEach(() => {
        testDir = mkdtempSync(join(tmpdir(), 'removed-models-test-'));
        testPath = join(testDir, 'removed-models.txt');
    });
    afterEach(() => {
        try {
            rmSync(testDir, { recursive: true, force: true });
        }
        catch (err) {
            // Best-effort cleanup; do not fail the suite if the OS is slow.
            process.stderr.write(`Warning: could not remove ${testDir}: ${err}\n`);
        }
    });
    it('readRemovedModels returns empty array when file does not exist', () => {
        const result = readRemovedModels(testPath);
        assert.deepStrictEqual(result, []);
    });
    it('readRemovedModels reads models from file', () => {
        writeFileSync(testPath, 'model-a\nmodel-b\nmodel-c\n', 'utf-8');
        const result = readRemovedModels(testPath);
        assert.deepStrictEqual(result, ['model-a', 'model-b', 'model-c']);
    });
    it('readRemovedModels handles blank lines', () => {
        writeFileSync(testPath, 'model-a\n\nmodel-b\n\n', 'utf-8');
        const result = readRemovedModels(testPath);
        assert.deepStrictEqual(result, ['model-a', 'model-b']);
    });
    it('writeRemovedModels creates file with models', () => {
        writeRemovedModels(['model-x', 'model-y'], testPath);
        const result = readRemovedModels(testPath);
        assert.deepStrictEqual(result, ['model-x', 'model-y']);
    });
    it('writeRemovedModels with empty array creates empty file', () => {
        writeRemovedModels([], testPath);
        const content = readFileSync(testPath, 'utf-8');
        assert.strictEqual(content, '');
    });
    it('appendRemovedModels adds new models to existing file', () => {
        writeFileSync(testPath, 'existing-model\n', 'utf-8');
        appendRemovedModels(['new-model-a', 'new-model-b'], testPath);
        const result = readRemovedModels(testPath);
        assert.deepStrictEqual(result, ['existing-model', 'new-model-a', 'new-model-b']);
    });
    it('appendRemovedModels skips duplicates', () => {
        writeFileSync(testPath, 'model-a\nmodel-b\n', 'utf-8');
        appendRemovedModels(['model-b', 'model-c'], testPath);
        const result = readRemovedModels(testPath);
        assert.deepStrictEqual(result, ['model-a', 'model-b', 'model-c']);
    });
    it('appendRemovedModels creates file if it does not exist', () => {
        appendRemovedModels(['model-a'], testPath);
        const result = readRemovedModels(testPath);
        assert.deepStrictEqual(result, ['model-a']);
    });
    it('cleanupRemovedModels removes models not in provider catalog', () => {
        writeFileSync(testPath, 'alive-model\ndead-model\nalso-alive\n', 'utf-8');
        const available = new Set(['alive-model', 'also-alive', 'other-model']);
        cleanupRemovedModels(available, testPath);
        const result = readRemovedModels(testPath);
        assert.deepStrictEqual(result, ['alive-model', 'also-alive']);
    });
    it('cleanupRemovedModels does nothing when all models are in catalog', () => {
        writeFileSync(testPath, 'model-a\nmodel-b\n', 'utf-8');
        const available = new Set(['model-a', 'model-b']);
        cleanupRemovedModels(available, testPath);
        const result = readRemovedModels(testPath);
        assert.deepStrictEqual(result, ['model-a', 'model-b']);
    });
    it('cleanupRemovedModels creates no file if none exists', () => {
        cleanupRemovedModels(new Set(['model-a']), testPath);
        assert.ok(!existsSync(testPath));
    });
    it('models not in provider catalog are NOT written to removed-models.txt', () => {
        const availableModels = new Set(['model-a']);
        const failed = ['model-a', 'model-b'];
        // Classification logic (mirrors bench-entry.ts main)
        const transientFailed = [];
        for (const model of failed) {
            if (availableModels.has(model)) {
                transientFailed.push(model);
            }
        }
        appendRemovedModels(transientFailed, testPath);
        const result = readRemovedModels(testPath);
        assert.deepStrictEqual(result, ['model-a']);
        assert.ok(!result.includes('model-b'));
    });
    it('writeRemovedModels overwrites existing content', () => {
        writeFileSync(testPath, 'old-model\n', 'utf-8');
        writeRemovedModels(['new-model'], testPath);
        const result = readRemovedModels(testPath);
        assert.deepStrictEqual(result, ['new-model']);
    });
});
describe('recheck flow simulation', () => {
    beforeEach(() => {
        testDir = mkdtempSync(join(tmpdir(), 'recheck-test-'));
        testPath = join(testDir, 'removed-models.txt');
    });
    afterEach(() => {
        try {
            rmSync(testDir, { recursive: true, force: true });
        }
        catch (err) {
            process.stderr.write(`Warning: could not remove ${testDir}: ${err}\n`);
        }
    });
    it('recovered models are removed from removed-models.txt', () => {
        // Simulate: file has model-a and model-b, model-a recovers
        writeFileSync(testPath, 'model-a\nmodel-b\n', 'utf-8');
        const removedModels = readRemovedModels(testPath);
        assert.deepStrictEqual(removedModels, ['model-a', 'model-b']);
        // Simulate recheck: model-a probe passes, model-b probe fails
        const recovered = ['model-a'];
        const stillFailed = removedModels.filter(m => !recovered.includes(m));
        writeRemovedModels(stillFailed, testPath);
        const result = readRemovedModels(testPath);
        assert.deepStrictEqual(result, ['model-b']);
    });
    it('all models recovered empties the file', () => {
        writeFileSync(testPath, 'model-a\nmodel-b\nmodel-c\n', 'utf-8');
        const removedModels = readRemovedModels(testPath);
        // All three recover
        const recovered = ['model-a', 'model-b', 'model-c'];
        const stillFailed = removedModels.filter(m => !recovered.includes(m));
        writeRemovedModels(stillFailed, testPath);
        const result = readRemovedModels(testPath);
        assert.deepStrictEqual(result, []);
    });
    it('no models recovered keeps file unchanged', () => {
        writeFileSync(testPath, 'model-a\nmodel-b\n', 'utf-8');
        const removedModels = readRemovedModels(testPath);
        // None recover
        const recovered = [];
        const stillFailed = removedModels.filter(m => !recovered.includes(m));
        writeRemovedModels(stillFailed, testPath);
        const result = readRemovedModels(testPath);
        assert.deepStrictEqual(result, ['model-a', 'model-b']);
    });
    it('new failures can be added while recheck runs', () => {
        writeFileSync(testPath, 'model-a\n', 'utf-8');
        // During recheck, a new model fails
        appendRemovedModels(['model-b'], testPath);
        // Recheck recovers model-a
        const removedModels = readRemovedModels(testPath);
        const recovered = ['model-a'];
        const stillFailed = removedModels.filter(m => !recovered.includes(m));
        writeRemovedModels(stillFailed, testPath);
        const result = readRemovedModels(testPath);
        assert.deepStrictEqual(result, ['model-b']);
    });
});
