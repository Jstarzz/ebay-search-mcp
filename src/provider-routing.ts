export type Store = "ebay" | "amazon" | "aliexpress";

export type ProviderId =
    | "ebay-official"
    | "ebay-selfhosted"
    | "bright-data"
    | "scrapingdog"
    | "hasdata"
    | "apify"
    | "serpapi"
    | "amazon-selfhosted"
    | "aliexpress-official"
    | "aliexpress-selfhosted"
    | "oxylabs"
    | "scrapingbee"
    | "scraperapi"
    | "crawlbase"
    | "zyte"
    | "decodo";

export type ProviderClass = "official" | "recurring-free" | "self-hosted" | "trial-reserve";

export type ProviderDefinition = {
    id: ProviderId;
    providerClass: ProviderClass;
    recurringMonthlyAllowance: number | null;
    sharedAllowanceGroup: "bright-data" | "hasdata" | "apify" | null;
    preserveForAmazon: boolean;
    envKeys: string[];
    notes: string;
};

export const providerDefinitions: Record<ProviderId, ProviderDefinition> = {
    "ebay-official": {
        id: "ebay-official", providerClass: "official", recurringMonthlyAllowance: null,
        sharedAllowanceGroup: null, preserveForAmazon: false,
        envKeys: ["EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET"], notes: "Primary eBay Browse API path.",
    },
    "ebay-selfhosted": {
        id: "ebay-selfhosted", providerClass: "self-hosted", recurringMonthlyAllowance: null,
        sharedAllowanceGroup: null, preserveForAmazon: false,
        envKeys: ["EBAY_SELFHOSTED_URL"], notes: "Overflow/fallback eBay scraper endpoint.",
    },
    "bright-data": {
        id: "bright-data", providerClass: "recurring-free", recurringMonthlyAllowance: 5000,
        sharedAllowanceGroup: "bright-data", preserveForAmazon: true,
        envKeys: ["BRIGHT_DATA_API_KEY"], notes: "Shared pool; preserve capacity for Amazon unless cheaper AliExpress paths fail.",
    },
    scrapingdog: {
        id: "scrapingdog", providerClass: "recurring-free", recurringMonthlyAllowance: 200,
        sharedAllowanceGroup: null, preserveForAmazon: false,
        envKeys: ["SCRAPINGDOG_API_KEY"], notes: "Dedicated Amazon search/product API.",
    },
    hasdata: {
        id: "hasdata", providerClass: "recurring-free", recurringMonthlyAllowance: 1000,
        sharedAllowanceGroup: "hasdata", preserveForAmazon: true,
        envKeys: ["HASDATA_API_KEY"], notes: "Shared pool; preserve capacity for Amazon when possible.",
    },
    apify: {
        id: "apify", providerClass: "recurring-free", recurringMonthlyAllowance: null,
        sharedAllowanceGroup: "apify", preserveForAmazon: false,
        envKeys: ["APIFY_TOKEN"], notes: "$5 monthly platform-credit path; store-specific actor ID is also required.",
    },
    serpapi: {
        id: "serpapi", providerClass: "recurring-free", recurringMonthlyAllowance: 250,
        sharedAllowanceGroup: null, preserveForAmazon: false,
        envKeys: ["SERPAPI_API_KEY"], notes: "Amazon discovery/search fallback rather than a full product-detail source.",
    },
    "amazon-selfhosted": {
        id: "amazon-selfhosted", providerClass: "self-hosted", recurringMonthlyAllowance: null,
        sharedAllowanceGroup: null, preserveForAmazon: false,
        envKeys: ["AMAZON_SELFHOSTED_URL"], notes: "Overflow/fallback Amazon scraper endpoint.",
    },
    "aliexpress-official": {
        id: "aliexpress-official", providerClass: "official", recurringMonthlyAllowance: null,
        sharedAllowanceGroup: null, preserveForAmazon: false,
        envKeys: ["ALIEXPRESS_APP_KEY", "ALIEXPRESS_APP_SECRET"], notes: "AliExpress Affiliate API when approved.",
    },
    "aliexpress-selfhosted": {
        id: "aliexpress-selfhosted", providerClass: "self-hosted", recurringMonthlyAllowance: null,
        sharedAllowanceGroup: null, preserveForAmazon: false,
        envKeys: ["ALIEXPRESS_SELFHOSTED_URL"], notes: "Cheap local fallback before consuming shared anti-bot capacity.",
    },
    oxylabs: trialProvider("oxylabs", "OXYLABS_API_KEY"),
    scrapingbee: trialProvider("scrapingbee", "SCRAPINGBEE_API_KEY"),
    scraperapi: trialProvider("scraperapi", "SCRAPERAPI_API_KEY"),
    crawlbase: trialProvider("crawlbase", "CRAWLBASE_API_KEY"),
    zyte: trialProvider("zyte", "ZYTE_API_KEY"),
    decodo: trialProvider("decodo", "DECODO_API_KEY"),
};

function trialProvider(id: Extract<ProviderId, "oxylabs" | "scrapingbee" | "scraperapi" | "crawlbase" | "zyte" | "decodo">, envKey: string): ProviderDefinition {
    return {
        id, providerClass: "trial-reserve", recurringMonthlyAllowance: null,
        sharedAllowanceGroup: null, preserveForAmazon: false, envKeys: [envKey],
        notes: "Trial/reserve capacity only; routing must not depend on this provider recurring forever.",
    };
}

const trialPool: ProviderId[] = ["oxylabs", "scrapingbee", "scraperapi", "crawlbase", "zyte", "decodo"];

export const storeRoutes: Record<Store, ProviderId[]> = {
    ebay: ["ebay-official", "ebay-selfhosted"],
    amazon: ["bright-data", "scrapingdog", "hasdata", "apify", "serpapi", ...trialPool, "amazon-selfhosted"],
    aliexpress: ["aliexpress-official", "apify", "aliexpress-selfhosted", "bright-data", "hasdata", ...trialPool],
};

export type ProviderEnvironment = Readonly<Record<string, string | undefined>>;

function hasEnv(env: ProviderEnvironment, key: string): boolean {
    return Boolean(env[key]?.trim());
}

export function isProviderConfigured(provider: ProviderId, env: ProviderEnvironment = process.env, store?: Store): boolean {
    const baseConfigured = providerDefinitions[provider].envKeys.every((key) => hasEnv(env, key));
    if (!baseConfigured) return false;

    if (provider === "apify" && store === "amazon") return hasEnv(env, "APIFY_AMAZON_ACTOR_ID");
    if (provider === "apify" && store === "aliexpress") return hasEnv(env, "APIFY_ALIEXPRESS_ACTOR_ID");
    return true;
}

export function getConfiguredRoute(store: Store, env: ProviderEnvironment = process.env): ProviderId[] {
    return storeRoutes[store].filter((provider) => isProviderConfigured(provider, env, store));
}

export function getRoutingStatus(env: ProviderEnvironment = process.env): Record<Store, {
    configuredRoute: ProviderId[];
    fullRoute: ProviderId[];
}> {
    return {
        ebay: { configuredRoute: getConfiguredRoute("ebay", env), fullRoute: [...storeRoutes.ebay] },
        amazon: { configuredRoute: getConfiguredRoute("amazon", env), fullRoute: [...storeRoutes.amazon] },
        aliexpress: { configuredRoute: getConfiguredRoute("aliexpress", env), fullRoute: [...storeRoutes.aliexpress] },
    };
}
