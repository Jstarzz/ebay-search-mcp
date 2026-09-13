import { HTTPError, isRecord } from "./common.js";
import { rankEbayDeals } from "./ebay-ranking.js";
import { searchEbay, type EbaySearchOptions, type EbaySearchResult } from "./ebay.js";

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const SELF_HOSTED_TIMEOUT_MS = 25_000;

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetry(error: unknown): boolean {
    if (error instanceof HTTPError) {
        return RETRYABLE_STATUS.has(error.status);
    }
    return error instanceof TypeError || (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"));
}

async function withRetries<T>(operation: () => Promise<T>, attempts = 3): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
            return await operation();
        } catch (error) {
            lastError = error;
            if (!shouldRetry(error) || attempt === attempts - 1) throw error;
            const backoffMs = Math.min(250 * (2 ** attempt) + Math.floor(Math.random() * 150), 2_000);
            await delay(backoffMs);
        }
    }
    throw lastError instanceof Error ? lastError : new Error("eBay search failed after retries.");
}

async function searchEbaySelfHosted(options: EbaySearchOptions): Promise<EbaySearchResult> {
    const endpoint = process.env.EBAY_SELFHOSTED_URL?.trim();
    if (!endpoint) throw new Error("EBAY_SELFHOSTED_URL is not configured");

    const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(options),
        signal: AbortSignal.timeout(SELF_HOSTED_TIMEOUT_MS),
    });
    if (!response.ok) {
        throw new HTTPError(response.status, (await response.text()).slice(0, 500));
    }

    const payload: unknown = await response.json();
    if (!isRecord(payload) || !Array.isArray(payload.listings)) {
        throw new Error("eBay self-hosted fallback must return a normalized EbaySearchResult with a listings array");
    }

    return {
        provider: "ebay",
        query: typeof payload.query === "string" ? payload.query : options.query,
        total: typeof payload.total === "number" ? payload.total : null,
        returned: payload.listings.length,
        discarded: typeof payload.discarded === "number" ? payload.discarded : 0,
        destination: isRecord(payload.destination) ? {
            country: typeof payload.destination.country === "string" ? payload.destination.country : options.shipToCountry ?? null,
            postalCode: typeof payload.destination.postalCode === "string" ? payload.destination.postalCode : options.shipToPostalCode ?? null,
        } : {
            country: options.shipToCountry ?? null,
            postalCode: options.shipToPostalCode ?? null,
        },
        shippingWarning: typeof payload.shippingWarning === "string" ? payload.shippingWarning : "Results came from the self-hosted eBay fallback; confirm shipping on eBay.",
        listings: payload.listings as EbaySearchResult["listings"],
    };
}

async function searchWithFallback(options: EbaySearchOptions): Promise<EbaySearchResult> {
    let officialError: unknown;
    try {
        return await withRetries(() => searchEbay(options));
    } catch (error) {
        officialError = error;
    }

    if (!process.env.EBAY_SELFHOSTED_URL?.trim()) throw officialError;
    try {
        return await withRetries(() => searchEbaySelfHosted(options), 2);
    } catch (fallbackError) {
        const officialMessage = officialError instanceof Error ? officialError.message : String(officialError);
        const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        throw new Error(`eBay official search failed (${officialMessage}); self-hosted fallback failed (${fallbackMessage})`);
    }
}

export async function searchEbaySmart(options: EbaySearchOptions): Promise<EbaySearchResult> {
    const requestedLimit = Math.min(Math.max(options.limit ?? 10, 1), 50);
    const shouldRankDeals = options.rankByTotalCost ?? true;
    const candidateLimit = shouldRankDeals
        ? Math.min(Math.max(requestedLimit * 4, 25), 50)
        : requestedLimit;

    const result = await searchWithFallback({
        ...options,
        limit: candidateLimit,
        rankByTotalCost: false,
    });

    const listings = shouldRankDeals
        ? rankEbayDeals(result.listings, options.query).slice(0, requestedLimit)
        : result.listings.slice(0, requestedLimit);

    return {
        ...result,
        returned: listings.length,
        listings,
    };
}
