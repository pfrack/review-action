export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatResult {
  content: string;
  usage: Usage;
  latency: number;
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
}

interface ChatResponseChoice {
  message?: { content: string };
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
      throw new Error(`NIM returned ${resp.status}: ${body}`);
    }

    const data = await resp.json() as ChatResponse;
    if (!data.choices || data.choices.length === 0) {
      throw new Error('NIM returned no choices');
    }

    return {
      content: (data.choices[0].message?.content ?? '').trim(),
      usage: data.usage,
      latency: Date.now() - start,
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
      throw new Error(`NIM returned ${resp.status}: ${body}`);
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
