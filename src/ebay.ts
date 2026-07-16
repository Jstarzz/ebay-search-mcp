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

const clientId = runtimeConfig.ebayClientId;
const clientSecret = runtimeConfig.ebayClientSecret;
const marketplaceId = runtimeConfig.ebayMarketplaceId;
const defaultShipToCountry = runtimeConfig.defaultShipToCountry;
const defaultShipToPostalCode = runtimeConfig.defaultShipToPostalCode;

type TokenCache = {
    token: string;
    expiresAt: number;
};

let tokenCache: TokenCache | null = null;

interface EbayTokenData {
    access_token: string;
    expires_in: number;
}

export type EbaySort = "best_match" | "price_low" | "price_high" | "newly_listed" | "ending_soonest";

export type EbaySearchOptions = {
    query: string;
    limit?: number;
    minPrice?: number;
    maxPrice?: number;
    currency?: string;
    conditions?: Array<"NEW" | "USED" | "UNSPECIFIED">;
    conditionIds?: string[];
    buyingOptions?: Array<"FIXED_PRICE" | "AUCTION" | "BEST_OFFER" | "CLASSIFIED_AD">;
    returnsAccepted?: boolean;
    freeShipping?: boolean;
    itemLocationCountry?: string;
    shipToCountry?: string;
    shipToPostalCode?: string;
    categoryId?: string;
    sort?: EbaySort;
    rankByTotalCost?: boolean;
};

type EbaySearchResponse = {
    total?: number;
    itemSummaries?: unknown[];
};

export type EbaySearchResult = {
    provider: "ebay";
    query: string;
    total: number | null;
    returned: number;
    discarded: number;
    destination: {
        country: string | null;
        postalCode: string | null;
    };
    shippingWarning: string | null;
    listings: NormalizedListing[];
};

async function getAccessToken(): Promise<string> {
    if (!clientId || !clientSecret) {
        throw new Error("Missing EBAY_CLIENT_ID or EBAY_CLIENT_SECRET environment variables.");
    }

    const now = Date.now();
    if (tokenCache && tokenCache.expiresAt > now) {
        return tokenCache.token;
    }

    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const response = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
        method: "POST",
        headers: {
            Authorization: `Basic ${credentials}`,
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
            grant_type: "client_credentials",
            scope: "https://api.ebay.com/oauth/api_scope",
        }),
    });

    if (!response.ok) {
        throw new HTTPError(response.status, await readErrorBody(response));
    }

    const data = (await response.json()) as EbayTokenData;
    tokenCache = {
        token: data.access_token,
        expiresAt: Date.now() + Math.max(data.expires_in - 60, 0) * 1000,
    };
    return tokenCache.token;
}

function buildRange(minimum: number | undefined, maximum: number | undefined): string | null {
    if (minimum === undefined && maximum === undefined) {
        return null;
    }
    if (minimum !== undefined && maximum !== undefined) {
        return `[${minimum}..${maximum}]`;
    }
    if (minimum !== undefined) {
        return `[${minimum}]`;
    }
    return `[..${maximum}]`;
}

function setFilterSet(filters: string[], name: string, values: string[] | undefined): void {
    if (values && values.length > 0) {
        filters.push(`${name}:{${values.join("|")}}`);
    }
}

export function resolveEbayDestination(options: EbaySearchOptions): {
    country?: string;
    postalCode?: string;
} {
    const country = options.shipToCountry ?? defaultShipToCountry;
    const postalCode = options.shipToPostalCode ?? defaultShipToPostalCode;
    return { country, postalCode };
}

export function buildEbaySearchUrl(options: EbaySearchOptions): URL {
    if (options.minPrice !== undefined && options.maxPrice !== undefined && options.minPrice > options.maxPrice) {
        throw new Error("minPrice cannot be greater than maxPrice.");
    }
    if (options.conditions?.length && options.conditionIds?.length) {
        throw new Error("Use either conditions or conditionIds, not both.");
    }

    const limit = Math.min(Math.max(options.limit ?? 10, 1), 50);
    const url = new URL("https://api.ebay.com/buy/browse/v1/item_summary/search");
    const params = new URLSearchParams({
        q: options.query,
        limit: String(limit),
        fieldgroups: "EXTENDED",
    });

    const filters: string[] = [];
    const priceRange = buildRange(options.minPrice, options.maxPrice);
    if (priceRange) {
        filters.push(`price:${priceRange}`);
        filters.push(`priceCurrency:${options.currency ?? "USD"}`);
    }

    setFilterSet(filters, "conditions", options.conditions);
    setFilterSet(filters, "conditionIds", options.conditionIds);
    setFilterSet(filters, "buyingOptions", options.buyingOptions);

    if (options.returnsAccepted) {
        filters.push("returnsAccepted:true");
    }
    if (options.freeShipping) {
        filters.push("maxDeliveryCost:0");
    }
    if (options.itemLocationCountry) {
        filters.push(`itemLocationCountry:${options.itemLocationCountry.toUpperCase()}`);
    }

    const destination = resolveEbayDestination(options);
    if (destination.country) {
        filters.push(`deliveryCountry:${destination.country.toUpperCase()}`);
    }
    if (destination.postalCode) {
        if (!destination.country) {
            throw new Error("shipToPostalCode requires shipToCountry.");
        }
        filters.push(`deliveryPostalCode:${destination.postalCode}`);
    }

    if (filters.length > 0) {
        params.set("filter", filters.join(","));
    }
    if (options.categoryId) {
        params.set("category_ids", options.categoryId);
    }

    const sortMap: Partial<Record<EbaySort, string>> = {
        price_low: "price",
        price_high: "-price",
        newly_listed: "newlyListed",
        ending_soonest: "endingSoonest",
    };
    const sort = options.sort ? sortMap[options.sort] : undefined;
    if (sort) {
        params.set("sort", sort);
    }

    url.search = params.toString();
    return url;
}

function buildEndUserContext(country?: string, postalCode?: string): string | undefined {
    if (!country) {
        return undefined;
    }

    const locationParts = [`country=${country.toUpperCase()}`];
    if (postalCode) {
        locationParts.push(`zip=${postalCode}`);
    }
    return `contextualLocation=${encodeURIComponent(locationParts.join(","))}`;
}

function normalizeShippingOptions(value: unknown): ShippingOption[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value
        .filter(isRecord)
        .map((option) => {
            const shippingCost = isRecord(option.shippingCost) ? option.shippingCost : null;
            return {
                cost: money(shippingCost?.value, shippingCost?.currency),
                serviceName: textOrNull(option.shippingServiceCode ?? option.type),
                minEstimatedDeliveryDate: textOrNull(option.minEstimatedDeliveryDate),
                maxEstimatedDeliveryDate: textOrNull(option.maxEstimatedDeliveryDate),
            };
        });
}

function selectLowestShipping(options: ShippingOption[], fallbackCurrency: string | null) {
    const known = options.filter((option) => option.cost.value !== null);
    if (known.length === 0) {
        return { value: null, currency: fallbackCurrency };
    }

    return known.reduce((best, current) => {
        return (current.cost.value ?? Number.POSITIVE_INFINITY) < (best.cost.value ?? Number.POSITIVE_INFINITY)
            ? current
            : best;
    }).cost;
}

export function normalizeEbayListing(item: unknown, destinationAware: boolean): NormalizedListing | null {
    if (!isRecord(item)) {
        return null;
    }

    const itemId = textOrNull(item.itemId);
    const title = textOrNull(item.title);
    const url = textOrNull(item.itemAffiliateWebUrl) ?? textOrNull(item.itemWebUrl);
    if (!itemId || !title || !url) {
        return null;
    }

    const rawPrice = isRecord(item.price) ? item.price : null;
    const price = money(rawPrice?.value, rawPrice?.currency);
    const shippingOptions = normalizeShippingOptions(item.shippingOptions);
    const shippingCost = selectLowestShipping(shippingOptions, price.currency);
    const seller = isRecord(item.seller) ? item.seller : null;
    const location = isRecord(item.itemLocation) ? item.itemLocation : null;
    const image = isRecord(item.image) ? item.image : null;
    const buyingOptions = Array.isArray(item.buyingOptions)
        ? item.buyingOptions.filter((value): value is string => typeof value === "string")
        : [];

    return {
        provider: "ebay",
        id: itemId,
        title,
        url,
        imageUrl: textOrNull(image?.imageUrl),
        price,
        shippingCost,
        totalCost: addMoney(price, shippingCost),
        shippingAccuracy: destinationAware ? "destination-aware" : shippingOptions.length > 0 ? "generic" : "unknown",
        shippingOptions,
        condition: textOrNull(item.condition),
        sellerName: textOrNull(seller?.username),
        sellerFeedbackPercentage: toNumberOrNull(seller?.feedbackPercentage),
        sellerFeedbackScore: toNumberOrNull(seller?.feedbackScore),
        locationCountry: textOrNull(location?.country),
        buyingOptions,
        returnsAccepted: typeof item.returnsAccepted === "boolean" ? item.returnsAccepted : null,
        availability: textOrNull(item.itemEndDate),
        metadata: {
            shortDescription: textOrNull(item.shortDescription),
            categoryId: textOrNull(item.categoryId),
            itemGroupId: textOrNull(item.itemGroupId),
        },
    };
}

function compareTotalCost(left: NormalizedListing, right: NormalizedListing): number {
    const leftValue = left.totalCost.value ?? Number.POSITIVE_INFINITY;
    const rightValue = right.totalCost.value ?? Number.POSITIVE_INFINITY;
    return leftValue - rightValue;
}

export async function searchEbay(options: EbaySearchOptions): Promise<EbaySearchResult> {
    const token = await getAccessToken();
    const destination = resolveEbayDestination(options);
    const url = buildEbaySearchUrl(options);
    const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID": marketplaceId,
    };

    const endUserContext = buildEndUserContext(destination.country, destination.postalCode);
    if (endUserContext) {
        headers["X-EBAY-C-ENDUSERCTX"] = endUserContext;
    }

    const response = await fetch(url, { headers });
    if (!response.ok) {
        throw new HTTPError(response.status, await readErrorBody(response));
    }

    const data = (await response.json()) as EbaySearchResponse;
    const rawItems = Array.isArray(data.itemSummaries) ? data.itemSummaries : [];
    const listings = rawItems
        .map((item) => normalizeEbayListing(item, Boolean(destination.country && destination.postalCode)))
        .filter((item): item is NormalizedListing => item !== null);

    if (options.rankByTotalCost ?? true) {
        listings.sort(compareTotalCost);
    }

    return {
        provider: "ebay",
        query: options.query,
        total: typeof data.total === "number" ? data.total : null,
        returned: listings.length,
        discarded: rawItems.length - listings.length,
        destination: {
            country: destination.country ?? null,
            postalCode: destination.postalCode ?? null,
        },
        shippingWarning: destination.country && destination.postalCode
            ? null
            : "Shipping is not fully destination-aware. Ask the user for the destination country and postal code, then rerun the search.",
        listings,
    };
}

export function extractLegacyItemId(value: string): string | null {
    if (/^\d{9,15}$/.test(value)) {
        return value;
    }

    try {
        const url = new URL(value);
        const match = url.pathname.match(/\/itm\/(?:[^/]+\/)?(\d{9,15})(?:\/|$)/);
        return match?.[1] ?? null;
    } catch {
        return null;
    }
}

export async function getEbayItem(
    itemIdOrUrl: string,
    shipToCountry?: string,
    shipToPostalCode?: string,
    includeRaw = false,
): Promise<unknown> {
    const token = await getAccessToken();
    const country = shipToCountry ?? defaultShipToCountry;
    const postalCode = shipToPostalCode ?? defaultShipToPostalCode;
    const legacyId = extractLegacyItemId(itemIdOrUrl);

    let url: URL;
    if (itemIdOrUrl.startsWith("v1|")) {
        url = new URL(`https://api.ebay.com/buy/browse/v1/item/${encodeURIComponent(itemIdOrUrl)}`);
    } else if (legacyId) {
        url = new URL("https://api.ebay.com/buy/browse/v1/item/get_item_by_legacy_id");
        url.searchParams.set("legacy_item_id", legacyId);
    } else {
        throw new Error("Provide an eBay REST item ID, numeric legacy listing ID, or eBay item URL.");
    }

    const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID": marketplaceId,
    };
    const endUserContext = buildEndUserContext(country, postalCode);
    if (endUserContext) {
        headers["X-EBAY-C-ENDUSERCTX"] = endUserContext;
    }

    const response = await fetch(url, { headers });
    if (!response.ok) {
        throw new HTTPError(response.status, await readErrorBody(response));
    }

    const item = (await response.json()) as Record<string, unknown>;
    const normalized = normalizeEbayListing(item, Boolean(country && postalCode));
    const localizedAspects = Array.isArray(item.localizedAspects)
        ? item.localizedAspects.filter(isRecord).map((aspect) => ({
            name: textOrNull(aspect.name),
            value: textOrNull(aspect.value),
        }))
        : [];
    const returnTerms = isRecord(item.returnTerms) ? item.returnTerms : null;
    const returnPeriod = isRecord(returnTerms?.returnPeriod) ? returnTerms.returnPeriod : null;

    return {
        listing: normalized,
        destination: {
            country: country ?? null,
            postalCode: postalCode ?? null,
        },
        shortDescription: textOrNull(item.shortDescription),
        description: textOrNull(item.description),
        aspects: localizedAspects,
        returns: {
            accepted: typeof returnTerms?.returnsAccepted === "boolean" ? returnTerms.returnsAccepted : null,
            periodValue: toNumberOrNull(returnPeriod?.value),
            periodUnit: textOrNull(returnPeriod?.unit),
        },
        estimatedAvailabilities: Array.isArray(item.estimatedAvailabilities) ? item.estimatedAvailabilities : [],
        additionalImages: Array.isArray(item.additionalImages) ? item.additionalImages : [],
        ...(includeRaw ? { raw: item } : {}),
    };
}
