/**
 * URL handling for stored items and page matching.
 *
 * Two rules shape this module:
 *
 * - **Stored URLs carry no protocol.** `https://` is noise in a vault entry;
 *   the host is the identifying part. Input is accepted with or without a
 *   scheme and normalised on the way in.
 * - **Subdomains are distinguishable.** The previous version flattened every
 *   host to its last two labels, so `mail.example.com` and `dev.example.com`
 *   were the same entry and neither could be preferred over the other. Full
 *   hosts are kept, and matching ranks an exact host above a parent-domain
 *   fall-back.
 */

/** Hosts whose registrable domain is three labels, not two. */
const MULTI_LABEL_SUFFIXES = new Set([
    'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'co.jp', 'or.jp', 'ne.jp',
    'com.au', 'net.au', 'org.au', 'co.nz', 'com.br', 'com.mx', 'co.za',
    'com.sg', 'co.in', 'qc.ca', 'on.ca', 'gc.ca',
]);

/** Parses input that may or may not carry a scheme. */
function toUrl(input: string): URL | null {
    if (!input) return null;
    const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`;
    try {
        return new URL(candidate);
    } catch {
        return null;
    }
}

/** Full lowercase host, `www.` removed. `https://App.Example.com/x` -> `app.example.com`. */
export function getHost(input: string): string {
    const url = toUrl(input);
    if (!url) return '';
    return url.hostname.toLowerCase().replace(/^www\./, '');
}

/** The registrable domain: `mail.example.co.uk` -> `example.co.uk`. */
export function getRegistrableDomain(input: string): string {
    const host = getHost(input);
    if (!host) return '';

    const parts = host.split('.');
    if (parts.length <= 2) return host;

    const lastTwo = parts.slice(-2).join('.');
    if (MULTI_LABEL_SUFFIXES.has(lastTwo) && parts.length >= 3) {
        return parts.slice(-3).join('.');
    }
    return lastTwo;
}

/**
 * How an item's URL is persisted and shown: no scheme, no `www.`, no trailing
 * slash — but any path the user entered is kept, since some sites need a
 * specific sign-in path.
 */
export function normalizeStoredUrl(input: string): string {
    const url = toUrl(input);
    if (!url) return input.trim();

    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
    return `${host}${path}${url.search}`;
}

/** Kept for existing callers; an alias of the registrable domain. */
export function normalizeDomain(input: string): string {
    return getRegistrableDomain(input);
}

export function getFullDomain(input: string): string {
    return getHost(input);
}

export function getFaviconUrl(input: string): string {
    const host = getHost(input);
    if (!host) return '';
    return `https://www.google.com/s2/favicons?domain=${host}&sz=64`;
}

export function getInitials(name: string): string {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2 && parts[0] && parts[parts.length - 1]) {
        return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    return name.slice(0, 2).toUpperCase();
}

/* ---------------------------------------------------------------- matching */

export const MATCH_NONE = 0;
/** Same registrable domain, different subdomain — offered, but ranked last. */
export const MATCH_RELATED = 1;
/** The page is a subdomain of the stored host (stored `example.com`, page `app.example.com`). */
export const MATCH_PARENT = 2;
/** Host for host. */
export const MATCH_EXACT = 3;

/**
 * Scores how well a stored host/URL matches the page.
 *
 * A ranking rather than a boolean, so the menu can put the credential saved for
 * *this* subdomain above one saved for a sibling. Either argument may be a full
 * URL, a bare host, or a registrable domain — items written by older versions
 * stored the registrable domain in `metadata.domain`.
 */
export function matchStrength(stored: string, pageUrl: string): number {
    const storedHost = getHost(stored);
    const pageHost = getHost(pageUrl);
    if (!storedHost || !pageHost) return MATCH_NONE;

    if (storedHost === pageHost) return MATCH_EXACT;
    if (pageHost.endsWith(`.${storedHost}`)) return MATCH_PARENT;

    const storedRegistrable = getRegistrableDomain(storedHost);
    const pageRegistrable = getRegistrableDomain(pageHost);
    if (storedRegistrable && storedRegistrable === pageRegistrable) return MATCH_RELATED;

    return MATCH_NONE;
}

export function domainMatches(itemDomain: string, pageUrl: string): boolean {
    return matchStrength(itemDomain, pageUrl) > MATCH_NONE;
}

export function urlMatches(itemUrl: string, pageUrl: string): boolean {
    return matchStrength(itemUrl, pageUrl) > MATCH_NONE;
}
