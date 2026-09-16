import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getBestBuyOpenBox, getBestBuyProduct, searchBestBuy } from "./bestbuy.js";
import { getEbayItem } from "./ebay.js";
import { registerLegacyTools } from "./legacy-tools.js";
import { compactSearchPayload, compactSearchText } from "./mcp-output.js";
import { searchMarketplace } from "./marketplace-router.js";
import { RequestFilterError, requireFilteredSearchRequest } from "./request-filter.js";
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
const debugErrors = process.env.MCP_DEBUG_ERRORS?.trim() === "1";

function sourceFromListings(listings: Array<{ metadata: Record<string, unknown> }>, fallback: string): string {
    const source = listings[0]?.metadata.sourceProvider;
    return typeof source === "string" && source ? source : fallback;
}

function compactErrorMessage(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error);
    const compact = raw.replace(/\s+/g, " ").trim();
    return compact.length <= 180 ? compact : `${compact.slice(0, 177)}...`;
}

function toolFailure(label: string, error: unknown): {
    structuredContent: Record<string, unknown>;
    content: Array<{ type: "text"; text: string }>;
    isError: true;
} {
    const code = error instanceof RequestFilterError ? error.code : "request_failed";
    return {
        structuredContent: {
            error: code,
            ...(debugErrors ? { detail: compactErrorMessage(error) } : {}),
        },
        content: [{ type: "text", text: `${label} failed.` }],
        isError: true,
    };
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
        const label = input.marketplace === "amazon"
            ? "Amazon search"
            : input.marketplace === "aliexpress"
                ? "AliExpress search"
                : input.marketplace === "ebay"
                    ? "eBay search"
                    : "Best Buy search";
        try {
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
                const resultLabel = input.marketplace === "amazon" ? "Amazon" : "AliExpress";
                return {
                    structuredContent: compactSearchPayload({
                        query: result.query,
                        listings: result.listings,
                        source: result.sourceUsed,
                        cacheHit: result.cacheHit,
                        warnings,
                    }),
                    content: [{ type: "text" as const, text: compactSearchText({
                        label: resultLabel,
                        listings: result.listings,
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
                    content: [{ type: "text" as const, text: compactSearchText({
                        label: "eBay",
                        listings: result.listings,
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
                content: [{ type: "text" as const, text: compactSearchText({
                    label: "Best Buy",
                    listings: result.listings,
                    source: "bestbuy",
                }) }],
            };
        } catch (error) {
            return toolFailure(label, error);
        }
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
        try {
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
        } catch (error) {
            return toolFailure("Product lookup", error);
        }
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
