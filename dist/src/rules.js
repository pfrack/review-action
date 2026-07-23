export function parseRules(input) {
    if (!input || !input.trim())
        return [];
    const lines = input.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    return lines.map(line => {
        const severityMatch = line.match(/^\[(critical|warning|suggestion)\]\s*/i);
        let severity = 'warning';
        let description = line;
        if (severityMatch) {
            severity = severityMatch[1].toLowerCase();
            description = line.slice(severityMatch[0].length);
        }
        const categoryMatch = description.match(/^([^:]+):\s*/);
        let category = 'custom';
        let pattern;
        if (categoryMatch) {
            category = categoryMatch[1].trim().toLowerCase();
            description = description.slice(categoryMatch[0].length);
        }
        const patternMatch = description.match(/^\/(.+?)\/\s*/);
        if (patternMatch) {
            pattern = patternMatch[1];
            description = description.slice(patternMatch[0].length);
        }
        return { category, severity, description: description.trim(), pattern };
    });
}
const INJECTION_PATTERNS = [
    /ignore\s+(previous|all|above)\s+instructions/i,
    /disregard\s+(previous|all|above)/i,
    /you\s+are\s+now\s+/i,
    /new\s+instructions?:/i,
    /system\s*prompt\s*override/i,
];
export function validateRules(rules) {
    const errors = [];
    for (let i = 0; i < rules.length; i++) {
        const rule = rules[i];
        if (rule.description.length > 500) {
            errors.push(`Rule ${i + 1} exceeds 500 characters (${rule.description.length})`);
        }
        for (const pattern of INJECTION_PATTERNS) {
            if (pattern.test(rule.description)) {
                errors.push(`Rule ${i + 1} contains potential prompt injection`);
            }
        }
    }
    return { valid: errors.length === 0, errors };
}
export function formatRulesForPrompt(rules) {
    if (rules.length === 0)
        return '';
    const lines = ['## Custom Review Rules', 'Apply these additional rules during review:'];
    for (let i = 0; i < rules.length; i++) {
        const r = rules[i];
        lines.push(`${i + 1}. [${r.severity.toUpperCase()}] ${r.description}`);
    }
    return lines.join('\n');
}
