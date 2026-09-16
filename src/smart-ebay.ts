import { HTTPError } from "./common.js";
import { rankEbayDeals } from "./ebay-ranking.js";
import { searchEbay, type EbaySearchOptions, type EbaySearchResult } from "./ebay.js";
import { isSelfHostedScraperConfigured, searchSelfHostedScraper } from "./selfhosted.js";

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

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

function withinPriceRange(value: number | null, options: EbaySearchOptions): boolean {
    if (value === null) return true;
    if (options.minPrice !== undefined && value < options.minPrice) return false;
    if (options.maxPrice !== undefined && value > options.maxPrice) return false;
    return true;
}

async function searchEbaySelfHosted(options: EbaySearchOptions): Promise<EbaySearchResult> {
    const rawListings = await searchSelfHostedScraper({
        marketplace: "ebay",
        query: options.query,
        limit: Math.min(Math.max(options.limit ?? 10, 1), 50),
    });
    const listings = rawListings.filter((listing) => withinPriceRange(listing.price.value, options));

    return {
        provider: "ebay",
        query: options.query,
        total: null,
        returned: listings.length,
        discarded: rawListings.length - listings.length,
        destination: {
            country: options.shipToCountry ?? null,
            postalCode: options.shipToPostalCode ?? null,
        },
        shippingWarning: "Self-hosted eBay fallback results are not checkout quotes; confirm shipping and listing terms on eBay.",
        listings,
    };
}

async function searchWithFallback(options: EbaySearchOptions): Promise<EbaySearchResult> {
    let officialError: unknown;
    try {
        return await withRetries(() => searchEbay(options));
    } catch (error) {
        officialError = error;
    }

    if (!isSelfHostedScraperConfigured("ebay")) throw officialError;
    try {
        return await withRetries(() => searchEbaySelfHosted(options), 2);
    } catch (fallbackError) {
        const officialMessage = officialError instanceof Error ? officialError.message : String(officialError);
        const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        throw new Error(`eBay official search failed (${officialMessage.slice(0, 180)}); self-hosted fallback failed (${fallbackMessage.slice(0, 180)})`);
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
