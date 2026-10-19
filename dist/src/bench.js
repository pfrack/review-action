export async function runBenchmark(client, model, cfg) {
    const messages = [{ role: 'user', content: cfg.prompt }];
    const opts = { temperature: cfg.temperature, maxTokens: cfg.maxTokens };
    const result = { model, iterations: [] };
    // Warmup call — discard result
    try {
        await client.chat(model, messages, opts);
    }
    catch {
        // ignore warmup errors
    }
    for (let i = 0; i < cfg.iterations; i++) {
        try {
            // Non-streaming call for latency + tokens/sec
            const chatResult = await client.chat(model, messages, opts);
            // Streaming call for TTFT
            const streamStart = Date.now();
            let ttft = 0;
            try {
                for await (const chunk of client.chatStream(model, messages, opts)) {
                    if (chunk.delta) {
                        ttft = Date.now() - streamStart;
                        break;
                    }
                }
            }
            catch {
                // TTFT measurement failed, continue
            }
            const tps = chatResult.latency > 0
                ? (chatResult.usage.completion_tokens / (chatResult.latency / 1000))
                : 0;
            result.iterations.push({
                ttft,
                latency: chatResult.latency,
                completionTokens: chatResult.usage.completion_tokens,
                tokensPerSec: tps,
                error: null,
            });
        }
        catch (err) {
            result.iterations.push({
                ttft: 0,
                latency: 0,
                completionTokens: 0,
                tokensPerSec: 0,
                error: err,
            });
        }
    }
    return result;
}
export function median(arr) {
    if (arr.length === 0)
        return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}
export function countErrors(iters) {
    return iters.filter(it => it.error !== null).length;
}
export function formatDuration(ms) {
    if (ms === 0)
        return 'N/A';
    if (ms < 1)
        return `${Math.round(ms * 1000)}μs`;
    if (ms < 1000)
        return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
}
export function formatMarkdownTable(results) {
    const lines = [
        '| Model | TTFT (median) | Latency (median) | Tokens/sec (median) | Errors |',
        '|-------|---------------|------------------|---------------------|--------|',
    ];
    for (const r of results) {
        const ttfts = [];
        const latencies = [];
        const tpsList = [];
        let errCount = 0;
        for (const it of r.iterations) {
            if (it.error) {
                errCount++;
                continue;
            }
            if (it.ttft > 0)
                ttfts.push(it.ttft);
            latencies.push(it.latency);
            if (it.tokensPerSec > 0)
                tpsList.push(it.tokensPerSec);
        }
        const ttftStr = formatDuration(median(ttfts));
        const latStr = formatDuration(median(latencies));
        const tpsStr = median(tpsList).toFixed(1);
        lines.push(`| \`${r.model}\` | ${ttftStr} | ${latStr} | ${tpsStr} | ${errCount} |`);
    }
    return lines.join('\n');
}
