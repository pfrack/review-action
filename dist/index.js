import * as core from '@actions/core';
import { NimClient } from './nim-client.js';
import { loadConfig, fetchDiff, postComment, shouldExclude, BASE_SYSTEM_PROMPT } from './review.js';
import { loadEvent } from './event.js';
import { buildCombinedChain } from './model-chain.js';
async function run() {
    const config = loadConfig();
    const hasCustom = !!(config.customApiUrl && config.customModel);
    // Validate custom URL protocol first (more specific error)
    if (config.customApiUrl) {
        const url = new URL(config.customApiUrl);
        const isLoopback = url.hostname === 'localhost'
            || url.hostname === '127.0.0.1'
            || url.hostname === '::1'
            || url.hostname === '0.0.0.0';
        if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
            throw new Error('custom_api_url must use https:// (or http:// for localhost only)');
        }
    }
    if (!config.apiKey && !config.mistralApiKey && !hasCustom) {
        throw new Error('At least one of nim_api_key, mistral_api_key, or custom_api_url + custom_model is required');
    }
    // Informational: custom-only means no fallback if custom model fails
    if (hasCustom && !config.apiKey && !config.mistralApiKey) {
        core.info('Running with only custom API configured — no fallback chain available if custom model fails');
    }
    const nimClient = config.apiKey ? new NimClient(config.baseURL, config.apiKey) : null;
    const mistralClient = config.mistralApiKey ? new NimClient(config.mistralBaseUrl, config.mistralApiKey) : null;
    const customClient = hasCustom
        ? new NimClient(config.customApiUrl, config.customApiKey)
        : null;
    const clients = {
        nim: nimClient,
        mistral: mistralClient,
        custom: customClient,
    };
    const chain = buildCombinedChain({
        nimModels: config.models,
        mistralModels: config.mistralModels,
        hasNimKey: !!config.apiKey,
        hasMistralKey: !!config.mistralApiKey,
        customModel: config.customModel,
        hasCustomConfig: hasCustom,
    });
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
    core.info(`Combined chain: ${chain.map(m => `${m.id}(${m.provider})`).join(', ')}`);
    const filesDiff = await fetchDiff(repo, prNumber, token);
    if (Object.keys(filesDiff).length === 0) {
        const msg = '### AI Code Review\n\nNo reviewable files found in this PR (all excluded).';
        await postComment(repo, prNumber, token, msg);
        return;
    }
    // Filter files
    const filenames = Object.keys(filesDiff).sort();
    const reviewableFiles = [];
    for (const filePath of filenames) {
        if (!shouldExclude(filePath, config.excludePatterns)) {
            reviewableFiles.push(filePath);
        }
    }
    if (reviewableFiles.length === 0) {
        const msg = '### AI Code Review\n\nNo reviewable files found in this PR (all excluded).';
        await postComment(repo, prNumber, token, msg);
        return;
    }
    // Truncate if too many files
    const filesToReview = reviewableFiles.slice(0, config.maxFiles);
    const truncated = reviewableFiles.length > config.maxFiles;
    core.info(`Reviewing ${filesToReview.length} files...`);
    // Build combined diff
    let diffToSend = '';
    for (const filePath of filesToReview) {
        diffToSend += `\n--- ${filePath} ---\n${filesDiff[filePath]}\n`;
    }
    const userMsg = `Review the following code changes:\n\n\`\`\`diff\n${diffToSend}\n\`\`\``;
    // Try models from combined chain in order, stop at first success
    let review = '';
    let usedModel = '';
    for (const tagged of chain) {
        const client = clients[tagged.provider];
        if (!client)
            continue;
        try {
            core.info(`Trying ${tagged.id} (${tagged.provider})...`);
            const result = await client.chat(tagged.id, [
                { role: 'system', content: config.systemPrompt || BASE_SYSTEM_PROMPT },
                { role: 'user', content: userMsg },
            ], { temperature: 0.2, maxTokens: 4096 });
            if (result.content && result.content.trim()) {
                review = result.content;
                usedModel = tagged.id;
                core.info(`Done with ${tagged.id} (${tagged.provider})`);
                break;
            }
            core.info(`${tagged.id} returned empty, trying next...`);
        }
        catch (err) {
            core.info(`${tagged.id} (${tagged.provider}) failed: ${err}`);
        }
    }
    if (!review) {
        review = 'No review content returned from any model.';
    }
    const modelShort = usedModel.split('/').pop() || usedModel;
    const sections = [`### AI Code Review\n\n<sub>Model: ${modelShort}</sub>\n`];
    sections.push(`\n${review}`);
    if (truncated) {
        sections.push(`\n---\nReached max file limit (${config.maxFiles}); ${reviewableFiles.length - config.maxFiles} files skipped.`);
    }
    await postComment(repo, prNumber, token, sections.join('\n'));
}
run().catch(err => {
    core.setFailed(err instanceof Error ? err.message : String(err));
});
