import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getBestBuyOpenBox, getBestBuyProduct, searchBestBuy } from "./bestbuy.js";
import { getEbayItem, searchEbay } from "./ebay.js";

const server = new McpServer({
    name: "hardware-procurement",
    version: "1.0.0",
});

const destinationFields = {
    ship_to_country: z.string().length(2).optional().describe("ISO 3166-1 alpha-2 country code, such as US."),
    ship_to_postal_code: z.string().min(1).optional().describe("Destination postal or ZIP code."),
};

server.tool(
    "search_ebay",
    "Read-only eBay procurement search. Returns direct listing links and ranks by item price plus the lowest returned shipping cost. Ask the user for destination country and postal code before relying on shipping totals.",
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
        const result = await searchEbay({
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
                text: result.shippingWarning
                    ? `Found ${result.returned} eBay listings. ${result.shippingWarning}`
                    : `Found ${result.returned} eBay listings with destination-aware shipping data.`,
            }],
        };
    },
);

server.tool(
    "get_ebay_item",
    "Get detailed read-only information for one eBay item, including direct link, aspects, shipping options, availability, and return terms. Accepts a REST item ID, numeric listing ID, or eBay item URL.",
    {
        item_id_or_url: z.string().min(1),
        ...destinationFields,
    },
    async (input) => {
        const result = await getEbayItem(
            input.item_id_or_url,
            input.ship_to_country,
            input.ship_to_postal_code,
        );
        return {
            structuredContent: result as Record<string, unknown>,
            content: [{ type: "text", text: "Retrieved the eBay item details and direct purchase link." }],
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
            content: [{ type: "text", text: `Found ${result.returned} Best Buy products. ${result.shippingWarning}` }],
        };
    },
);

server.tool(
    "get_bestbuy_product",
    "Get full read-only Best Buy product details and a direct product link by SKU.",
    { sku: z.string().min(1) },
    async ({ sku }) => {
        const result = await getBestBuyProduct(sku);
        return {
            structuredContent: result as Record<string, unknown>,
            content: [{ type: "text", text: "Retrieved the Best Buy product details and direct link." }],
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
            content: [{ type: "text", text: "Retrieved available Best Buy open-box offers." }],
        };
    },
);

const transport = new StdioServerTransport();
await server.connect(transport);
