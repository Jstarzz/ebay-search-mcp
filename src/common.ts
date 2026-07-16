export type Money = {
    value: number | null;
    currency: string | null;
};

export type ShippingOption = {
    cost: Money;
    serviceName: string | null;
    minEstimatedDeliveryDate: string | null;
    maxEstimatedDeliveryDate: string | null;
};

export type NormalizedListing = {
    provider: "ebay" | "bestbuy";
    id: string;
    title: string;
    url: string;
    imageUrl: string | null;
    price: Money;
    shippingCost: Money;
    totalCost: Money;
    shippingAccuracy: "destination-aware" | "generic" | "unknown";
    shippingOptions: ShippingOption[];
    condition: string | null;
    sellerName: string | null;
    sellerFeedbackPercentage: number | null;
    sellerFeedbackScore: number | null;
    locationCountry: string | null;
    buyingOptions: string[];
    returnsAccepted: boolean | null;
    availability: string | null;
    metadata: Record<string, unknown>;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

export function toNumberOrNull(value: unknown): number | null {
    if (value === undefined || value === null || value === "") {
        return null;
    }

    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

export function textOrNull(value: unknown): string | null {
    return typeof value === "string" && value.length > 0 ? value : null;
}

export function money(value: unknown, currency: unknown): Money {
    return {
        value: toNumberOrNull(value),
        currency: textOrNull(currency),
    };
}

export function addMoney(price: Money, shipping: Money): Money {
    if (price.value === null || shipping.value === null) {
        return { value: null, currency: price.currency ?? shipping.currency };
    }

    if (price.currency && shipping.currency && price.currency !== shipping.currency) {
        return { value: null, currency: price.currency };
    }

    return {
        value: price.value + shipping.value,
        currency: price.currency ?? shipping.currency,
    };
}

export async function readErrorBody(response: Response): Promise<unknown> {
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
        return response.json();
    }

    const text = await response.text();
    return text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
}

export class HTTPError extends Error {
    readonly status: number;
    readonly data: unknown;

    constructor(status: number, data: unknown) {
        super(`HTTP request failed with status ${status}`);
        this.name = "HTTPError";
        this.status = status;
        this.data = data;
    }
}
