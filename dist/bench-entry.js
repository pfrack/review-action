import { appendFileSync, readFileSync } from 'node:fs';
import { NimClient } from './nim-client.js';
import { runBenchmark, formatMarkdownTable } from './bench.js';
import { SWE_BENCH_SCORES } from './bench-reorder.js';
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
async function probe(baseURL, apiKey, models) {
    const client = new NimClient(baseURL, apiKey);
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
    const client = new NimClient(baseURL, apiKey);
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
    // --probe mode
    if (process.argv.includes('--probe')) {
        await probe(baseURL, apiKey, models);
        return;
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
    // Output results table
    const successResults = results.filter(r => {
        const errCount = r.iterations.filter(it => it.error !== null).length;
        return errCount < r.iterations.length;
    });
    const table = formatMarkdownTable(successResults);
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
main().catch(err => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
});
