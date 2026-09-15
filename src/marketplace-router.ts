import {
    clearMarketplaceCache as clearProviderCache,
    searchMarketplace as searchProviders,
    type MarketplaceSearchOptions,
    type MarketplaceSearchResult,
} from "./marketplace-search.js";

const NEGATIVE_CACHE_TTL_MS = 20_000;

type NegativeEntry = {
    expiresAt: number;
    result: MarketplaceSearchResult;
};

const inFlight = new Map<string, Promise<MarketplaceSearchResult>>();
const negativeCache = new Map<string, NegativeEntry>();

function requestKey(options: MarketplaceSearchOptions): string {
    return JSON.stringify([
        options.store,
        options.query.trim().toLowerCase(),
        Math.min(Math.max(options.limit ?? 10, 1), 50),
        options.minPrice ?? null,
        options.maxPrice ?? null,
        options.shipToCountry?.toUpperCase() ?? null,
        options.shipToPostalCode?.trim() ?? null,
    ]);
}

export async function searchMarketplace(options: MarketplaceSearchOptions): Promise<MarketplaceSearchResult> {
    const key = requestKey(options);
    const now = Date.now();

    const negative = negativeCache.get(key);
    if (negative) {
        if (negative.expiresAt > now) {
            return { ...negative.result, cacheHit: true };
        }
        negativeCache.delete(key);
    }

    const existing = inFlight.get(key);
    if (existing) {
        return existing;
    }

    const operation = searchProviders(options).then((result) => {
        if (result.sourceUsed === null) {
            negativeCache.set(key, {
                expiresAt: Date.now() + NEGATIVE_CACHE_TTL_MS,
                result,
            });
        } else {
            negativeCache.delete(key);
        }
        return result;
    });

    inFlight.set(key, operation);
    try {
        return await operation;
    } finally {
        if (inFlight.get(key) === operation) {
            inFlight.delete(key);
        }
    }
}

export function clearMarketplaceCache(): void {
    negativeCache.clear();
    inFlight.clear();
    clearProviderCache();
}
