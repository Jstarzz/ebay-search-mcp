# Hardware Procurement MCP

Read-only MCP product search across eBay, Amazon, AliExpress, Best Buy, and the self-hosted `web-scraper` service.

The design goal is simple: deterministic filtering first, cheap/cacheable search paths next, compact model context last. The MCP never buys, bids, checks out, or changes retailer accounts.

## Request path

```text
MCP client / model
  -> deterministic request filter
  -> provider router
  -> official/provider API OR authenticated web-scraper
  -> normalized listings
  -> compact MCP response
```

The deterministic filter runs before provider network I/O. The self-hosted scraper independently applies its own matching `search-v1` policy before it creates a job, so direct calls to the scraper do not bypass the gate.

## Deterministic search gate

`src/request-filter.ts` performs no AI calls and no network calls. It normalizes benign input and rejects malformed or suspicious search requests with stable codes.

It rejects:

- hidden, control, zero-width, and bidirectional characters
- URLs embedded in product search text
- credential, bearer-token, and private-key shaped values
- prompt-injection and instruction-like text
- localhost, metadata-service, environment, and sensitive-file targets
- excessive query length or term count
- invalid price values or reversed price ranges
- invalid destination country/postal fields

The same pure module can be reused by a gateway if filtering must happen before an upstream model sees the request.

## Self-hosted scraper integration

Preferred configuration:

```env
SELFHOSTED_SCRAPER_URL=https://scraper.example.com
SELFHOSTED_SCRAPER_API_KEY=your-web-scraper-api-key
```

One URL/key pair configures the eBay, Amazon, and AliExpress self-hosted routes. Per-marketplace URL/key overrides are also supported; see `.env.example`.

The client speaks the real `web-scraper` job protocol:

```http
POST /v1/search
Authorization: Bearer <api-key>
Content-Type: application/json
X-Search-Policy-Version: search-v1
```

```json
{
  "marketplace": "amazon",
  "query": "esp32 display",
  "limit": 6,
  "wait_ms": 10000
}
```

If the API returns `202`, the MCP polls `GET /v1/jobs/:id` until the job completes or the total self-hosted budget expires. Scraper listing values such as `price_minor` and `shipping_minor` are converted from minor currency units before ranking/output.

## Token/context budget

Search tools are deliberately compact because MCP tool output becomes model context.

- Default search size is 6 listings; the MCP tool maximum is 12.
- Search results are not emitted twice as full JSON plus repeated prose listings.
- Search text output is one short summary line.
- Structured results contain only useful model-facing fields.
- Raw provider rows are not included in ordinary search results.
- Null/default fields are omitted.
- Product titles and warning strings are bounded.
- Common URL tracking parameters are removed while meaningful query parameters are retained.
- Provider error strings are bounded and only a small warning set is surfaced.
- Tool descriptions and schemas are intentionally short.
- Detailed raw payloads remain opt-in on item-detail tools.

This reduces both repeated context and accidental prompt-size growth when providers return large nested objects.

## Provider routing

```text
eBay:
  official Browse API
  -> self-hosted web-scraper

Amazon:
  cache
  -> Bright Data
  -> ScrapingDog
  -> HasData
  -> Apify
  -> SerpApi
  -> reserve providers
  -> self-hosted web-scraper

AliExpress:
  cache
  -> official Affiliate API
  -> Apify
  -> self-hosted web-scraper
  -> shared reserve capacity
```

Only providers with complete configuration are included in a route. Amazon and AliExpress routed results use a five-minute in-process cache keyed by store, query, price range, destination, and result limit.

## Tools

| Tool | Purpose |
|---|---|
| `get_procurement_status` | Compact configured provider/route status |
| `search_hardware` | Search eBay and/or Best Buy and rank a shortlist |
| `search_amazon` | Routed Amazon product search |
| `search_aliexpress` | Routed AliExpress product search |
| `search_ebay` | eBay search with deal ranking and self-hosted fallback |
| `get_ebay_item` | One detailed eBay item lookup |
| `search_bestbuy` | Best Buy catalog search |
| `get_bestbuy_product` | One Best Buy product lookup |
| `get_bestbuy_open_box` | Best Buy open-box lookup |

## Setup

```bash
npm install
cp .env.example .env
npm run build
npm test
```

Configure only providers you actually use. For the self-hosted path, the simplest setup is the shared URL/key pair shown above.

## Protocol safety

MCP uses stdio, so stdout is reserved for JSON-RPC. Environment loading uses quiet mode. Do not add `console.log` calls to the server; use stderr or MCP structured logging for diagnostics.

## Destination accuracy

Shipping precision depends on the provider. eBay can use destination country/postal data. Other sources may expose only generic shipping or search-page pricing. Treat unknown shipping as provisional and confirm final checkout values on the retailer.

## Claude Desktop

Point the client at the compiled entry point:

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

After pulling changes, run `npm install && npm run build` and restart the MCP client.

## CI

Pull requests and `main` build/test on Node 20 and Node 22 across Linux and Windows. The package is also packed on the release-capable matrix leg to catch missing distribution files.
