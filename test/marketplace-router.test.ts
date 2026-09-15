import assert from "node:assert/strict";
import test from "node:test";
import { clearMarketplaceCache, searchMarketplace } from "../src/marketplace-router.js";

const originalFetch = globalThis.fetch;
const envKeys = [
    "BRIGHT_DATA_API_KEY",
    "SCRAPINGDOG_API_KEY",
    "HASDATA_API_KEY",
    "APIFY_TOKEN",
    "APIFY_AMAZON_ACTOR_ID",
    "SERPAPI_API_KEY",
    "SELFHOSTED_SCRAPER_URL",
    "SELFHOSTED_SCRAPER_API_KEY",
    "AMAZON_SELFHOSTED_URL",
    "AMAZON_SELFHOSTED_API_KEY",
] as const;
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

function isolateScrapingDog(): void {
    for (const key of envKeys) delete process.env[key];
    process.env.SCRAPINGDOG_API_KEY = "test-key";
    clearMarketplaceCache();
}

function restore(): void {
    globalThis.fetch = originalFetch;
    for (const key of envKeys) {
        const value = originalEnv[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    clearMarketplaceCache();
}

test.afterEach(restore);

test("coalesces concurrent identical routed searches", async () => {
    isolateScrapingDog();
    let calls = 0;
    globalThis.fetch = async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 40));
        return new Response(JSON.stringify({
            products: [{ title: "ESP32 Display", url: "https://example.test/esp32", price: "$12.00" }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
    };

    const options = { store: "amazon" as const, query: "esp32 display", limit: 6 };
    const [first, second] = await Promise.all([
        searchMarketplace(options),
        searchMarketplace(options),
    ]);

    assert.equal(calls, 1);
    assert.equal(first.returned, 1);
    assert.equal(second.returned, 1);
    assert.equal(first.sourceUsed, "scrapingdog");
    assert.equal(second.sourceUsed, "scrapingdog");
});

test("short negative cache prevents immediate repeated provider spend", async () => {
    isolateScrapingDog();
    let calls = 0;
    globalThis.fetch = async () => {
        calls += 1;
        return new Response(JSON.stringify({ products: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        });
    };

    const options = { store: "amazon" as const, query: "nothing here", limit: 6 };
    const first = await searchMarketplace(options);
    const second = await searchMarketplace(options);

    assert.equal(calls, 1);
    assert.equal(first.sourceUsed, null);
    assert.equal(second.sourceUsed, null);
    assert.equal(second.cacheHit, true);
});
