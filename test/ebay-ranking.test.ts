import assert from "node:assert/strict";
import test from "node:test";
import type { NormalizedListing } from "../src/common.js";
import { ebayDealScore, rankEbayDeals } from "../src/ebay-ranking.js";

function listing(overrides: Partial<NormalizedListing>): NormalizedListing {
    return {
        provider: "ebay",
        id: "1",
        title: "NVIDIA RTX 3080 10GB",
        url: "https://example.com/item",
        imageUrl: null,
        price: { value: 300, currency: "USD" },
        shippingCost: { value: 0, currency: "USD" },
        totalCost: { value: 300, currency: "USD" },
        shippingAccuracy: "destination-aware",
        shippingOptions: [],
        condition: "Used",
        sellerName: "seller",
        sellerFeedbackPercentage: 99.8,
        sellerFeedbackScore: 5000,
        locationCountry: "US",
        buyingOptions: ["FIXED_PRICE"],
        returnsAccepted: true,
        availability: null,
        metadata: {},
        ...overrides,
    };
}

test("rankEbayDeals prefers a trustworthy close-priced listing", () => {
    const risky = listing({
        id: "risky",
        title: "NVIDIA RTX 3080 10GB untested as-is",
        price: { value: 270, currency: "USD" },
        totalCost: { value: 270, currency: "USD" },
        sellerFeedbackPercentage: 92,
        sellerFeedbackScore: 4,
        returnsAccepted: false,
    });
    const safe = listing({ id: "safe" });

    const ranked = rankEbayDeals([risky, safe], "RTX 3080 10GB");
    assert.equal(ranked[0]?.id, "safe");
});

test("deal scoring penalizes weak query matches", () => {
    const exact = listing({ id: "exact" });
    const unrelated = listing({
        id: "accessory",
        title: "GPU support bracket",
        totalCost: { value: 260, currency: "USD" },
        price: { value: 260, currency: "USD" },
    });

    assert.ok(ebayDealScore(exact, "RTX 3080 10GB") < ebayDealScore(unrelated, "RTX 3080 10GB"));
});
