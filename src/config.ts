import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getRoutingStatus } from "./provider-routing.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// MCP stdio reserves stdout for JSON-RPC. dotenv 17 logs a startup banner
// unless quiet mode is enabled, so environment loading must stay silent.
loadEnv({
    path: resolve(projectRoot, ".env"),
    quiet: true,
});

function optionalEnv(name: string): string | undefined {
    const value = process.env[name]?.trim();
    return value ? value : undefined;
}

export type ProcurementProvider = "ebay" | "bestbuy";

export const runtimeConfig = Object.freeze({
    ebayClientId: optionalEnv("EBAY_CLIENT_ID"),
    ebayClientSecret: optionalEnv("EBAY_CLIENT_SECRET"),
    ebayMarketplaceId: optionalEnv("EBAY_MARKETPLACE_ID") ?? "EBAY_US",
    bestBuyApiKey: optionalEnv("BESTBUY_API_KEY"),
    defaultShipToCountry: optionalEnv("DEFAULT_SHIP_TO_COUNTRY"),
    defaultShipToPostalCode: optionalEnv("DEFAULT_SHIP_TO_POSTAL_CODE"),
});

export function getConfiguredProviders(): ProcurementProvider[] {
    const providers: ProcurementProvider[] = [];

    if (runtimeConfig.ebayClientId && runtimeConfig.ebayClientSecret) {
        providers.push("ebay");
    }
    if (runtimeConfig.bestBuyApiKey) {
        providers.push("bestbuy");
    }

    return providers;
}

export function getConfigurationStatus(): {
    providers: Record<ProcurementProvider, { configured: boolean }>;
    routing: ReturnType<typeof getRoutingStatus>;
    ebayMarketplaceId: string;
    defaultDestination: {
        country: string | null;
        postalCode: string | null;
    };
    nodeVersion: string;
} {
    return {
        providers: {
            ebay: {
                configured: Boolean(runtimeConfig.ebayClientId && runtimeConfig.ebayClientSecret),
            },
            bestbuy: {
                configured: Boolean(runtimeConfig.bestBuyApiKey),
            },
        },
        routing: getRoutingStatus(),
        ebayMarketplaceId: runtimeConfig.ebayMarketplaceId,
        defaultDestination: {
            country: runtimeConfig.defaultShipToCountry ?? null,
            postalCode: runtimeConfig.defaultShipToPostalCode ?? null,
        },
        nodeVersion: process.version,
    };
}
