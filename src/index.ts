import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { search_items } from "./ebay.js";

const server = new McpServer({
    name: "ebay-search",
    version: "0.1.0",
});

server.tool(
    "search_ebay",
    "Search eBay listings and return normalized results.",
    {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(20).default(5),
    },
    async ({ query, limit }) => {
        const result = await search_items(query, limit);

        return {
            structuredContent: result,
            content: [
                {
                    type: "text",
                    text: `Found ${result.returned} listings${result.total !== null ? ` out of ${result.total}` : ""}; ${result.discarded} were filtered out.`,
                },
            ],
        };
    },
);

const transport = new StdioServerTransport();
await server.connect(transport);