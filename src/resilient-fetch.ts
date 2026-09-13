const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export type RetryOptions = {
    attempts?: number;
    timeoutMs?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
};

function parseRetryAfter(value: string | null): number | null {
    if (!value) {
        return null;
    }

    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) {
        return seconds * 1000;
    }

    const date = Date.parse(value);
    if (Number.isNaN(date)) {
        return null;
    }

    return Math.max(date - Date.now(), 0);
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelay(response: Response | null, attempt: number, baseDelayMs: number, maxDelayMs: number): number {
    const retryAfter = response ? parseRetryAfter(response.headers.get("retry-after")) : null;
    if (retryAfter !== null) {
        return Math.min(retryAfter, maxDelayMs);
    }

    const exponential = baseDelayMs * (2 ** attempt);
    const jitter = Math.floor(Math.random() * Math.max(baseDelayMs, 1));
    return Math.min(exponential + jitter, maxDelayMs);
}

export async function resilientFetch(
    input: string | URL | Request,
    init: RequestInit = {},
    options: RetryOptions = {},
): Promise<Response> {
    const attempts = Math.max(options.attempts ?? 3, 1);
    const timeoutMs = Math.max(options.timeoutMs ?? 10_000, 1);
    const baseDelayMs = Math.max(options.baseDelayMs ?? 250, 0);
    const maxDelayMs = Math.max(options.maxDelayMs ?? 4_000, baseDelayMs);

    let lastError: unknown = null;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
        const timeoutSignal = AbortSignal.timeout(timeoutMs);
        const signal = init.signal
            ? AbortSignal.any([init.signal, timeoutSignal])
            : timeoutSignal;

        try {
            const response = await fetch(input, { ...init, signal });
            if (!RETRYABLE_STATUS.has(response.status) || attempt === attempts - 1) {
                return response;
            }

            await response.body?.cancel().catch(() => undefined);
            await delay(retryDelay(response, attempt, baseDelayMs, maxDelayMs));
        } catch (error) {
            lastError = error;
            if (attempt === attempts - 1 || init.signal?.aborted) {
                throw error;
            }
            await delay(retryDelay(null, attempt, baseDelayMs, maxDelayMs));
        }
    }

    throw lastError instanceof Error ? lastError : new Error("HTTP request failed after retries.");
}
