import { config as loadEnv } from "dotenv"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

loadEnv({
    path: resolve(dirname(fileURLToPath(import.meta.url)), "..", ".env"),
})

const client_id = process.env.EBAY_CLIENT_ID
const client_secret = process.env.EBAY_CLIENT_SECRET
const ebay_id = process.env.EBAY_MARKETPLACE_ID

type TokenCache = {
    token: string;
    expiresAt: number;
}

let tokenCache: TokenCache | null = null

class APIError extends Error {
    status: number;
    data: unknown;

    constructor(status: number, data: unknown) {
        super(`HTTP Request failed with status ${status}`);
        this.status = status;
        this.data = data;
    }
}

class HTMLError extends Error {
    status: number;
    raw_html: string;

    constructor(status: number, html_text: string) {
        const clean = html_text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        const snippet = clean.length > 100 ? `${clean.slice(0, 100)}...` : clean;

        super(`HTTP ${status}: ${snippet || 'HTML Error'}`);
        this.name = 'HTMLError';
        this.status = status;
        this.raw_html = html_text;
        Object.setPrototypeOf(this, HTMLError.prototype);
    }
}

interface EbayTokenData {
    access_token: string;
    expires_in: number;
    token_type: string;
}

export interface EbayListing {
    itemId: string;
    title: string;
    price: number | null;
    currency: string | null;
    condition: string | null;
    url: string;
    seller: {
        username: string | null;
        feedbackPercentage: number | null;
        feedbackScore: number | null;
    };
    shippingCost: number | null;
    shippingCurrency: string | null;
    locationCountry: string | null;
    buyingOptions: string[];
}

interface EbayRawSeller {
    username?: string;
    feedbackPercentage?: string | number;
    feedbackScore?: string | number;
}

interface EbayRawPrice {
    value?: string | number;
    currency?: string;
}

interface EbayRawShippingCost {
    value?: string | number;
    currency?: string;
}

interface EbayRawShippingOption {
    shippingCost?: EbayRawShippingCost;
}

interface EbayRawItem {
    itemId?: string;
    title?: string;
    price?: EbayRawPrice;
    condition?: string;
    itemWebUrl?: string;
    seller?: EbayRawSeller;
    shippingOptions?: EbayRawShippingOption[];
    itemLocation?: {
        country?: string;
    };
    buyingOptions?: string[];
}

interface EbaySearchResponse {
    total?: number;
    limit?: number;
    offset?: number;
    itemSummaries?: EbayRawItem[];
}

type SearchResult = {
    query: string;
    limit: number;
    total: number | null;
    returned: number;
    discarded: number;
    listings: EbayListing[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
}

function toNumberOrNull(value: unknown): number | null {
    if (value === undefined || value === null || value === '') {
        return null
    }

    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
}

async function get_access_token() {
    if (!client_id || !client_secret) {
        throw new Error("Missing EBAY_CLIENT_ID or EBAY_CLIENT_SECRET environment variables.")
    }

    const now = Date.now()
    if (tokenCache && tokenCache.expiresAt > now) {
        return tokenCache.token
    }

    const url = 'https://api.ebay.com/identity/v1/oauth2/token'
    const creds = `${client_id}:${client_secret}`
    const base64_encoded = Buffer.from(creds).toString('base64')

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${base64_encoded}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
                grant_type: 'client_credentials',
                scope: 'https://api.ebay.com/oauth/api_scope',
            })
        })

        if (!response.ok) {
            const content_type = response.headers.get('content-type') || ''
            if (content_type.includes('application/json')) {
                const err_body = await response.json()
                throw new APIError(response.status, err_body)
            } else {
                const raw_html_text = await response.text();
                throw new HTMLError(response.status, raw_html_text)
            }
        } else {
            const data = (await response.json()) as EbayTokenData
            tokenCache = {
                token: data.access_token,
                expiresAt: Date.now() + Math.max(data.expires_in - 60, 0) * 1000,
            }
            return data.access_token
        }


    } catch (error) {
        throw error
    }
}

export function normalize_listing(item: unknown): EbayListing | null {
    if (!isRecord(item)) {
        return null
    }

    const itemId = typeof item.itemId === 'string' ? item.itemId : null
    const title = typeof item.title === 'string' ? item.title : null
    const url = typeof item.itemWebUrl === 'string' ? item.itemWebUrl : null

    if (!itemId || !title || !url) {
        return null
    }

    const price = isRecord(item.price) ? item.price : null
    const shippingOptions = Array.isArray(item.shippingOptions) ? item.shippingOptions : []
    const shippingOption = shippingOptions.length > 0 && isRecord(shippingOptions[0])
        ? shippingOptions[0]
        : null
    const shippingCost = shippingOption && isRecord(shippingOption.shippingCost)
        ? shippingOption.shippingCost
        : null
    const seller = isRecord(item.seller) ? item.seller : null
    const itemLocation = isRecord(item.itemLocation) ? item.itemLocation : null
    const buyingOptions = Array.isArray(item.buyingOptions)
        ? item.buyingOptions.filter((option): option is string => typeof option === 'string')
        : []

    return {
        itemId,
        title,
        price: toNumberOrNull(price?.value),
        currency: typeof price?.currency === 'string' ? price.currency : null,
        condition: typeof item.condition === 'string' ? item.condition : null,
        url,
        seller: {
            username: typeof seller?.username === 'string' ? seller.username : null,
            feedbackPercentage: toNumberOrNull(seller?.feedbackPercentage),
            feedbackScore: toNumberOrNull(seller?.feedbackScore),
        },
        shippingCost: toNumberOrNull(shippingCost?.value),
        shippingCurrency: typeof shippingCost?.currency === 'string' ? shippingCost.currency : null,
        locationCountry: typeof itemLocation?.country === 'string' ? itemLocation.country : null,
        buyingOptions,
    }
}

export async function search_items(query: string, limit = 5): Promise<SearchResult> {
    const token = await get_access_token();
    if (!ebay_id) {
        throw new Error("Missing EBAY_MARKETPLACE_ID environment variable.")
    }

    const url = new URL('https://api.ebay.com/buy/browse/v1/item_summary/search')
    url.search = new URLSearchParams({
        q: query,
        limit: String(limit)
    }).toString()

    const response = await fetch(url, {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${token}`,
            "X-EBAY-C-MARKETPLACE-ID": ebay_id,
        }
    })

    if (!response.ok) {
        const err_body = await response.json()
        throw new APIError(response.status, err_body)
    }

    const data = (await response.json()) as EbaySearchResponse
    const rawItems = Array.isArray(data.itemSummaries) ? data.itemSummaries : []
    const normalizedListings = rawItems
        .map(normalize_listing)
        .filter((listing): listing is EbayListing => listing !== null)

    return {
        query,
        limit,
        total: data.total ?? null,
        returned: normalizedListings.length,
        discarded: rawItems.length - normalizedListings.length,
        listings: normalizedListings,
    }
}