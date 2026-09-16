import type { NormalizedListing } from "./common.js";

const MAX_TITLE_CODEPOINTS = 120;
const MAX_WARNING_CODEPOINTS = 140;
const MAX_WARNINGS = 2;

const trackingParams = new Set([
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id",
    "ref", "tag", "linkcode", "creative", "creativeasin", "camp", "ascsubtag",
    "mkcid", "mkevt", "mkrid", "ssspo", "sssrc", "ssuid", "widget_ver",
]);

function truncate(value: string, maximum: number): string {
    const points = Array.from(value.replace(/\s+/g, " ").trim());
    if (points.length <= maximum) return points.join("");
    return `${points.slice(0, Math.max(0, maximum - 3)).join("")}...`;
}

export function compactProductURL(value: string): string {
    try {
        const url = new URL(value);
        url.hash = "";
        for (const key of [...url.searchParams.keys()]) {
            if (trackingParams.has(key.toLowerCase()) || key.toLowerCase().startsWith("utm_")) {
                url.searchParams.delete(key);
            }
        }
        return url.toString();
    } catch {
        return value;
    }
}

function money(value: number | null, currency: string | null): string | undefined {
    if (value === null) return undefined;
    return `${currency ?? ""} ${value.toFixed(2)}`.trim();
}

function metadataNumber(listing: NormalizedListing, key: string): number | undefined {
    const value = listing.metadata[key];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export type CompactListing = {
    id: string;
    title: string;
    url: string;
    total?: string;
    price?: string;
    ship?: string;
    condition?: string;
    seller?: string;
    rating?: number;
    reviews?: number;
    availability?: string;
};

export function compactListing(listing: NormalizedListing): CompactListing {
    const total = money(listing.totalCost.value, listing.totalCost.currency);
    const price = money(listing.price.value, listing.price.currency);
    const ship = money(listing.shippingCost.value, listing.shippingCost.currency);
    const rating = metadataNumber(listing, "rating");
    const reviews = metadataNumber(listing, "reviewCount");

    return {
        id: listing.id,
        title: truncate(listing.title, MAX_TITLE_CODEPOINTS),
        url: compactProductURL(listing.url),
        ...(total ? { total } : {}),
        ...(!total && price ? { price } : {}),
        ...(ship ? { ship } : {}),
        ...(listing.condition ? { condition: truncate(listing.condition, 48) } : {}),
        ...(listing.sellerName ? { seller: truncate(listing.sellerName, 64) } : {}),
        ...(rating !== undefined ? { rating } : {}),
        ...(reviews !== undefined ? { reviews } : {}),
        ...(listing.availability ? { availability: truncate(listing.availability, 32) } : {}),
    };
}

function compactWarnings(warnings: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const warning of warnings) {
        const compact = truncate(warning, MAX_WARNING_CODEPOINTS);
        if (!compact || seen.has(compact)) continue;
        seen.add(compact);
        result.push(compact);
        if (result.length >= MAX_WARNINGS) break;
    }
    return result;
}

export function compactSearchPayload(options: {
    query: string;
    listings: NormalizedListing[];
    source?: string | null;
    cacheHit?: boolean;
    warnings?: string[];
}): Record<string, unknown> {
    const warnings = compactWarnings(options.warnings ?? []);
    return {
        query: options.query,
        count: options.listings.length,
        ...(options.source ? { source: options.source } : {}),
        ...(options.cacheHit ? { cache: true } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
        results: options.listings.map(compactListing),
    };
}

export function searchSummary(options: {
    label: string;
    count: number;
    source?: string | null;
    cacheHit?: boolean;
    failed?: boolean;
}): string {
    if (options.failed) return `${options.label} search failed.`;
    const source = options.source ? ` via ${options.source}` : "";
    const cache = options.cacheHit ? " (cache)" : "";
    return `${options.count} ${options.label} result${options.count === 1 ? "" : "s"}${source}${cache}.`;
}

export function compactSearchText(options: {
    label: string;
    listings: NormalizedListing[];
    source?: string | null;
    cacheHit?: boolean;
    failed?: boolean;
}): string {
    const summary = searchSummary({
        label: options.label,
        count: options.listings.length,
        source: options.source,
        cacheHit: options.cacheHit,
        failed: options.failed,
    });

    if (options.failed || options.listings.length === 0) return summary;

    const rows = options.listings.map((listing, index) => {
        const compact = compactListing(listing);
        const details: string[] = [];

        if (compact.total) {
            details.push(`${compact.total} total`);
        } else if (compact.price) {
            details.push(compact.ship ? `${compact.price} + ${compact.ship} ship` : compact.price);
        }
        if (compact.rating !== undefined) details.push(`${compact.rating}★`);
        if (compact.condition) details.push(compact.condition);

        const detailText = details.length > 0 ? ` — ${details.join(" — ")}` : "";
        return `${index + 1}. ${compact.title}${detailText} — ${compact.url}`;
    });

    return `${summary}\n${rows.join("\n")}`;
}
