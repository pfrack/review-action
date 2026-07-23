import * as core from '@actions/core';
import { OpenAIClient } from './openai-client.js';
import { loadConfig, fetchDiff, postComment, findExistingComment, deleteComment, shouldExclude, validateFindings, renderReview, severityTally, DiffTooLargeError, BASE_SYSTEM_PROMPT } from './review.js';
import { loadEvent } from './event.js';
import { buildCombinedChain } from './model-chain.js';
import { ReviewSchema, ReviewJsonSchema } from './review-schema.js';
import { safeParseJson } from './utils.js';
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
    const nimClient = config.apiKey ? new OpenAIClient(config.baseURL, config.apiKey) : null;
    const mistralClient = config.mistralApiKey ? new OpenAIClient(config.mistralBaseUrl, config.mistralApiKey) : null;
    const customClient = hasCustom
        ? new OpenAIClient(config.customApiUrl, config.customApiKey)
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
    let filesDiff;
    try {
        filesDiff = await fetchDiff(repo, prNumber, token);
    }
    catch (err) {
        if (err instanceof DiffTooLargeError) {
            const msg = `### AI Code Review\n\n${err.message}`;
            try {
                await postComment(repo, prNumber, token, msg);
            }
            catch (postErr) {
                core.warning(`Failed to post diff-too-large comment: ${postErr}`);
            }
            return;
        }
        throw err;
    }
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
    function providerToFormat(provider) {
        if (provider === 'mistral')
            return 'tools';
        return 'json_schema';
    }
    // Try models from combined chain in order, stop at first success
    let review = null;
    let usedModel = '';
    let lastRawContent = '';
    for (const tagged of chain) {
        const client = clients[tagged.provider];
        if (!client)
            continue;
        try {
            core.info(`Trying ${tagged.id} (${tagged.provider})...`);
            const result = await client.chat(tagged.id, [
                {
                    role: 'system',
                    content: config.promptMode === 'replace'
                        ? (config.systemPrompt || BASE_SYSTEM_PROMPT)
                        : (config.systemPrompt
                            ? `${BASE_SYSTEM_PROMPT}\n\n${config.systemPrompt}`
                            : BASE_SYSTEM_PROMPT),
                },
                { role: 'user', content: userMsg },
            ], {
                temperature: 0.2,
                maxTokens: 4096,
                schema: ReviewJsonSchema,
                format: providerToFormat(tagged.provider),
            });
            if (result.finishReason === 'length') {
                core.info(`${tagged.id} response truncated, trying next...`);
                continue;
            }
            if (!result.content || !result.content.trim()) {
                core.info(`${tagged.id} returned empty, trying next...`);
                continue;
            }
            // Try parsing as structured JSON
            let parsed = ReviewSchema.safeParse(safeParseJson(result.content));
            if (!parsed.success) {
                // Retry once with validation error appended, truncating the previous
                // response to avoid exceeding token limits on large outputs.
                core.info(`${tagged.id} schema validation failed, retrying...`);
                const truncated = result.content.length > 500
                    ? '...' + result.content.slice(-500)
                    : result.content;
                const errorSummary = parsed.error.issues.slice(0, 3).map(i => `- ${i.path.join('.')}: ${i.message}`).join('\n');
                const retryResult = await client.chat(tagged.id, [
                    {
                        role: 'system',
                        content: config.promptMode === 'replace'
                            ? (config.systemPrompt || BASE_SYSTEM_PROMPT)
                            : (config.systemPrompt
                                ? `${BASE_SYSTEM_PROMPT}\n\n${config.systemPrompt}`
                                : BASE_SYSTEM_PROMPT),
                    },
                    { role: 'user', content: userMsg },
                    { role: 'assistant', content: truncated },
                    { role: 'user', content: `Your previous response was not valid JSON matching the required schema. ${parsed.error.issues.length} validation error(s) occurred:\n${errorSummary}\nPlease respond with valid JSON matching the schema.` },
                ], {
                    temperature: 0.2,
                    maxTokens: 4096,
                    schema: ReviewJsonSchema,
                    format: providerToFormat(tagged.provider),
                });
                if (retryResult.finishReason === 'length') {
                    core.info(`${tagged.id} retry truncated, trying next...`);
                    continue;
                }
                parsed = ReviewSchema.safeParse(safeParseJson(retryResult.content));
                if (!parsed.success) {
                    lastRawContent = retryResult.content;
                    core.info(`${tagged.id} JSON validation failed after retry, trying next...`);
                    continue;
                }
            }
            // Both first-attempt and retry success paths converge here
            review = parsed.data;
            const changedFiles = new Set(reviewableFiles);
            const validated = validateFindings(review, filesDiff, changedFiles);
            for (const w of validated.warnings)
                core.warning(w);
            review = validated.valid;
            usedModel = tagged.id;
            core.info(`Done with ${tagged.id} (${tagged.provider})`);
            break;
        }
        catch (err) {
            core.info(`${tagged.id} (${tagged.provider}) failed: ${err}`);
        }
    }
    const modelShort = usedModel.split('/').pop() || usedModel;
    const existingCommentId = await findExistingComment(repo, prNumber, token);
    // No issues found — delete existing comment and stop
    if (review && review.findings.length === 0) {
        if (existingCommentId) {
            await deleteComment(repo, existingCommentId, token);
            core.info('Deleted previous review comment (no issues found)');
        }
        return;
    }
    const sections = [`### AI Code Review\n\n<sub>Model: ${modelShort}</sub>\n`];
    if (review) {
        const { critical, warning, suggestion } = severityTally(review);
        const tally = [
            critical ? `🚨 ${critical} critical${critical === 1 ? '' : 's'}` : null,
            warning ? `⚠️ ${warning} warning${warning === 1 ? '' : 's'}` : null,
            suggestion ? `💡 ${suggestion} suggestion${suggestion === 1 ? '' : 's'}` : null,
        ].filter(Boolean).join(' · ');
        sections.push(`\n${tally}\n`);
        sections.push(`\n${renderReview(review)}`);
    }
    else if (!usedModel) {
        sections.push(`\nNo review content returned from any model.`);
    }
    else if (config.promptMode === 'replace' && lastRawContent) {
        sections.push(`\n**Note:** The model's response did not match the expected JSON schema; showing raw output.\n\n\`\`\`\n${lastRawContent}\n\`\`\``);
    }
    if (truncated) {
        sections.push(`\n---\nReached max file limit (${config.maxFiles}); ${reviewableFiles.length - config.maxFiles} files skipped.`);
    }
    await postComment(repo, prNumber, token, sections.join('\n'));
}
run().catch(err => {
    core.setFailed(err instanceof Error ? err.message : String(err));
});
