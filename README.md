# Hardware Procurement MCP

A local, read-only MCP server for finding hardware listings and returning direct product links. It currently supports:

- **Unified procurement search** - one normalized shortlist across configured providers, with provider failures reported instead of hiding successful results.
- **eBay Browse API** - destination-aware search, filters, delivered-price ranking, seller data, and detailed item lookup.
- **Best Buy Products API** - catalog search, product details, shipping weight and cost fields, ratings, and open-box lookup.

It never adds items to a cart, checks out, bids, or purchases anything.

## Protocol safety

This server uses the MCP stdio transport. Standard output is reserved exclusively for JSON-RPC messages. Environment loading is centralized and runs with dotenv quiet mode enabled, so startup banners and normal logs cannot corrupt the protocol stream.

Do not add `console.log` calls to the server. Use `process.stderr.write` for local diagnostics, or MCP structured logging if logging is added later.

## Why destination matters

For eBay, shipping estimates become substantially more accurate when a destination country and postal code are supplied. The MCP tool description tells Claude to ask for these before treating shipping totals as final.

Best Buy's public Products API exposes catalog shipping fields, but exact address-specific checkout quotes require Best Buy's restricted Commerce API. Returned product URLs should be opened to confirm the final total.

## Tools

| Tool | Purpose |
|---|---|
| `get_procurement_status` | Show configured providers and non-secret defaults |
| `search_hardware` | Search configured providers and return one ranked shortlist with direct links |
| `search_ebay` | Search and filter eBay listings; rank by price plus returned shipping cost |
| `get_ebay_item` | Retrieve detailed listing, shipping, aspects, availability, returns, and direct link |
| `search_bestbuy` | Search Best Buy products with price and availability filters |
| `get_bestbuy_product` | Retrieve Best Buy product details by SKU |
| `get_bestbuy_open_box` | Retrieve Best Buy open-box offers for a SKU |

The detail tools omit the full raw provider response by default to reduce context usage. Set `include_raw` to true only when the normalized fields are insufficient.

## Setup

```bash
npm install
cp .env.example .env
npm run build
```

Fill in `.env`:

```env
EBAY_CLIENT_ID=your-client-id
EBAY_CLIENT_SECRET=your-client-secret
EBAY_MARKETPLACE_ID=EBAY_US
BESTBUY_API_KEY=your-api-key

# Optional defaults. Leave the postal code blank if Claude should always ask.
DEFAULT_SHIP_TO_COUNTRY=US
DEFAULT_SHIP_TO_POSTAL_CODE=
```

Only configured providers are searched by default. You can configure eBay, Best Buy, or both.

## Claude Desktop

Point Claude Desktop at the built JavaScript file:

```json
{
  "mcpServers": {
    "hardware-procurement": {
      "command": "node",
      "args": ["/absolute/path/to/ebay-search-mcp/dist/index.js"]
    }
  }
}
```

If Claude Desktop cannot find `node`, replace `command` with the full path returned by `where node` on Windows or `which node` on macOS/Linux.

After pulling or merging changes, always rebuild and restart Claude Desktop:

```bash
npm install
npm run build
```

## Troubleshooting invalid JSON startup errors

An error such as `Unexpected token` followed by text that is not JSON means something wrote to stdout before the MCP response. Run:

```bash
npm test
```

The protocol regression test starts the compiled server, confirms that startup produces no stdout, performs an MCP initialize handshake, lists tools, and verifies that every stdout line is valid JSON.

Also confirm that Claude Desktop points to the current `dist/index.js`, not an old clone or the TypeScript source.

## AliExpress status

AliExpress is intentionally not included yet. Public projects that expose destination shipping generally reverse-engineer AliExpress browser endpoints and depend on logged-in cookies. That can work locally, but it is more brittle than the official eBay and Best Buy integrations and needs a separate provider implementation with explicit warnings and throttling.

The next sensible step is an optional `aliexpress` adapter behind its own environment flag, not mixing unstable scraping into the reliable providers.
