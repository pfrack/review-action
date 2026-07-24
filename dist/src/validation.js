import * as core from '@actions/core';
export function validateCodeContext(finding, diff) {
    const issue = finding.issue;
    const warnings = [];
    function nameInDiff(name) {
        const MAX_NAME_LENGTH = 80;
        const safeName = name.length > MAX_NAME_LENGTH ? name.slice(0, MAX_NAME_LENGTH) : name;
        const lowerDiff = diff.toLowerCase();
        const lowerName = safeName.toLowerCase();
        let idx = 0;
        while (true) {
            idx = lowerDiff.indexOf(lowerName, idx);
            if (idx === -1)
                return false;
            const before = idx === 0 || !/\w/.test(diff[idx - 1]);
            const after = idx + lowerName.length >= lowerDiff.length || !/\w/.test(diff[idx + lowerName.length]);
            if (before && after)
                return true;
            idx += 1;
        }
    }
    // Check for backtick-wrapped identifiers (most reliable)
    const backtickRefs = issue.match(/`(\w+)`/g);
    if (backtickRefs) {
        for (const ref of backtickRefs) {
            const name = ref.slice(1, -1);
            if (name.length > 2 && !nameInDiff(name)) {
                warnings.push(`Note: referenced identifier \`${name}\` not found in diff — may exist in broader file context`);
            }
        }
    }
    // Check for explicit references like "function X", "variable X", "class X"
    const explicitRef = issue.match(/(?:function|variable|field|param|class|struct|type|interface)\s+(\w+)/i);
    if (explicitRef) {
        const name = explicitRef[1];
        if (name.length > 2 && !nameInDiff(name)) {
            warnings.push(`Note: referenced \`${name}\` not found in diff — may exist in broader file context`);
        }
    }
    return { valid: true, reason: warnings.length > 0 ? warnings.join('; ') : undefined };
}
export async function revalidateFindings(findings, diff, client, model) {
    if (findings.length === 0)
        return { valid: [], dropped: 0 };
    const findingsText = findings.map((f, i) => `[${i}] ${f.severity} in ${f.file}:${f.line_start ?? 'file-level'}: ${f.issue}`).join('\n');
    const prompt = `You are a code review validator. A reviewer produced these findings for a code diff.
For each finding, determine if it is a REAL issue or a HALLUCINATION (not supported by the code).

Findings:
${findingsText}

Respond with ONLY a JSON array of booleans, one per finding, where true = valid, false = hallucination.
Example: [true, false, true]`;
    const MAX_DIFF_LENGTH = 8000;
    let truncatedDiff = diff;
    if (diff.length > MAX_DIFF_LENGTH) {
        const lastNewline = diff.slice(0, MAX_DIFF_LENGTH).lastIndexOf('\n');
        truncatedDiff = diff.slice(0, lastNewline > 0 ? lastNewline : MAX_DIFF_LENGTH) + '\n... (truncated)';
    }
    try {
        const result = await client.chat(model, [
            { role: 'system', content: 'You are a validation assistant. Respond only with a JSON array of booleans.' },
            { role: 'user', content: `${prompt}\n\nDiff:\n\`\`\`\n${truncatedDiff}\n\`\`\`` },
        ], {
            temperature: 0,
            maxTokens: 256,
        });
        let parsed;
        try {
            parsed = JSON.parse(result.content);
        }
        catch {
            core.warning('LLM revalidation failed: could not parse model response. All findings passed through unchecked.');
            return { valid: findings, dropped: 0 };
        }
        if (!Array.isArray(parsed))
            return { valid: findings, dropped: 0 };
        const valid = [];
        let dropped = 0;
        for (let i = 0; i < findings.length; i++) {
            if (parsed[i] === true) {
                valid.push(findings[i]);
            }
            else {
                dropped++;
            }
        }
        return { valid, dropped };
    }
    catch {
        core.warning('LLM revalidation failed: model call threw an error. All findings passed through unchecked.');
        return { valid: findings, dropped: 0 };
    }
}
