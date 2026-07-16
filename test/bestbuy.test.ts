import assert from "node:assert/strict";
import test from "node:test";

process.env.BESTBUY_API_KEY = "test-key";

const { buildBestBuySearchUrl, normalizeBestBuyProduct } = await import("../src/bestbuy.js");

test("buildBestBuySearchUrl supports search and price filters", () => {
    const url = buildBestBuySearchUrl({
        query: "RTX 4070",
        minPrice: 400,
        maxPrice: 700,
        sort: "price_low",
    });

    assert.match(url.pathname, /search=RTX/);
    assert.match(url.pathname, /salePrice%3E=400|salePrice>=400/);
    assert.equal(url.searchParams.get("sort"), "salePrice.asc");
});

test("normalizeBestBuyProduct exposes direct URL and total", () => {
    const listing = normalizeBestBuyProduct({
        sku: 123,
        name: "GPU",
        url: "https://bestbuy.example/item",
        salePrice: 500,
        shippingCost: 0,
    });

    assert.equal(listing?.url, "https://bestbuy.example/item");
    assert.equal(listing?.totalCost.value, 500);
});
