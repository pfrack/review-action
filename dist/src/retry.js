export class RetryableError extends Error {
    status;
    retryAfterMs;
    constructor(message, status, retryAfterMs) {
        super(message);
        this.name = 'RetryableError';
        this.status = status;
        this.retryAfterMs = retryAfterMs;
    }
}
export function getRetryDelay(error, attempt, delayMs) {
    const exponentialDelay = Math.min(delayMs * Math.pow(2, attempt), 30_000);
    const retryAfterMs = error instanceof RetryableError ? error.retryAfterMs ?? 0 : 0;
    return Math.min(Math.max(exponentialDelay, retryAfterMs), 60_000);
}
export async function withRetry(fn, maxRetries = 2, delayMs = 1000) {
    let lastError;
    for (let i = 0; i < maxRetries + 1; i++) {
        try {
            return await fn();
        }
        catch (error) {
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
