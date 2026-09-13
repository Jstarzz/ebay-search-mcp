import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getBestBuyOpenBox, getBestBuyProduct, searchBestBuy } from "./bestbuy.js";
import type { NormalizedListing } from "./common.js";
import { getConfigurationStatus } from "./config.js";
import { getEbayItem } from "./ebay.js";
import {
    formatBestBuyOpenBoxResult,
    formatBestBuyProductResult,
    formatEbayItemResult,
} from "./format.js";
import { searchMarketplace } from "./marketplace-search.js";
import { searchHardware } from "./procurement.js";
import { searchEbaySmart } from "./smart-ebay.js";

const server = new McpServer({
    name: "hardware-procurement",
    version: "1.3.0",
});

const destinationFields = {
    ship_to_country: z.string().length(2).optional().describe("ISO 3166-1 alpha-2 country code, such as US."),
    ship_to_postal_code: z.string().min(1).optional().describe("Destination postal or ZIP code."),
};

function compactText(value: string): string {
    return value.replace(/\s+/g, " ").trim().slice(0, 180);
}

function formatMoney(listing: NormalizedListing): string {
    const amount = listing.totalCost.value !== null ? listing.totalCost : listing.price;
    if (amount.value === null) {
        return "price unavailable";
    }
    return `${amount.currency ?? ""} ${amount.value.toFixed(2)}`.trim();
}

function formatListings(listings: NormalizedListing[], maximum = 10): string {
    if (listings.length === 0) {
        return "No listings returned.";
    }

    return listings.slice(0, maximum).map((listing, index) => {
        return `${index + 1}. ${compactText(listing.title)} | ${formatMoney(listing)} | ${listing.url}`;
    }).join("\n");
}

function formatSearchResult(
    heading: string,
    listings: NormalizedListing[],
    warnings: string[] = [],
): string {
    const sections = [heading];
    if (warnings.length > 0) {
        sections.push(`Warnings: ${warnings.join(" ")}`);
    }
    sections.push(formatListings(listings));
    return sections.join("\n");
}

server.tool(
    "get_procurement_status",
    "Show configured retailer credentials, routed marketplace fallbacks, the eBay marketplace, and non-secret destination defaults. Does not expose API credentials.",
    {},
    async () => {
        const result = getConfigurationStatus();
        const enabled = Object.entries(result.providers)
            .filter(([, value]) => value.configured)
            .map(([provider]) => provider);
        const routed = Object.entries(result.routing)
            .map(([store, value]) => `${store}: ${value.configuredRoute.join(" -> ") || "none"}`)
            .join("; ");

        return {
            structuredContent: result,
            content: [{
                type: "text",
                text: `Configured direct providers: ${enabled.join(", ") || "none"}. Routed fallbacks: ${routed}. eBay marketplace: ${result.ebayMarketplaceId}.`,
            }],
        };
    },
);

server.tool(
    "search_hardware",
    "Search configured read-only retailers and return one normalized shortlist with direct product links. Ask for the destination country and postal code before treating delivered totals as final. Provider failures are returned without hiding successful results.",
    {
        query: z.string().min(1),
        providers: z.array(z.enum(["ebay", "bestbuy"])).min(1).optional().describe("Providers to query. Omit to use every configured provider."),
        limit: z.number().int().min(1).max(50).default(10),
        min_price: z.number().nonnegative().optional(),
        max_price: z.number().nonnegative().optional(),
        ebay_conditions: z.array(z.enum(["NEW", "USED", "UNSPECIFIED"])).optional(),
        ebay_buying_options: z.array(z.enum(["FIXED_PRICE", "AUCTION", "BEST_OFFER", "CLASSIFIED_AD"])).optional(),
        returns_accepted: z.boolean().default(false),
        ...destinationFields,
    },
    async (input) => {
        const result = await searchHardware({
            query: input.query,
            providers: input.providers,
            limit: input.limit,
            minPrice: input.min_price,
            maxPrice: input.max_price,
            shipToCountry: input.ship_to_country,
            shipToPostalCode: input.ship_to_postal_code,
            ebayConditions: input.ebay_conditions,
            ebayBuyingOptions: input.ebay_buying_options,
            returnsAccepted: input.returns_accepted,
        });

        const failureWarnings = result.providerFailures.map((failure) => `${failure.provider} failed: ${failure.error}`);
        const allProvidersFailed = result.providersSucceeded.length === 0 && result.providerFailures.length > 0;
        const heading = allProvidersFailed
            ? "Search failed for every requested provider."
            : `Returned ${result.returned} hardware listings from ${result.providersSucceeded.join(", ") || "no providers"}.`;

        return {
            structuredContent: result,
            content: [{
                type: "text",
                text: formatSearchResult(
                    heading,
                    result.listings,
                    [...result.warnings, ...failureWarnings],
                ),
            }],
            isError: allProvidersFailed,
        };
    },
);

server.tool(
    "search_amazon",
    "Read-only Amazon deal search with a cache-first free-provider router. Current native route is Bright Data -> ScrapingDog -> HasData -> Apify -> SerpApi -> self-hosted, skipping unconfigured providers. Shared anti-bot capacity is intentionally prioritized for Amazon.",
    {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(50).default(10),
        min_price: z.number().nonnegative().optional(),
        max_price: z.number().nonnegative().optional(),
        ...destinationFields,
    },
    async (input) => {
        const result = await searchMarketplace({
            store: "amazon",
            query: input.query,
            limit: input.limit,
            minPrice: input.min_price,
            maxPrice: input.max_price,
            shipToCountry: input.ship_to_country,
            shipToPostalCode: input.ship_to_postal_code,
        });
        const warnings = result.providerFailures.map((failure) => `${failure.provider} failed: ${failure.error}`);
        const heading = result.sourceUsed
            ? `Found ${result.returned} Amazon listings via ${result.sourceUsed}${result.cacheHit ? " (cache)" : ""}.`
            : "Every configured Amazon provider failed or returned no usable listings.";
        return {
            structuredContent: result,
            content: [{ type: "text", text: formatSearchResult(heading, result.listings, warnings) }],
            isError: result.sourceUsed === null,
        };
    },
);

server.tool(
    "search_aliexpress",
    "Read-only AliExpress deal search with cache-first fallback routing. Priority is official Affiliate API -> Apify -> self-hosted before consuming shared Bright Data/HasData capacity. Trial providers remain reserve-only routing metadata until a structured adapter is configured.",
    {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(50).default(10),
        min_price: z.number().nonnegative().optional(),
        max_price: z.number().nonnegative().optional(),
        ...destinationFields,
    },
    async (input) => {
        const result = await searchMarketplace({
            store: "aliexpress",
            query: input.query,
            limit: input.limit,
            minPrice: input.min_price,
            maxPrice: input.max_price,
            shipToCountry: input.ship_to_country,
            shipToPostalCode: input.ship_to_postal_code,
        });
        const warnings = result.providerFailures.map((failure) => `${failure.provider} failed: ${failure.error}`);
        const heading = result.sourceUsed
            ? `Found ${result.returned} AliExpress listings via ${result.sourceUsed}${result.cacheHit ? " (cache)" : ""}.`
            : "Every configured AliExpress provider failed or returned no usable listings.";
        return {
            structuredContent: result,
            content: [{ type: "text", text: formatSearchResult(heading, result.listings, warnings) }],
            isError: result.sourceUsed === null,
        };
    },
);

server.tool(
    "search_ebay",
    "Read-only eBay procurement search. Searches a larger eBay candidate pool, retries transient provider failures, and ranks by delivered cost, query match, seller quality, returns, shipping certainty, and listing-risk signals. Ask the user for destination country and postal code before relying on shipping totals.",
    {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(50).default(10),
        min_price: z.number().nonnegative().optional(),
        max_price: z.number().nonnegative().optional(),
        currency: z.string().length(3).default("USD"),
        conditions: z.array(z.enum(["NEW", "USED", "UNSPECIFIED"])).optional(),
        condition_ids: z.array(z.string().min(1)).optional(),
        buying_options: z.array(z.enum(["FIXED_PRICE", "AUCTION", "BEST_OFFER", "CLASSIFIED_AD"])).optional(),
        returns_accepted: z.boolean().default(false),
        free_shipping: z.boolean().default(false),
        item_location_country: z.string().length(2).optional(),
        category_id: z.string().min(1).optional(),
        sort: z.enum(["best_match", "price_low", "price_high", "newly_listed", "ending_soonest"]).default("best_match"),
        rank_by_total_cost: z.boolean().default(true),
        ...destinationFields,
    },
    async (input) => {
        const result = await searchEbaySmart({
            query: input.query,
            limit: input.limit,
            minPrice: input.min_price,
            maxPrice: input.max_price,
            currency: input.currency.toUpperCase(),
            conditions: input.conditions,
            conditionIds: input.condition_ids,
            buyingOptions: input.buying_options,
            returnsAccepted: input.returns_accepted,
            freeShipping: input.free_shipping,
            itemLocationCountry: input.item_location_country,
            shipToCountry: input.ship_to_country,
            shipToPostalCode: input.ship_to_postal_code,
            categoryId: input.category_id,
            sort: input.sort,
            rankByTotalCost: input.rank_by_total_cost,
        });

        return {
            structuredContent: result,
            content: [{
                type: "text",
                text: formatSearchResult(
                    `Found ${result.returned} eBay listings ranked for deal quality.`,
                    result.listings,
                    result.shippingWarning ? [result.shippingWarning] : [],
                ),
            }],
        };
    },
);

server.tool(
    "get_ebay_item",
    "Get detailed read-only information for one eBay item, including direct link, price, seller, shipping, aspects, availability, and return terms. Accepts a REST item ID, numeric listing ID, or eBay item URL.",
    {
        item_id_or_url: z.string().min(1),
        include_raw: z.boolean().default(false).describe("Include the full provider payload. Leave false to reduce context size."),
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
            content: [{ type: "text", text: formatEbayItemResult(result) }],
        };
    },
);

server.tool(
    "search_bestbuy",
    "Read-only Best Buy catalog search using the official Products API. Returns product links, prices, catalog shipping cost, shipping weight, ratings, and availability. Exact address-specific shipping must still be confirmed on Best Buy.",
    {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(50).default(10),
        min_price: z.number().nonnegative().optional(),
        max_price: z.number().nonnegative().optional(),
        online_only: z.boolean().default(true),
        sort: z.enum(["relevance", "price_low", "price_high", "rating_high"]).default("relevance"),
    },
    async (input) => {
        const result = await searchBestBuy({
            query: input.query,
            limit: input.limit,
            minPrice: input.min_price,
            maxPrice: input.max_price,
            onlineOnly: input.online_only,
            sort: input.sort,
        });
        return {
            structuredContent: result,
            content: [{
                type: "text",
                text: formatSearchResult(
                    `Found ${result.returned} Best Buy products.`,
                    result.listings,
                    [result.shippingWarning],
                ),
            }],
        };
    },
);

server.tool(
    "get_bestbuy_product",
    "Get full read-only Best Buy product details and a direct product link by SKU.",
    {
        sku: z.string().min(1),
        include_raw: z.boolean().default(false).describe("Include the full provider payload. Leave false to reduce context size."),
    },
    async ({ sku, include_raw }) => {
        const result = await getBestBuyProduct(sku, include_raw);
        return {
            structuredContent: result as Record<string, unknown>,
            content: [{ type: "text", text: formatBestBuyProductResult(result) }],
        };
    },
);

server.tool(
    "get_bestbuy_open_box",
    "Check read-only Best Buy open-box offers for a SKU. Returns offer condition, pricing, and product links when available.",
    { sku: z.string().min(1) },
    async ({ sku }) => {
        const result = await getBestBuyOpenBox(sku);
        return {
            structuredContent: result as Record<string, unknown>,
            content: [{ type: "text", text: formatBestBuyOpenBoxResult(result) }],
        };
    },
);

async function main(): Promise<void> {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`Failed to start hardware procurement MCP: ${message}\n`);
    process.exitCode = 1;
});
