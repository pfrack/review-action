import * as core from '@actions/core';
import { OpenAIClient } from './openai-client.js';
import { loadConfig } from './config.js';
import { fetchDiff, shouldExclude, validateFindings, DiffTooLargeError } from './review.js';
import { renderReview, severityTally } from './render.js';
import { postComment, findExistingComment, deleteComment, findExistingReview, deleteReview, AI_REVIEW_MARKER, createReview, shouldUseInlineComments, cleanupInlineReview, INLINE_COMMENT_THRESHOLD } from './github-review.js';
import { listReviewThreads } from './github-graphql.js';
import { formatPreviousFindings } from './previous-findings.js';
import { buildSystemMessage, languageForFile } from './prompts.js';
import { loadEvent } from './event.js';
import { buildCombinedChain } from './model-chain.js';
import { probeModels } from './model-chain.js';
import { ReviewSchema, ReviewJsonSchema } from './review-schema.js';
import { safeParseJson, validateProviderUrl, escapeMarkdown } from './utils.js';
import { parseRules, validateRules } from './rules.js';
import { formatMetrics } from './metrics.js';
import { batchFiles, mergeFindings } from './batching.js';
export async function withAggregateTimeout(operation, timeoutMs) {
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
const MAX_OUTPUT_TOKENS_CAP = 16384;
/**
 * Compute the output token limit for a model call.
 *
 * When `explicitMaxTokens > 0`, that value is honoured (capped at 16384).
 * Otherwise the limit scales with the input diff size so that large reviews
 * (many files / large diffs) get enough output tokens to produce a complete
 * JSON findings array instead of being truncated at `finish_reason: 'length'`.
 *
 * Scaling rule:
 *   inputTokens = ceil(diffLength / 3)   (conservative 3 chars/token)
 *   output      = 4096 + min(inputTokens, 8000)
 *   result      = min(output, 16384)
 */
export function computeMaxTokens(combinedDiff, explicitMaxTokens) {
    if (explicitMaxTokens > 0) {
        return Math.min(explicitMaxTokens, MAX_OUTPUT_TOKENS_CAP);
    }
    const inputTokens = Math.ceil(combinedDiff.length / 3);
    const scaledOutput = 4096 + Math.min(inputTokens, 12288);
    return Math.min(scaledOutput, MAX_OUTPUT_TOKENS_CAP);
}
function delay(ms, signal) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(), ms);
        signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
        }, { once: true });
    });
}
/**
 * Attempt a single model: chat → truncation check → schema validation (+ retry) → finding validation.
 * Returns a BatchResult on partial-or-full failure (with lastRawContent), or null if the model
 * should be skipped entirely (timeout, truncation with no extractable JSON, empty response).
 */
async function attemptModel(tagged, client, batch, userMsg, systemMessage, responseFormat, config, modelTimeoutMs, maxTokens, externalSignal) {
    try {
        const isTextModeModel = /\bstep-\d/.test(tagged.id);
        // Text-mode models (step-*) need extra headroom because the JSON is
        // extracted from the natural response, which tends to be more verbose.
        const effectiveMaxTokens = isTextModeModel ? Math.max(maxTokens, 8192) : maxTokens;
        core.info(`Trying ${tagged.id} (${tagged.provider})...`);
        const initSignals = modelTimeoutMs > 0 ? [AbortSignal.timeout(modelTimeoutMs)] : [];
        if (externalSignal)
            initSignals.push(externalSignal);
        const attemptSignal = initSignals.length > 0 ? AbortSignal.any(initSignals) : undefined;
        const result = await client.chat(tagged.id, [
            { role: 'system', content: systemMessage },
            { role: 'user', content: userMsg },
        ], {
            temperature: 0.2,
            maxTokens: effectiveMaxTokens,
            schema: ReviewJsonSchema,
            format: providerToFormat(tagged.provider, responseFormat),
            signal: attemptSignal,
        });
        if (result.finishReason === 'length') {
            // For text-mode models, extractJsonFromText (inside chat) may
            // have pulled a complete JSON object from the response *before*
            // the model's thinking stream hit the token cap. Don't throw
            // that away — validate it. For non-text-mode models the JSON is
            // definitely incomplete, so skip immediately.
            if (!safeParseJson(result.content)) {
                core.info(`${tagged.id} response truncated, trying next...`);
                return null;
            }
            core.info(`${tagged.id} response truncated but JSON was extractable, proceeding to validation`);
        }
        if (!result.content || !result.content.trim()) {
            core.info(`${tagged.id} returned empty, trying next...`);
            return null;
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
            const retrySignals = modelTimeoutMs > 0 ? [AbortSignal.timeout(modelTimeoutMs)] : [];
            if (externalSignal)
                retrySignals.push(externalSignal);
            const retrySignal = retrySignals.length > 0 ? AbortSignal.any(retrySignals) : undefined;
            const retryResult = await client.chat(tagged.id, [
                { role: 'system', content: systemMessage },
                { role: 'user', content: userMsg },
                { role: 'assistant', content: truncatedContent },
                { role: 'user', content: `Your previous response was not valid JSON matching the required schema. ${parsed.error.issues.length} validation error(s) occurred:\n${errorSummary}\nPlease respond with valid JSON matching the schema.` },
            ], {
                temperature: 0.2,
                maxTokens: effectiveMaxTokens,
                schema: ReviewJsonSchema,
                format: providerToFormat(tagged.provider, responseFormat),
                signal: retrySignal,
            });
            if (retryResult.finishReason === 'length') {
                core.info(`${tagged.id} retry truncated, trying next...`);
                return null;
            }
            parsed = ReviewSchema.safeParse(safeParseJson(retryResult.content));
            if (!parsed.success) {
                core.info(`${tagged.id} JSON validation failed after retry, trying next...`);
                return { findings: [], summary: '', usedModel: tagged.id, lastRawContent: retryResult.content, dropped: 0 };
            }
        }
        const batchReview = parsed.data;
        const changedFiles = new Set(batch.files);
        const validated = await validateFindings(batchReview, batch.diffs, changedFiles, config.revalidateFindings ? client : undefined, config.revalidateFindings ? tagged.id : undefined, config);
        for (const warning of validated.warnings)
            core.warning(warning);
        core.info(`Done with ${tagged.id} (${tagged.provider})`);
        return {
            findings: validated.valid.findings,
            summary: validated.valid.summary ?? '',
            usedModel: tagged.id,
            lastRawContent: '',
            dropped: validated.dropped,
        };
    }
    catch (err) {
        core.info(`${tagged.id} (${tagged.provider}) failed: ${err}`);
        return null;
    }
}
export async function runModelChainForBatch(chain, clients, batch, systemMessage, responseFormat, config, modelTimeoutMs = 60_000) {
    const combinedDiff = batch.files.map(f => `\n--- ${f} ---\n${batch.diffs[f]}\n`).join('');
    const userMsg = `Review the following code changes:\n\n\`\`\`diff\n${combinedDiff}\n\`\`\``;
    const maxTokens = computeMaxTokens(combinedDiff, config.maxTokens);
    const availableChain = chain.filter(tagged => clients[tagged.provider]);
    let batchReview = null;
    let batchUsedModel = '';
    let batchLastRawContent = '';
    let batchDropped = 0;
    const parallelEnabled = config.parallelAttempts > 1 && availableChain.length > 1;
    if (parallelEnabled) {
        const parallelCount = Math.min(config.parallelAttempts, availableChain.length);
        const controller = new AbortController();
        const attemptPromises = [];
        const attemptModelIds = [];
        for (let i = 0; i < parallelCount; i++) {
            const tagged = availableChain[i];
            const client = clients[tagged.provider];
            const delayMs = i * config.parallelThreshold * 1000;
            attemptModelIds.push(tagged.id);
            attemptPromises.push((async () => {
                if (delayMs > 0) {
                    try {
                        await delay(delayMs, controller.signal);
                    }
                    catch {
                        return null;
                    }
                }
                if (controller.signal.aborted)
                    return null;
                const result = await attemptModel(tagged, client, batch, userMsg, systemMessage, responseFormat, config, modelTimeoutMs, maxTokens, controller.signal);
                if (result && result.findings.length > 0)
                    controller.abort();
                return result;
            })());
        }
        const settled = await Promise.all(attemptPromises.map(p => p.catch(() => null)));
        let winner = null;
        let fallbackContent = '';
        let fallbackModel = '';
        for (const r of settled) {
            if (r && r.findings.length > 0) {
                winner = r;
                break;
            }
            if (r && r.lastRawContent && !fallbackContent) {
                fallbackContent = r.lastRawContent;
                fallbackModel = r.usedModel;
            }
        }
        if (winner && parallelCount > 1) {
            const cancelledIds = attemptModelIds.filter((_id, idx) => settled[idx] === null);
            core.info(`Parallel: ${winner.usedModel} won; cancelled ${cancelledIds.join(', ')}`);
        }
        if (winner) {
            batchReview = { findings: winner.findings, summary: winner.summary };
            batchUsedModel = winner.usedModel;
            batchDropped = winner.dropped;
        }
        else if (fallbackContent) {
            // All parallel attempts failed but we captured raw content.
            // Continue to remaining chain sequentially; fallthrough overwrites
            // batchLastRawContent if a later model produces valid findings.
            batchLastRawContent = fallbackContent;
            batchUsedModel = fallbackModel;
            for (let i = parallelCount; i < availableChain.length; i++) {
                const tagged = availableChain[i];
                const client = clients[tagged.provider];
                const result = await attemptModel(tagged, client, batch, userMsg, systemMessage, responseFormat, config, modelTimeoutMs, maxTokens, undefined);
                if (result) {
                    if (result.findings.length > 0) {
                        batchReview = { findings: result.findings, summary: result.summary };
                        batchUsedModel = result.usedModel;
                        batchDropped = result.dropped;
                        batchLastRawContent = '';
                        break;
                    }
                    if (result.lastRawContent)
                        batchLastRawContent = result.lastRawContent;
                    if (result.usedModel)
                        batchUsedModel = result.usedModel;
                }
            }
        }
        else {
            // No winner, no fallback — try remaining chain sequentially
            for (let i = parallelCount; i < availableChain.length; i++) {
                const tagged = availableChain[i];
                const client = clients[tagged.provider];
                const result = await attemptModel(tagged, client, batch, userMsg, systemMessage, responseFormat, config, modelTimeoutMs, maxTokens, undefined);
                if (result) {
                    if (result.findings.length > 0) {
                        batchReview = { findings: result.findings, summary: result.summary };
                        batchUsedModel = result.usedModel;
                        batchDropped = result.dropped;
                        break;
                    }
                    if (result.lastRawContent)
                        batchLastRawContent = result.lastRawContent;
                    if (result.usedModel)
                        batchUsedModel = result.usedModel;
                }
            }
        }
    }
    else {
        // Sequential fallback (original behavior)
        for (const tagged of availableChain) {
            const client = clients[tagged.provider];
            const result = await attemptModel(tagged, client, batch, userMsg, systemMessage, responseFormat, config, modelTimeoutMs, maxTokens, undefined);
            if (result) {
                if (result.findings.length > 0) {
                    batchReview = { findings: result.findings, summary: result.summary };
                    batchUsedModel = result.usedModel;
                    batchDropped = result.dropped;
                    break;
                }
                // Validation failed after retry — preserve lastRawContent
                if (result.lastRawContent)
                    batchLastRawContent = result.lastRawContent;
                if (result.usedModel)
                    batchUsedModel = result.usedModel;
            }
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
    if (config.customModelsBaseUrl && config.customModelsBaseUrl !== config.customApiUrl) {
        validateProviderUrl(config.customModelsBaseUrl, 'custom_models_base_url');
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
export function buildRawOutputBody(summaryBody, lastRawContent) {
    return `${summaryBody}\n**Note:** The model's response did not match the expected JSON schema; showing raw output.\n\`\`\`\`\`\n${escapeMarkdown(lastRawContent)}\n\`\`\`\`\``;
}
export function buildClients(config) {
    const hasCustom = !!(config.customApiUrl && (config.customModel || config.customModels.length > 0));
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
export async function prioritizeChain(chain, clients) {
    try {
        const probed = await probeModels(chain, clients);
        if (probed) {
            core.info(`Probe: ${probed.id} (${probed.provider}) — fastest available`);
        }
        else {
            core.info(`Probe: no model available, using SWE-bench chain order`);
        }
    }
    catch (probeErr) {
        core.warning(`Model probing failed, using original chain order: ${probeErr}`);
    }
}
export async function executeReview(chain, clients, filesToReview, filesDiffMap, batches, systemMessage, config) {
    const work = batches.length > 1 ? batches : [{ files: filesToReview, diffs: filesDiffMap }];
    const batchResults = [];
    const modelTimeoutMs = config.modelTimeout * 1000;
    for (const batch of work) {
        if (batches.length > 1) {
            core.info(`Processing batch ${batchResults.length + 1}/${batches.length} (${batch.files.length} files)`);
        }
        const runBatch = () => runModelChainForBatch(chain, clients, batch, systemMessage, 'json_schema', config, modelTimeoutMs);
        let result;
        try {
            result = config.chainTimeout > 0
                ? await withAggregateTimeout(runBatch, config.chainTimeout * 1000)
                : await runBatch();
        }
        catch (err) {
            core.warning(`Batch ${batchResults.length + 1}/${batches.length} failed: ${err} — ${batch.files.length} file(s) dropped`);
            result = null;
        }
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
export async function dispatchOutput(context) {
    const { repo, prNumber, token, config, review, reviewableFiles, truncated, usedModel, lastRawContent, commitSha } = context;
    const modelShort = usedModel.split('/').pop() || usedModel;
    const { critical, warning, suggestion } = severityTally(review);
    const tally = [
        critical ? `🚨 ${critical} critical${critical === 1 ? '' : 's'}` : null,
        warning ? `⚠️ ${warning} warning${warning === 1 ? '' : 's'}` : null,
        suggestion ? `💡 ${suggestion} suggestion${suggestion === 1 ? '' : 's'}` : null,
    ].filter(Boolean).join(' · ');
    const modelLabel = modelShort || 'Unavailable (no model completed)';
    const summaryBody = `${AI_REVIEW_MARKER}\n\n<sub>Model: ${modelLabel}</sub>\n\n${tally || 'No findings'}\n`;
    if (review.findings.length === 0) {
        // No findings: remove any prior output and post a friendly note.
        // Inline mode has nothing to anchor here, so it shares the summary
        // cleanup path (the prior review, if any, is removed).
        await safeCleanup(repo, prNumber, token);
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
        body = buildRawOutputBody(summaryBody, lastRawContent);
    }
    // Inline mode: auto-resolve outdated threads, then post line-anchored
    // review comments. Any cleanup failure or too-many-findings case falls
    // back to the summary path below — users always get output.
    if (config.commentMode === 'inline') {
        const cleanup = await cleanupInlineReview(repo, prNumber, token);
        if (cleanup.failed) {
            core.warning('Inline cleanup failed; falling back to summary mode for this run');
        }
        else if (shouldUseInlineComments(review.findings)) {
            try {
                await createReview(repo, prNumber, commitSha, review.findings, body, token);
                core.info(`Posted inline review with ${review.findings.length} finding(s)`);
                return { critical, warning, suggestion };
            }
            catch (err) {
                core.warning(`Failed to post inline review: ${err instanceof Error ? err.message : String(err)} — falling back to summary mode`);
            }
        }
        else {
            core.warning(`More than ${INLINE_COMMENT_THRESHOLD} inline comments would be posted; falling back to summary mode`);
        }
        // fall through to summary path below
    }
    // Summary path (unchanged for comment_mode: summary / unset).
    await safeCleanup(repo, prNumber, token);
    try {
        await postComment(repo, prNumber, token, body);
        core.info(`Posted comment with ${review.findings.length} finding(s)`);
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
export async function run() {
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
        customSweScore: config.customSweScore,
    });
    const event = loadEvent();
    const prNumber = event.pull_request.number;
    const commitSha = event.pull_request.head.sha;
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
    const filteredRules = rulesValidation.blockedRules.length > 0
        ? rules.filter((_, idx) => !rulesValidation.blockedRules.includes(idx))
        : rules;
    if (rulesValidation.blockedRules.length > 0) {
        core.info(`Blocked ${rulesValidation.blockedRules.length} custom rule(s) matching prompt-injection patterns`);
    }
    if (filteredRules.length > 0)
        core.info(`Loaded ${filteredRules.length} custom rule(s)`);
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
    // Load previous review threads to feed into the model as context.
    // Failure is non-fatal: if the GraphQL call fails (no permission,
    // network error), the run continues with no carry-over.
    let previousFindingsBlock = '';
    try {
        const previousThreads = await listReviewThreads(repo, prNumber, token);
        previousFindingsBlock = formatPreviousFindings(previousThreads);
        if (previousFindingsBlock) {
            core.info(`Loaded ${previousThreads.filter(t => !t.isResolved).length} unresolved previous finding(s) as carry-over context`);
        }
    }
    catch (err) {
        core.warning(`Could not load previous findings; continuing without carry-over context: ${err instanceof Error ? err.message : String(err)}`);
    }
    const systemMessage = buildSystemMessage(config.promptMode, config.systemPrompt, detectedLanguage, filteredRules, previousFindingsBlock);
    const result = await executeReview(chain, clients, filesToReview, filesDiffMap, batches, systemMessage, config);
    const counts = await dispatchOutput({ repo, prNumber, token, config, review: result.review, reviewableFiles, filesToReview, truncated, usedModel: result.usedModel, lastRawContent: result.lastRawContent, commitSha });
    await writeMetrics({ pr_number: prNumber, model_used: result.usedModel.split('/').pop() || result.usedModel, findings_count: counts, files_reviewed: filesToReview.length, review_duration_ms: Date.now() - reviewStartTime, validation_dropped: result.validationDropped, batch_count: result.batchCount });
}
const inTest = process.argv.includes('--test') || !!process.env.NODE_TEST_CONTEXT;
if (!inTest) {
    run().catch(err => {
        core.setFailed(err instanceof Error ? err.message : String(err));
    });
}
