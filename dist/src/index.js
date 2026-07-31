import * as core from '@actions/core';
import { OpenAIClient } from './openai-client.js';
import { loadConfig } from './config.js';
import { fetchDiff, shouldExclude, validateFindings, DiffTooLargeError } from './review.js';
import { renderReview, severityTally } from './render.js';
import { postComment, findExistingComment, deleteComment, findExistingReview, deleteReview, AI_REVIEW_MARKER } from './github-review.js';
import { buildSystemMessage, languageForFile } from './prompts.js';
import { loadEvent } from './event.js';
import { buildCombinedChain } from './model-chain.js';
import { probeModels } from './model-chain.js';
import { ReviewSchema, ReviewJsonSchema } from './review-schema.js';
import { safeParseJson, validateProviderUrl } from './utils.js';
import { parseRules, validateRules } from './rules.js';
import { formatMetrics } from './metrics.js';
import { batchFiles, mergeFindings } from './batching.js';
const CHAIN_TIMEOUT_MS = 120_000;
export async function withAggregateTimeout(operation, timeoutMs = CHAIN_TIMEOUT_MS) {
    let timer;
    try {
        return await Promise.race([
            operation(),
            new Promise(resolve => {
                timer = setTimeout(() => {
                    core.warning(`Model chain timed out after ${timeoutMs}ms`);
                    resolve(null);
                }, timeoutMs);
            }),
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
async function cleanupPreviousOutput(repo, prNumber, token) {
    // Delete ALL AI-generated comments (not just the first one)
    let commentId;
    while ((commentId = await findExistingComment(repo, prNumber, token)) !== null) {
        await deleteComment(repo, commentId, token);
    }
    // Delete ALL AI-generated reviews (deleting the review removes its inline comments)
    let reviewId;
    while ((reviewId = await findExistingReview(repo, prNumber, token)) !== null) {
        await deleteReview(repo, prNumber, reviewId, token);
    }
}
function providerToFormat(provider, responseFormat) {
    return provider === 'mistral' ? 'tools' : responseFormat;
}
export async function runModelChainForBatch(chain, clients, batch, systemMessage, responseFormat, config) {
    const combinedDiff = batch.files.map(f => `\n--- ${f} ---\n${batch.diffs[f]}\n`).join('');
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
                { role: 'system', content: systemMessage },
                { role: 'user', content: userMsg },
            ], {
                temperature: 0.2,
                maxTokens: 4096,
                schema: ReviewJsonSchema,
                format: providerToFormat(tagged.provider, responseFormat),
            });
            if (result.finishReason === 'length') {
                core.info(`${tagged.id} response truncated, trying next...`);
                continue;
            }
            if (!result.content || !result.content.trim()) {
                core.info(`${tagged.id} returned empty, trying next...`);
                continue;
            }
            let parsed = ReviewSchema.safeParse(safeParseJson(result.content));
            if (!parsed.success) {
                core.info(`${tagged.id} schema validation failed, retrying...`);
                const truncatedContent = result.content.length > 500
                    ? '...' + result.content.slice(-500)
                    : result.content;
                const errorSummary = parsed.error.issues.slice(0, 3)
                    .map(i => `- ${i.path.join('.') || 'root'}: invalid value`)
                    .join('\n');
                const retryResult = await client.chat(tagged.id, [
                    { role: 'system', content: systemMessage },
                    { role: 'user', content: userMsg },
                    { role: 'assistant', content: truncatedContent },
                    { role: 'user', content: `Your previous response was not valid JSON matching the required schema. ${parsed.error.issues.length} validation error(s) occurred:\n${errorSummary}\nPlease respond with valid JSON matching the schema.` },
                ], {
                    temperature: 0.2,
                    maxTokens: 4096,
                    schema: ReviewJsonSchema,
                    format: providerToFormat(tagged.provider, responseFormat),
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
            batchReview = parsed.data;
            const changedFiles = new Set(batch.files);
            const validated = await validateFindings(batchReview, batch.diffs, changedFiles, config.revalidateFindings ? client : undefined, config.revalidateFindings ? tagged.id : undefined);
            for (const warning of validated.warnings)
                core.warning(warning);
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
function validateConfig(config) {
    const hasCustom = !!(config.customApiUrl && config.customModel);
    const hasCustomModels = !!(config.customApiUrl && config.customModels.length > 0);
    if (config.apiKey)
        core.setSecret(config.apiKey);
    if (config.mistralApiKey)
        core.setSecret(config.mistralApiKey);
    if (config.groqApiKey)
        core.setSecret(config.groqApiKey);
    if (config.openRouterApiKey)
        core.setSecret(config.openRouterApiKey);
    if (config.kiloApiKey)
        core.setSecret(config.kiloApiKey);
    if (config.customApiKey)
        core.setSecret(config.customApiKey);
    if (config.customApiUrl) {
        const url = new URL(config.customApiUrl);
        const isLoopback = url.hostname === 'localhost'
            || url.hostname === '127.0.0.1'
            || url.hostname === '::1'
            || url.hostname === '0.0.0.0';
        if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
            throw new Error('custom_api_url must use https:// (or http:// for localhost only)');
        }
        validateProviderUrl(config.customApiUrl, 'custom_api_url');
    }
    if (config.openRouterBaseUrl)
        validateProviderUrl(config.openRouterBaseUrl, 'openrouter_base_url');
    if (config.kiloBaseUrl)
        validateProviderUrl(config.kiloBaseUrl, 'kilocode_base_url');
    if (config.baseURL)
        validateProviderUrl(config.baseURL, 'nim_base_url');
    if (config.mistralBaseUrl)
        validateProviderUrl(config.mistralBaseUrl, 'mistral_base_url');
    if (config.groqBaseUrl)
        validateProviderUrl(config.groqBaseUrl, 'groq_base_url');
    if (!config.apiKey && !config.mistralApiKey && !config.groqApiKey && !config.openRouterApiKey && !config.kiloApiKey && !hasCustom && !hasCustomModels) {
        throw new Error('At least one of nim_api_key, mistral_api_key, groq_api_key, openrouter_api_key, kilocode_api_key, or custom_api_url + custom_model/custom_models is required');
    }
    if (hasCustom && !config.apiKey && !config.mistralApiKey && !config.groqApiKey && !config.openRouterApiKey && !config.kiloApiKey) {
        core.info('Running with only custom API configured — no fallback chain available if custom model fails');
    }
    if (hasCustomModels && !hasCustom && !config.apiKey && !config.mistralApiKey && !config.groqApiKey && !config.openRouterApiKey && !config.kiloApiKey) {
        core.info('Running with only custom API configured — no fallback chain available if custom model fails');
    }
}
function buildClients(config) {
    const hasCustom = !!(config.customApiUrl && config.customModel);
    return {
        nim: config.apiKey ? new OpenAIClient(config.baseURL, config.apiKey, 'NIM') : null,
        mistral: config.mistralApiKey ? new OpenAIClient(config.mistralBaseUrl, config.mistralApiKey, 'Mistral') : null,
        groq: config.groqApiKey ? new OpenAIClient(config.groqBaseUrl, config.groqApiKey, 'Groq') : null,
        openrouter: config.openRouterApiKey ? new OpenAIClient(config.openRouterBaseUrl, config.openRouterApiKey, 'OpenRouter') : null,
        kilocode: config.kiloApiKey ? new OpenAIClient(config.kiloBaseUrl, config.kiloApiKey, 'Kilo') : null,
        custom: hasCustom ? new OpenAIClient(config.customApiUrl, config.customApiKey, 'Custom') : null,
    };
}
export function detectLanguage(files) {
    const langCounts = {};
    for (const filePath of files) {
        const language = languageForFile(filePath);
        langCounts[language] = (langCounts[language] || 0) + 1;
    }
    return Object.entries(langCounts)
        .filter(([language]) => language !== 'generic')
        .sort(([a, countA], [b, countB]) => countB - countA || a.localeCompare(b))[0]?.[0];
}
async function prioritizeChain(chain, clients) {
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
}
async function executeReview(chain, clients, filesToReview, filesDiffMap, batches, systemMessage, config) {
    const work = batches.length > 1 ? batches : [{ files: filesToReview, diffs: filesDiffMap }];
    const batchResults = [];
    for (const batch of work) {
        if (batches.length > 1) {
            core.info(`Processing batch ${batchResults.length + 1}/${batches.length} (${batch.files.length} files)`);
        }
        const result = await withAggregateTimeout(() => runModelChainForBatch(chain, clients, batch, systemMessage, 'json_schema', config));
        if (result === null) {
            core.warning(`Batch ${batchResults.length + 1}/${batches.length} timed out — ${batch.files.length} file(s) dropped`);
        }
        batchResults.push(result ?? { findings: [], summary: '', usedModel: '', lastRawContent: '', dropped: 0 });
    }
    if (batches.length > 1) {
        const merged = mergeFindings(batchResults.map(result => ({ findings: result.findings, summary: result.summary })));
        return {
            review: { findings: merged.findings, summary: merged.summary },
            usedModel: batchResults.find(result => result.usedModel)?.usedModel || '',
            lastRawContent: batchResults.find(result => result.lastRawContent)?.lastRawContent || '',
            validationDropped: batchResults.reduce((sum, result) => sum + result.dropped, 0),
            batchCount: batches.length,
        };
    }
    const result = batchResults[0];
    return {
        review: { findings: result.findings, summary: result.summary },
        usedModel: result.usedModel,
        lastRawContent: result.lastRawContent,
        validationDropped: result.dropped,
        batchCount: 1,
    };
}
async function safeCleanup(repo, prNumber, token) {
    try {
        await cleanupPreviousOutput(repo, prNumber, token);
    }
    catch (err) {
        core.warning(`Failed to clean up previous review output: ${err}`);
    }
}
async function dispatchOutput(context) {
    const { repo, prNumber, token, config, review, reviewableFiles, filesToReview, truncated, usedModel, lastRawContent } = context;
    const modelShort = usedModel.split('/').pop() || usedModel;
    const { critical, warning, suggestion } = severityTally(review);
    const tally = [
        critical ? `🚨 ${critical} critical${critical === 1 ? '' : 's'}` : null,
        warning ? `⚠️ ${warning} warning${warning === 1 ? '' : 's'}` : null,
        suggestion ? `💡 ${suggestion} suggestion${suggestion === 1 ? '' : 's'}` : null,
    ].filter(Boolean).join(' · ');
    const modelLabel = modelShort || 'Unavailable (no model completed)';
    const summaryBody = `${AI_REVIEW_MARKER}\n\n<sub>Model: ${modelLabel}</sub>\n\n${tally || 'No findings'}\n`;
    // Single cleanup at the start — removes ALL previous AI comments and reviews
    await safeCleanup(repo, prNumber, token);
    if (review.findings.length === 0) {
        try {
            const message = usedModel
                ? 'No issues found. LGTM!'
                : 'No review content returned from any model.';
            await postComment(repo, prNumber, token, `${summaryBody}\n${message}`);
            core.info(usedModel ? 'Posted LGTM comment (no issues found)' : 'Posted no-review-content comment');
        }
        catch (err) {
            core.warning(`Failed to post LGTM comment: ${err}`);
        }
        return { critical, warning, suggestion };
    }
    let body = summaryBody;
    if (usedModel) {
        const sections = [summaryBody, `\n${renderReview(review)}\n`];
        if (truncated) {
            sections.push(`\n---\nReached max file limit (${config.maxFiles}); ${reviewableFiles.length - config.maxFiles} files skipped.`);
        }
        body = sections.join('\n');
    }
    else {
        body = `${summaryBody}\nNo review content returned from any model.`;
    }
    if (config.promptMode === 'replace' && lastRawContent) {
        body = `${summaryBody}\n**Note:** The model's response did not match the expected JSON schema; showing raw output.\n\`\`\`\`\`\n${lastRawContent}\n\`\`\`\`\``;
    }
    try {
        await postComment(repo, prNumber, token, body);
        core.info(`Posted comment with ${review.findings.length} findings`);
    }
    catch (err) {
        core.warning(`Failed to post comment: ${err}`);
    }
    return { critical, warning, suggestion };
}
async function writeMetrics(metrics) {
    const stepSummary = process.env.GITHUB_STEP_SUMMARY;
    if (!stepSummary)
        return;
    try {
        const fs = await import('node:fs');
        fs.appendFileSync(stepSummary, `\n${formatMetrics(metrics)}\n`);
        core.info('Metrics written to step summary');
    }
    catch (err) {
        core.warning(`Failed to write metrics to step summary: ${err}`);
    }
}
async function run() {
    const config = await loadConfig();
    validateConfig(config);
    const clients = buildClients(config);
    const hasCustom = !!(config.customApiUrl && config.customModel);
    const chain = buildCombinedChain({
        nimModels: config.models,
        mistralModels: config.mistralModels,
        groqModels: config.groqModels,
        hasNimKey: !!config.apiKey,
        hasMistralKey: !!config.mistralApiKey,
        hasGroqKey: !!config.groqApiKey,
        openrouterModels: config.openRouterModels,
        hasOpenRouterKey: !!config.openRouterApiKey,
        kiloModels: config.kiloModels,
        hasKiloKey: !!config.kiloApiKey,
        customModel: config.customModel,
        hasCustomConfig: hasCustom,
        customModels: config.customModels,
        hasCustomModels: !!(config.customApiUrl && config.customModels.length > 0),
    });
    const event = loadEvent();
    const prNumber = event.pull_request.number;
    const repo = process.env.GITHUB_REPOSITORY;
    if (!repo)
        throw new Error('GITHUB_REPOSITORY not set');
    const token = process.env.GITHUB_TOKEN;
    if (!token)
        throw new Error('GITHUB_TOKEN not set');
    core.info(`Reviewing PR #${prNumber} in ${repo}`);
    core.info(`Combined chain: ${chain.map(m => `${m.id}(${m.provider})`).join(', ')}`);
    const rules = parseRules(config.customRules);
    const rulesValidation = validateRules(rules);
    if (!rulesValidation.valid)
        for (const err of rulesValidation.errors)
            core.warning(err);
    if (rules.length > 0)
        core.info(`Loaded ${rules.length} custom rule(s)`);
    const reviewStartTime = Date.now();
    let filesDiff;
    try {
        filesDiff = await fetchDiff(repo, prNumber, token);
    }
    catch (err) {
        if (err instanceof DiffTooLargeError) {
            try {
                await postComment(repo, prNumber, token, `### AI Code Review\n\n${err.message}`);
            }
            catch (postErr) {
                core.warning(`Failed to post diff-too-large comment: ${postErr}`);
            }
            return;
        }
        throw err;
    }
    const reviewableFiles = Object.keys(filesDiff).sort().filter(file => !shouldExclude(file, config.excludePatterns));
    if (reviewableFiles.length === 0) {
        await postComment(repo, prNumber, token, '### AI Code Review\n\nNo reviewable files found in this PR (all excluded).');
        return;
    }
    const filesToReview = reviewableFiles.slice(0, config.maxFiles);
    const truncated = reviewableFiles.length > config.maxFiles;
    core.info(`Reviewing ${filesToReview.length} files...`);
    const detectedLanguage = detectLanguage(filesToReview);
    if (detectedLanguage)
        core.info(`Detected language: ${detectedLanguage}`);
    await prioritizeChain(chain, clients);
    const filesDiffMap = {};
    for (const file of filesToReview)
        filesDiffMap[file] = filesDiff[file] || '';
    const batches = filesToReview.length > 50 ? batchFiles(filesDiffMap, 50) : [];
    const useBatching = batches.length > 1;
    core.info(`Reviewing ${filesToReview.length} files${useBatching ? ` in ${batches.length} batches` : ''}...`);
    const systemMessage = buildSystemMessage(config.promptMode, config.systemPrompt, detectedLanguage, rules);
    const result = await executeReview(chain, clients, filesToReview, filesDiffMap, batches, systemMessage, config);
    const counts = await dispatchOutput({ repo, prNumber, token, config, review: result.review, reviewableFiles, filesToReview, truncated, usedModel: result.usedModel, lastRawContent: result.lastRawContent });
    await writeMetrics({ pr_number: prNumber, model_used: result.usedModel.split('/').pop() || result.usedModel, findings_count: counts, files_reviewed: filesToReview.length, review_duration_ms: Date.now() - reviewStartTime, validation_dropped: result.validationDropped, batch_count: result.batchCount });
}
const inTest = process.argv.includes('--test') || !!process.env.NODE_TEST_CONTEXT;
if (!inTest) {
    run().catch(err => {
        core.setFailed(err instanceof Error ? err.message : String(err));
    });
}
