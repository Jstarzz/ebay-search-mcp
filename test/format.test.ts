import assert from "node:assert/strict";
import test from "node:test";
import {
    formatBestBuyOpenBoxResult,
    formatBestBuyProductResult,
    formatEbayItemResult,
} from "../src/format.js";

const baseListing = {
    id: "123",
    title: "Test GPU",
    url: "https://example.com/item",
    imageUrl: null,
    price: { value: 200, currency: "USD" },
    shippingCost: { value: 15, currency: "USD" },
    totalCost: { value: 215, currency: "USD" },
    shippingAccuracy: "destination-aware" as const,
    shippingOptions: [],
    condition: "Used",
    sellerName: "seller-name",
    sellerFeedbackPercentage: 99.8,
    sellerFeedbackScore: 1234,
    locationCountry: "US",
    buyingOptions: ["FIXED_PRICE"],
    returnsAccepted: true,
    availability: "AVAILABLE",
    metadata: {},
};

test("formatEbayItemResult exposes useful item details and direct link", () => {
    const text = formatEbayItemResult({
        listing: { ...baseListing, provider: "ebay" },
        destination: { country: "US", postalCode: "33166" },
        shortDescription: "A tested graphics card.",
        aspects: [{ name: "Memory Size", value: "10 GB" }],
        returns: { accepted: true, periodValue: 30, periodUnit: "DAY" },
    });

    assert.match(text, /Title: Test GPU/);
    assert.match(text, /Estimated total: USD 215\.00/);
    assert.match(text, /Seller: seller-name/);
    assert.match(text, /Shipping destination: US 33166/);
    assert.match(text, /Memory Size: 10 GB/);
    assert.match(text, /Link: https:\/\/example\.com\/item/);
});

test("formatBestBuyProductResult exposes model and rating fields", () => {
    const text = formatBestBuyProductResult({
        listing: {
            ...baseListing,
            provider: "bestbuy",
            sellerName: "Best Buy",
            metadata: {
                manufacturer: "Example Corp",
                modelNumber: "GPU-1",
                customerReviewAverage: 4.7,
                customerReviewCount: 88,
                shippingWeightLb: 3.2,
            },
        },
    });

    assert.match(text, /Manufacturer: Example Corp/);
    assert.match(text, /Model: GPU-1/);
    assert.match(text, /Customer rating: 4\.7 from 88 reviews/);
    assert.match(text, /Shipping weight: 3\.2 lb/);
});

test("formatBestBuyOpenBoxResult surfaces returned offer data", () => {
    const text = formatBestBuyOpenBoxResult({
        results: [{ condition: "Excellent", price: 180, url: "https://example.com/open-box" }],
    });

    assert.match(text, /Best Buy open-box offers:/);
    assert.match(text, /Excellent/);
    assert.match(text, /https:\/\/example\.com\/open-box/);
});
