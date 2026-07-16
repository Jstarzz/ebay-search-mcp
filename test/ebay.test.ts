import assert from "node:assert/strict";
import test from "node:test";
import { buildEbaySearchUrl, extractLegacyItemId, normalizeEbayListing } from "../src/ebay.js";

test("buildEbaySearchUrl adds procurement filters", () => {
    const url = buildEbaySearchUrl({
        query: "RTX 3080",
        minPrice: 200,
        maxPrice: 400,
        currency: "USD",
        conditions: ["USED"],
        buyingOptions: ["FIXED_PRICE"],
        returnsAccepted: true,
        shipToCountry: "US",
        shipToPostalCode: "33166",
        sort: "price_low",
    });

    assert.equal(url.searchParams.get("q"), "RTX 3080");
    assert.equal(url.searchParams.get("sort"), "price");
    assert.match(url.searchParams.get("filter") ?? "", /price:\[200\.\.400\]/);
    assert.match(url.searchParams.get("filter") ?? "", /deliveryPostalCode:33166/);
});

test("extractLegacyItemId accepts common eBay URLs", () => {
    assert.equal(extractLegacyItemId("https://www.ebay.com/itm/Some-Item/123456789012"), "123456789012");
    assert.equal(extractLegacyItemId("123456789012"), "123456789012");
    assert.equal(extractLegacyItemId("not-an-item"), null);
});

test("normalizeEbayListing calculates delivered total", () => {
    const listing = normalizeEbayListing({
        itemId: "v1|123|0",
        title: "GPU",
        itemWebUrl: "https://example.com/item",
        price: { value: "200", currency: "USD" },
        shippingOptions: [{ shippingCost: { value: "15", currency: "USD" } }],
    }, true);

    assert.equal(listing?.totalCost.value, 215);
    assert.equal(listing?.shippingAccuracy, "destination-aware");
});
