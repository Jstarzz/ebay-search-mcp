import {
    addMoney,
    HTTPError,
    isRecord,
    money,
    type NormalizedListing,
    readErrorBody,
    textOrNull,
    toNumberOrNull,
    type ShippingOption,
} from "./common.js";
import { runtimeConfig } from "./config.js";

const apiKey = runtimeConfig.bestBuyApiKey;

export type BestBuySort = "relevance" | "price_low" | "price_high" | "rating_high";

export type BestBuySearchOptions = {
    query: string;
    limit?: number;
    minPrice?: number;
    maxPrice?: number;
    onlineOnly?: boolean;
    sort?: BestBuySort;
};

type BestBuySearchResponse = {
    total?: number;
    products?: unknown[];
};

function requireApiKey(): string {
    if (!apiKey) {
        throw new Error("Missing BESTBUY_API_KEY environment variable.");
    }
    return apiKey;
}

function escapeSearchToken(token: string): string {
    return token.replace(/[()&|=<>!,]/g, " ").trim();
}

export function buildBestBuySearchUrl(options: BestBuySearchOptions): URL {
    if (options.minPrice !== undefined && options.maxPrice !== undefined && options.minPrice > options.maxPrice) {
        throw new Error("minPrice cannot be greater than maxPrice.");
    }

    const tokens = options.query
        .split(/\s+/)
        .map(escapeSearchToken)
        .filter(Boolean);
    if (tokens.length === 0) {
        throw new Error("Best Buy search query must contain at least one searchable word.");
    }

    const clauses = tokens.map((token) => `search=${encodeURIComponent(token)}`);
    if (options.minPrice !== undefined) {
        clauses.push(`salePrice>=${options.minPrice}`);
    }
    if (options.maxPrice !== undefined) {
        clauses.push(`salePrice<=${options.maxPrice}`);
    }
    if (options.onlineOnly ?? true) {
        clauses.push("onlineAvailability=true");
    }

    const url = new URL(`https://api.bestbuy.com/v1/products(${clauses.join("&")})`);
    url.searchParams.set("format", "json");
    url.searchParams.set("apiKey", requireApiKey());
    url.searchParams.set("pageSize", String(Math.min(Math.max(options.limit ?? 10, 1), 50)));
    url.searchParams.set(
        "show",
        [
            "sku",
            "name",
            "salePrice",
            "regularPrice",
            "url",
            "addToCartUrl",
            "image",
            "thumbnailImage",
            "manufacturer",
            "modelNumber",
            "customerReviewAverage",
            "customerReviewCount",
            "shippingCost",
            "shippingWeight",
            "shippingLevelsOfService",
            "freeShipping",
            "freeShippingEligible",
            "onlineAvailability",
            "orderable",
            "condition",
            "preowned",
        ].join(","),
    );

    const sortMap: Partial<Record<BestBuySort, string>> = {
        price_low: "salePrice.asc",
        price_high: "salePrice.desc",
        rating_high: "customerReviewAverage.desc",
    };
    const sort = options.sort ? sortMap[options.sort] : undefined;
    if (sort) {
        url.searchParams.set("sort", sort);
    }

    return url;
}

function normalizeShippingOptions(value: unknown): ShippingOption[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value.filter(isRecord).map((option) => ({
        cost: money(option.unitShippingPrice, "USD"),
        serviceName: textOrNull(option.serviceLevelName),
        minEstimatedDeliveryDate: null,
        maxEstimatedDeliveryDate: null,
    }));
}

export function normalizeBestBuyProduct(product: unknown): NormalizedListing | null {
    if (!isRecord(product)) {
        return null;
    }

    const sku = product.sku === undefined || product.sku === null ? null : String(product.sku);
    const title = textOrNull(product.name);
    const url = textOrNull(product.url);
    if (!sku || !title || !url) {
        return null;
    }

    const price = money(product.salePrice, "USD");
    const shippingOptions = normalizeShippingOptions(product.shippingLevelsOfService);
    const shippingCost = money(product.shippingCost, "USD");
    const imageUrl = textOrNull(product.image) ?? textOrNull(product.thumbnailImage);

    return {
        provider: "bestbuy",
        id: sku,
        title,
        url,
        imageUrl,
        price,
        shippingCost,
        totalCost: addMoney(price, shippingCost),
        shippingAccuracy: shippingCost.value !== null ? "generic" : "unknown",
        shippingOptions,
        condition: textOrNull(product.condition) ?? (product.preowned === true ? "Pre-owned" : "New"),
        sellerName: "Best Buy",
        sellerFeedbackPercentage: null,
        sellerFeedbackScore: null,
        locationCountry: "US",
        buyingOptions: ["FIXED_PRICE"],
        returnsAccepted: null,
        availability: product.onlineAvailability === true ? "ONLINE" : product.orderable === true ? "ORDERABLE" : null,
        metadata: {
            regularPrice: toNumberOrNull(product.regularPrice),
            manufacturer: textOrNull(product.manufacturer),
            modelNumber: textOrNull(product.modelNumber),
            customerReviewAverage: toNumberOrNull(product.customerReviewAverage),
            customerReviewCount: toNumberOrNull(product.customerReviewCount),
            shippingWeightLb: toNumberOrNull(product.shippingWeight),
            freeShipping: product.freeShipping === true,
            freeShippingEligible: product.freeShippingEligible === true,
            addToCartUrl: textOrNull(product.addToCartUrl),
        },
    };
}

export async function searchBestBuy(options: BestBuySearchOptions): Promise<{
    provider: "bestbuy";
    query: string;
    total: number | null;
    returned: number;
    discarded: number;
    shippingWarning: string;
    listings: NormalizedListing[];
}> {
    const response = await fetch(buildBestBuySearchUrl(options));
    if (!response.ok) {
        throw new HTTPError(response.status, await readErrorBody(response));
    }

    const data = (await response.json()) as BestBuySearchResponse;
    const rawProducts = Array.isArray(data.products) ? data.products : [];
    const listings = rawProducts
        .map(normalizeBestBuyProduct)
        .filter((item): item is NormalizedListing => item !== null);

    return {
        provider: "bestbuy",
        query: options.query,
        total: typeof data.total === "number" ? data.total : null,
        returned: listings.length,
        discarded: rawProducts.length - listings.length,
        shippingWarning: "Best Buy's public Products API exposes catalog shipping costs, not an address-specific checkout quote. Open the returned product link to confirm the final destination cost.",
        listings,
    };
}

export async function getBestBuyProduct(sku: string, includeRaw = false): Promise<unknown> {
    const url = new URL(`https://api.bestbuy.com/v1/products/${encodeURIComponent(sku)}.json`);
    url.searchParams.set("apiKey", requireApiKey());
    url.searchParams.set("show", "all");

    const response = await fetch(url);
    if (!response.ok) {
        throw new HTTPError(response.status, await readErrorBody(response));
    }

    const product = (await response.json()) as Record<string, unknown>;
    return {
        listing: normalizeBestBuyProduct(product),
        ...(includeRaw ? { raw: product } : {}),
    };
}

export async function getBestBuyOpenBox(sku: string): Promise<unknown> {
    const url = new URL(`https://api.bestbuy.com/beta/products/${encodeURIComponent(sku)}/openBox`);
    url.searchParams.set("apiKey", requireApiKey());

    const response = await fetch(url);
    if (!response.ok) {
        throw new HTTPError(response.status, await readErrorBody(response));
    }

    return response.json();
}
