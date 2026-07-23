export function validateCodeContext(finding, diff) {
    const issue = finding.issue;
    // Check for backtick-wrapped identifiers (most reliable)
    const backtickRefs = issue.match(/`(\w+)`/g);
    if (backtickRefs) {
        for (const ref of backtickRefs) {
            const name = ref.slice(1, -1);
            if (name.length > 2 && !diff.includes(name)) {
                return { valid: false, reason: `Referenced identifier \`${name}\` not found in diff` };
            }
        }
    }
    // Check for explicit references like "function X", "variable X", "class X"
    const explicitRef = issue.match(/(?:function|variable|field|param|class|struct|type|interface)\s+(\w+)/i);
    if (explicitRef) {
        const name = explicitRef[1];
        if (name.length > 2 && !diff.includes(name)) {
            return { valid: false, reason: `Referenced \`${name}\` not found in diff` };
        }
    }
    return { valid: true };
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
    const truncatedDiff = diff.length > 8000 ? diff.slice(0, 8000) + '\n... (truncated)' : diff;
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
        return { valid: findings, dropped: 0 };
    }
}
