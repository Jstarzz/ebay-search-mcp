# Hardware Procurement MCP

A local, read-only MCP server for finding hardware and shopping listings with direct product links. It now supports resilient eBay search plus routed Amazon and AliExpress fallbacks while keeping purchasing actions out of scope.

## What it supports

- **eBay** - official Browse API first, with smart deal ranking, transient-error retries, and an optional self-hosted scraper fallback in the routing policy.
- **Amazon** - cache-first routing across Bright Data, ScrapingDog, HasData, Apify, SerpApi, reserve providers, and self-hosted overflow.
- **AliExpress** - cache-first routing across the official Affiliate API, Apify, self-hosted scraping, shared Bright Data/HasData capacity, and reserve providers.
- **Best Buy** - official Products API, product details, shipping fields, ratings, and open-box lookup.
- **Normalized results** - provider-specific payloads are converted into one listing shape so downstream formatting and ranking do not need provider-specific branches.

It never adds items to a cart, checks out, bids, places orders, or changes retailer accounts.

## Deterministic request gate

Every search tool passes through a pure deterministic filter before any retailer API, paid scraping provider, or self-hosted scraper request is made. The filter does not call an AI model and does not perform network I/O.

Benign input is normalized with Unicode NFKC normalization, whitespace collapse, destination-country uppercasing, and postal-code trimming. The request is rejected before provider routing when it contains hidden/control characters, URLs in a search query, credential-shaped values, prompt-injection style instructions, internal/metadata targets, excessive query size, invalid price values or ranges, or invalid destination fields.

The reusable implementation is in `src/request-filter.ts`. A separate gateway can import the same function if filtering must happen before an upstream LLM sees a request. Inside this MCP, the gate runs after the MCP client has chosen a tool but before any external shopping/search endpoint is contacted.

## Provider routing policy

The provider order is intentionally asymmetric. Amazon is the difficult anti-bot target, so shared recurring-free capacity is preserved for Amazon whenever possible.

```text
eBay:
  official Browse API
  -> self-hosted fallback

Amazon:
  cache
  -> Bright Data
  -> ScrapingDog
  -> HasData
  -> Apify
  -> SerpApi
  -> trial/reserve pool
  -> self-hosted

AliExpress:
  cache
  -> official Affiliate API
  -> Apify
  -> self-hosted
  -> Bright Data
  -> HasData
  -> trial/reserve pool
```

The trial/reserve pool is registered separately and is never treated as permanent monthly capacity:

- Oxylabs
- ScrapingBee
- ScraperAPI
- Crawlbase
- Zyte
- Decodo

The routing registry tracks provider class, recurring allowance metadata, shared allowance groups, required environment variables, and whether capacity should be preserved for Amazon. `get_procurement_status` exposes the configured route without exposing secrets.

### Native adapters currently wired

Amazon has native structured-data adapters for:

- Bright Data Amazon dataset scraping
- ScrapingDog Amazon Search API
- HasData Amazon Search API
- Apify Actor execution
- SerpApi Amazon Search API
- self-hosted JSON endpoint

AliExpress has native structured-data adapters for:

- official Affiliate Product Query API
- Apify Actor execution
- self-hosted JSON endpoint

Bright Data and HasData remain in the AliExpress policy after the cheaper paths, but the MCP deliberately does not consume them for AliExpress through an unstructured generic scraper yet. This protects Amazon capacity and avoids pretending an HTML response is equivalent to structured product data.

The reserve providers are present in policy/configuration now, but they do not yet have native structured adapters. They can be rotated in later without changing the routing model or MCP tool contracts.

## Cache behavior

Amazon and AliExpress routed searches use a five-minute in-process cache keyed by store, query, price range, destination, and result limit. A cache hit avoids consuming any provider credits.

The router tries configured providers in order and stops after the first provider returns usable structured listings. Provider failures are retained in the result for diagnostics rather than silently swallowed.

## Protocol safety

This server uses MCP over stdio. Standard output is reserved exclusively for JSON-RPC messages. Environment loading uses dotenv quiet mode so startup banners cannot corrupt the protocol stream.

Do not add `console.log` calls to the server. Use `process.stderr.write` for local diagnostics or MCP structured logging.

## Tools

| Tool | Purpose |
|---|---|
| `get_procurement_status` | Show configured direct providers, routing order, and non-secret defaults |
| `search_hardware` | Search the existing eBay/Best Buy procurement providers and return one ranked shortlist |
| `search_amazon` | Search Amazon through the cache-first free-provider router |
| `search_aliexpress` | Search AliExpress through the cache-first official/Apify/self-hosted router |
| `search_ebay` | Search eBay with retry logic and deal-quality ranking |
| `get_ebay_item` | Retrieve detailed eBay listing, seller, shipping, availability, returns, and direct link |
| `search_bestbuy` | Search Best Buy products with price and availability filters |
| `get_bestbuy_product` | Retrieve Best Buy product details by SKU |
| `get_bestbuy_open_box` | Retrieve Best Buy open-box offers for a SKU |

## Setup

```bash
npm install
cp .env.example .env
npm run build
npm test
```

Configure only the providers you actually have. Unconfigured providers are skipped automatically.

### Core retailer credentials

```env
EBAY_CLIENT_ID=
EBAY_CLIENT_SECRET=
EBAY_MARKETPLACE_ID=EBAY_US
BESTBUY_API_KEY=
```

### Amazon free-provider pool

```env
BRIGHT_DATA_API_KEY=
SCRAPINGDOG_API_KEY=
HASDATA_API_KEY=
SERPAPI_API_KEY=

APIFY_TOKEN=
APIFY_AMAZON_ACTOR_ID=

AMAZON_SELFHOSTED_URL=
```

### AliExpress pool

```env
ALIEXPRESS_APP_KEY=
ALIEXPRESS_APP_SECRET=
ALIEXPRESS_TRACKING_ID=
ALIEXPRESS_API_URL=https://api-sg.aliexpress.com/sync
ALIEXPRESS_SIGN_METHOD=md5

APIFY_TOKEN=
APIFY_ALIEXPRESS_ACTOR_ID=

ALIEXPRESS_SELFHOSTED_URL=
```

See `.env.example` for marketplace/domain overrides and reserve-provider variables.

## Self-hosted scraper contract

Amazon and AliExpress self-hosted fallbacks receive a POST body like:

```json
{
  "query": "rtx 3080",
  "limit": 10,
  "minPrice": 200,
  "maxPrice": 500,
  "shipToCountry": "US",
  "shipToPostalCode": "10001"
}
```

The endpoint may return a plain array or an object containing `results`, `products`, `items`, `data`, or `result`. Rows are normalized from common fields such as `title`, `url`, `price`, `currency`, `image`, seller fields, rating, review count, availability, and shipping cost.

## Destination accuracy

Shipping totals are only as good as the upstream provider data. eBay can become destination-aware when country and postal code are supplied. Amazon/AliExpress providers vary: some expose location-aware price/shipping while others only expose the search-page price. Treat unknown shipping as provisional and confirm final checkout totals on the retailer.

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

After pulling or merging changes, rebuild and restart the MCP client:

```bash
npm install
npm run build
```

## CI/CD

Pull requests and `main` run the full test/build matrix on Node 20 and 22 across Linux and Windows. Successful builds retain compiled artifacts and verify package contents.

Tags matching `v*.*.*` run the release workflow, verify the tag against `package.json`, run the complete test suite, build the npm tarball, generate SHA-256 checksums, upload artifacts, and create a GitHub Release.
