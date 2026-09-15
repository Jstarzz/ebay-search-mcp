import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getBestBuyOpenBox, getBestBuyProduct, searchBestBuy } from "./bestbuy.js";
import { getEbayItem } from "./ebay.js";
import { registerLegacyTools } from "./legacy-tools.js";
import { compactSearchPayload, searchSummary } from "./mcp-output.js";
import { searchMarketplace } from "./marketplace-search.js";
import { requireFilteredSearchRequest } from "./request-filter.js";
import { searchEbaySmart } from "./smart-ebay.js";

const server = new McpServer({
    name: "hardware-procurement",
    version: "1.5.0",
});

const searchLimit = z.number().int().min(1).max(12).default(6);
const destinationFields = {
    ship_to_country: z.string().length(2).optional(),
    ship_to_postal_code: z.string().min(1).max(32).optional(),
};

function sourceFromListings(listings: Array<{ metadata: Record<string, unknown> }>, fallback: string): string {
    const source = listings[0]?.metadata.sourceProvider;
    return typeof source === "string" && source ? source : fallback;
}

server.tool(
    "search_products",
    "Search one marketplace for products.",
    {
        marketplace: z.enum(["ebay", "amazon", "aliexpress", "bestbuy"]),
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

        if (input.marketplace === "amazon" || input.marketplace === "aliexpress") {
            const result = await searchMarketplace({
                store: input.marketplace,
                query: filtered.query,
                limit: input.limit,
                minPrice: filtered.minPrice,
                maxPrice: filtered.maxPrice,
                shipToCountry: filtered.shipToCountry,
                shipToPostalCode: filtered.shipToPostalCode,
            });
            const warnings = result.providerFailures.map((failure) => `${failure.provider}: ${failure.error}`);
            const label = input.marketplace === "amazon" ? "Amazon" : "AliExpress";
            return {
                structuredContent: compactSearchPayload({
                    query: result.query,
                    listings: result.listings,
                    source: result.sourceUsed,
                    cacheHit: result.cacheHit,
                    warnings,
                }),
                content: [{ type: "text" as const, text: searchSummary({
                    label,
                    count: result.returned,
                    source: result.sourceUsed,
                    cacheHit: result.cacheHit,
                    failed: result.sourceUsed === null,
                }) }],
                isError: result.sourceUsed === null,
            };
        }

        if (input.marketplace === "ebay") {
            const result = await searchEbaySmart({
                query: filtered.query,
                limit: input.limit,
                minPrice: filtered.minPrice,
                maxPrice: filtered.maxPrice,
                currency: "USD",
                shipToCountry: filtered.shipToCountry,
                shipToPostalCode: filtered.shipToPostalCode,
                sort: "best_match",
                rankByTotalCost: true,
            });
            const source = sourceFromListings(result.listings, "ebay");
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
        }

        const result = await searchBestBuy({
            query: filtered.query,
            limit: input.limit,
            minPrice: filtered.minPrice,
            maxPrice: filtered.maxPrice,
            onlineOnly: true,
            sort: "relevance",
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
    "get_product",
    "Get details for one eBay or Best Buy product.",
    {
        marketplace: z.enum(["ebay", "bestbuy"]),
        id_or_url: z.string().min(1).max(512),
        open_box: z.boolean().default(false),
        ...destinationFields,
    },
    async (input) => {
        if (input.marketplace === "ebay") {
            if (input.open_box) {
                throw new Error("open_box is only supported for Best Buy");
            }
            const result = await getEbayItem(
                input.id_or_url,
                input.ship_to_country,
                input.ship_to_postal_code,
                false,
            );
            return {
                structuredContent: result as Record<string, unknown>,
                content: [{ type: "text" as const, text: "eBay item details returned." }],
            };
        }

        const result = input.open_box
            ? await getBestBuyOpenBox(input.id_or_url)
            : await getBestBuyProduct(input.id_or_url, false);
        return {
            structuredContent: result as Record<string, unknown>,
            content: [{
                type: "text" as const,
                text: input.open_box ? "Best Buy open-box offers returned." : "Best Buy product details returned.",
            }],
        };
    },
);

if (process.env.MCP_LEGACY_TOOLS?.trim() === "1") {
    registerLegacyTools(server);
}

async function main(): Promise<void> {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`Failed to start hardware procurement MCP: ${message}\n`);
    process.exitCode = 1;
});
