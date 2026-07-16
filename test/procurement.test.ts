import assert from "node:assert/strict";
import test from "node:test";
import type { NormalizedListing } from "../src/common.js";
import { rankProcurementListings } from "../src/procurement.js";

function listing(id: string, total: number | null, price: number): NormalizedListing {
    return {
        provider: "ebay",
        id,
        title: id,
        url: `https://example.com/${id}`,
        imageUrl: null,
        price: { value: price, currency: "USD" },
        shippingCost: { value: total === null ? null : total - price, currency: "USD" },
        totalCost: { value: total, currency: "USD" },
        shippingAccuracy: total === null ? "unknown" : "destination-aware",
        shippingOptions: [],
        condition: null,
        sellerName: null,
        sellerFeedbackPercentage: null,
        sellerFeedbackScore: null,
        locationCountry: null,
        buyingOptions: [],
        returnsAccepted: null,
        availability: null,
        metadata: {},
    };
}

test("rankProcurementListings puts known lower delivered totals first", () => {
    const ranked = rankProcurementListings([
        listing("unknown", null, 100),
        listing("expensive", 250, 220),
        listing("cheap", 210, 200),
    ]);

    assert.deepEqual(ranked.map((item) => item.id), ["cheap", "expensive", "unknown"]);
});
