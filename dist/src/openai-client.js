import { withRetry, RetryableError } from './retry.js';
export class OpenAIClient {
    baseURL;
    apiKey;
    constructor(baseURL, apiKey) {
        this.baseURL = baseURL.replace(/\/+$/, '');
        this.apiKey = apiKey;
    }
    async chat(model, messages, opts = {}) {
        const payload = {
            model,
            messages,
            temperature: opts.temperature ?? 0.2,
            max_tokens: opts.maxTokens ?? 1024,
            stream: false,
        };
        if (opts.schema && opts.format && opts.format !== 'text') {
            if (opts.format === 'json_schema') {
                payload.response_format = {
                    type: 'json_schema',
                    strict: true,
                    json_schema: { name: 'review', schema: opts.schema },
                };
            }
            else if (opts.format === 'tools') {
                payload.tools = [{
                        type: 'function',
                        function: {
                            name: 'review_for_code_diff',
                            description: 'Record the structured code review findings for the given diff.',
                            parameters: opts.schema,
                        },
                    }];
                payload.tool_choice = { type: 'function', function: { name: 'review_for_code_diff' } };
            }
        }
        const start = Date.now();
        const resp = await withRetry(async () => {
            const response = await fetch(`${this.baseURL}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(180_000),
            });
            if (!response.ok) {
                const body = await response.text();
                const provider = this.baseURL.includes('nvidia.com') ? 'NIM' :
                    this.baseURL.includes('mistral') ? 'Mistral' :
                        this.baseURL.split('/')[2] || 'API';
                throw new RetryableError(`${provider} returned ${response.status}: ${body}`, response.status);
            }
            return response;
        });
        const data = await resp.json();
        if (!data.choices || data.choices.length === 0) {
            throw new Error('NIM returned no choices');
        }
        const choice = data.choices[0];
        let content;
        if (choice.message?.tool_calls && choice.message.tool_calls.length > 0) {
            // Use the first tool call's arguments (we specify tool_choice to force a single tool)
            const toolCall = choice.message.tool_calls[0];
            if (!toolCall.function?.arguments) {
                throw new Error('Tool call missing arguments');
            }
            content = toolCall.function.arguments;
        }
        else {
            content = (choice.message?.content ?? '').trim();
        }
        return {
            content,
            usage: data.usage,
            latency: Date.now() - start,
            finishReason: choice.finish_reason,
        };
    }
    async *chatStream(model, messages, opts = {}) {
        const payload = {
            model,
            messages,
            temperature: opts.temperature ?? 0.2,
            max_tokens: opts.maxTokens ?? 1024,
            stream: true,
        };
        const resp = await withRetry(async () => {
            const r = await fetch(`${this.baseURL}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json',
                    'Accept': 'text/event-stream',
                },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(180_000),
            });
            if (!r.ok) {
                const body = await r.text();
                throw new RetryableError(`${r.status}: ${body}`, r.status);
            }
            return r;
        });
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let firstTokenAt = null;
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
                if (!line.startsWith('data: '))
                    continue;
                const data = line.slice(6).trim();
                if (data === '[DONE]') {
                    yield { delta: '', done: true, firstTokenAt: null };
                    return;
                }
                let chunk;
                try {
                    chunk = JSON.parse(data);
                }
                catch {
                    continue;
                }
                if (!chunk.choices || chunk.choices.length === 0)
                    continue;
                const delta = chunk.choices[0].delta?.content ?? '';
                if (!delta)
                    continue;
                if (firstTokenAt === null) {
                    firstTokenAt = Date.now();
                }
                yield { delta, done: false, firstTokenAt };
            }
        }
    }
    async probeModel(model) {
        try {
            await this.chat(model, [{ role: 'user', content: 'Say hi' }], {
                temperature: 0,
                maxTokens: 8,
            });
            return true;
        }
        catch {
            return false;
        }
    }
    async listModels() {
        const resp = await fetch(`${this.baseURL}/models`, {
            headers: {
                'Authorization': `Bearer ${this.apiKey}`,
                'Accept': 'application/json',
            },
            signal: AbortSignal.timeout(30_000),
        });
        if (!resp.ok) {
            throw new Error(`NIM /models returned ${resp.status}`);
        }
        const data = await resp.json();
        return data.data.map(m => m.id);
    }
}
