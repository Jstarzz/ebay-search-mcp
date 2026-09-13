import { HTTPError } from "./common.js";
import { rankEbayDeals } from "./ebay-ranking.js";
import { searchEbay, type EbaySearchOptions, type EbaySearchResult } from "./ebay.js";

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetry(error: unknown): boolean {
    if (error instanceof HTTPError) {
        return RETRYABLE_STATUS.has(error.status);
    }

    return error instanceof TypeError || (error instanceof Error && error.name === "AbortError");
}

async function withRetries<T>(operation: () => Promise<T>, attempts = 3): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
            return await operation();
        } catch (error) {
            lastError = error;
            if (!shouldRetry(error) || attempt === attempts - 1) {
                throw error;
            }

            const backoffMs = Math.min(250 * (2 ** attempt) + Math.floor(Math.random() * 150), 2_000);
            await delay(backoffMs);
        }
    }

    throw lastError instanceof Error ? lastError : new Error("eBay search failed after retries.");
}

export async function searchEbaySmart(options: EbaySearchOptions): Promise<EbaySearchResult> {
    const requestedLimit = Math.min(Math.max(options.limit ?? 10, 1), 50);
    const shouldRankDeals = options.rankByTotalCost ?? true;
    const candidateLimit = shouldRankDeals
        ? Math.min(Math.max(requestedLimit * 4, 25), 50)
        : requestedLimit;

    const result = await withRetries(() => searchEbay({
        ...options,
        limit: candidateLimit,
        // Preserve eBay's candidate ordering until optional local ranking below.
        rankByTotalCost: false,
    }));

    const listings = shouldRankDeals
        ? rankEbayDeals(result.listings, options.query).slice(0, requestedLimit)
        : result.listings.slice(0, requestedLimit);

    return {
        ...result,
        returned: listings.length,
        listings,
    };
}
