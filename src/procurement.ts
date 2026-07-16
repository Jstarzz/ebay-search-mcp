import { searchBestBuy } from "./bestbuy.js";
import type { NormalizedListing } from "./common.js";
import { searchEbay } from "./ebay.js";

export type ProcurementProvider = "ebay" | "bestbuy";

export type HardwareSearchOptions = {
    query: string;
    providers?: ProcurementProvider[];
    limit?: number;
    minPrice?: number;
    maxPrice?: number;
    shipToCountry?: string;
    shipToPostalCode?: string;
    ebayConditions?: Array<"NEW" | "USED" | "UNSPECIFIED">;
    ebayBuyingOptions?: Array<"FIXED_PRICE" | "AUCTION" | "BEST_OFFER" | "CLASSIFIED_AD">;
    returnsAccepted?: boolean;
};

export type ProviderFailure = {
    provider: ProcurementProvider;
    error: string;
};

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function rankProcurementListings(listings: NormalizedListing[]): NormalizedListing[] {
    return [...listings].sort((left, right) => {
        const leftCurrency = left.totalCost.currency;
        const rightCurrency = right.totalCost.currency;
        const currenciesComparable = leftCurrency !== null && leftCurrency === rightCurrency;

        if (currenciesComparable) {
            const leftValue = left.totalCost.value ?? Number.POSITIVE_INFINITY;
            const rightValue = right.totalCost.value ?? Number.POSITIVE_INFINITY;
            if (leftValue !== rightValue) {
                return leftValue - rightValue;
            }
        }

        const leftKnown = left.totalCost.value !== null ? 0 : 1;
        const rightKnown = right.totalCost.value !== null ? 0 : 1;
        if (leftKnown !== rightKnown) {
            return leftKnown - rightKnown;
        }

        return left.price.value === null
            ? 1
            : right.price.value === null
                ? -1
                : left.price.value - right.price.value;
    });
}

export async function searchHardware(options: HardwareSearchOptions): Promise<{
    query: string;
    destination: {
        country: string | null;
        postalCode: string | null;
    };
    providersRequested: ProcurementProvider[];
    providersSucceeded: ProcurementProvider[];
    providerFailures: ProviderFailure[];
    returned: number;
    warnings: string[];
    listings: NormalizedListing[];
}> {
    const providers: ProcurementProvider[] = options.providers?.length
        ? [...new Set(options.providers)]
        : ["ebay", "bestbuy"];
    const limit = Math.min(Math.max(options.limit ?? 10, 1), 50);
    const perProviderLimit = Math.min(Math.max(limit, 10), 50);

    const jobs = providers.map(async (provider) => {
        if (provider === "ebay") {
            const result = await searchEbay({
                query: options.query,
                limit: perProviderLimit,
                minPrice: options.minPrice,
                maxPrice: options.maxPrice,
                currency: "USD",
                conditions: options.ebayConditions,
                buyingOptions: options.ebayBuyingOptions,
                returnsAccepted: options.returnsAccepted,
                shipToCountry: options.shipToCountry,
                shipToPostalCode: options.shipToPostalCode,
                rankByTotalCost: true,
            });
            return {
                provider,
                listings: result.listings,
                warning: result.shippingWarning,
            };
        }

        const result = await searchBestBuy({
            query: options.query,
            limit: perProviderLimit,
            minPrice: options.minPrice,
            maxPrice: options.maxPrice,
            onlineOnly: true,
            sort: "price_low",
        });
        return {
            provider,
            listings: result.listings,
            warning: result.shippingWarning,
        };
    });

    const settled = await Promise.allSettled(jobs);
    const listings: NormalizedListing[] = [];
    const warnings: string[] = [];
    const providersSucceeded: ProcurementProvider[] = [];
    const providerFailures: ProviderFailure[] = [];

    settled.forEach((result, index) => {
        const provider = providers[index];
        if (result.status === "fulfilled") {
            providersSucceeded.push(provider);
            listings.push(...result.value.listings);
            if (result.value.warning) {
                warnings.push(`${provider}: ${result.value.warning}`);
            }
            return;
        }

        providerFailures.push({
            provider,
            error: errorMessage(result.reason),
        });
    });

    if (!options.shipToCountry || !options.shipToPostalCode) {
        warnings.unshift("Destination is incomplete. Ask for the shipping country and postal code before treating delivered totals as final.");
    }

    const rankedListings = rankProcurementListings(listings).slice(0, limit);
    return {
        query: options.query,
        destination: {
            country: options.shipToCountry ?? null,
            postalCode: options.shipToPostalCode ?? null,
        },
        providersRequested: providers,
        providersSucceeded,
        providerFailures,
        returned: rankedListings.length,
        warnings,
        listings: rankedListings,
    };
}
