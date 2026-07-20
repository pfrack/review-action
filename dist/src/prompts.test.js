import { describe, it } from 'node:test';
import assert from 'node:assert';
import { languageForFile } from './prompts.js';
describe('languageForFile', () => {
    const tests = [
        ['main.go', 'go'],
        ['pkg/util.go', 'go'],
        ['app.py', 'python'],
        ['lib/module.py', 'python'],
        ['src/index.ts', 'typescript'],
        ['src/app.tsx', 'typescript'],
        ['src/utils.js', 'typescript'],
        ['src/component.jsx', 'typescript'],
        ['Main.java', 'java'],
        ['src/main.rs', 'rust'],
        ['lib/core.cpp', 'cpp'],
        ['src/header.h', 'cpp'],
        ['include/module.hpp', 'cpp'],
        ['lib/legacy.c', 'cpp'],
        ['README.md', 'generic'],
        ['config.yaml', 'generic'],
        ['data.json', 'generic'],
    ];
    for (const [fp, want] of tests) {
        it(`returns "${want}" for "${fp}"`, () => {
            assert.strictEqual(languageForFile(fp), want);
        });
    }
});
