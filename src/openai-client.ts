import * as core from '@actions/core';
import { withRetry, RetryableError } from './retry.js';

export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const timestamp = Date.parse(trimmed);
  if (Number.isNaN(timestamp)) return undefined;
  return Math.max(0, timestamp - now);
}

export function sanitizeErrorBody(body: string): string {
  return body
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/api[_-]?key["'\s]*[:=]["'\s]*\S+/gi, 'api[_-]?key: [REDACTED]');
}

function isUnsupportedJsonSchemaResponse(status: number, body: string): boolean {
  if (status !== 400) return false;
  // Match the API parameter name (OpenAI/Groq wording) OR the generic
  // feature name (StepFun "structured_outputs", Anthropic "structured
  // output", etc.). Without the OR, models whose error body says only
  // "structured_outputs" never trigger the json_object retry path.
  const signalsStructuredOutput = /json_schema|structured_outputs|structured\s+output/i.test(body);
  const signalsUnsupported = /does not support|doesn't support|not supported|unsupported|is not supported/i.test(body);
  return signalsStructuredOutput && signalsUnsupported;
}

class UnsupportedJsonSchemaError extends Error {}

// Per-provider/model format overrides. When a model is known not to
// support `json_schema` (e.g. Groq llama-3.3-70b-versatile, some Mistral
// legacy IDs), starting with `json_object` skips one wasted round-trip
// and the half-second latency it costs. The fallback path in `chat()`
// still triggers the retry on unknown models — this only short-circuits
// the cases we know about.
const NO_JSON_SCHEMA_MODELS: ReadonlySet<string> = new Set<string>([
  // Groq: json_schema unsupported on most llama models (only certain
  // gpt-oss and moonshotai variants support it on Groq).
  'llama-3.3-70b-versatile',
  'llama-3.1-70b-versatile',
  'llama3-70b-8192',
  'llama3-8b-8192',
  'mixtral-8x7b-32768',
  'gemma2-9b-it',
]);

// Models that don't support ANY structured output — both `json_schema`
// and `json_object` are rejected with messages like
// "structured_outputs is not supported" (StepFun's wording). For these,
// we fall through to plain text mode and parse the JSON out of the
// model's natural response (which is usually wrapped in ```json ... ```
// or a bare object). Without this fallback the chain would skip them
// entirely and burn ~3s per model on the failed attempts.
const NO_STRUCTURED_OUTPUT_MODELS: ReadonlySet<string> = new Set<string>([
  // StepFun step-* models: no structured output support at all.
  'step-3.7-flash',
  'step-3.5-flash',
  'step-3.5-flash-2603',
]);

export function effectiveFormat(model: string, provider: string, requested: ResponseFormat): ResponseFormat {
  if (requested !== 'json_schema' && requested !== 'json_object') return requested;
  // 1. Provider-qualified key wins (e.g. "groq:llama-3.3-70b-versatile")
  if (NO_JSON_SCHEMA_MODELS.has(`${provider}:${model}`)) return 'json_object';
  if (NO_JSON_SCHEMA_MODELS.has(model)) return 'json_object';
  // 2. Models that reject all structured output fall through to text
  // mode, where the response is parsed as JSON client-side.
  if (NO_STRUCTURED_OUTPUT_MODELS.has(`${provider}:${model}`)) return 'text';
  if (NO_STRUCTURED_OUTPUT_MODELS.has(model)) return 'text';
  return requested;
}

/**
 * Strip chain-of-thought / reasoning blocks that some models (StepFun,
 * DeepSeek, Qwen3, etc.) emit inside their `content` response.
 *
 * These markers come in a few dialects:
 *   <thinking>...</thinking>
 *   === thinking === ... === answer ===
 *   [thinking]...[/thinking]
 *   思考内容: ...  (Chinese models)
 *
 * Removing the block *before* JSON extraction prevents reasoning prose
 * (which can contain stray braces) from corrupting the brace walker.
 */
export function stripThinkingContent(text: string): string {
  if (!text) return text;
  return text
    .replace(/<thinking\b[^>]*>[\s\S]*?<\/thinking>/gi, '')
    .replace(/\[thinking\b[^\]]*\][\s\S]*?\[\/thinking\]/gi, '')
    .replace(/===+\s*thinking\s*===+[\s\S]*?===\s*(?:answer|response|final)\s*===+/gi, '')
    .replace(/thought_block\b[\s\S]*?endofthought_block\b/gi, '')
    .trim();
}

/**
 * Extract a JSON object from a model's text response.
 *
 * Most models that don't support structured output still emit well-formed
 * JSON when asked. They typically wrap it in a ```json ... ``` code
 * block, or emit a bare object. This helper tries, in order:
 *   1. A ```json ... ``` fenced code block (most common)
 *   2. A fenced block with no language tag
 *   3. The first balanced top-level { ... } object in the text
 *
 * Returns the extracted JSON string, or null if none could be found.
 * The caller is responsible for parsing the string as JSON.
 */
export function extractJsonFromText(text: string): string | null {
  const cleaned = stripThinkingContent(text);
  const trimmed = cleaned.trim();
  if (!trimmed) return null;

  // 1. Fenced code block with `json` language tag
  const jsonFence = trimmed.match(/```json\s*([\s\S]*?)\s*```/i);
  if (jsonFence) return jsonFence[1].trim();

  // 2. Any fenced code block (some models omit the language tag)
  const anyFence = trimmed.match(/```\s*([\s\S]*?)\s*```/);
  if (anyFence) return anyFence[1].trim();

  // 3. First balanced top-level object — walk braces so embedded
  // objects/arrays don't prematurely close the match.
  const start = trimmed.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return trimmed.slice(start, i + 1);
    }
  }
  return null;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  schema?: object;
  format?: ResponseFormat;
  signal?: AbortSignal;
}

export type ResponseFormat = 'json_schema' | 'json_object' | 'tools' | 'text';

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatResult {
  content: string;
  usage: Usage;
  latency: number;
  finishReason?: string | null;
}

export interface StreamChunk {
  delta: string;
  done: boolean;
  firstTokenAt: number | null;
}

interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature: number;
  max_tokens: number;
  stream: boolean;
  response_format?: {
    type: 'json_schema';
    strict: true;
    json_schema: { name: string; schema: object };
  } | {
    type: 'json_object';
  };
  tools?: Array<{
    type: 'function';
    function: { name: string; description: string; parameters: object };
  }>;
  tool_choice?: { type: 'function'; function: { name: string } };
}

interface ChatResponseChoice {
  message?: {
    content: string | null;
    tool_calls?: Array<{ function: { arguments: string } }>
    /** Separate reasoning/thinking content emitted by reasoning models (StepFun, DeepSeek). Currently ignored — only `content` is parsed. */
    reasoning_content?: string | null;
  };
  delta?: { content: string };
  finish_reason?: string;
}

interface ChatResponse {
  choices: ChatResponseChoice[];
  usage: Usage;
}

export class OpenAIClient {
  private baseURL: string;
  private apiKey: string;
  private providerLabel: string;
  private providerKey: string;

  constructor(baseURL: string, apiKey: string, providerLabel?: string) {
    this.baseURL = baseURL.replace(/\/+$/, '');
    this.apiKey = apiKey;
     this.providerLabel = providerLabel ||
       (baseURL.includes('nvidia.com') ? 'NIM' :
        baseURL.includes('mistral') ? 'Mistral' :
        baseURL.includes('groq') ? 'Groq' :
        baseURL.includes('openrouter') ? 'OpenRouter' :
        baseURL.includes('kilo.ai') ? 'Kilo' :
        baseURL.includes('nousresearch') ? 'NousResearch' :
        baseURL.split('/')[2] || 'API');
     this.providerKey =
       baseURL.includes('nvidia.com') ? 'nim' :
       baseURL.includes('mistral') ? 'mistral' :
       baseURL.includes('groq') ? 'groq' :
       baseURL.includes('openrouter') ? 'openrouter' :
       baseURL.includes('kilo.ai') ? 'kilocode' :
       baseURL.includes('nousresearch') ? 'nousresearch' :
       'custom';
  }

  async chat(model: string, messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    const outerSignal = opts.signal;
    const format = effectiveFormat(model, this.providerKey, opts.format ?? 'text');
    const payload: ChatRequest = {
      model,
      messages,
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.maxTokens ?? 1024,
      stream: false,
    };

    if (format === 'json_schema' || format === 'tools') {
      if (!opts.schema) {
        throw new Error(`format "${format}" requires a schema to be provided`);
      }
    }

    if (format === 'json_object') {
      payload.response_format = { type: 'json_object' };
    } else if (opts.schema && format && format !== 'text') {
      if (format === 'json_schema') {
        payload.response_format = {
          type: 'json_schema',
          strict: true,
          json_schema: { name: 'review', schema: opts.schema },
        };
      } else if (format === 'tools') {
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
    let resp: Response;
    try {
      resp = await withRetry(async () => {
        if (outerSignal?.aborted) throw new Error('Request aborted by caller');
        const response = await fetch(`${this.baseURL}/chat/completions`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal: outerSignal
            ? AbortSignal.any([AbortSignal.timeout(180_000), outerSignal])
            : AbortSignal.timeout(180_000),
        });

        if (!response.ok) {
          const body = await response.text();
          const errorBody = sanitizeErrorBody(body.length > 200 ? '...' + body.slice(-200) : body);
          if (opts.format === 'json_schema' && isUnsupportedJsonSchemaResponse(response.status, body)) {
            throw new UnsupportedJsonSchemaError(errorBody);
          }
          const retryAfterMs = response.status === 429 ? parseRetryAfter(response.headers.get('Retry-After')) : undefined;
          throw new RetryableError(`${this.providerLabel} returned ${response.status}: ${errorBody}`, response.status, retryAfterMs);
        }
        return response;
      });
    } catch (err) {
      if (err instanceof UnsupportedJsonSchemaError) {
        core.info(`${this.providerLabel} does not support json_schema for ${model}; retrying with json_object`);
        const result = await this.chat(model, messages, { ...opts, format: 'json_object' });
        return { ...result, latency: Date.now() - start };
      }
      throw err;
    }

    let data: ChatResponse;
    try {
      data = await resp.json() as ChatResponse;
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new RetryableError(`${this.providerLabel} returned non-JSON response`, 502);
      }
      throw err;
    }
    if (!data.choices || data.choices.length === 0) {
      throw new Error('API returned no choices');
    }

    const choice = data.choices[0];
    let content: string;
    if (choice.message?.tool_calls && choice.message.tool_calls.length > 0) {
      // Use the first tool call's arguments (we specify tool_choice to force a single tool)
      const toolCall = choice.message.tool_calls[0];
      if (!toolCall.function?.arguments) {
        throw new Error('Tool call missing arguments');
      }
      content = toolCall.function.arguments;
    } else {
      content = (choice.message?.content ?? '').trim();
    }

    // Text-mode fallback: when the caller wanted structured output but
    // we had to drop to plain text (model in NO_STRUCTURED_OUTPUT_MODELS),
    // try to extract a JSON object from the model's natural response so
    // the downstream schema validator can parse it.
    const requestedStructured = opts.format === 'json_schema' || opts.format === 'json_object';
    if (format === 'text' && requestedStructured) {
      const extracted = extractJsonFromText(content);
      if (extracted !== null) {
        content = extracted;
      }
      // If extraction failed, return the raw text — the chain's schema
      // validator will reject it and the chain moves on.
    }

    return {
      content,
      usage: data.usage ?? { completion_tokens: 0, prompt_tokens: 0, total_tokens: 0 },
      latency: Date.now() - start,
      finishReason: choice.finish_reason ?? null,
    };
  }

  async *chatStream(model: string, messages: ChatMessage[], opts: ChatOptions = {}): AsyncGenerator<StreamChunk> {
    const payload: ChatRequest = {
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
        const retryAfterMs = r.status === 429 ? parseRetryAfter(r.headers.get('Retry-After')) : undefined;
        throw new RetryableError(`${this.providerLabel}: ${r.status}: ${sanitizeErrorBody(body.length > 200 ? '...' + body.slice(-200) : body)}`, r.status, retryAfterMs);
      }
      return r;
    });

    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let firstTokenAt: number | null = null;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();

          if (data === '[DONE]') {
            yield { delta: '', done: true, firstTokenAt: null };
            return;
          }

          let chunk: ChatResponse;
          try {
            chunk = JSON.parse(data);
          } catch {
            continue;
          }

          if (!chunk.choices || chunk.choices.length === 0) continue;
          const delta = chunk.choices[0].delta?.content ?? '';
          if (!delta) continue;

          if (firstTokenAt === null) {
            firstTokenAt = Date.now();
          }

          yield { delta, done: false, firstTokenAt };
        }
      }
    }
    finally {
      reader.releaseLock();
    }
  }

  async probeModel(model: string): Promise<boolean> {
    try {
      await this.chat(model, [{ role: 'user', content: 'Say hi' }], {
        temperature: 0,
        maxTokens: 8,
      });
      return true;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<string[]> {
    const resp = await fetch(`${this.baseURL}/models`, {
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      throw new Error(`/models returned ${resp.status}`);
    }

    const data = await resp.json() as { data: { id: string }[] };
    return data.data.map(m => m.id);
  }
}
