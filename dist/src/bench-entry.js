import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { OpenAIClient } from './openai-client.js';
import { runBenchmark, formatMarkdownTable } from './bench.js';
import { SWE_BENCH_SCORES, fetchSweBenchScores } from './bench-reorder.js';
import { readRemovedModels, writeRemovedModels } from './removed-models.js';
function envOrDefault(key, def) {
    return process.env[key] || def;
}
function splitCSV(s) {
    return s.split(',').map(item => item.trim()).filter(item => item !== '');
}
const SYNTHETIC_REVIEW_PROMPT = `You are reviewing a code change. Analyze the following diff for bugs, security issues, and performance problems. Respond in concise markdown with findings.

\`\`\`diff
func processOrder(items []Item, discount float64) Order {
    total := 0.0
    for _, item := range items {
        total += item.Price * float64(item.Quantity)
    }
    total = total * (1 - discount)
    tax := total * 0.08
    return Order{
        Items: items,
        Subtotal: total,
        Tax: tax,
        Total: total + tax,
    }
}
\`\`\``;
const TARGET_COUNT = 7;
/**
 * Read current models from action.yml
 */
function readCurrentModels(actionPath) {
    const content = readFileSync(actionPath, 'utf-8');
    const match = content.match(/nim_models:\n\s+description:[^\n]*\n\s+default:\s*'([^']*)'/);
    if (!match)
        return [];
    return splitCSV(match[1]);
}
/**
 * Get SWE-bench ranked candidates not already in the active list
 */
function getReplacements(activeModels) {
    const activeSet = new Set(activeModels);
    return Object.entries(SWE_BENCH_SCORES)
        .filter(([model]) => !activeSet.has(model))
        .sort((a, b) => b[1] - a[1])
        .map(([model]) => model);
}
/**
 * Normalize a model id for comparison: lowercase, strip org prefix, strip
 * common suffixes (instruct, chat, base, etc.) and non-alphanumerics.
 */
function normalizeModelId(id) {
    return id
        .toLowerCase()
        .replace(/^[^/]+\//, '')
        .replace(/-(instruct|chat|base|it|bf16|fp8|fp16|preview)$/i, '')
        .replace(/[^a-z0-9]/g, '');
}
/**
 * Deterministic match between a NIM model id and a leaderboard entry.
 * Returns the matched score and strategy, or null if no plausible match.
 *
 * Strategies tried in order:
 *   1. exact id match
 *   2. case-insensitive id match
 *   3. normalized id match (strip org + common suffixes)
 *   4. unique substring match in either direction on the normalized form
 */
export function deterministicMatch(nimModelId, leaderboard) {
    const lc = nimModelId.toLowerCase();
    // 1. exact match
    const exact = leaderboard.find(e => e.modelId === nimModelId);
    if (exact)
        return { score: exact.score, strategy: 'exact', matchedId: exact.modelId };
    // 2. case-insensitive match
    const ci = leaderboard.find(e => e.modelId.toLowerCase() === lc);
    if (ci)
        return { score: ci.score, strategy: 'case-insensitive', matchedId: ci.modelId };
    // 3. normalized match (strip org + suffix)
    const norm = normalizeModelId(nimModelId);
    const normMatches = leaderboard.filter(e => normalizeModelId(e.modelId) === norm);
    if (normMatches.length === 1) {
        const m = normMatches[0];
        return { score: m.score, strategy: 'normalized', matchedId: m.modelId };
    }
    // 4. unique substring match on normalized forms
    const substrMatches = leaderboard.filter(e => {
        const a = normalizeModelId(e.modelId);
        return a.includes(norm) || norm.includes(a);
    });
    if (substrMatches.length === 1) {
        const m = substrMatches[0];
        return { score: m.score, strategy: 'substring', matchedId: m.modelId };
    }
    if (substrMatches.length > 1) {
        process.stderr.write(`    ambiguous substring matches for ${nimModelId}: ${substrMatches.map(m => m.modelId).join(', ')}\n`);
    }
    return null;
}
/**
 * Use an LLM to match a NIM model ID to a SWE-bench score.
 *
 * Tries deterministic matching first (exact, case-insensitive, normalized,
 * substring). Falls back to an LLM only when no deterministic match is found.
 * Returns the matched score or null if no match found.
 */
export async function matchModelScore(client, nimModelId, leaderboard, matcherModel) {
    const det = deterministicMatch(nimModelId, leaderboard);
    if (det) {
        process.stderr.write(`    ${nimModelId} → ${det.matchedId} (${det.strategy}) score=${det.score}\n`);
        return det.score;
    }
    process.stderr.write(`    ${nimModelId}: no deterministic match, falling back to LLM\n`);
    const topModels = leaderboard.slice(0, 30).map(e => `"${e.modelId}": ${e.score}`);
    const prompt = `Given these SWE-bench Verified scores:\n${topModels.join('\n')}\n\nWhat is the score for NIM model '${nimModelId}'? Return just the numeric score (e.g. 0.75) or "none" if no match.`;
    try {
        const result = await client.chat(matcherModel, [
            { role: 'user', content: prompt },
        ], { temperature: 0, maxTokens: 16 });
        const text = result.content.trim().toLowerCase();
        if (text === 'none' || text === 'n/a') {
            process.stderr.write(`    LLM: no match for ${nimModelId}\n`);
            return null;
        }
        const score = parseFloat(text);
        if (isNaN(score) || score < 0 || score > 1) {
            process.stderr.write(`    LLM: invalid score "${text}" for ${nimModelId} (rejected, plausible range is 0-1)\n`);
            return null;
        }
        process.stderr.write(`    LLM: matched ${nimModelId} → score ${score}\n`);
        return score;
    }
    catch (err) {
        process.stderr.write(`    LLM match failed for ${nimModelId}: ${err}\n`);
        return null;
    }
}
async function probe(baseURL, apiKey, models) {
    const client = new OpenAIClient(baseURL, apiKey);
    for (const model of models) {
        process.stderr.write(`  ${model} ...`);
        const ok = await client.probeModel(model);
        if (ok) {
            process.stderr.write(' ok\n');
            console.log(`${model} ok`);
        }
        else {
            process.stderr.write(' FAIL\n');
            console.log(`${model} FAIL`);
        }
    }
}
async function main() {
    const apiKey = process.env.NIM_API_KEY;
    if (!apiKey) {
        throw new Error('NIM_API_KEY is required');
    }
    const baseURL = envOrDefault('NIM_BASE_URL', 'https://integrate.api.nvidia.com/v1');
    const actionPath = envOrDefault('ACTION_PATH', 'action.yml');
    const client = new OpenAIClient(baseURL, apiKey);
    // Fetch provider catalog to distinguish transient vs permanent failures
    let availableModels = null;
    try {
        const models = await client.listModels();
        availableModels = new Set(models);
        process.stderr.write(`Provider has ${models.length} models available\n`);
    }
    catch (err) {
        process.stderr.write(`Warning: could not fetch model list: ${err}\n`);
    }
    // Track removed-models in memory for this run. Read once at startup,
    // drop permanently-gone models, and persist the final set at the end.
    // This avoids races between multiple read/write pairs during a single run
    // and is safe because bench-entry is a single-process script.
    let removedModels = readRemovedModels();
    if (availableModels) {
        const before = removedModels.length;
        removedModels = removedModels.filter(m => availableModels.has(m));
        if (removedModels.length !== before) {
            process.stderr.write(`Cleaned ${before - removedModels.length} permanently removed model(s) from removed-models.txt\n`);
        }
    }
    // Determine models to benchmark
    let models;
    const modelsEnv = process.env.NIM_MODELS;
    if (modelsEnv) {
        models = splitCSV(modelsEnv);
    }
    else {
        // Read current top from action.yml
        models = readCurrentModels(actionPath);
        if (models.length === 0) {
            // First run — seed from SWE-bench top models
            models = Object.entries(SWE_BENCH_SCORES)
                .sort((a, b) => b[1] - a[1])
                .slice(0, TARGET_COUNT)
                .map(([model]) => model);
            process.stderr.write(`First run — seeding with top ${TARGET_COUNT} SWE-bench models\n`);
        }
        else {
            process.stderr.write(`Benchmarking current ${models.length} models from action.yml\n`);
        }
    }
    // --probe mode runs before model discovery so a probe-only invocation
    // does not trigger LLM-based score matching for newly-found models.
    if (process.argv.includes('--probe')) {
        await probe(baseURL, apiKey, models);
        return;
    }
    // Discover new models and fetch SWE-bench scores
    const fetchedScores = new Map();
    const discoveredModels = [];
    if (availableModels) {
        const knownModels = new Set([...Object.keys(SWE_BENCH_SCORES), ...models]);
        const newModels = [...availableModels].filter(m => !knownModels.has(m));
        if (newModels.length > 0) {
            process.stderr.write(`\nDiscovered ${newModels.length} new model(s) not in SWE-bench table\n`);
            const leaderboard = await fetchSweBenchScores();
            if (leaderboard.length > 0) {
                // Use the first model from the active list as the matcher
                const matcherModel = models[0];
                if (matcherModel) {
                    const maxDiscover = parseInt(envOrDefault('NIM_MAX_DISCOVER', '5'), 10);
                    for (const nimModel of newModels.slice(0, maxDiscover)) {
                        process.stderr.write(`  Matching ${nimModel} ...`);
                        const score = await matchModelScore(client, nimModel, leaderboard, matcherModel);
                        if (score !== null) {
                            process.stderr.write(` score=${score}\n`);
                            fetchedScores.set(nimModel, score);
                            discoveredModels.push(nimModel);
                        }
                        else {
                            process.stderr.write(' no match\n');
                        }
                    }
                }
            }
        }
    }
    // Add discovered models to the benchmark list
    if (discoveredModels.length > 0) {
        models = [...models, ...discoveredModels];
    }
    let iterations = 2;
    const iterEnv = process.env.NIM_BENCH_ITERATIONS;
    if (iterEnv) {
        const n = parseInt(iterEnv, 10);
        if (isNaN(n))
            throw new Error('NIM_BENCH_ITERATIONS must be an integer');
        iterations = n;
    }
    const benchPrompt = envOrDefault('NIM_BENCH_PROMPT', SYNTHETIC_REVIEW_PROMPT);
    process.stderr.write(`\nBenchmarking ${models.length} models with ${iterations} iterations...\n\n`);
    // Benchmark current models
    const results = [];
    const failed = [];
    for (const model of models) {
        process.stderr.write(`  ${model} ...`);
        const start = Date.now();
        const result = await runBenchmark(client, model, {
            prompt: benchPrompt,
            iterations,
            temperature: 0.2,
            maxTokens: 1024,
        });
        const elapsed = Date.now() - start;
        const errCount = result.iterations.filter(it => it.error !== null).length;
        const allFailed = errCount === iterations;
        if (allFailed) {
            process.stderr.write(` FAILED (${Math.round(elapsed / 1000)}s)\n`);
            failed.push(model);
        }
        else {
            process.stderr.write(` done in ${Math.round(elapsed / 1000)}s (${errCount} errors)\n`);
        }
        results.push(result);
    }
    // Replace failed models with next best from SWE-bench
    if (failed.length > 0) {
        process.stderr.write(`\n${failed.length} model(s) failed. Finding replacements...\n`);
        const replacements = getReplacements(models);
        for (const deadModel of failed) {
            let replaced = false;
            for (const candidate of replacements) {
                if (models.includes(candidate))
                    continue;
                process.stderr.write(`  Probing ${candidate} ...`);
                const ok = await client.probeModel(candidate);
                if (!ok) {
                    process.stderr.write(' FAIL, skipping\n');
                    continue;
                }
                process.stderr.write(' ok, benchmarking...');
                const result = await runBenchmark(client, candidate, {
                    prompt: benchPrompt,
                    iterations,
                    temperature: 0.2,
                    maxTokens: 1024,
                });
                const errCount = result.iterations.filter(it => it.error !== null).length;
                if (errCount === iterations) {
                    process.stderr.write(' FAILED\n');
                    continue;
                }
                process.stderr.write(` done (replacing ${deadModel})\n`);
                results.push(result);
                // Replace in models list
                const idx = models.indexOf(deadModel);
                models[idx] = candidate;
                replaced = true;
                break;
            }
            if (!replaced) {
                process.stderr.write(`  No replacement found for ${deadModel}\n`);
            }
        }
    }
    // Classify failures. Transient ones are tracked in-memory and persisted
    // together with recheck results at the end of the run.
    const transientFailed = [];
    if (failed.length > 0) {
        for (const model of failed) {
            if (availableModels && !availableModels.has(model)) {
                process.stderr.write(`  ${model}: permanently removed from provider (not retried)\n`);
            }
            else {
                process.stderr.write(`  ${model}: transient failure (will retry next run)\n`);
                transientFailed.push(model);
            }
        }
    }
    // Recheck previously removed models (concurrent with limit)
    if (removedModels.length > 0) {
        // Skip models that are already in the active list — they will be
        // benchmarked as part of the main run, so rechecking here would duplicate
        // work. Also drops them from the removed-models file below.
        const activeSet = new Set(models);
        const toRecheck = removedModels.filter(m => !activeSet.has(m));
        const alreadyActive = removedModels.filter(m => activeSet.has(m));
        if (alreadyActive.length > 0) {
            process.stderr.write(`\nSkipping recheck for ${alreadyActive.length} model(s) already in active list: ${alreadyActive.join(', ')}\n`);
        }
        if (toRecheck.length === 0) {
            // Nothing to recheck; just persist the cleanup.
            const finalRemoved = new Set([...transientFailed]);
            writeRemovedModels([...finalRemoved]);
            removedModels = [...finalRemoved];
        }
        else {
            process.stderr.write(`\nRechecking ${toRecheck.length} previously removed model(s)...\n`);
            const recovered = [];
            const stillFailed = [];
            const concurrency = parseInt(envOrDefault('NIM_RECHECK_CONCURRENCY', '3'), 10);
            // Process models in batches of `concurrency`
            for (let i = 0; i < toRecheck.length; i += concurrency) {
                const batch = toRecheck.slice(i, i + concurrency);
                const outcomes = await Promise.all(batch.map(async (model) => {
                    process.stderr.write(`  Probing ${model} ...`);
                    const ok = await client.probeModel(model);
                    if (!ok) {
                        process.stderr.write(' still down\n');
                        return { model, status: 'down' };
                    }
                    process.stderr.write(' back! benchmarking...');
                    const result = await runBenchmark(client, model, {
                        prompt: benchPrompt,
                        iterations,
                        temperature: 0.2,
                        maxTokens: 1024,
                    });
                    const errCount = result.iterations.filter(it => it.error !== null).length;
                    if (errCount === iterations) {
                        process.stderr.write(' FAILED\n');
                        return { model, status: 'failed' };
                    }
                    process.stderr.write(' ok\n');
                    return { model, status: 'recovered', result };
                }));
                for (const outcome of outcomes) {
                    if (outcome.status === 'recovered') {
                        recovered.push(outcome.model);
                        results.push(outcome.result);
                    }
                    else {
                        stillFailed.push(outcome.model);
                    }
                }
            }
            // Persist the final removed-models state once. recovered models are
            // dropped, recheck-still-failed models are kept, already-active models
            // are dropped (they are now in the main list), and any new transient
            // failures from this run are merged in (deduplicated).
            const finalRemoved = new Set(stillFailed);
            for (const m of transientFailed)
                finalRemoved.add(m);
            writeRemovedModels([...finalRemoved]);
            removedModels = [...finalRemoved];
            if (recovered.length > 0) {
                process.stderr.write(`  Recovered ${recovered.length} model(s): ${recovered.join(', ')}\n`);
            }
        }
    }
    else if (transientFailed.length > 0) {
        // No recheck needed, but still persist the new transient failures.
        const finalRemoved = new Set([...removedModels, ...transientFailed]);
        writeRemovedModels([...finalRemoved]);
    }
    // Output results table
    const successResults = results.filter(r => {
        const errCount = r.iterations.filter(it => it.error !== null).length;
        return errCount < r.iterations.length;
    });
    const table = formatMarkdownTable(successResults);
    // Pass fetched scores to bench-reorder via a dedicated file (preferred) or
    // an HTML comment fallback for backward compatibility.
    if (fetchedScores.size > 0) {
        const scoresObj = {};
        fetchedScores.forEach((v, k) => { scoresObj[k] = v; });
        const json = JSON.stringify(scoresObj);
        const scoresFile = process.env.BENCH_SCORES_FILE;
        if (scoresFile) {
            try {
                writeFileSync(scoresFile, json + '\n', 'utf-8');
                process.stderr.write(`Wrote ${fetchedScores.size} fetched score(s) to ${scoresFile}\n`);
            }
            catch (err) {
                process.stderr.write(`Warning: could not write ${scoresFile}: ${err}; falling back to HTML comment\n`);
                console.log(`<!-- FETCHED_SCORES: ${json} -->`);
            }
        }
        else {
            console.log(`<!-- FETCHED_SCORES: ${json} -->`);
        }
    }
    console.log(table);
    // Write to GITHUB_STEP_SUMMARY if set
    const summaryPath = process.env.GITHUB_STEP_SUMMARY;
    if (summaryPath) {
        try {
            appendFileSync(summaryPath, `\n## NIM Model Benchmark\n\n${table}\n`);
        }
        catch (err) {
            process.stderr.write(`Warning: could not open GITHUB_STEP_SUMMARY: ${err}\n`);
        }
    }
}
// Only run when executed directly
const isMainModule = process.argv[1]?.endsWith('bench-entry.js');
if (isMainModule) {
    main().catch(err => {
        console.error(`Error: ${err.message}`);
        process.exit(1);
    });
}
