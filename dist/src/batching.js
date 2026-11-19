export function batchFiles(filesDiff, batchSize = 50) {
    if (batchSize <= 0) {
        throw new Error('batchSize must be a positive integer');
    }
    const sortedFiles = Object.keys(filesDiff).sort();
    const batches = [];
    for (let i = 0; i < sortedFiles.length; i += batchSize) {
        const batchFiles = sortedFiles.slice(i, i + batchSize);
        const batchDiffs = {};
        for (const file of batchFiles) {
            batchDiffs[file] = filesDiff[file];
        }
        batches.push({ files: batchFiles, diffs: batchDiffs });
    }
    return batches;
}
export function mergeFindings(batchResults) {
    const seen = new Set();
    const merged = [];
    const summaries = [];
    for (const result of batchResults) {
        if (result.summary) {
            summaries.push(result.summary);
        }
        for (const finding of result.findings) {
            const key = finding.line_start != null
                ? `${finding.file}:${finding.line_start}:${finding.line_end ?? 'none'}:${finding.severity}:${finding.issue.trim().toLowerCase()}:${(finding.suggestion || '').trim().toLowerCase()}`
                : `${finding.file}:file:${finding.severity}:${finding.issue.trim().toLowerCase()}:${(finding.suggestion || '').trim().toLowerCase()}`;
            if (!seen.has(key)) {
                seen.add(key);
                merged.push(finding);
            }
        }
    }
    return { findings: merged, summary: summaries.length > 0 ? summaries.join('\n\n') : null };
}
