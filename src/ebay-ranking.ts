import type { NormalizedListing } from "./common.js";

const RISKY_TITLE_PATTERNS = [
    /\bfor\s+parts\b/i,
    /\bparts\s+only\b/i,
    /\bnot\s+working\b/i,
    /\bnon[- ]?working\b/i,
    /\buntested\b/i,
    /\bas[- ]?is\b/i,
    /\bbox\s+only\b/i,
    /\bread\s+(?:the\s+)?description\b/i,
];

const QUERY_STOP_WORDS = new Set([
    "a", "an", "and", "for", "in", "of", "on", "or", "the", "to", "with",
    "cheap", "deal", "deals", "best", "good", "used", "new",
]);

function normalizedTokens(value: string): string[] {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
        .split(/\s+/)
        .filter((token) => token.length > 1 && !QUERY_STOP_WORDS.has(token));
}

function queryCoverage(query: string, title: string): number {
    const queryTokens = [...new Set(normalizedTokens(query))];
    if (queryTokens.length === 0) {
        return 1;
    }

    const titleTokens = new Set(normalizedTokens(title));
    const matched = queryTokens.filter((token) => titleTokens.has(token)).length;
    return matched / queryTokens.length;
}

function listingCost(listing: NormalizedListing): number {
    return listing.totalCost.value ?? listing.price.value ?? Number.POSITIVE_INFINITY;
}

function qualityMultiplier(listing: NormalizedListing, query: string): number {
    let multiplier = 1;

    const coverage = queryCoverage(query, listing.title);
    if (coverage < 0.5) {
        multiplier *= 1.35;
    } else if (coverage < 0.75) {
        multiplier *= 1.12;
    } else if (coverage === 1) {
        multiplier *= 0.98;
    }

    if (RISKY_TITLE_PATTERNS.some((pattern) => pattern.test(listing.title))) {
        multiplier *= 1.25;
    }

    if (listing.shippingCost.value === null) {
        multiplier *= 1.06;
    }

    const feedbackPercentage = listing.sellerFeedbackPercentage;
    if (feedbackPercentage !== null) {
        if (feedbackPercentage < 95) {
            multiplier *= 1.18;
        } else if (feedbackPercentage < 98) {
            multiplier *= 1.08;
        } else if (feedbackPercentage >= 99.5) {
            multiplier *= 0.97;
        }
    }

    const feedbackScore = listing.sellerFeedbackScore;
    if (feedbackScore !== null) {
        if (feedbackScore < 10) {
            multiplier *= 1.12;
        } else if (feedbackScore < 50) {
            multiplier *= 1.05;
        } else if (feedbackScore >= 1000) {
            multiplier *= 0.98;
        }
    }

    if (listing.returnsAccepted === true) {
        multiplier *= 0.98;
    } else if (listing.returnsAccepted === false) {
        multiplier *= 1.04;
    }

    return multiplier;
}

export function ebayDealScore(listing: NormalizedListing, query: string): number {
    const cost = listingCost(listing);
    if (!Number.isFinite(cost)) {
        return Number.POSITIVE_INFINITY;
    }
    return cost * qualityMultiplier(listing, query);
}

export function rankEbayDeals(listings: NormalizedListing[], query: string): NormalizedListing[] {
    return [...listings].sort((left, right) => {
        const scoreDifference = ebayDealScore(left, query) - ebayDealScore(right, query);
        if (scoreDifference !== 0) {
            return scoreDifference;
        }
        return listingCost(left) - listingCost(right);
    });
}
