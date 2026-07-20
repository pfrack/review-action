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
}

export type ResponseFormat = 'json_schema' | 'tools' | 'text';

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatResult {
  content: string;
  usage: Usage;
  latency: number;
  finishReason?: string;
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
  };
  tools?: Array<{
    type: 'function';
    function: { name: string; description: string; parameters: object };
  }>;
  tool_choice?: { type: 'function'; function: { name: string } };
}

interface ChatResponseChoice {
  message?: { content: string | null; tool_calls?: Array<{ function: { arguments: string } }> };
  delta?: { content: string };
  finish_reason?: string;
}

interface ChatResponse {
  choices: ChatResponseChoice[];
  usage: Usage;
}

export class NimClient {
  private baseURL: string;
  private apiKey: string;

  constructor(baseURL: string, apiKey: string) {
    this.baseURL = baseURL.replace(/\/+$/, '');
    this.apiKey = apiKey;
  }

  async chat(model: string, messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    const payload: ChatRequest = {
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
      } else if (opts.format === 'tools') {
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
    const resp = await fetch(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(180_000),
    });

    if (!resp.ok) {
      const body = await resp.text();
      const provider = this.baseURL.includes('nvidia.com') ? 'NIM' :
                       this.baseURL.includes('mistral') ? 'Mistral' :
                       this.baseURL.split('/')[2] || 'API';
      throw new Error(`${provider} returned ${resp.status}: ${body}`);
    }

    const data = await resp.json() as ChatResponse;
    if (!data.choices || data.choices.length === 0) {
      throw new Error('NIM returned no choices');
    }

    const choice = data.choices[0];
    let content: string;
    if (choice.message?.tool_calls && choice.message.tool_calls.length > 0) {
      const args = choice.message.tool_calls[0].function.arguments;
      try {
        content = JSON.stringify(JSON.parse(args));
      } catch {
        content = args;
      }
    } else {
      content = (choice.message?.content ?? '').trim();
    }

    return {
      content,
      usage: data.usage,
      latency: Date.now() - start,
      finishReason: choice.finish_reason,
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

    const resp = await fetch(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(180_000),
    });

    if (!resp.ok) {
      const body = await resp.text();
      const provider = this.baseURL.includes('nvidia.com') ? 'NIM' :
                       this.baseURL.includes('mistral') ? 'Mistral' :
                       this.baseURL.split('/')[2] || 'API';
      throw new Error(`${provider} returned ${resp.status}: ${body}`);
    }

    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let firstTokenAt: number | null = null;

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
      throw new Error(`NIM /models returned ${resp.status}`);
    }

    const data = await resp.json() as { data: { id: string }[] };
    return data.data.map(m => m.id);
  }
}
