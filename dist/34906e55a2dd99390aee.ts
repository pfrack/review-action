import * as core from '@actions/core';
import { NimClient } from './nim-client.js';
import { loadConfig, fetchDiff, postComment, reviewFileWithFallback } from './review.js';
import { loadEvent } from './event.js';
async function run() {
    const config = loadConfig();
    if (!config.apiKey) {
        throw new Error('NIM_API_KEY is required');
    }
    const client = new NimClient(config.baseURL, config.apiKey);
    const event = loadEvent();
    const prNumber = event.pull_request.number;
    const repo = process.env.GITHUB_REPOSITORY;
    if (!repo) {
        throw new Error('GITHUB_REPOSITORY not set');
    }
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
        throw new Error('GITHUB_TOKEN not set');
    }
    core.info(`Reviewing PR #${prNumber} in ${repo}`);
    core.info(`Models: ${config.models.join(' -> ')}`);
    const filesDiff = await fetchDiff(repo, prNumber, token);
    if (Object.keys(filesDiff).length === 0) {
        const msg = '### NIM Code Review\n\nNo reviewable files found in this PR (all excluded).';
        await postComment(repo, prNumber, token, msg);
        return;
    }
    let reviewed = 0;
    const sections = [`### NIM Code Review\n\n_Models: \`${config.models.join(' -> ')}\`_\n`];
    const filenames = Object.keys(filesDiff).sort();
    for (const filePath of filenames) {
        const diff = filesDiff[filePath];
        if (reviewed >= config.maxFiles) {
            sections.push(`\n---\nReached max file limit (${config.maxFiles}); remaining files skipped.`);
            break;
        }
        if (filePath.split('/').pop() && config.excludePatterns.some(pat => {
            const re = new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
            return re.test(filePath) || re.test(filePath.split('/').pop() || '');
        })) {
            continue;
        }
        core.info(`Reviewing ${filePath} ...`);
        try {
            const review = await reviewFileWithFallback(client, filePath, diff, config);
            sections.push(`\n#### \`${filePath}\`\n\n${review}`);
        }
        catch (err) {
            sections.push(`\n#### \`${filePath}\`\n\nReview failed: \`${err}\``);
        }
        reviewed++;
    }
    await postComment(repo, prNumber, token, sections.join('\n'));
}
run().catch(err => {
    core.setFailed(err instanceof Error ? err.message : String(err));
});
