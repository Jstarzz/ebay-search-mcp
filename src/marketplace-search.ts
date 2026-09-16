import { createHash, createHmac } from "node:crypto";
import {
    HTTPError,
    addMoney,
    isRecord,
    money,
    readErrorBody,
    textOrNull,
    toNumberOrNull,
    type ListingStore,
    type NormalizedListing,
} from "./common.js";
import { getConfiguredRoute, type ProviderId } from "./provider-routing.js";
import { searchSelfHostedScraper } from "./selfhosted.js";

export type RoutedStore = Extract<ListingStore, "amazon" | "aliexpress">;

export type MarketplaceSearchOptions = {
    store: RoutedStore;
    query: string;
    limit?: number;
    minPrice?: number;
    maxPrice?: number;
    shipToCountry?: string;
    shipToPostalCode?: string;
};

export type MarketplaceProviderFailure = {
    provider: ProviderId;
    error: string;
};

export type MarketplaceSearchResult = {
    store: RoutedStore;
    query: string;
    route: ProviderId[];
    attemptedProviders: ProviderId[];
    sourceUsed: ProviderId | null;
    cacheHit: boolean;
    returned: number;
    providerFailures: MarketplaceProviderFailure[];
    listings: NormalizedListing[];
};

type CacheEntry = {
    expiresAt: number;
    result: MarketplaceSearchResult;
};

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 25_000;

const nativeProviders = new Set<ProviderId>([
    "bright-data",
    "scrapingdog",
    "hasdata",
    "apify",
    "serpapi",
    "amazon-selfhosted",
    "aliexpress-official",
    "aliexpress-selfhosted",
]);

function env(name: string): string | undefined {
    const value = process.env[name]?.trim();
    return value ? value : undefined;
}

function errorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(/\s+/g, " ").trim().slice(0, 240);
}

function first(record: Record<string, unknown>, keys: string[]): unknown {
    for (const key of keys) {
        if (record[key] !== undefined && record[key] !== null && record[key] !== "") {
            return record[key];
        }
    }
    return undefined;
}

function nestedRows(value: unknown): Record<string, unknown>[] {
    if (Array.isArray(value)) {
        return value.filter(isRecord);
    }
    if (!isRecord(value)) {
        return [];
    }

    for (const key of ["organic_results", "results", "products", "items", "data", "result", "listings"]) {
        const candidate = value[key];
        if (Array.isArray(candidate)) {
            return candidate.filter(isRecord);
        }
        if (isRecord(candidate)) {
            const nested = nestedRows(candidate);
            if (nested.length > 0) {
                return nested;
            }
        }
    }

    for (const child of Object.values(value)) {
        if (isRecord(child)) {
            const nested = nestedRows(child);
            if (nested.length > 0) {
                return nested;
            }
        }
    }

    return [];
}

function inferCurrency(value: unknown, fallback = "USD"): string {
    if (typeof value === "string") {
        if (value.includes("£")) return "GBP";
        if (value.includes("€")) return "EUR";
        if (value.includes("CA$")) return "CAD";
        if (value.includes("AU$")) return "AUD";
    }
    return fallback;
}

function normalizeRow(
    store: RoutedStore,
    source: ProviderId,
    row: Record<string, unknown>,
    index: number,
): NormalizedListing | null {
    const title = textOrNull(first(row, ["title", "product_title", "productTitle", "name"]));
    const url = textOrNull(first(row, ["url", "product_url", "productUrl", "link", "product_link", "canonical_url"]));
    if (!title || !url) {
        return null;
    }

    const rawPrice = first(row, [
        "price",
        "sale_price",
        "salePrice",
        "current_price",
        "currentPrice",
        "extracted_price",
        "price_value",
    ]);
    const rawCurrency = first(row, ["currency", "currency_code", "currencyCode"]);
    const currency = textOrNull(rawCurrency) ?? inferCurrency(rawPrice);
    const priceMinor = toNumberOrNull(first(row, ["price_minor", "priceMinor"]));
    const price = priceMinor === null
        ? money(rawPrice, currency)
        : { value: priceMinor / 100, currency };

    const rawShipping = first(row, ["shipping", "shipping_cost", "shippingCost", "delivery_price"]);
    const shippingMinor = toNumberOrNull(first(row, ["shipping_minor", "shippingMinor"]));
    const shippingCost = shippingMinor === null
        ? money(rawShipping, currency)
        : { value: shippingMinor / 100, currency };
    const totalCost = shippingCost.value === null
        ? { value: price.value, currency: price.currency }
        : addMoney(price, shippingCost);

    const id = String(first(row, ["asin", "product_id", "productId", "external_id", "externalId", "id", "item_id"]) ?? `${source}-${index}`);
    const sellerName = textOrNull(first(row, ["seller_name", "sellerName", "seller", "store_name", "storeName", "shop_name"]));
    const imageUrl = textOrNull(first(row, ["main_image", "image", "imageUrl", "image_url", "thumbnail"]));
    const rating = toNumberOrNull(first(row, ["rating", "stars", "evaluate_rate"]));
    const reviewCount = toNumberOrNull(first(row, ["reviews_count", "reviews", "reviewCount", "ratings_total"]));
    const sponsored = first(row, ["isSponsored", "is_sponsored", "sponsored"]);

    return {
        provider: store,
        id,
        title,
        url,
        imageUrl,
        price,
        shippingCost,
        totalCost,
        shippingAccuracy: shippingCost.value === null ? "unknown" : "generic",
        shippingOptions: [],
        condition: textOrNull(first(row, ["condition"])),
        sellerName,
        sellerFeedbackPercentage: null,
        sellerFeedbackScore: null,
        locationCountry: textOrNull(first(row, ["country", "ship_from_country", "shipFromCountry"])),
        buyingOptions: [],
        returnsAccepted: null,
        availability: null,
        metadata: {
            sourceProvider: source,
            ...(rating !== null ? { rating } : {}),
            ...(reviewCount !== null ? { reviewCount } : {}),
            ...(typeof sponsored === "boolean" ? { sponsored } : {}),
        },
    };
}

function normalizeRows(store: RoutedStore, source: ProviderId, payload: unknown): NormalizedListing[] {
    return nestedRows(payload)
        .map((row, index) => normalizeRow(store, source, row, index))
        .filter((listing): listing is NormalizedListing => listing !== null);
}

async function fetchJson(url: string | URL, init: RequestInit = {}): Promise<unknown> {
    const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
        throw new HTTPError(response.status, await readErrorBody(response));
    }
    return response.json();
}

async function searchBrightData(options: MarketplaceSearchOptions): Promise<NormalizedListing[]> {
    if (options.store !== "amazon") {
        throw new Error("Bright Data AliExpress adapter is not native yet; preserve this shared pool for Amazon.");
    }
    const apiKey = env("BRIGHT_DATA_API_KEY");
    if (!apiKey) throw new Error("BRIGHT_DATA_API_KEY is not configured");

    const datasetId = env("BRIGHT_DATA_AMAZON_DATASET_ID") ?? "gd_l7q7dkf244hwjntr0";
    const url = new URL("https://api.brightdata.com/datasets/v3/scrape");
    url.searchParams.set("dataset_id", datasetId);
    url.searchParams.set("discover_by", "keyword");
    url.searchParams.set("format", "json");

    const payload = await fetchJson(url, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            input: [{
                keyword: options.query,
                ...(options.shipToPostalCode ? { zipcode: options.shipToPostalCode } : {}),
            }],
        }),
    });
    return normalizeRows("amazon", "bright-data", payload);
}

async function searchScrapingDog(options: MarketplaceSearchOptions): Promise<NormalizedListing[]> {
    if (options.store !== "amazon") throw new Error("ScrapingDog is only routed for Amazon");
    const apiKey = env("SCRAPINGDOG_API_KEY");
    if (!apiKey) throw new Error("SCRAPINGDOG_API_KEY is not configured");

    const url = new URL("https://api.scrapingdog.com/amazon/search");
    url.searchParams.set("api_key", apiKey);
    url.searchParams.set("domain", env("AMAZON_TLD") ?? "com");
    url.searchParams.set("query", options.query);
    url.searchParams.set("page", "1");
    url.searchParams.set("country", (options.shipToCountry ?? "US").toLowerCase());
    if (options.shipToPostalCode) url.searchParams.set("postal_code", options.shipToPostalCode);

    const payload = await fetchJson(url);
    return normalizeRows("amazon", "scrapingdog", payload);
}

async function searchHasData(options: MarketplaceSearchOptions): Promise<NormalizedListing[]> {
    if (options.store !== "amazon") {
        throw new Error("HasData AliExpress adapter is not native yet; preserve this shared pool for Amazon.");
    }
    const apiKey = env("HASDATA_API_KEY");
    if (!apiKey) throw new Error("HASDATA_API_KEY is not configured");

    const url = new URL("https://api.hasdata.com/scrape/amazon/search");
    url.searchParams.set("q", options.query);
    url.searchParams.set("domain", env("AMAZON_DOMAIN") ?? "www.amazon.com");
    url.searchParams.set("page", "1");
    if (options.shipToPostalCode) url.searchParams.set("deliveryZip", options.shipToPostalCode);
    if (options.shipToCountry) url.searchParams.set("shippingLocation", options.shipToCountry.toUpperCase());

    const payload = await fetchJson(url, {
        headers: { "x-api-key": apiKey },
    });
    return normalizeRows("amazon", "hasdata", payload);
}

function apifyInput(options: MarketplaceSearchOptions): Record<string, unknown> {
    if (options.store === "aliexpress") {
        return {
            searchQuery: options.query,
            maxResults: Math.min(options.limit ?? 10, 50),
            ...(options.shipToCountry ? { shipToCountry: options.shipToCountry.toUpperCase() } : {}),
        };
    }
    return {
        searchStringsArray: [options.query],
        maxItems: Math.min(options.limit ?? 10, 50),
    };
}

async function searchApify(options: MarketplaceSearchOptions): Promise<NormalizedListing[]> {
    const token = env("APIFY_TOKEN");
    if (!token) throw new Error("APIFY_TOKEN is not configured");
    const actor = options.store === "amazon"
        ? env("APIFY_AMAZON_ACTOR_ID")
        : env("APIFY_ALIEXPRESS_ACTOR_ID");
    if (!actor) throw new Error(`APIFY_${options.store.toUpperCase()}_ACTOR_ID is not configured`);

    const actorId = actor.replace("/", "~");
    const url = new URL(`https://api.apify.com/v2/actors/${encodeURIComponent(actorId)}/run-sync-get-dataset-items`);
    url.searchParams.set("token", token);
    url.searchParams.set("clean", "1");
    url.searchParams.set("limit", String(Math.min(options.limit ?? 10, 50)));

    const payload = await fetchJson(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(apifyInput(options)),
    });
    return normalizeRows(options.store, "apify", payload);
}

async function searchSerpApi(options: MarketplaceSearchOptions): Promise<NormalizedListing[]> {
    if (options.store !== "amazon") throw new Error("SerpApi is only routed for Amazon discovery");
    const apiKey = env("SERPAPI_API_KEY");
    if (!apiKey) throw new Error("SERPAPI_API_KEY is not configured");

    const url = new URL("https://serpapi.com/search");
    url.searchParams.set("engine", "amazon");
    url.searchParams.set("api_key", apiKey);
    url.searchParams.set("k", options.query);
    url.searchParams.set("amazon_domain", env("SERPAPI_AMAZON_DOMAIN") ?? "amazon.com");

    const payload = await fetchJson(url);
    return normalizeRows("amazon", "serpapi", payload);
}

function aliExpressTimestamp(): string {
    return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function signAliExpress(params: Record<string, string>, secret: string): string {
    const material = Object.keys(params)
        .sort()
        .map((key) => `${key}${params[key]}`)
        .join("");
    const method = (env("ALIEXPRESS_SIGN_METHOD") ?? "md5").toLowerCase();
    if (method === "hmac") {
        return createHmac("md5", secret).update(material).digest("hex").toUpperCase();
    }
    return createHash("md5").update(`${secret}${material}${secret}`).digest("hex").toUpperCase();
}

async function searchAliExpressOfficial(options: MarketplaceSearchOptions): Promise<NormalizedListing[]> {
    if (options.store !== "aliexpress") throw new Error("AliExpress official adapter only supports AliExpress");
    const appKey = env("ALIEXPRESS_APP_KEY");
    const appSecret = env("ALIEXPRESS_APP_SECRET");
    if (!appKey || !appSecret) throw new Error("AliExpress app credentials are not configured");

    const params: Record<string, string> = {
        app_key: appKey,
        format: "json",
        method: "aliexpress.affiliate.product.query",
        sign_method: (env("ALIEXPRESS_SIGN_METHOD") ?? "md5").toLowerCase() === "hmac" ? "hmac" : "md5",
        timestamp: aliExpressTimestamp(),
        v: "2.0",
        keywords: options.query,
        page_no: "1",
        page_size: String(Math.min(options.limit ?? 10, 50)),
        target_currency: "USD",
        target_language: "EN",
        sort: "SALE_PRICE_ASC",
    };
    if (options.shipToCountry) params.ship_to_country = options.shipToCountry.toUpperCase();
    const trackingId = env("ALIEXPRESS_TRACKING_ID");
    if (trackingId) params.tracking_id = trackingId;
    if (options.minPrice !== undefined) params.min_sale_price = String(options.minPrice);
    if (options.maxPrice !== undefined) params.max_sale_price = String(options.maxPrice);
    params.sign = signAliExpress(params, appSecret);

    const payload = await fetchJson(env("ALIEXPRESS_API_URL") ?? "https://api-sg.aliexpress.com/sync", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
        body: new URLSearchParams(params),
    });
    return normalizeRows("aliexpress", "aliexpress-official", payload);
}

async function searchSelfHosted(options: MarketplaceSearchOptions): Promise<NormalizedListing[]> {
    return searchSelfHostedScraper({
        marketplace: options.store,
        query: options.query,
        limit: options.limit ?? 10,
    });
}

async function executeProvider(provider: ProviderId, options: MarketplaceSearchOptions): Promise<NormalizedListing[]> {
    switch (provider) {
        case "bright-data": return searchBrightData(options);
        case "scrapingdog": return searchScrapingDog(options);
        case "hasdata": return searchHasData(options);
        case "apify": return searchApify(options);
        case "serpapi": return searchSerpApi(options);
        case "amazon-selfhosted":
        case "aliexpress-selfhosted": return searchSelfHosted(options);
        case "aliexpress-official": return searchAliExpressOfficial(options);
        default:
            throw new Error(`${provider} is registered as trial/reserve capacity but does not have a native structured-data adapter yet`);
    }
}

function cacheKey(options: MarketplaceSearchOptions): string {
    return JSON.stringify([
        options.store,
        options.query.trim().toLowerCase(),
        options.limit ?? 10,
        options.minPrice ?? null,
        options.maxPrice ?? null,
        options.shipToCountry ?? null,
        options.shipToPostalCode ?? null,
    ]);
}

function filterAndDedupe(listings: NormalizedListing[], options: MarketplaceSearchOptions): NormalizedListing[] {
    const seen = new Set<string>();
    return listings.filter((listing) => {
        const price = listing.price.value;
        if (price !== null && options.minPrice !== undefined && price < options.minPrice) return false;
        if (price !== null && options.maxPrice !== undefined && price > options.maxPrice) return false;
        const key = `${listing.id}|${listing.url}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    }).sort((a, b) => (a.totalCost.value ?? Number.POSITIVE_INFINITY) - (b.totalCost.value ?? Number.POSITIVE_INFINITY));
}

export async function searchMarketplace(options: MarketplaceSearchOptions): Promise<MarketplaceSearchResult> {
    const normalizedOptions = {
        ...options,
        query: options.query.trim(),
        limit: Math.min(Math.max(options.limit ?? 10, 1), 50),
    };
    if (!normalizedOptions.query) throw new Error("Search query cannot be empty");

    const key = cacheKey(normalizedOptions);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
        return { ...cached.result, cacheHit: true };
    }

    const fullConfiguredRoute = getConfiguredRoute(normalizedOptions.store);
    const route = fullConfiguredRoute.filter((provider) => nativeProviders.has(provider));
    if (route.length === 0) {
        throw new Error(`No native ${normalizedOptions.store} search provider is configured`);
    }

    const attemptedProviders: ProviderId[] = [];
    const providerFailures: MarketplaceProviderFailure[] = [];
    let sourceUsed: ProviderId | null = null;
    let listings: NormalizedListing[] = [];

    for (const provider of route) {
        attemptedProviders.push(provider);
        try {
            const candidateListings = filterAndDedupe(await executeProvider(provider, normalizedOptions), normalizedOptions);
            if (candidateListings.length === 0) {
                providerFailures.push({ provider, error: "no usable listings" });
                continue;
            }
            sourceUsed = provider;
            listings = candidateListings.slice(0, normalizedOptions.limit);
            break;
        } catch (error) {
            providerFailures.push({ provider, error: errorMessage(error) });
        }
    }

    const result: MarketplaceSearchResult = {
        store: normalizedOptions.store,
        query: normalizedOptions.query,
        route: fullConfiguredRoute,
        attemptedProviders,
        sourceUsed,
        cacheHit: false,
        returned: listings.length,
        providerFailures,
        listings,
    };

    if (listings.length > 0) {
        cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, result });
    }
    return result;
}

export function clearMarketplaceCache(): void {
    cache.clear();
}
