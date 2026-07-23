export function batchFiles(filesDiff, batchSize = 50) {
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
            const key = `${finding.file}:${finding.line_start ?? 'file'}:${finding.severity}:${finding.issue}`;
            if (!seen.has(key)) {
                seen.add(key);
                merged.push(finding);
            }
        }
    }
    return { findings: merged, summary: summaries.length > 0 ? summaries.join('\n\n') : null };
}
