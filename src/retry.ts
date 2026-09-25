export class RetryableError extends Error {
  status: number;
  retryAfterMs?: number;
  constructor(message: string, status: number, retryAfterMs?: number) {
    super(message);
    this.name = 'RetryableError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export function getRetryDelay(error: unknown, attempt: number, delayMs: number): number {
  const jitter = delayMs * (0.5 + Math.random());
  const exponentialDelay = Math.min(delayMs * Math.pow(2, attempt), 30_000);
  const retryAfterMs = error instanceof RetryableError ? error.retryAfterMs ?? 0 : 0;
  return Math.min(Math.max(exponentialDelay + jitter, retryAfterMs), 60_000);
}

export async function withRetry<T>(fn: () => Promise<T>, maxRetries = 2, delayMs = 1000): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < maxRetries + 1; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const status = error instanceof RetryableError ? error.status : 0;
      const isFetchNetworkError = error instanceof TypeError &&
        /fetch|network|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNRESET/i.test(error.message);
      if (i < maxRetries && (status >= 500 || status === 429 || isFetchNetworkError)) {
        const delay = getRetryDelay(error, i, delayMs);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}
