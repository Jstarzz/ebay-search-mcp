# Hardware Procurement MCP

A local, read-only MCP server for finding hardware listings and returning direct product links. It currently supports:

- **eBay Browse API** — destination-aware search, filters, delivered-price ranking, seller data, detailed item lookup.
- **Best Buy Products API** — catalog search, product details, shipping weight/cost fields, ratings, and open-box lookup.

It never adds items to a cart, checks out, bids, or purchases anything.

## Why destination matters

For eBay, shipping estimates become substantially more accurate when a destination country and postal code are supplied. The MCP tool description tells Claude to ask for these before treating shipping totals as final.

Best Buy's public Products API exposes catalog shipping fields, but exact address-specific checkout quotes require Best Buy's restricted Commerce API. Returned product URLs should be opened to confirm the final total.

## Tools

| Tool | Purpose |
|---|---|
| `search_ebay` | Search and filter eBay listings; rank by price plus returned shipping cost |
| `get_ebay_item` | Retrieve detailed listing, shipping, aspects, availability, returns, and direct link |
| `search_bestbuy` | Search Best Buy products with price and availability filters |
| `get_bestbuy_product` | Retrieve full Best Buy product details by SKU |
| `get_bestbuy_open_box` | Retrieve Best Buy open-box offers for a SKU |

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

After changing configuration:

```bash
npm run build
```

Then restart Claude Desktop.

## AliExpress status

AliExpress is intentionally not included yet. Public projects that expose destination shipping generally reverse-engineer AliExpress's browser MTOP endpoints and depend on logged-in cookies. That can work locally, but it is more brittle than the official eBay and Best Buy integrations and needs a separate provider implementation with explicit warnings and throttling.

The next sensible step is an optional `aliexpress` adapter behind its own environment flag, not mixing unstable scraping into the reliable providers.
