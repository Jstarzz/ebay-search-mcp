import { addMoney, isRecord, type ListingStore, type NormalizedListing, textOrNull } from "./common.js";

export const SEARCH_POLICY_VERSION = "search-v1";

const TOTAL_TIMEOUT_MS = 24_000;
const POLL_INTERVAL_MS = 1_000;

type ScraperMarketplace = Extract<ListingStore, "amazon" | "aliexpress" | "ebay">;

type ScraperConfig = {
    endpoint: URL;
    apiKey: string;
};

type ScraperJob = {
    id: string;
    marketplace: string;
    query: string;
    status: string;
    error?: string;
    result?: unknown[];
};

export type SelfHostedSearchOptions = {
    marketplace: ScraperMarketplace;
    query: string;
    limit: number;
};

function env(name: string): string | undefined {
    const value = process.env[name]?.trim();
    return value ? value : undefined;
}

function marketplacePrefix(marketplace: ScraperMarketplace): string {
    return marketplace.toUpperCase();
}

export function getSelfHostedScraperConfig(marketplace: ScraperMarketplace): ScraperConfig | null {
    const prefix = marketplacePrefix(marketplace);
    const rawEndpoint = env("SELFHOSTED_SCRAPER_URL") ?? env(`${prefix}_SELFHOSTED_URL`);
    if (!rawEndpoint) return null;

    const apiKey = env("SELFHOSTED_SCRAPER_API_KEY") ?? env(`${prefix}_SELFHOSTED_API_KEY`);
    if (!apiKey) return null;

    const endpoint = new URL(rawEndpoint);
    const trimmedPath = endpoint.pathname.replace(/\/+$/, "");
    if (!trimmedPath.endsWith("/v1/search")) {
        endpoint.pathname = `${trimmedPath}/v1/search`.replace(/^\/\//, "/");
    }
    return { endpoint, apiKey };
}

export function isSelfHostedScraperConfigured(marketplace: ScraperMarketplace): boolean {
    try {
        return getSelfHostedScraperConfig(marketplace) !== null;
    } catch {
        return false;
    }
}

function jobURL(searchEndpoint: URL, jobID: string): URL {
    const url = new URL(searchEndpoint);
    const marker = "/v1/search";
    const markerIndex = url.pathname.lastIndexOf(marker);
    const basePath = markerIndex >= 0 ? url.pathname.slice(0, markerIndex) : url.pathname.replace(/\/+$/, "");
    url.pathname = `${basePath}/v1/jobs/${encodeURIComponent(jobID)}`.replace(/^\/\//, "/");
    url.search = "";
    url.hash = "";
    return url;
}

function headers(apiKey: string, includeJSON = false): Record<string, string> {
    return {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
        "X-Search-Policy-Version": SEARCH_POLICY_VERSION,
        ...(includeJSON ? { "Content-Type": "application/json" } : {}),
    };
}

async function decodeJSON(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text) return null;
    try {
        return JSON.parse(text) as unknown;
    } catch {
        throw new Error(`self-hosted scraper returned invalid JSON (HTTP ${response.status})`);
    }
}

function errorMessage(payload: unknown, fallback: string): string {
    if (!isRecord(payload)) return fallback;
    for (const key of ["message", "error", "detail"]) {
        const value = payload[key];
        if (typeof value === "string" && value.trim()) return value.trim().slice(0, 240);
    }
    return fallback;
}

function parseJob(payload: unknown): ScraperJob {
    if (!isRecord(payload)) {
        throw new Error("self-hosted scraper returned a non-object job response");
    }
    const id = textOrNull(payload.id);
    const marketplace = textOrNull(payload.marketplace);
    const query = textOrNull(payload.query);
    const status = textOrNull(payload.status);
    if (!id || !marketplace || !query || !status) {
        throw new Error("self-hosted scraper job response is missing id, marketplace, query, or status");
    }
    return {
        id,
        marketplace,
        query,
        status,
        error: textOrNull(payload.error) ?? undefined,
        result: Array.isArray(payload.result) ? payload.result : undefined,
    };
}

function remainingTimeout(deadline: number): number {
    return Math.max(1, deadline - Date.now());
}

async function requestJob(config: ScraperConfig, options: SelfHostedSearchOptions, deadline: number): Promise<ScraperJob> {
    const response = await fetch(config.endpoint, {
        method: "POST",
        headers: headers(config.apiKey, true),
        body: JSON.stringify({
            marketplace: options.marketplace,
            query: options.query,
            limit: Math.min(Math.max(options.limit, 1), 100),
            wait_ms: 0,
        }),
        signal: AbortSignal.timeout(remainingTimeout(deadline)),
    });
    const payload = await decodeJSON(response);
    if (!response.ok && response.status !== 502) {
        throw new Error(errorMessage(payload, `self-hosted scraper search failed with HTTP ${response.status}`));
    }
    const job = parseJob(payload);
    if (job.status === "failed" || response.status === 502) {
        throw new Error(job.error || errorMessage(payload, "self-hosted scraper job failed"));
    }
    return job;
}

async function pollJob(config: ScraperConfig, job: ScraperJob, deadline: number): Promise<ScraperJob> {
    let current = job;
    while (current.status !== "complete") {
        if (current.status === "failed") {
            throw new Error(current.error || "self-hosted scraper job failed");
        }
        if (Date.now() >= deadline) {
            throw new Error(`self-hosted scraper job ${current.id} did not complete within ${TOTAL_TIMEOUT_MS} ms`);
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_INTERVAL_MS, remainingTimeout(deadline))));
        const response = await fetch(jobURL(config.endpoint, current.id), {
            method: "GET",
            headers: headers(config.apiKey),
            signal: AbortSignal.timeout(remainingTimeout(deadline)),
        });
        const payload = await decodeJSON(response);
        if (!response.ok) {
            throw new Error(errorMessage(payload, `self-hosted scraper job poll failed with HTTP ${response.status}`));
        }
        current = parseJob(payload);
    }
    return current;
}

function minorAmount(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value / 100 : null;
}

function numberOrNull(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeScraperListing(
    marketplace: ScraperMarketplace,
    row: unknown,
): NormalizedListing | null {
    if (!isRecord(row)) return null;

    const title = textOrNull(row.title);
    const url = textOrNull(row.url);
    const externalID = textOrNull(row.external_id);
    if (!title || !url || !externalID) return null;

    const currency = textOrNull(row.currency)?.toUpperCase() ?? null;
    const price = { value: minorAmount(row.price_minor), currency };
    const shippingCost = { value: minorAmount(row.shipping_minor), currency };
    const totalCost = shippingCost.value === null
        ? { ...price }
        : addMoney(price, shippingCost);
    const available = typeof row.available === "boolean" ? row.available : null;
    const rating = numberOrNull(row.rating);
    const reviewCount = numberOrNull(row.review_count);
    const soldCount = numberOrNull(row.sold_count);
    const sponsored = typeof row.sponsored === "boolean" ? row.sponsored : null;

    return {
        provider: marketplace,
        id: externalID,
        title,
        url,
        imageUrl: textOrNull(row.image_url),
        price,
        shippingCost,
        totalCost,
        shippingAccuracy: shippingCost.value === null ? "unknown" : "generic",
        shippingOptions: [],
        condition: null,
        sellerName: textOrNull(row.seller),
        sellerFeedbackPercentage: null,
        sellerFeedbackScore: null,
        locationCountry: null,
        buyingOptions: [],
        returnsAccepted: null,
        availability: available === null ? null : available ? "AVAILABLE" : "UNAVAILABLE",
        metadata: {
            sourceProvider: `${marketplace}-selfhosted`,
            ...(rating !== null ? { rating } : {}),
            ...(reviewCount !== null ? { reviewCount } : {}),
            ...(soldCount !== null ? { soldCount } : {}),
            ...(sponsored !== null ? { sponsored } : {}),
        },
    };
}

export async function searchSelfHostedScraper(options: SelfHostedSearchOptions): Promise<NormalizedListing[]> {
    const config = getSelfHostedScraperConfig(options.marketplace);
    if (!config) {
        throw new Error(`self-hosted scraper is not fully configured for ${options.marketplace}; URL and API key are required`);
    }

    const deadline = Date.now() + TOTAL_TIMEOUT_MS;
    const initial = await requestJob(config, options, deadline);
    const completed = initial.status === "complete" ? initial : await pollJob(config, initial, deadline);
    if (completed.marketplace !== options.marketplace) {
        throw new Error(`self-hosted scraper returned marketplace ${completed.marketplace} for ${options.marketplace} request`);
    }

    return (completed.result ?? [])
        .map((row) => normalizeScraperListing(options.marketplace, row))
        .filter((listing): listing is NormalizedListing => listing !== null);
}
