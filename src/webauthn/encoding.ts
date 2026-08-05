/**
 * Byte-level primitives the authenticator needs: base64url, a minimal CBOR
 * encoder, COSE key construction, and ECDSA signature re-encoding.
 *
 * These run in the background service worker and in the injected page script,
 * so nothing here may touch `chrome.*` or the DOM.
 */

/* ------------------------------------------------------------------ base64 */

/**
 * `String.fromCharCode(...bytes)` blows the argument limit and throws
 * `RangeError` on inputs of a few hundred KB. Chunked loop instead — see the
 * matching note in `docs/crypto-status.md`.
 */
function bytesToBinaryString(bytes: Uint8Array): string {
    const CHUNK = 0x8000;
    let out = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
        out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return out;
}

export function bytesToBase64url(bytes: Uint8Array): string {
    return btoa(bytesToBinaryString(bytes))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

export function base64urlToBytes(value: string): Uint8Array {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
    const total = parts.reduce((sum, p) => sum + p.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

/* -------------------------------------------------------------------- CBOR */

/** CBOR major types used by the WebAuthn structures we emit. */
const MAJOR_UINT = 0;
const MAJOR_NEGINT = 1;
const MAJOR_BYTES = 2;
const MAJOR_TEXT = 3;
const MAJOR_MAP = 5;

export type CborKey = number | string;
export type CborValue = number | string | Uint8Array | CborValue[] | Map<CborKey, CborValue>;

function encodeHead(major: number, argument: number): Uint8Array {
    const prefix = major << 5;
    if (argument < 24) {
        return new Uint8Array([prefix | argument]);
    }
    if (argument < 0x100) {
        return new Uint8Array([prefix | 24, argument]);
    }
    if (argument < 0x10000) {
        return new Uint8Array([prefix | 25, argument >> 8, argument & 0xff]);
    }
    if (argument < 0x100000000) {
        return new Uint8Array([
            prefix | 26,
            (argument >>> 24) & 0xff,
            (argument >>> 16) & 0xff,
            (argument >>> 8) & 0xff,
            argument & 0xff,
        ]);
    }
    // WebAuthn never produces a 64-bit length; refuse rather than emit garbage.
    throw new Error('CBOR argument exceeds 32 bits');
}

/**
 * CTAP2 canonical ordering: unsigned keys before negative keys before text
 * keys, shorter text before longer, then bytewise. Verifiers that re-serialize
 * the COSE key (a common way to compare public keys) depend on this.
 */
function canonicalKeyRank(key: CborKey): [number, number, string] {
    if (typeof key === 'number') {
        return key >= 0 ? [0, key, ''] : [1, -key - 1, ''];
    }
    return [2, key.length, key];
}

function compareKeys(a: CborKey, b: CborKey): number {
    const [aMajor, aNum, aText] = canonicalKeyRank(a);
    const [bMajor, bNum, bText] = canonicalKeyRank(b);
    if (aMajor !== bMajor) return aMajor - bMajor;
    if (aNum !== bNum) return aNum - bNum;
    return aText < bText ? -1 : aText > bText ? 1 : 0;
}

export function cborEncode(value: CborValue): Uint8Array {
    if (typeof value === 'number') {
        if (!Number.isInteger(value)) {
            throw new Error('CBOR encoder supports integers only');
        }
        return value >= 0
            ? encodeHead(MAJOR_UINT, value)
            : encodeHead(MAJOR_NEGINT, -value - 1);
    }

    if (typeof value === 'string') {
        const utf8 = new TextEncoder().encode(value);
        return concatBytes(encodeHead(MAJOR_TEXT, utf8.length), utf8);
    }

    if (value instanceof Uint8Array) {
        return concatBytes(encodeHead(MAJOR_BYTES, value.length), value);
    }

    if (Array.isArray(value)) {
        return concatBytes(encodeHead(4, value.length), ...value.map(cborEncode));
    }

    if (value instanceof Map) {
        const keys = [...value.keys()].sort(compareKeys);
        const body = keys.flatMap(key => [
            cborEncode(key as CborValue),
            cborEncode(value.get(key) as CborValue),
        ]);
        return concatBytes(encodeHead(MAJOR_MAP, keys.length), ...body);
    }

    throw new Error(`CBOR encoder cannot handle value of type ${typeof value}`);
}

/* -------------------------------------------------------------------- COSE */

export const COSE_ALG_ES256 = -7;

/**
 * COSE_Key for an ES256 (P-256) public key, built from the raw uncompressed
 * point WebCrypto exports (`0x04 || x || y`).
 */
export function coseKeyFromRawPublicKey(raw: Uint8Array): Uint8Array {
    if (raw.length !== 65 || raw[0] !== 0x04) {
        throw new Error('Expected an uncompressed P-256 public key (65 bytes, 0x04 prefix)');
    }
    const key = new Map<CborKey, CborValue>([
        [1, 2],                        // kty: EC2
        [3, COSE_ALG_ES256],           // alg: ES256
        [-1, 1],                       // crv: P-256
        [-2, raw.slice(1, 33)],        // x
        [-3, raw.slice(33, 65)],       // y
    ]);
    return cborEncode(key);
}

/* --------------------------------------------------------------- signature */

function trimLeadingZeros(bytes: Uint8Array): Uint8Array {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start++;
    return bytes.subarray(start);
}

function derInteger(value: Uint8Array): Uint8Array {
    const trimmed = trimLeadingZeros(value);
    // A leading bit of 1 would read as a negative number in DER, so pad it.
    const body = (trimmed[0] ?? 0) & 0x80
        ? concatBytes(new Uint8Array([0x00]), trimmed)
        : trimmed;
    return concatBytes(new Uint8Array([0x02, body.length]), body);
}

/**
 * WebCrypto's ECDSA output is the raw `r || s` pair, but WebAuthn relying
 * parties parse an ASN.1 DER SEQUENCE. Converting is mandatory — skipping it
 * is the classic reason a hand-rolled authenticator gets rejected at verify.
 */
export function rawSignatureToDer(raw: Uint8Array): Uint8Array {
    if (raw.length !== 64) {
        throw new Error(`Expected a 64-byte raw ECDSA signature, got ${raw.length}`);
    }
    const r = derInteger(raw.subarray(0, 32));
    const s = derInteger(raw.subarray(32, 64));
    const body = concatBytes(r, s);
    return concatBytes(new Uint8Array([0x30, body.length]), body);
}
