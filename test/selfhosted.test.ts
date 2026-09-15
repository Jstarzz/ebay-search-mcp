import assert from "node:assert/strict";
import test from "node:test";
import { searchSelfHostedScraper } from "../src/selfhosted.js";

const originalFetch = globalThis.fetch;
const originalURL = process.env.SELFHOSTED_SCRAPER_URL;
const originalKey = process.env.SELFHOSTED_SCRAPER_API_KEY;

function restore(): void {
    globalThis.fetch = originalFetch;
    if (originalURL === undefined) delete process.env.SELFHOSTED_SCRAPER_URL;
    else process.env.SELFHOSTED_SCRAPER_URL = originalURL;
    if (originalKey === undefined) delete process.env.SELFHOSTED_SCRAPER_API_KEY;
    else process.env.SELFHOSTED_SCRAPER_API_KEY = originalKey;
}

test.afterEach(restore);

test("self-hosted adapter speaks the web-scraper job contract and converts minor units", async () => {
    process.env.SELFHOSTED_SCRAPER_URL = "https://scraper.example.test";
    process.env.SELFHOSTED_SCRAPER_API_KEY = "ws_live_test_key";

    let requestBody: Record<string, unknown> | null = null;
    let requestURL = "";
    let authorization = "";
    let policyVersion = "";

    globalThis.fetch = async (input, init) => {
        requestURL = String(input);
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        policyVersion = new Headers(init?.headers).get("x-search-policy-version") ?? "";
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
            id: "job-1",
            marketplace: "amazon",
            query: "esp32 display",
            limit: 6,
            status: "complete",
            result: [{
                marketplace: "amazon",
                external_id: "B0123",
                title: "ESP32 Display",
                url: "https://amazon.example/dp/B0123",
                price_minor: 12345,
                shipping_minor: 500,
                currency: "usd",
                seller: "Example Seller",
                rating: 4.7,
                review_count: 321,
                available: true,
            }],
            created_at: "2026-09-15T00:00:00Z",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
    };

    const listings = await searchSelfHostedScraper({
        marketplace: "amazon",
        query: "esp32 display",
        limit: 6,
    });

    assert.equal(requestURL, "https://scraper.example.test/v1/search");
    assert.equal(authorization, "Bearer ws_live_test_key");
    assert.equal(policyVersion, "search-v1");
    assert.equal(requestBody?.marketplace, "amazon");
    assert.equal(requestBody?.query, "esp32 display");
    assert.equal(requestBody?.limit, 6);
    assert.equal(typeof requestBody?.wait_ms, "number");

    assert.equal(listings.length, 1);
    assert.equal(listings[0].price.value, 123.45);
    assert.equal(listings[0].shippingCost.value, 5);
    assert.equal(listings[0].totalCost.value, 128.45);
    assert.equal(listings[0].price.currency, "USD");
    assert.equal(listings[0].availability, "AVAILABLE");
    assert.deepEqual(listings[0].metadata, {
        sourceProvider: "amazon-selfhosted",
        rating: 4.7,
        reviewCount: 321,
    });
});

test("self-hosted adapter rejects a marketplace-mismatched job", async () => {
    process.env.SELFHOSTED_SCRAPER_URL = "https://scraper.example.test/v1/search";
    process.env.SELFHOSTED_SCRAPER_API_KEY = "ws_live_test_key";

    globalThis.fetch = async () => new Response(JSON.stringify({
        id: "job-2",
        marketplace: "aliexpress",
        query: "esp32",
        limit: 1,
        status: "complete",
        result: [],
        created_at: "2026-09-15T00:00:00Z",
    }), { status: 200, headers: { "Content-Type": "application/json" } });

    await assert.rejects(
        () => searchSelfHostedScraper({ marketplace: "amazon", query: "esp32", limit: 1 }),
        /returned marketplace aliexpress for amazon request/,
    );
});
