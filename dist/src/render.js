import { escapeMarkdown } from './utils.js';
const SEVERITY_META = {
    Critical: { emoji: '🚨', label: 'Critical', actionKey: 'critical_action', tag: 'Must-fix' },
    Warning: { emoji: '⚠️', label: 'Warning', actionKey: 'warning_action', tag: 'Investigate' },
    Suggestion: { emoji: '💡', label: 'Suggestion', actionKey: 'suggestion_action', tag: 'Nit' },
};
const SEVERITY_ORDER = ['Critical', 'Warning', 'Suggestion'];
export function severityTally(review) {
    const counts = { critical: 0, warning: 0, suggestion: 0 };
    for (const f of review.findings) {
        if (f.severity === 'Critical')
            counts.critical++;
        else if (f.severity === 'Warning')
            counts.warning++;
        else if (f.severity === 'Suggestion')
            counts.suggestion++;
    }
    return counts;
}
export function renderReview(review) {
    if (review.findings.length === 0) {
        return review.summary || 'No issues found.';
    }
    const lines = [];
    for (const severity of SEVERITY_ORDER) {
        const meta = SEVERITY_META[severity];
        const bucket = review.findings.filter(f => f.severity === severity);
        if (bucket.length === 0)
            continue;
        lines.push(`### ${meta.emoji} ${meta.label} (${bucket.length})`);
        const byFile = new Map();
        for (const f of bucket) {
            const list = byFile.get(f.file) || [];
            list.push(f);
            byFile.set(f.file, list);
        }
        for (const [file, findings] of [...byFile.entries()].sort(([a], [b]) => a.localeCompare(b))) {
            lines.push(`**File:** \`${file}\``);
            for (const f of findings) {
                const lineInfo = f.line_start != null
                    ? `  **Line:** ${f.line_start}${f.line_end != null && f.line_end !== f.line_start ? '-' + f.line_end : ''}\n`
                    : '';
                const suggestionInfo = f.suggestion ? `\n  **Suggestion:** ${escapeMarkdown(f.suggestion)}` : '';
                const matchAction = f[meta.actionKey];
                const actionLine = (typeof matchAction === 'string' && matchAction && matchAction !== 'not applicable')
                    ? `\n  - **${meta.tag}:** ${escapeMarkdown(matchAction)}`
                    : '';
                lines.push(`- ${meta.emoji} **${meta.label}**\n${lineInfo}  **Issue:** ${escapeMarkdown(f.issue)}${actionLine}${suggestionInfo}`);
            }
            lines.push('');
        }
    }
    if (review.summary) {
        lines.push(`**Summary:** ${escapeMarkdown(review.summary)}`);
    }
    return lines.join('\n');
}
