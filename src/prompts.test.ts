import { describe, it } from 'node:test';
import assert from 'node:assert';
import { languageForFile, languagePrompts, buildSystemPrompt } from './prompts.js';

describe('languageForFile', () => {
  const tests: [string, string][] = [
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

  for (const key of Object.keys(languagePrompts)) {
    it(`languagePrompts["${key}"] carries severity guidance`, () => {
      const text = languagePrompts[key];
      for (const sub of requiredSubstrings) {
        assert.ok(text.includes(sub), `languagePrompts["${key}"] missing "${sub}"`);
      }
    });
  }
});

describe('buildSystemPrompt', () => {
  it('returns generic prompt for unknown language', () => {
    const prompt = buildSystemPrompt('unknown');
    assert.ok(prompt.includes('code review'));
    assert.ok(prompt.includes('critical_action'));
    assert.ok(prompt.includes('warning_action'));
    assert.ok(prompt.includes('suggestion_action'));
  });

  it('returns generic prompt for undefined language', () => {
    const prompt = buildSystemPrompt();
    assert.ok(prompt.includes('code review'));
    assert.ok(prompt.includes('severity'));
  });

  it('returns Go-specific prompt for "go"', () => {
    const prompt = buildSystemPrompt('go');
    assert.ok(prompt.includes('Go'));
    assert.ok(prompt.includes('goroutine'));
    assert.ok(prompt.includes('critical_action'));
  });

  it('returns Python-specific prompt for "python"', () => {
    const prompt = buildSystemPrompt('python');
    assert.ok(prompt.includes('Python'));
    assert.ok(prompt.includes('Mutable default'));
    assert.ok(prompt.includes('critical_action'));
  });

  it('returns TypeScript-specific prompt for "typescript"', () => {
    const prompt = buildSystemPrompt('typescript');
    assert.ok(prompt.includes('TypeScript'));
    assert.ok(prompt.includes('Async'));
    assert.ok(prompt.includes('critical_action'));
  });

  it('returns Java-specific prompt for "java"', () => {
    const prompt = buildSystemPrompt('java');
    assert.ok(prompt.includes('Java'));
    assert.ok(prompt.includes('try-with-resources'));
    assert.ok(prompt.includes('critical_action'));
  });

  it('returns Rust-specific prompt for "rust"', () => {
    const prompt = buildSystemPrompt('rust');
    assert.ok(prompt.includes('Rust'));
    assert.ok(prompt.includes('Unsafe'));
    assert.ok(prompt.includes('critical_action'));
  });

  it('returns C++-specific prompt for "cpp"', () => {
    const prompt = buildSystemPrompt('cpp');
    assert.ok(prompt.includes('C/C++'));
    assert.ok(prompt.includes('buffer overflow'));
    assert.ok(prompt.includes('critical_action'));
  });

  it('all language prompts include JSON schema definition', () => {
    for (const lang of ['go', 'python', 'typescript', 'java', 'rust', 'cpp']) {
      const prompt = buildSystemPrompt(lang);
      assert.ok(prompt.includes('```json'), `${lang} prompt missing JSON schema`);
      assert.ok(prompt.includes('findings'), `${lang} prompt missing findings schema`);
    }
  });

  it('all language prompts include anti-patterns section', () => {
    for (const lang of ['go', 'python', 'typescript', 'java', 'rust', 'cpp']) {
      const prompt = buildSystemPrompt(lang);
      assert.ok(prompt.includes('Anti-patterns'), `${lang} prompt missing anti-patterns`);
    }
  });

  it('all language prompts include severity calibration', () => {
    for (const lang of ['go', 'python', 'typescript', 'java', 'rust', 'cpp']) {
      const prompt = buildSystemPrompt(lang);
      assert.ok(prompt.includes('Severity calibration'), `${lang} prompt missing severity calibration`);
    }
  });
});
