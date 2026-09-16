import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getBestBuyOpenBox, getBestBuyProduct, searchBestBuy } from "./bestbuy.js";
import { getConfigurationStatus } from "./config.js";
import { getEbayItem } from "./ebay.js";
import {
    formatBestBuyOpenBoxResult,
    formatBestBuyProductResult,
    formatEbayItemResult,
} from "./format.js";
import { compactSearchPayload, searchSummary } from "./mcp-output.js";
import { searchMarketplace } from "./marketplace-search.js";
import { searchHardware } from "./procurement.js";
import { requireFilteredSearchRequest } from "./request-filter.js";
import { searchEbaySmart } from "./smart-ebay.js";

const searchLimit = z.number().int().min(1).max(12).default(6);
const destinationFields = {
    ship_to_country: z.string().length(2).optional().describe("2-letter destination country."),
    ship_to_postal_code: z.string().min(1).max(32).optional().describe("Destination postal code."),
};

function resultSource(listings: Array<{ metadata: Record<string, unknown> }>, fallback: string): string {
    const source = listings[0]?.metadata.sourceProvider;
    return typeof source === "string" && source ? source : fallback;
}

export function registerLegacyTools(server: McpServer): void {
    server.tool(
        "get_procurement_status",
        "Show configured search providers and routes.",
        {},
        async () => {
            const result = getConfigurationStatus();
            const enabled = Object.entries(result.providers)
                .filter(([, value]) => value.configured)
                .map(([provider]) => provider);
            const routes = Object.fromEntries(
                Object.entries(result.routing).map(([store, value]) => [store, value.configuredRoute]),
            );
            const compact = {
                providers: enabled,
                routes,
                ebay_marketplace: result.ebayMarketplaceId,
                destination: result.defaultDestination,
            };
            return {
                structuredContent: compact,
                content: [{ type: "text" as const, text: `Providers: ${enabled.join(", ") || "none"}.` }],
            };
        },
    );

    server.tool(
        "search_hardware",
        "Search eBay and/or Best Buy and rank the best listings.",
        {
            query: z.string().min(1).max(240),
            providers: z.array(z.enum(["ebay", "bestbuy"])).min(1).max(2).optional(),
            limit: searchLimit,
            min_price: z.number().nonnegative().optional(),
            max_price: z.number().nonnegative().optional(),
            ebay_conditions: z.array(z.enum(["NEW", "USED", "UNSPECIFIED"])).max(3).optional(),
            ebay_buying_options: z.array(z.enum(["FIXED_PRICE", "AUCTION", "BEST_OFFER", "CLASSIFIED_AD"])).max(4).optional(),
            returns_accepted: z.boolean().default(false),
            ...destinationFields,
        },
        async (input) => {
            const filtered = requireFilteredSearchRequest({
                query: input.query,
                minPrice: input.min_price,
                maxPrice: input.max_price,
                shipToCountry: input.ship_to_country,
                shipToPostalCode: input.ship_to_postal_code,
            });
            const result = await searchHardware({
                query: filtered.query,
                providers: input.providers,
                limit: input.limit,
                minPrice: filtered.minPrice,
                maxPrice: filtered.maxPrice,
                shipToCountry: filtered.shipToCountry,
                shipToPostalCode: filtered.shipToPostalCode,
                ebayConditions: input.ebay_conditions,
                ebayBuyingOptions: input.ebay_buying_options,
                returnsAccepted: input.returns_accepted,
            });
            const failureWarnings = result.providerFailures.map((failure) => `${failure.provider}: ${failure.error}`);
            const allProvidersFailed = result.providersSucceeded.length === 0 && result.providerFailures.length > 0;
            const source = result.providersSucceeded.join("+") || null;
            return {
                structuredContent: compactSearchPayload({
                    query: result.query,
                    listings: result.listings,
                    source,
                    warnings: [...result.warnings, ...failureWarnings],
                }),
                content: [{ type: "text" as const, text: searchSummary({
                    label: "hardware",
                    count: result.returned,
                    source,
                    failed: allProvidersFailed,
                }) }],
                isError: allProvidersFailed,
            };
        },
    );

    server.tool(
        "search_amazon",
        "Search Amazon through the configured provider router.",
        {
            query: z.string().min(1).max(240),
            limit: searchLimit,
            min_price: z.number().nonnegative().optional(),
            max_price: z.number().nonnegative().optional(),
            ...destinationFields,
        },
        async (input) => {
            const filtered = requireFilteredSearchRequest({
                query: input.query,
                minPrice: input.min_price,
                maxPrice: input.max_price,
                shipToCountry: input.ship_to_country,
                shipToPostalCode: input.ship_to_postal_code,
            });
            const result = await searchMarketplace({
                store: "amazon",
                query: filtered.query,
                limit: input.limit,
                minPrice: filtered.minPrice,
                maxPrice: filtered.maxPrice,
                shipToCountry: filtered.shipToCountry,
                shipToPostalCode: filtered.shipToPostalCode,
            });
            const warnings = result.providerFailures.map((failure) => `${failure.provider}: ${failure.error}`);
            return {
                structuredContent: compactSearchPayload({
                    query: result.query,
                    listings: result.listings,
                    source: result.sourceUsed,
                    cacheHit: result.cacheHit,
                    warnings,
                }),
                content: [{ type: "text" as const, text: searchSummary({
                    label: "Amazon",
                    count: result.returned,
                    source: result.sourceUsed,
                    cacheHit: result.cacheHit,
                    failed: result.sourceUsed === null,
                }) }],
                isError: result.sourceUsed === null,
            };
        },
    );

    server.tool(
        "search_aliexpress",
        "Search AliExpress through the configured provider router.",
        {
            query: z.string().min(1).max(240),
            limit: searchLimit,
            min_price: z.number().nonnegative().optional(),
            max_price: z.number().nonnegative().optional(),
            ...destinationFields,
        },
        async (input) => {
            const filtered = requireFilteredSearchRequest({
                query: input.query,
                minPrice: input.min_price,
                maxPrice: input.max_price,
                shipToCountry: input.ship_to_country,
                shipToPostalCode: input.ship_to_postal_code,
            });
            const result = await searchMarketplace({
                store: "aliexpress",
                query: filtered.query,
                limit: input.limit,
                minPrice: filtered.minPrice,
                maxPrice: filtered.maxPrice,
                shipToCountry: filtered.shipToCountry,
                shipToPostalCode: filtered.shipToPostalCode,
            });
            const warnings = result.providerFailures.map((failure) => `${failure.provider}: ${failure.error}`);
            return {
                structuredContent: compactSearchPayload({
                    query: result.query,
                    listings: result.listings,
                    source: result.sourceUsed,
                    cacheHit: result.cacheHit,
                    warnings,
                }),
                content: [{ type: "text" as const, text: searchSummary({
                    label: "AliExpress",
                    count: result.returned,
                    source: result.sourceUsed,
                    cacheHit: result.cacheHit,
                    failed: result.sourceUsed === null,
                }) }],
                isError: result.sourceUsed === null,
            };
        },
    );

    server.tool(
        "search_ebay",
        "Search eBay and rank listings by deal quality.",
        {
            query: z.string().min(1).max(240),
            limit: searchLimit,
            min_price: z.number().nonnegative().optional(),
            max_price: z.number().nonnegative().optional(),
            currency: z.string().length(3).default("USD"),
            conditions: z.array(z.enum(["NEW", "USED", "UNSPECIFIED"])).max(3).optional(),
            condition_ids: z.array(z.string().min(1).max(16)).max(8).optional(),
            buying_options: z.array(z.enum(["FIXED_PRICE", "AUCTION", "BEST_OFFER", "CLASSIFIED_AD"])).max(4).optional(),
            returns_accepted: z.boolean().default(false),
            free_shipping: z.boolean().default(false),
            item_location_country: z.string().length(2).optional(),
            category_id: z.string().min(1).max(32).optional(),
            sort: z.enum(["best_match", "price_low", "price_high", "newly_listed", "ending_soonest"]).default("best_match"),
            rank_by_total_cost: z.boolean().default(true),
            ...destinationFields,
        },
        async (input) => {
            const filtered = requireFilteredSearchRequest({
                query: input.query,
                minPrice: input.min_price,
                maxPrice: input.max_price,
                shipToCountry: input.ship_to_country,
                shipToPostalCode: input.ship_to_postal_code,
            });
            const result = await searchEbaySmart({
                query: filtered.query,
                limit: input.limit,
                minPrice: filtered.minPrice,
                maxPrice: filtered.maxPrice,
                currency: input.currency.toUpperCase(),
                conditions: input.conditions,
                conditionIds: input.condition_ids,
                buyingOptions: input.buying_options,
                returnsAccepted: input.returns_accepted,
                freeShipping: input.free_shipping,
                itemLocationCountry: input.item_location_country,
                shipToCountry: filtered.shipToCountry,
                shipToPostalCode: filtered.shipToPostalCode,
                categoryId: input.category_id,
                sort: input.sort,
                rankByTotalCost: input.rank_by_total_cost,
            });
            const source = resultSource(result.listings, "ebay");
            return {
                structuredContent: compactSearchPayload({
                    query: result.query,
                    listings: result.listings,
                    source,
                    warnings: result.shippingWarning ? [result.shippingWarning] : [],
                }),
                content: [{ type: "text" as const, text: searchSummary({
                    label: "eBay",
                    count: result.returned,
                    source,
                }) }],
            };
        },
    );

    server.tool(
        "get_ebay_item",
        "Get one eBay item's details.",
        {
            item_id_or_url: z.string().min(1).max(512),
            include_raw: z.boolean().default(false),
            ...destinationFields,
        },
        async (input) => {
            const result = await getEbayItem(
                input.item_id_or_url,
                input.ship_to_country,
                input.ship_to_postal_code,
                input.include_raw,
            );
            return {
                structuredContent: result as Record<string, unknown>,
                content: [{ type: "text" as const, text: input.include_raw ? formatEbayItemResult(result) : "eBay item details returned." }],
            };
        },
    );

    server.tool(
        "search_bestbuy",
        "Search the Best Buy catalog.",
        {
            query: z.string().min(1).max(240),
            limit: searchLimit,
            min_price: z.number().nonnegative().optional(),
            max_price: z.number().nonnegative().optional(),
            online_only: z.boolean().default(true),
            sort: z.enum(["relevance", "price_low", "price_high", "rating_high"]).default("relevance"),
        },
        async (input) => {
            const filtered = requireFilteredSearchRequest({
                query: input.query,
                minPrice: input.min_price,
                maxPrice: input.max_price,
            });
            const result = await searchBestBuy({
                query: filtered.query,
                limit: input.limit,
                minPrice: filtered.minPrice,
                maxPrice: filtered.maxPrice,
                onlineOnly: input.online_only,
                sort: input.sort,
            });
            return {
                structuredContent: compactSearchPayload({
                    query: result.query,
                    listings: result.listings,
                    source: "bestbuy",
                    warnings: [result.shippingWarning],
                }),
                content: [{ type: "text" as const, text: searchSummary({
                    label: "Best Buy",
                    count: result.returned,
                    source: "bestbuy",
                }) }],
            };
        },
    );

    server.tool(
        "get_bestbuy_product",
        "Get one Best Buy product by SKU.",
        {
            sku: z.string().min(1).max(64),
            include_raw: z.boolean().default(false),
        },
        async ({ sku, include_raw }) => {
            const result = await getBestBuyProduct(sku, include_raw);
            return {
                structuredContent: result as Record<string, unknown>,
                content: [{ type: "text" as const, text: include_raw ? formatBestBuyProductResult(result) : "Best Buy product details returned." }],
            };
        },
    );

    server.tool(
        "get_bestbuy_open_box",
        "Get Best Buy open-box offers for a SKU.",
        { sku: z.string().min(1).max(64) },
        async ({ sku }) => {
            const result = await getBestBuyOpenBox(sku);
            return {
                structuredContent: result as Record<string, unknown>,
                content: [{ type: "text" as const, text: formatBestBuyOpenBoxResult(result) }],
            };
        },
    );
}
