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

The deterministic filter runs before provider network I/O. The self-hosted scraper independently applies its matching `search-v1` policy before it creates a job, so direct scraper calls do not bypass the gate.

## Lean MCP surface

The default MCP exposes only two tools:

| Tool | Purpose |
|---|---|
| `search_products` | Search eBay, Amazon, AliExpress, or Best Buy |
| `get_product` | Get one eBay/Best Buy item; optionally request Best Buy open-box offers |

This is intentional. Tool definitions are model context too. Keeping five overlapping search tools plus several detail/status tools would impose a static token tax before any result is returned.

For compatibility/debugging, set:

```env
MCP_LEGACY_TOOLS=1
```

That additionally exposes the previous provider-specific tool set. It is off by default.

Provider exception details are also hidden from model context by default. Set `MCP_DEBUG_ERRORS=1` only while debugging; details are still length-bounded.

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
  "wait_ms": 0
}
```

The MCP intentionally uses async job creation and polls `GET /v1/jobs/:id` at 1 Hz until completion or the total self-hosted timeout expires. The scraper job endpoint is authenticated but designed as a cheap status read rather than new scrape work. Scraper values such as `price_minor` and `shipping_minor` are converted from minor currency units before ranking/output.

## Token/context budget

Search output is deliberately compact because MCP tool definitions and tool results both become model context.

- Default search size is 6 listings; maximum is 12.
- Default tool surface is 2 tools instead of 9 provider-specific tools.
- Search results are not emitted twice as full JSON plus repeated prose listings.
- Search text output is one short summary line.
- Structured results contain only useful model-facing fields.
- Raw provider rows are excluded from ordinary search results.
- Null/default fields are omitted.
- Product titles and warning strings are bounded.
- Common URL tracking parameters are removed while meaningful query parameters are retained.
- Provider warning/error strings are bounded; provider exception detail is hidden unless debug mode is enabled.
- Deterministic rejection codes are preserved without echoing suspicious input.
- Detailed raw payloads are available only through the optional legacy/debug surface.

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

Pull requests and `main` build/test on Node 20 and Node 22 across Linux and Windows. The protocol test locks the default tool list to the lean two-tool surface. The package is also packed on the release-capable matrix leg.
