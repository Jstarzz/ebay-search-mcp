import { isRecord, type Money, type NormalizedListing } from "./common.js";

function compactText(value: string, maximum = 500): string {
    return value.replace(/\s+/g, " ").trim().slice(0, maximum);
}

function textField(record: Record<string, unknown> | null, key: string): string | null {
    if (!record) {
        return null;
    }
    const value = record[key];
    return typeof value === "string" && value.length > 0 ? value : null;
}

function numberField(record: Record<string, unknown> | null, key: string): number | null {
    if (!record) {
        return null;
    }
    const value = record[key];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanField(record: Record<string, unknown> | null, key: string): boolean | null {
    if (!record) {
        return null;
    }
    const value = record[key];
    return typeof value === "boolean" ? value : null;
}

function normalizedListing(value: unknown): NormalizedListing | null {
    if (!isRecord(value)) {
        return null;
    }
    if ((value.provider !== "ebay" && value.provider !== "bestbuy")
        || typeof value.id !== "string"
        || typeof value.title !== "string"
        || typeof value.url !== "string") {
        return null;
    }
    return value as unknown as NormalizedListing;
}

function formatMoney(value: Money): string {
    if (value.value === null) {
        return "unavailable";
    }
    return `${value.currency ?? ""} ${value.value.toFixed(2)}`.trim();
}

function formatListingLines(listing: NormalizedListing): string[] {
    const lines = [
        `Title: ${compactText(listing.title, 300)}`,
        `Item price: ${formatMoney(listing.price)}`,
        `Shipping: ${formatMoney(listing.shippingCost)} (${listing.shippingAccuracy})`,
        `Estimated total: ${formatMoney(listing.totalCost)}`,
        `Condition: ${listing.condition ?? "unavailable"}`,
    ];

    if (listing.sellerName) {
        const feedback = listing.sellerFeedbackPercentage === null
            ? "feedback unavailable"
            : `${listing.sellerFeedbackPercentage.toFixed(1)}% feedback`;
        const score = listing.sellerFeedbackScore === null
            ? ""
            : `, score ${listing.sellerFeedbackScore}`;
        lines.push(`Seller: ${listing.sellerName} (${feedback}${score})`);
    }

    if (listing.locationCountry) {
        lines.push(`Item location: ${listing.locationCountry}`);
    }
    if (listing.buyingOptions.length > 0) {
        lines.push(`Buying options: ${listing.buyingOptions.join(", ")}`);
    }
    if (listing.availability) {
        lines.push(`Availability: ${listing.availability}`);
    }
    lines.push(`Link: ${listing.url}`);
    return lines;
}

export function formatEbayItemResult(value: unknown): string {
    if (!isRecord(value)) {
        return "eBay returned an item response, but it was not in the expected format.";
    }

    const listing = normalizedListing(value.listing);
    if (!listing) {
        return "eBay returned item data, but the normalized listing details were unavailable.";
    }

    const lines = formatListingLines(listing);
    const destination = isRecord(value.destination) ? value.destination : null;
    const country = textField(destination, "country");
    const postalCode = textField(destination, "postalCode");
    if (country || postalCode) {
        lines.push(`Shipping destination: ${[country, postalCode].filter(Boolean).join(" ")}`);
    }

    const returns = isRecord(value.returns) ? value.returns : null;
    const returnsAccepted = booleanField(returns, "accepted");
    const returnPeriodValue = numberField(returns, "periodValue");
    const returnPeriodUnit = textField(returns, "periodUnit");
    if (returnsAccepted !== null) {
        const period = returnPeriodValue !== null && returnPeriodUnit
            ? ` for ${returnPeriodValue} ${returnPeriodUnit}`
            : "";
        lines.push(`Returns: ${returnsAccepted ? `accepted${period}` : "not accepted"}`);
    }

    const description = textField(value, "shortDescription") ?? textField(value, "description");
    if (description) {
        lines.push(`Description: ${compactText(description)}`);
    }

    if (Array.isArray(value.aspects)) {
        const aspects = value.aspects
            .filter(isRecord)
            .map((aspect) => {
                const name = textField(aspect, "name");
                const aspectValue = textField(aspect, "value");
                return name && aspectValue ? `${name}: ${aspectValue}` : null;
            })
            .filter((aspect): aspect is string => aspect !== null)
            .slice(0, 15);
        if (aspects.length > 0) {
            lines.push(`Item specifics: ${aspects.join("; ")}`);
        }
    }

    return lines.join("\n");
}

export function formatBestBuyProductResult(value: unknown): string {
    if (!isRecord(value)) {
        return "Best Buy returned a product response, but it was not in the expected format.";
    }

    const listing = normalizedListing(value.listing);
    if (!listing) {
        return "Best Buy returned product data, but the normalized product details were unavailable.";
    }

    const lines = formatListingLines(listing);
    const metadata = listing.metadata;
    const manufacturer = textField(metadata, "manufacturer");
    const modelNumber = textField(metadata, "modelNumber");
    const reviewAverage = numberField(metadata, "customerReviewAverage");
    const reviewCount = numberField(metadata, "customerReviewCount");
    const shippingWeight = numberField(metadata, "shippingWeightLb");

    if (manufacturer) {
        lines.push(`Manufacturer: ${manufacturer}`);
    }
    if (modelNumber) {
        lines.push(`Model: ${modelNumber}`);
    }
    if (reviewAverage !== null) {
        lines.push(`Customer rating: ${reviewAverage.toFixed(1)}${reviewCount === null ? "" : ` from ${reviewCount} reviews`}`);
    }
    if (shippingWeight !== null) {
        lines.push(`Shipping weight: ${shippingWeight} lb`);
    }

    return lines.join("\n");
}

export function formatBestBuyOpenBoxResult(value: unknown): string {
    let serialized: string;
    try {
        serialized = JSON.stringify(value, null, 2);
    } catch {
        return "Best Buy returned open-box data, but it could not be serialized for display.";
    }

    if (!serialized || serialized === "{}" || serialized === "[]") {
        return "No Best Buy open-box offers were returned for this SKU.";
    }

    const maximum = 12000;
    const suffix = serialized.length > maximum ? "\nResponse truncated; structured content contains the full result." : "";
    return `Best Buy open-box offers:\n${serialized.slice(0, maximum)}${suffix}`;
}
