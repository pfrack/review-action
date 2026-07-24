import { describe, it } from 'node:test';
import assert from 'node:assert';
import { safeParseJson, escapeMarkdown } from './utils.js';
describe('safeParseJson', () => {
    it('parses valid JSON', () => {
        assert.deepStrictEqual(safeParseJson('{"a":1}'), { a: 1 });
    });
    it('returns undefined for empty string', () => {
        assert.strictEqual(safeParseJson(''), undefined);
    });
    it('returns undefined for whitespace-only', () => {
        assert.strictEqual(safeParseJson('   '), undefined);
    });
    it('returns undefined for invalid JSON', () => {
        assert.strictEqual(safeParseJson('not json'), undefined);
    });
});
describe('escapeMarkdown', () => {
    it('escapes asterisks (bold)', () => {
        assert.strictEqual(escapeMarkdown('*bold*'), '\\*bold\\*');
    });
    it('escapes underscores (italic)', () => {
        assert.strictEqual(escapeMarkdown('_italic_'), '\\_italic\\_');
    });
    it('escapes backticks (code)', () => {
        assert.strictEqual(escapeMarkdown('`code`'), '\\`code\\`');
    });
    it('escapes square brackets (links)', () => {
        assert.strictEqual(escapeMarkdown('[text](url)'), '\\[text\\]\\(url\\)');
    });
    it('escapes hash (headers)', () => {
        assert.strictEqual(escapeMarkdown('# heading'), '\\# heading');
    });
    it('escapes less-than (HTML injection)', () => {
        assert.strictEqual(escapeMarkdown('<img src=x>'), '\\<img src=x\\>');
    });
    it('escapes ampersand (HTML entities)', () => {
        assert.strictEqual(escapeMarkdown('a & b'), 'a \\& b');
    });
    it('escapes greater-than', () => {
        assert.strictEqual(escapeMarkdown('a > b'), 'a \\> b');
    });
    it('escapes pipe (tables)', () => {
        assert.strictEqual(escapeMarkdown('a | b'), 'a \\| b');
    });
    it('escapes tilde (strikethrough)', () => {
        assert.strictEqual(escapeMarkdown('~strike~'), '\\~strike\\~');
    });
    it('escapes plus (diff context)', () => {
        assert.strictEqual(escapeMarkdown('+added'), '\\+added');
    });
    it('escapes curly braces (template syntax)', () => {
        assert.strictEqual(escapeMarkdown('{{var}}'), '\\{\\{var\\}\\}');
    });
    it('escapes parentheses', () => {
        assert.strictEqual(escapeMarkdown('(text)'), '\\(text\\)');
    });
    it('handles plain text without special chars', () => {
        assert.strictEqual(escapeMarkdown('normal text here'), 'normal text here');
    });
    it('handles multiline text', () => {
        const input = 'First line\n*second line*\nThird line';
        const expected = 'First line\n\\*second line\\*\nThird line';
        assert.strictEqual(escapeMarkdown(input), expected);
    });
});
