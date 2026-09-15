export type SearchRequestForFilter = {
    query: string;
    minPrice?: number;
    maxPrice?: number;
    shipToCountry?: string;
    shipToPostalCode?: string;
};

export type FilteredSearchRequest = {
    query: string;
    minPrice?: number;
    maxPrice?: number;
    shipToCountry?: string;
    shipToPostalCode?: string;
};

export type RequestFilterCode =
    | "empty_query"
    | "query_too_long"
    | "too_many_terms"
    | "control_characters"
    | "url_in_query"
    | "credential_in_query"
    | "instruction_injection"
    | "internal_target"
    | "invalid_price"
    | "invalid_price_range"
    | "invalid_country"
    | "invalid_postal_code";

export type RequestFilterDecision =
    | {
        allowed: true;
        request: FilteredSearchRequest;
        normalized: boolean;
      }
    | {
        allowed: false;
        code: RequestFilterCode;
        reason: string;
      };

export class RequestFilterError extends Error {
    readonly code: RequestFilterCode;

    constructor(code: RequestFilterCode, reason: string) {
        super(`Request rejected by deterministic filter [${code}]: ${reason}`);
        this.name = "RequestFilterError";
        this.code = code;
    }
}

const MAX_QUERY_CODEPOINTS = 240;
const MAX_QUERY_TERMS = 40;
const MAX_POSTAL_CODEPOINTS = 32;

const secretPatterns: RegExp[] = [
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
    /\bsk-[A-Za-z0-9_-]{16,}\b/,
    /\bws_live_[A-Za-z0-9_-]{16,}\b/,
    /\bBearer\s+[A-Za-z0-9._~+\/-]{16,}\b/i,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
];

const instructionPatterns: RegExp[] = [
    /\bignore\s+(?:(?:all|any)\s+)?(?:previous|prior|above|system|developer)\s+(?:instructions?|prompts?|messages?|rules?)\b/i,
    /\b(?:system|developer)\s+(?:prompt|message|instructions?)\b/i,
    /\b(?:reveal|show|print|dump|expose|return)\b.{0,48}\b(?:secret|token|api[ _-]?key|credentials?|environment|env(?:ironment)? variables?)\b/i,
    /\b(?:jailbreak|prompt\s+injection|bypass\s+(?:the\s+)?(?:filter|guardrail|policy|safety))\b/i,
    /\b(?:do not|don't)\s+follow\b.{0,32}\b(?:instructions?|rules?|policy)\b/i,
];

const internalTargetPatterns: RegExp[] = [
    /\b(?:localhost|0\.0\.0\.0|127\.0\.0\.1|169\.254\.169\.254)\b/i,
    /\bmetadata\.google\.internal\b/i,
    /\bprocess\.env\b/i,
    /(?:^|\s)\/etc\/(?:passwd|shadow)(?:\s|$)/i,
];

function codePointLength(value: string): number {
    return Array.from(value).length;
}

function normalizeText(value: string): string {
    return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function hasForbiddenControlCharacters(value: string): boolean {
    return /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/u.test(value);
}

function finiteNonNegative(value: number | undefined): boolean {
    return value === undefined || (Number.isFinite(value) && value >= 0);
}

function blockedBy(patterns: RegExp[], query: string): boolean {
    return patterns.some((pattern) => pattern.test(query));
}

export function filterSearchRequest(input: SearchRequestForFilter): RequestFilterDecision {
    if (hasForbiddenControlCharacters(input.query)) {
        return {
            allowed: false,
            code: "control_characters",
            reason: "query contains hidden, bidirectional, or non-text control characters",
        };
    }

    const query = normalizeText(input.query);
    if (!query) {
        return { allowed: false, code: "empty_query", reason: "query is empty after normalization" };
    }
    if (codePointLength(query) > MAX_QUERY_CODEPOINTS) {
        return {
            allowed: false,
            code: "query_too_long",
            reason: `query exceeds ${MAX_QUERY_CODEPOINTS} characters`,
        };
    }
    if (query.split(" ").filter(Boolean).length > MAX_QUERY_TERMS) {
        return {
            allowed: false,
            code: "too_many_terms",
            reason: `query exceeds ${MAX_QUERY_TERMS} whitespace-delimited terms`,
        };
    }
    if (/\b(?:https?|ftp|file):\/\//i.test(query) || /\bwww\.[^\s]+/i.test(query)) {
        return {
            allowed: false,
            code: "url_in_query",
            reason: "search queries must be product terms, not URLs",
        };
    }
    if (blockedBy(secretPatterns, query)) {
        return {
            allowed: false,
            code: "credential_in_query",
            reason: "query appears to contain a credential or private key",
        };
    }
    if (blockedBy(instructionPatterns, query)) {
        return {
            allowed: false,
            code: "instruction_injection",
            reason: "query contains instruction-like text that should not be forwarded to providers",
        };
    }
    if (blockedBy(internalTargetPatterns, query)) {
        return {
            allowed: false,
            code: "internal_target",
            reason: "query references a local, metadata, environment, or sensitive host/file target",
        };
    }

    if (!finiteNonNegative(input.minPrice) || !finiteNonNegative(input.maxPrice)) {
        return {
            allowed: false,
            code: "invalid_price",
            reason: "price filters must be finite non-negative numbers",
        };
    }
    if (input.minPrice !== undefined && input.maxPrice !== undefined && input.minPrice > input.maxPrice) {
        return {
            allowed: false,
            code: "invalid_price_range",
            reason: "minPrice cannot be greater than maxPrice",
        };
    }

    const country = input.shipToCountry === undefined ? undefined : normalizeText(input.shipToCountry).toUpperCase();
    if (country !== undefined && !/^[A-Z]{2}$/.test(country)) {
        return {
            allowed: false,
            code: "invalid_country",
            reason: "shipToCountry must be a two-letter ISO country code",
        };
    }

    let postalCode: string | undefined;
    if (input.shipToPostalCode !== undefined) {
        if (hasForbiddenControlCharacters(input.shipToPostalCode)) {
            return {
                allowed: false,
                code: "invalid_postal_code",
                reason: "postal code contains forbidden control characters",
            };
        }
        postalCode = normalizeText(input.shipToPostalCode);
        if (!postalCode || codePointLength(postalCode) > MAX_POSTAL_CODEPOINTS) {
            return {
                allowed: false,
                code: "invalid_postal_code",
                reason: `postal code must contain 1 to ${MAX_POSTAL_CODEPOINTS} characters`,
            };
        }
    }

    const request: FilteredSearchRequest = {
        query,
        minPrice: input.minPrice,
        maxPrice: input.maxPrice,
        shipToCountry: country,
        shipToPostalCode: postalCode,
    };

    return {
        allowed: true,
        request,
        normalized: query !== input.query
            || country !== input.shipToCountry
            || postalCode !== input.shipToPostalCode,
    };
}

export function requireFilteredSearchRequest(input: SearchRequestForFilter): FilteredSearchRequest {
    const decision = filterSearchRequest(input);
    if (!decision.allowed) {
        throw new RequestFilterError(decision.code, decision.reason);
    }
    return decision.request;
}
