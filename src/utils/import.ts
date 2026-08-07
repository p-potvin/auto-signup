/**
 * Importers for other password managers.
 *
 * Parsing happens entirely in the extension: an export file is the most
 * sensitive document a person owns, and uploading one to be converted would
 * undo the point of a zero-knowledge vault. Nothing here touches the network.
 *
 * Everything returns `ParsedImport` so the UI can show a preview and let the
 * user commit or cancel — an import that silently writes hundreds of records is
 * not something you can undo.
 */

import type { ItemType, LoginItem, CardItem, TotpItem, VaultItemData, VaultItemMetadata } from '../types';
import { getHost, normalizeStoredUrl } from './domain';

export type ImportSource = 'proton' | 'bitwarden' | 'chrome' | 'lastpass' | 'onepassword' | 'csv';

export interface ImportCandidate {
    itemType: ItemType;
    data: VaultItemData;
    metadata: VaultItemMetadata;
    /** Set when an existing vault item looks like the same record. */
    duplicateOfId?: string;
}

export interface ParsedImport {
    source: ImportSource;
    sourceLabel: string;
    candidates: ImportCandidate[];
    /** Rows that could not be understood, with the reason, so nothing vanishes silently. */
    skipped: { reason: string; detail: string }[];
}

/* ------------------------------------------------------------------- csv */

/**
 * RFC 4180 parser. Hand-rolled because every export in the wild contains
 * quoted commas and embedded newlines in the notes column, and splitting on
 * commas mangles exactly the records people care most about keeping.
 */
export function parseCsv(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = '';
    let inQuotes = false;

    // Strip a UTF-8 BOM; Excel-produced exports carry one and it corrupts the
    // first header name.
    const input = text.replace(/^﻿/, '');

    for (let i = 0; i < input.length; i++) {
        const char = input[i];

        if (inQuotes) {
            if (char === '"') {
                if (input[i + 1] === '"') { field += '"'; i++; }
                else inQuotes = false;
            } else {
                field += char;
            }
            continue;
        }

        if (char === '"') { inQuotes = true; continue; }
        if (char === ',') { row.push(field); field = ''; continue; }
        if (char === '\r') continue;
        if (char === '\n') {
            row.push(field);
            // Skip blank trailing lines rather than importing an empty record.
            if (row.length > 1 || row[0] !== '') rows.push(row);
            row = [];
            field = '';
            continue;
        }
        field += char;
    }

    if (field !== '' || row.length > 0) {
        row.push(field);
        if (row.length > 1 || row[0] !== '') rows.push(row);
    }
    return rows;
}

function headerIndex(headers: string[], ...names: string[]): number {
    const normalized = headers.map(h => h.trim().toLowerCase().replace(/[\s_-]/g, ''));
    for (const name of names) {
        const target = name.toLowerCase().replace(/[\s_-]/g, '');
        const index = normalized.indexOf(target);
        if (index >= 0) return index;
    }
    return -1;
}

function looksLikeEmail(value: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/**
 * Splits a single identifier column into the email/username pair the vault
 * stores. Exports almost always have one "username" column holding whichever
 * the user typed.
 */
function splitIdentifier(value: string): { email: string; username: string } {
    const trimmed = (value ?? '').trim();
    return looksLikeEmail(trimmed)
        ? { email: trimmed, username: '' }
        : { email: '', username: trimmed };
}

function loginCandidate(fields: {
    name?: string;
    url?: string;
    identifier?: string;
    email?: string;
    username?: string;
    password?: string;
    notes?: string;
    totp?: string;
}): ImportCandidate {
    const url = normalizeStoredUrl(fields.url ?? '');
    const host = getHost(fields.url ?? '');

    let email = (fields.email ?? '').trim();
    let username = (fields.username ?? '').trim();
    if (!email && !username && fields.identifier) {
        ({ email, username } = splitIdentifier(fields.identifier));
    }

    const data: LoginItem = {
        url,
        username,
        email,
        password: fields.password ?? '',
        notes: fields.notes || undefined,
        totpSecret: normalizeTotpSecret(fields.totp),
    };

    return {
        itemType: 'login',
        data,
        metadata: {
            label: (fields.name ?? '').trim() || host || email || username || 'Imported login',
            domain: host || undefined,
            tags: ['imported'],
            favorite: false,
        },
    };
}

/** Accepts a raw Base32 secret or a full `otpauth://` URI. */
function normalizeTotpSecret(value?: string): string | undefined {
    const trimmed = (value ?? '').trim();
    if (!trimmed) return undefined;

    if (trimmed.toLowerCase().startsWith('otpauth://')) {
        try {
            const secret = new URL(trimmed).searchParams.get('secret');
            return secret ? secret.toUpperCase() : undefined;
        } catch {
            return undefined;
        }
    }
    return trimmed.replace(/\s/g, '').toUpperCase();
}

/* ---------------------------------------------------------------- proton */

interface ProtonItemContent {
    itemEmail?: string;
    itemUsername?: string;
    password?: string;
    urls?: string[];
    totpUri?: string;
    cardholderName?: string;
    number?: string;
    verificationNumber?: string;
    expirationDate?: string;
    pin?: string;
}

interface ProtonItem {
    itemId?: string;
    data?: {
        metadata?: { name?: string; note?: string };
        type?: string;
        content?: ProtonItemContent;
    };
    state?: number;
}

/**
 * Proton Pass JSON export (`Pass_export_*.zip` -> `data.json`, or the plain
 * `.json` download).
 *
 * Proton splits the identifier into `itemEmail` and `itemUsername`, which maps
 * directly onto the vault's two fields — one of the reasons that split was
 * worth making.
 */
export function parseProtonJson(text: string): ParsedImport {
    const result: ParsedImport = {
        source: 'proton',
        sourceLabel: 'Proton Pass',
        candidates: [],
        skipped: [],
    };

    let parsed: { vaults?: Record<string, { name?: string; items?: ProtonItem[] }> };
    try {
        parsed = JSON.parse(text);
    } catch (e) {
        throw new Error(`Not valid JSON: ${(e as Error).message}`);
    }

    const vaults = parsed.vaults ?? {};
    if (Object.keys(vaults).length === 0) {
        throw new Error('No "vaults" object found — is this a Proton Pass export?');
    }

    for (const vault of Object.values(vaults)) {
        for (const item of vault.items ?? []) {
            const data = item.data;
            const content = data?.content ?? {};
            const name = data?.metadata?.name ?? '';
            const note = data?.metadata?.note ?? '';

            // state 2 is Proton's trash.
            if (item.state === 2) {
                result.skipped.push({ reason: 'In Proton trash', detail: name || item.itemId || '' });
                continue;
            }

            switch (data?.type) {
                case 'login': {
                    result.candidates.push(loginCandidate({
                        name,
                        url: content.urls?.[0] ?? '',
                        email: content.itemEmail,
                        username: content.itemUsername,
                        password: content.password,
                        notes: note,
                        totp: content.totpUri,
                    }));

                    // Proton keeps every URL on one item; the extras become
                    // their own entries so each host still matches.
                    for (const extra of (content.urls ?? []).slice(1)) {
                        result.candidates.push(loginCandidate({
                            name: `${name || getHost(extra)} (${getHost(extra)})`,
                            url: extra,
                            email: content.itemEmail,
                            username: content.itemUsername,
                            password: content.password,
                            notes: note,
                        }));
                    }
                    break;
                }
                case 'creditCard': {
                    const [month = '', year = ''] = (content.expirationDate ?? '').split(/[-/]/);
                    const card: CardItem = {
                        holderName: content.cardholderName ?? '',
                        cardNumber: (content.number ?? '').replace(/\s/g, ''),
                        expiryMonth: month,
                        expiryYear: year,
                        cvv: content.verificationNumber ?? '',
                        notes: note || undefined,
                    };
                    result.candidates.push({
                        itemType: 'card',
                        data: card,
                        metadata: { label: name || 'Imported card', tags: ['imported'], favorite: false },
                    });
                    break;
                }
                case 'note': {
                    // Stored as a login carrying only notes; the vault has no
                    // dedicated note type yet.
                    result.candidates.push({
                        itemType: 'login',
                        data: { url: '', username: '', email: '', password: '', notes: note } satisfies LoginItem,
                        metadata: { label: name || 'Imported note', tags: ['imported', 'note'], favorite: false },
                    });
                    break;
                }
                default:
                    result.skipped.push({
                        reason: `Unsupported Proton item type "${data?.type ?? 'unknown'}"`,
                        detail: name,
                    });
            }
        }
    }

    return result;
}

/* ------------------------------------------------------------ csv sources */

interface CsvLayout {
    source: ImportSource;
    label: string;
    /** Returns true when these headers identify this exporter. */
    detect: (headers: string[]) => boolean;
    build: (headers: string[], row: string[]) => ImportCandidate | null;
}

const CSV_LAYOUTS: CsvLayout[] = [
    {
        source: 'bitwarden',
        label: 'Bitwarden',
        detect: h => headerIndex(h, 'login_uri') >= 0 && headerIndex(h, 'login_password') >= 0,
        build: (h, r) => {
            if ((r[headerIndex(h, 'type')] ?? 'login') !== 'login') return null;
            return loginCandidate({
                name: r[headerIndex(h, 'name')],
                url: r[headerIndex(h, 'login_uri')],
                identifier: r[headerIndex(h, 'login_username')],
                password: r[headerIndex(h, 'login_password')],
                notes: r[headerIndex(h, 'notes')],
                totp: r[headerIndex(h, 'login_totp')],
            });
        },
    },
    {
        source: 'chrome',
        label: 'Chrome / Edge',
        detect: h => headerIndex(h, 'name') >= 0 && headerIndex(h, 'url') >= 0
            && headerIndex(h, 'username') >= 0 && headerIndex(h, 'password') >= 0
            && headerIndex(h, 'login_uri') < 0,
        build: (h, r) => loginCandidate({
            name: r[headerIndex(h, 'name')],
            url: r[headerIndex(h, 'url')],
            identifier: r[headerIndex(h, 'username')],
            password: r[headerIndex(h, 'password')],
            notes: r[headerIndex(h, 'note', 'notes')],
        }),
    },
    {
        source: 'lastpass',
        label: 'LastPass',
        detect: h => headerIndex(h, 'grouping') >= 0 && headerIndex(h, 'url') >= 0,
        build: (h, r) => loginCandidate({
            name: r[headerIndex(h, 'name')],
            url: r[headerIndex(h, 'url')],
            identifier: r[headerIndex(h, 'username')],
            password: r[headerIndex(h, 'password')],
            notes: r[headerIndex(h, 'extra', 'notes')],
            totp: r[headerIndex(h, 'totp')],
        }),
    },
    {
        source: 'onepassword',
        label: '1Password',
        detect: h => headerIndex(h, 'title') >= 0 && headerIndex(h, 'password') >= 0,
        build: (h, r) => loginCandidate({
            name: r[headerIndex(h, 'title')],
            url: r[headerIndex(h, 'url', 'website')],
            identifier: r[headerIndex(h, 'username')],
            password: r[headerIndex(h, 'password')],
            notes: r[headerIndex(h, 'notes')],
            totp: r[headerIndex(h, 'otpauth', 'onetimepassword')],
        }),
    },
];

/** Last resort for an unrecognised CSV: match on whatever columns exist. */
const GENERIC_LAYOUT: CsvLayout = {
    source: 'csv',
    label: 'Generic CSV',
    detect: () => true,
    build: (h, r) => {
        const password = r[headerIndex(h, 'password', 'pass', 'motdepasse')];
        if (password === undefined) return null;
        return loginCandidate({
            name: r[headerIndex(h, 'name', 'title', 'site', 'nom')],
            url: r[headerIndex(h, 'url', 'uri', 'website', 'login_uri', 'adresse')],
            email: r[headerIndex(h, 'email', 'courriel')],
            username: r[headerIndex(h, 'username', 'user', 'utilisateur')],
            password,
            notes: r[headerIndex(h, 'notes', 'note', 'extra')],
            totp: r[headerIndex(h, 'totp', 'otpauth', 'twofactor')],
        });
    },
};

export function parseCsvExport(text: string): ParsedImport {
    const rows = parseCsv(text);
    if (rows.length < 2) {
        throw new Error('The file has no data rows.');
    }

    const headers = rows[0];
    const layout = CSV_LAYOUTS.find(l => l.detect(headers)) ?? GENERIC_LAYOUT;

    const result: ParsedImport = {
        source: layout.source,
        sourceLabel: layout.label,
        candidates: [],
        skipped: [],
    };

    if (layout === GENERIC_LAYOUT && headerIndex(headers, 'password', 'pass', 'motdepasse') < 0) {
        throw new Error('No password column found. Supported: Proton Pass JSON, Bitwarden, Chrome, LastPass, 1Password CSV.');
    }

    for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (row.every(cell => cell.trim() === '')) continue;

        try {
            const candidate = layout.build(headers, row);
            if (candidate) result.candidates.push(candidate);
            else result.skipped.push({ reason: 'Not a login row', detail: row[0] ?? `row ${i + 1}` });
        } catch (e) {
            result.skipped.push({ reason: (e as Error).message, detail: row[0] ?? `row ${i + 1}` });
        }
    }

    return result;
}

/* --------------------------------------------------------------- dispatch */

export function parseImportFile(filename: string, text: string): ParsedImport {
    const lower = filename.toLowerCase();

    if (lower.endsWith('.json')) return parseProtonJson(text);
    if (lower.endsWith('.csv') || lower.endsWith('.tsv') || lower.endsWith('.txt')) {
        return parseCsvExport(text);
    }

    // Fall back to sniffing content when the extension is missing or wrong.
    const trimmed = text.trimStart();
    if (trimmed.startsWith('{')) return parseProtonJson(text);
    return parseCsvExport(text);
}

/* -------------------------------------------------------------- dedupe */

/**
 * Flags candidates that already exist, comparing host plus identifier.
 *
 * Marked rather than dropped: re-importing after adding entries by hand is
 * normal, and the user should see what will be skipped before it happens.
 */
export function markDuplicates(
    candidates: ImportCandidate[],
    existing: { id: string; itemType: ItemType; data: VaultItemData; metadata: VaultItemMetadata }[],
): ImportCandidate[] {
    const key = (host: string, identifier: string) => `${host.toLowerCase()}|${identifier.trim().toLowerCase()}`;

    const seen = new Map<string, string>();
    for (const item of existing) {
        if (item.itemType !== 'login') continue;
        const login = item.data as LoginItem;
        const host = getHost(login.url) || item.metadata.domain || '';
        for (const identifier of [login.email, login.username]) {
            if (identifier) seen.set(key(host, identifier), item.id);
        }
    }

    return candidates.map(candidate => {
        if (candidate.itemType !== 'login') return candidate;
        const login = candidate.data as LoginItem;
        const host = getHost(login.url) || candidate.metadata.domain || '';
        for (const identifier of [login.email, login.username]) {
            if (!identifier) continue;
            const match = seen.get(key(host, identifier));
            if (match) return { ...candidate, duplicateOfId: match };
        }
        return candidate;
    });
}

export type { TotpItem };
