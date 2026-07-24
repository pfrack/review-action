import * as core from '@actions/core';
import { OpenAIClient } from './openai-client.js';
import { loadConfig, fetchDiff, postComment, findExistingComment, deleteComment, shouldExclude, validateFindings, renderReview, severityTally, DiffTooLargeError } from './review.js';
import { buildSystemMessage, languageForFile } from './prompts.js';
import { loadEvent } from './event.js';
import { buildCombinedChain } from './model-chain.js';
import { probeModels } from './model-chain.js';
import { ReviewSchema, ReviewJsonSchema } from './review-schema.js';
import { safeParseJson } from './utils.js';
import { parseRules, validateRules } from './rules.js';
import { createReview, shouldUseInlineComments, findExistingReview, deleteReview, AI_REVIEW_MARKER } from './github-review.js';
import { formatMetrics } from './metrics.js';
import { batchFiles, mergeFindings } from './batching.js';
async function cleanupPreviousOutput(repo, prNumber, token) {
    const existingReviewId = await findExistingReview(repo, prNumber, token);
    if (existingReviewId) {
        await deleteReview(repo, prNumber, existingReviewId, token);
    }
    const existingCommentId = await findExistingComment(repo, prNumber, token);
    if (existingCommentId) {
        await deleteComment(repo, existingCommentId, token);
    }
}
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
    const commitSha = event.pull_request.head.sha;
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
    // Parse and validate custom rules
    const rules = parseRules(config.customRules);
    const rulesValidation = validateRules(rules);
    if (!rulesValidation.valid) {
        for (const err of rulesValidation.errors)
            core.warning(err);
    }
    if (rules.length > 0) {
        core.info(`Loaded ${rules.length} custom rule(s)`);
    }
    const reviewStartTime = Date.now();
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
    // Detect most common language for prompt selection
    const langCounts = {};
    for (const filePath of filesToReview) {
        const lang = languageForFile(filePath);
        langCounts[lang] = (langCounts[lang] || 0) + 1;
    }
    const detectedLanguage = Object.entries(langCounts)
        .filter(([lang]) => lang !== 'generic')
        .sort(([a, countA], [b, countB]) => countB - countA || a.localeCompare(b))[0]?.[0];
    if (detectedLanguage) {
        core.info(`Detected language: ${detectedLanguage}`);
    }
    // Probe models in parallel to find the fastest, move it to front of chain
    try {
        const fastest = await probeModels(chain, clients);
        if (fastest) {
            const fastestIndex = chain.findIndex(m => m.id === fastest.id && m.provider === fastest.provider);
            if (fastestIndex > 0) {
                const [fastestModel] = chain.splice(fastestIndex, 1);
                chain.unshift(fastestModel);
                core.info(`Fastest model: ${fastestModel.id} (${fastestModel.provider}) — moved to front of chain`);
            }
        }
    }
    catch (probeErr) {
        core.warning(`Model probing failed, using original chain order: ${probeErr}`);
    }
    function providerToFormat(provider) {
        if (provider === 'mistral')
            return 'tools';
        return 'json_schema';
    }
    const BATCH_SIZE = 50;
    if (filesToReview.length === 0) {
        core.info('No files to review');
        return;
    }
    // Build diff map and split into batches if needed
    const filesDiffMap = {};
    for (const f of filesToReview) {
        filesDiffMap[f] = filesDiff[f] || '';
    }
    const batches = filesToReview.length > BATCH_SIZE
        ? batchFiles(filesDiffMap, BATCH_SIZE)
        : [];
    const useBatching = batches.length > 1;
    core.info(`Reviewing ${filesToReview.length} files${useBatching ? ` in ${batches.length} batches` : ''}...`);
    async function runModelChainForBatch(batchFileList, batchDiffMap) {
        const combinedDiff = batchFileList.map(f => `\n--- ${f} ---\n${batchDiffMap[f]}\n`).join('');
        const userMsg = `Review the following code changes:\n\n\`\`\`diff\n${combinedDiff}\n\`\`\``;
        let batchReview = null;
        let batchUsedModel = '';
        let batchLastRawContent = '';
        let batchDropped = 0;
        for (const tagged of chain) {
            const client = clients[tagged.provider];
            if (!client)
                continue;
            try {
                core.info(`Trying ${tagged.id} (${tagged.provider})...`);
                const result = await client.chat(tagged.id, [
                    {
                        role: 'system',
                        content: buildSystemMessage(config.promptMode, config.systemPrompt, detectedLanguage, rules),
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
                    // Retry once with validation error appended
                    core.info(`${tagged.id} schema validation failed, retrying...`);
                    const truncatedContent = result.content.length > 500
                        ? '...' + result.content.slice(-500)
                        : result.content;
                    const errorSummary = parsed.error.issues.slice(0, 3).map(i => `- ${i.path.join('.')}: ${i.message}`).join('\n');
                    const retryResult = await client.chat(tagged.id, [
                        {
                            role: 'system',
                            content: buildSystemMessage(config.promptMode, config.systemPrompt, detectedLanguage, rules),
                        },
                        { role: 'user', content: userMsg },
                        { role: 'assistant', content: truncatedContent },
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
                        batchLastRawContent = retryResult.content;
                        core.info(`${tagged.id} JSON validation failed after retry, trying next...`);
                        continue;
                    }
                }
                // Both first-attempt and retry success paths converge here
                batchReview = parsed.data;
                const changedFiles = new Set(batchFileList);
                const validated = await validateFindings(batchReview, batchDiffMap, changedFiles, config.revalidateFindings ? client : undefined, config.revalidateFindings ? tagged.id : undefined);
                for (const w of validated.warnings)
                    core.warning(w);
                batchReview = validated.valid;
                batchDropped = validated.dropped;
                batchUsedModel = tagged.id;
                core.info(`Done with ${tagged.id} (${tagged.provider})`);
                break;
            }
            catch (err) {
                core.info(`${tagged.id} (${tagged.provider}) failed: ${err}`);
            }
        }
        return {
            findings: batchReview?.findings ?? [],
            summary: batchReview?.summary ?? '',
            usedModel: batchUsedModel,
            lastRawContent: batchLastRawContent,
            dropped: batchDropped,
        };
    }
    let review = null;
    let usedModel = '';
    let lastRawContent = '';
    let validationDropped = 0;
    if (useBatching) {
        const batchResults = [];
        for (const batch of batches) {
            core.info(`Processing batch ${batchResults.length + 1}/${batches.length} (${batch.files.length} files)`);
            const result = await runModelChainForBatch(batch.files, batch.diffs);
            batchResults.push(result);
        }
        const merged = mergeFindings(batchResults.map(r => ({ findings: r.findings, summary: r.summary })));
        review = { findings: merged.findings, summary: merged.summary };
        usedModel = batchResults.find(r => r.usedModel)?.usedModel || '';
        lastRawContent = batchResults.find(r => r.lastRawContent)?.lastRawContent || '';
        validationDropped = batchResults.reduce((sum, r) => sum + r.dropped, 0);
    }
    else {
        const singleResult = await runModelChainForBatch(filesToReview, filesDiffMap);
        review = { findings: singleResult.findings, summary: singleResult.summary };
        usedModel = singleResult.usedModel;
        lastRawContent = singleResult.lastRawContent;
        validationDropped = singleResult.dropped;
    }
    const modelShort = usedModel.split('/').pop() || usedModel;
    const reviewDuration = Date.now() - reviewStartTime;
    // No issues found — clean up any existing review/comment and stop
    if (review && review.findings.length === 0) {
        await cleanupPreviousOutput(repo, prNumber, token);
        core.info('Deleted previous review (no issues found)');
        return;
    }
    const { critical, warning, suggestion } = review ? severityTally(review) : { critical: 0, warning: 0, suggestion: 0 };
    const tally = [
        critical ? `🚨 ${critical} critical${critical === 1 ? '' : 's'}` : null,
        warning ? `⚠️ ${warning} warning${warning === 1 ? '' : 's'}` : null,
        suggestion ? `💡 ${suggestion} suggestion${suggestion === 1 ? '' : 's'}` : null,
    ].filter(Boolean).join(' · ');
    const summaryBody = `${AI_REVIEW_MARKER}\n\n<sub>Model: ${modelShort}</sub>\n\n${tally || 'No findings'}\n`;
    if (review && review.findings.length > 0) {
        if (shouldUseInlineComments(review.findings)) {
            // Post findings as inline review comments
            await cleanupPreviousOutput(repo, prNumber, token);
            let body = `${summaryBody}\n${renderReview(review)}\n`;
            if (truncated) {
                body += `\n---\nReached max file limit (${config.maxFiles}); ${reviewableFiles.length - config.maxFiles} files skipped.`;
            }
            const reviewId = await createReview(repo, prNumber, commitSha, review.findings, body, token);
            core.info(`Created review #${reviewId} with ${review.findings.length} inline comments`);
        }
        else {
            // Too many findings for inline comments — post summary comment instead
            await cleanupPreviousOutput(repo, prNumber, token);
            const sections = [summaryBody];
            sections.push(`\n${renderReview(review)}\n`);
            if (truncated) {
                sections.push(`\n---\nReached max file limit (${config.maxFiles}); ${reviewableFiles.length - config.maxFiles} files skipped.`);
            }
            await postComment(repo, prNumber, token, sections.join('\n'));
            core.info(`Posted summary comment with ${review.findings.length} findings (exceeds inline threshold)`);
        }
    }
    else if (!usedModel) {
        await cleanupPreviousOutput(repo, prNumber, token);
        await postComment(repo, prNumber, token, `${summaryBody}\nNo review content returned from any model.`);
    }
    else if (config.promptMode === 'replace' && lastRawContent) {
        await cleanupPreviousOutput(repo, prNumber, token);
        await postComment(repo, prNumber, token, `${summaryBody}\n**Note:** The model's response did not match the expected JSON schema; showing raw output.\n\n\`\`\`\n${lastRawContent}\n\`\`\``);
    }
    // Collect and output metrics
    const metrics = {
        pr_number: prNumber,
        model_used: modelShort,
        findings_count: { critical, warning, suggestion },
        files_reviewed: filesToReview.length,
        review_duration_ms: reviewDuration,
        validation_dropped: validationDropped,
        batch_count: useBatching ? batches.length : 1,
    };
    const stepSummary = process.env.GITHUB_STEP_SUMMARY;
    if (stepSummary) {
        try {
            const fs = await import('node:fs');
            fs.appendFileSync(stepSummary, `\n${formatMetrics(metrics)}\n`);
            core.info('Metrics written to step summary');
        }
        catch (err) {
            core.warning(`Failed to write metrics to step summary: ${err}`);
        }
    }
}
const inTest = process.argv.includes('--test');
if (!inTest) {
    run().catch(err => {
        core.setFailed(err instanceof Error ? err.message : String(err));
    });
}
