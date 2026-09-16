import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { clearMarketplaceCache, searchMarketplace } from "../src/marketplace-search.js";

function listen(server: http.Server): Promise<number> {
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (!address || typeof address === "string") {
                reject(new Error("test server did not bind to a TCP port"));
                return;
            }
            resolve(address.port);
        });
    });
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("self-hosted Amazon fallback authenticates, sends marketplace, polls queued jobs, and normalizes minor-unit prices", async () => {
    clearMarketplaceCache();
    const originalEnv = { ...process.env };
    let searchBody: Record<string, unknown> | null = null;
    let searchAuthorization = "";
    let pollAuthorization = "";
    let polls = 0;

    const server = http.createServer(async (req, res) => {
        if (req.method === "POST" && req.url === "/v1/search") {
            searchAuthorization = req.headers.authorization ?? "";
            const chunks: Buffer[] = [];
            for await (const chunk of req) chunks.push(Buffer.from(chunk));
            searchBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
            res.writeHead(202, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "job-1", status: "queued" }));
            return;
        }

        if (req.method === "GET" && req.url === "/v1/jobs/job-1") {
            pollAuthorization = req.headers.authorization ?? "";
            polls += 1;
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                id: "job-1",
                status: "complete",
                result: [{
                    marketplace: "amazon",
                    external_id: "B0TEST123",
                    title: "Example GPU",
                    url: "https://www.amazon.com/dp/B0TEST123",
                    image_url: "https://images.example/gpu.jpg",
                    seller: "Example Seller",
                    price_minor: 49999,
                    shipping_minor: 0,
                    currency: "USD",
                    available: true,
                    rating: 4.8,
                    review_count: 1234,
                }],
            }));
            return;
        }

        res.writeHead(404);
        res.end();
    });

    const port = await listen(server);
    try {
        for (const key of [
            "BRIGHT_DATA_API_KEY",
            "SCRAPINGDOG_API_KEY",
            "HASDATA_API_KEY",
            "APIFY_TOKEN",
            "APIFY_AMAZON_ACTOR_ID",
            "SERPAPI_API_KEY",
        ]) delete process.env[key];
        process.env.AMAZON_SELFHOSTED_URL = `http://127.0.0.1:${port}/v1/search`;
        process.env.AMAZON_SELFHOSTED_API_KEY = "ws_live_test";
        process.env.SELFHOSTED_WAIT_MS = "0";
        process.env.SELFHOSTED_TOTAL_TIMEOUT_MS = "5000";

        const result = await searchMarketplace({ store: "amazon", query: "gpu", limit: 5 });

        assert.equal(searchAuthorization, "Bearer ws_live_test");
        assert.equal(pollAuthorization, "Bearer ws_live_test");
        assert.ok(polls >= 1);
        assert.equal(searchBody?.marketplace, "amazon");
        assert.equal(searchBody?.query, "gpu");
        assert.equal(searchBody?.wait_ms, 0);
        assert.equal(result.sourceUsed, "amazon-selfhosted");
        assert.equal(result.listings.length, 1);
        assert.equal(result.listings[0].id, "B0TEST123");
        assert.equal(result.listings[0].price.value, 499.99);
        assert.equal(result.listings[0].shippingCost.value, 0);
        assert.equal(result.listings[0].sellerName, "Example Seller");
        assert.equal(result.listings[0].availability, "available");
        assert.equal(result.listings[0].metadata.reviewCount, 1234);
    } finally {
        await close(server);
        process.env = originalEnv;
        clearMarketplaceCache();
    }
});
