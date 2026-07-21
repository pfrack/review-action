import { describe, it } from 'node:test';
import assert from 'node:assert';
import { languageForFile, languagePrompts } from './prompts.js';
import { BASE_SYSTEM_PROMPT } from './review.js';
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
describe('severity guidance in prompts', () => {
    const requiredSubstrings = ['critical_action', 'warning_action', 'suggestion_action', 'not applicable'];
    it('BASE_SYSTEM_PROMPT carries severity guidance', () => {
        for (const sub of requiredSubstrings) {
            assert.ok(BASE_SYSTEM_PROMPT.includes(sub), `BASE_SYSTEM_PROMPT missing "${sub}"`);
        }
    });
    for (const key of Object.keys(languagePrompts)) {
        it(`languagePrompts["${key}"] carries severity guidance`, () => {
            const text = languagePrompts[key];
            for (const sub of requiredSubstrings) {
                assert.ok(text.includes(sub), `languagePrompts["${key}"] missing "${sub}"`);
            }
        });
    }
});
