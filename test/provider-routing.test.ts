import assert from "node:assert/strict";
import test from "node:test";
import {
    getConfiguredRoute,
    providerDefinitions,
    storeRoutes,
    type ProviderEnvironment,
} from "../src/provider-routing.js";

test("store routes match the intended free-provider priority", () => {
    assert.deepEqual(storeRoutes.ebay, ["ebay-official", "ebay-selfhosted"]);
    assert.deepEqual(storeRoutes.amazon, [
        "bright-data", "scrapingdog", "hasdata", "apify", "serpapi",
        "oxylabs", "scrapingbee", "scraperapi", "crawlbase", "zyte", "decodo", "amazon-selfhosted",
    ]);
    assert.deepEqual(storeRoutes.aliexpress, [
        "aliexpress-official", "apify", "aliexpress-selfhosted", "bright-data", "hasdata",
        "oxylabs", "scrapingbee", "scraperapi", "crawlbase", "zyte", "decodo",
    ]);
});

test("shared anti-bot providers are marked to preserve capacity for Amazon", () => {
    assert.equal(providerDefinitions["bright-data"].preserveForAmazon, true);
    assert.equal(providerDefinitions.hasdata.preserveForAmazon, true);
    assert.equal(providerDefinitions.apify.preserveForAmazon, false);
});

test("configured route removes unavailable providers without changing priority", () => {
    const env: ProviderEnvironment = {
        BRIGHT_DATA_API_KEY: "bright",
        SCRAPINGDOG_API_KEY: "dog",
        APIFY_TOKEN: "apify",
        APIFY_AMAZON_ACTOR_ID: "actor",
        AMAZON_SELFHOSTED_URL: "http://127.0.0.1:3001",
    };

    assert.deepEqual(getConfiguredRoute("amazon", env), [
        "bright-data", "scrapingdog", "apify", "amazon-selfhosted",
    ]);
});

test("Apify requires a store-specific actor ID", () => {
    assert.deepEqual(getConfiguredRoute("amazon", { APIFY_TOKEN: "token" }), []);
    assert.deepEqual(getConfiguredRoute("amazon", {
        APIFY_TOKEN: "token",
        APIFY_AMAZON_ACTOR_ID: "amazon-actor",
    }), ["apify"]);
    assert.deepEqual(getConfiguredRoute("aliexpress", {
        APIFY_TOKEN: "token",
        APIFY_ALIEXPRESS_ACTOR_ID: "ali-actor",
    }), ["apify"]);
});

test("official providers require their complete credential pair", () => {
    assert.deepEqual(getConfiguredRoute("ebay", { EBAY_CLIENT_ID: "id" }), []);
    assert.deepEqual(getConfiguredRoute("ebay", {
        EBAY_CLIENT_ID: "id",
        EBAY_CLIENT_SECRET: "secret",
    }), ["ebay-official"]);

    assert.deepEqual(getConfiguredRoute("aliexpress", {
        ALIEXPRESS_APP_KEY: "key",
        ALIEXPRESS_APP_SECRET: "secret",
    }), ["aliexpress-official"]);
});
