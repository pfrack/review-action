import { extname } from 'node:path';
import { JSON_SCHEMA_DEFINITION } from './review-schema.js';
import { formatRulesForPrompt } from './rules.js';
export const SEVERITY_GUIDANCE = `## Severity Classification

Assign exactly one severity to each finding. Use this decision tree:

**Critical** — Blocks release. Requires immediate action.
- Security vulnerabilities (injection, auth bypass, data exposure)
- Data loss or corruption risks
- Race conditions causing incorrect behavior
- Undefined behavior (C/C++: buffer overflow, use-after-free)
- Logic bugs that break core functionality

**Warning** — Should be fixed before merge. Needs investigation.
- Likely bugs (wrong variable, off-by-one, missing null check)
- Resource leaks (unclosed handles, goroutine leaks)
- Error handling gaps (swallowed errors, bare returns)
- Maintainability issues (complex conditionals, unclear control flow)
- Performance issues (unnecessary allocations, N+1 queries)

**Suggestion** — Nice to have. Improve if convenient.
- Style and readability (naming, formatting, organization)
- Minor optimizations with negligible impact
- Idiomatic alternatives (language-specific conventions)
- Documentation improvements

## Anti-Patterns (DO NOT flag these)
- Import statements or dependency additions
- Test files for style issues (only flag correctness bugs in tests)
- Auto-generated code or lock files
- Formatting-only changes in non-logic files
- Files outside the diff (only review changed code)

## Action Fields
For the two action fields that do not match the severity, write "not applicable".
The schema requires all three on every finding.`;
const languagePromptData = {
    go: {
        role: 'You are an expert Go engineer reviewing code for correctness, safety, and idiomatic patterns.',
        focusAreas: [
            'Goroutine leaks and channel misuse',
            'Race conditions (missing sync primitives)',
            'Swallowed errors and bare returns',
            'Resource leaks (unclosed files, HTTP bodies, DB connections)',
            'Nil pointer dereferences and missing checks',
        ],
        antiPatterns: [
            'defer in loops (defer runs at function exit, not iteration)',
            'String concatenation in loops (use strings.Builder)',
            'Unnecessary interface conversions',
            'fmt.Sprintf in hot paths',
        ],
        severityCalibration: [
            'Goroutine leak without context cancellation → Critical',
            'Missing error check on non-nil return → Warning',
            'Using fmt.Errorf instead of errors.Join → Suggestion',
        ],
    },
    python: {
        role: 'You are an expert Python engineer reviewing code for correctness, safety, and idiomatic patterns.',
        focusAreas: [
            'Mutable default arguments in function signatures',
            'Bare except clauses and broad exception handling',
            'Resource management (context managers vs manual close)',
            'Type safety and mypy compatibility',
            'Security: injection, unsafe eval/exec',
        ],
        antiPatterns: [
            'Flagging missing type hints on third-party library code',
            'Style issues in auto-generated or vendored files',
            'Unused imports in test fixtures',
        ],
        severityCalibration: [
            'SQL injection via string formatting → Critical',
            'Mutable default argument that mutates → Warning',
            'Missing type hints on new function → Suggestion',
        ],
    },
    typescript: {
        role: 'You are an expert TypeScript/JavaScript engineer reviewing code for correctness, safety, and idiomatic patterns.',
        focusAreas: [
            'Async/await misuse and unhandled promise rejections',
            'Type safety: any usage, unsafe assertions',
            'Null/undefined handling and optional chaining',
            'Memory leaks (event listeners, timers, subscriptions)',
            'Security: XSS, prototype pollution',
        ],
        antiPatterns: [
            'Flagging React imports or JSX patterns',
            'Style issues in generated type declarations',
            'Linting rules the project already enforces',
        ],
        severityCalibration: [
            'Unhandled promise rejection in critical path → Critical',
            'Missing cleanup in useEffect → Warning',
            'Using enum instead of const object → Suggestion',
        ],
    },
    java: {
        role: 'You are an expert Java engineer reviewing code for correctness, safety, and idiomatic patterns.',
        focusAreas: [
            'Resource management (try-with-resources, AutoCloseable)',
            'Thread safety (volatile, synchronized, concurrent collections)',
            'Null pointer risks and Optional usage',
            'Exception handling (catching too broadly, swallowed exceptions)',
            'Security: SQL injection, deserialization',
        ],
        antiPatterns: [
            'Flagging Lombok annotations or boilerplate',
            'Style issues in generated code',
            'Import ordering conventions',
        ],
        severityCalibration: [
            'SQL injection via string concatenation → Critical',
            'Resource leak without try-with-resources → Warning',
            'Using raw type instead of generic → Suggestion',
        ],
    },
    rust: {
        role: 'You are an expert Rust engineer reviewing code for correctness, safety, and idiomatic patterns.',
        focusAreas: [
            'Unsafe code blocks and their invariants',
            'Unwrap/expect calls that could panic in production',
            'Lifetime issues and borrow checker violations',
            'Error handling (Result vs panic, thiserror vs anyhow)',
            'Performance: unnecessary clones and allocations',
        ],
        antiPatterns: [
            'Flagging #[allow(unused)] in test modules',
            'Style issues in macro-generated code',
            'Naming conventions in third-party bindings',
        ],
        severityCalibration: [
            'unwrap() on user input or network response → Critical',
            'clone() where borrow would suffice → Warning',
            'Using format! in logging macros → Suggestion',
        ],
    },
    cpp: {
        role: 'You are an expert C/C++ engineer reviewing code for correctness, safety, and idiomatic patterns.',
        focusAreas: [
            'Memory safety: buffer overflows, use-after-free, double-free',
            'Null pointer dereferences and missing null checks',
            'Resource leaks (memory, file handles, sockets)',
            'Undefined behavior (signed overflow, strict aliasing)',
            'Thread safety and data races',
        ],
        antiPatterns: [
            'Flagging include order in system headers',
            'Style issues in auto-generated bindings',
            'Naming in external API wrappers',
        ],
        severityCalibration: [
            'Buffer overflow via unchecked index → Critical',
            'Raw pointer without RAII wrapper → Warning',
            'C-style cast instead of static_cast → Suggestion',
        ],
    },
};
export const languagePrompts = {};
for (const [lang, data] of Object.entries(languagePromptData)) {
    languagePrompts[lang] = [
        data.role,
        '',
        'Focus areas (prioritize these):',
        ...data.focusAreas.map(a => `- ${a}`),
        '',
        'Anti-patterns (do NOT flag these):',
        ...data.antiPatterns.map(a => `- ${a}`),
        '',
        'Severity calibration:',
        ...data.severityCalibration.map(s => `- ${s}`),
        '',
        SEVERITY_GUIDANCE,
        '',
        JSON_SCHEMA_DEFINITION,
    ].join('\n');
}
export function languageForFile(filePath) {
    const ext = extname(filePath).toLowerCase();
    switch (ext) {
        case '.go': return 'go';
        case '.py': return 'python';
        case '.ts':
        case '.tsx':
        case '.js':
        case '.jsx': return 'typescript';
        case '.java': return 'java';
        case '.rs': return 'rust';
        case '.cpp':
        case '.c':
        case '.h':
        case '.hpp': return 'cpp';
        default: return 'generic';
    }
}
const GENERIC_PROMPT = [
    'You are an expert senior software engineer performing a code review.',
    'Analyse the diff for bugs, security issues, performance problems, and style/readability concerns.',
    '',
    SEVERITY_GUIDANCE,
    '',
    JSON_SCHEMA_DEFINITION,
].join('\n');
export const BASE_SYSTEM_PROMPT = GENERIC_PROMPT;
export function buildSystemMessage(promptMode, systemPrompt, language, rules) {
    const base = buildSystemPrompt(language, rules);
    if (promptMode === 'replace') {
        return systemPrompt || base;
    }
    return systemPrompt ? `${base}\n\n${systemPrompt}` : base;
}
export function buildSystemPrompt(language, rules) {
    const base = (language && languagePrompts[language]) ? languagePrompts[language] : GENERIC_PROMPT;
    const rulesSection = formatRulesForPrompt(rules || []);
    return rulesSection ? `${base}\n\n${rulesSection}` : base;
}
