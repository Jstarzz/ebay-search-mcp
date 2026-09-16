import assert from "node:assert/strict";
import test from "node:test";
import type { NormalizedListing } from "../src/common.js";
import { compactListing, compactProductURL, compactSearchPayload, compactSearchText } from "../src/mcp-output.js";

function listing(overrides: Partial<NormalizedListing> = {}): NormalizedListing {
    return {
        provider: "amazon",
        id: "A1",
        title: "Example Product",
        url: "https://example.com/item/1?utm_source=test&ref=tracking&variant=blue#reviews",
        imageUrl: null,
        price: { value: 10, currency: "USD" },
        shippingCost: { value: 2, currency: "USD" },
        totalCost: { value: 12, currency: "USD" },
        shippingAccuracy: "generic",
        shippingOptions: [],
        condition: null,
        sellerName: "Seller",
        sellerFeedbackPercentage: null,
        sellerFeedbackScore: null,
        locationCountry: null,
        buyingOptions: [],
        returnsAccepted: null,
        availability: "AVAILABLE",
        metadata: { rating: 4.8, reviewCount: 250, raw: { huge: "must not leak" } },
        ...overrides,
    };
}

test("compactProductURL removes tracking but preserves meaningful query parameters", () => {
    assert.equal(
        compactProductURL("https://example.com/item?utm_source=x&ref=y&variant=blue#fragment"),
        "https://example.com/item?variant=blue",
    );
});

test("compactListing omits raw metadata and redundant price when total is known", () => {
    const result = compactListing(listing());
    assert.deepEqual(result, {
        id: "A1",
        title: "Example Product",
        url: "https://example.com/item/1?variant=blue",
        total: "USD 12.00",
        ship: "USD 2.00",
        seller: "Seller",
        rating: 4.8,
        reviews: 250,
        availability: "AVAILABLE",
    });
    assert.equal("metadata" in result, false);
    assert.equal("price" in result, false);
});

test("compactSearchPayload keeps diagnostics bounded", () => {
    const payload = compactSearchPayload({
        query: "esp32",
        listings: [listing()],
        source: "amazon-selfhosted",
        cacheHit: true,
        warnings: ["a".repeat(300), "second", "third"],
    });
    assert.equal(payload.count, 1);
    assert.equal(payload.source, "amazon-selfhosted");
    assert.equal(payload.cache, true);
    assert.equal((payload.warnings as string[]).length, 2);
    assert.ok((payload.warnings as string[])[0].length <= 140);
});

test("compactSearchText exposes useful listings to text-only MCP clients", () => {
    const text = compactSearchText({
        label: "Amazon",
        listings: [listing()],
        source: "hasdata",
    });

    assert.equal(
        text,
        "1 Amazon result via hasdata.\n1. Example Product — USD 12.00 total — 4.8★ — https://example.com/item/1?variant=blue",
    );
    assert.equal(text.includes("huge"), false);
    assert.equal(text.includes("utm_source"), false);
});

test("compactSearchText preserves a concise failure response", () => {
    assert.equal(
        compactSearchText({ label: "AliExpress", listings: [], source: null, failed: true }),
        "AliExpress search failed.",
    );
});
