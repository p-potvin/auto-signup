/**
 * The authenticator itself.
 *
 * This is the half the browser normally hides inside a security key or the
 * platform TPM: it owns the credential private keys, builds authenticator data,
 * and signs ceremonies. It runs in the background service worker only — the
 * private key is unwrapped here, used here, and never crosses into a page.
 */

import {
    base64urlToBytes,
    bytesToBase64url,
    cborEncode,
    coseKeyFromRawPublicKey,
    concatBytes,
    rawSignatureToDer,
    COSE_ALG_ES256,
    type CborKey,
    type CborValue,
} from './encoding';
import type { SerializedCreationOptions, SerializedRequestOptions } from './types';

/**
 * Attestation is `none`, so the AAGUID is zeroed as the spec requires. A
 * self-identifying AAGUID would need a real attestation statement to mean
 * anything, and `none` is what a vault-backed authenticator should send.
 */
const AAGUID = new Uint8Array(16);

const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
const FLAG_BACKUP_ELIGIBLE = 0x08;
const FLAG_BACKED_UP = 0x10;
const FLAG_ATTESTED_DATA = 0x40;

/**
 * Always zero.
 *
 * A signature counter exists to detect cloned authenticators. Vault
 * credentials are *deliberately* cloned — that is what syncing a vault means —
 * so a per-device counter would drift and relying parties would read the
 * decrease as a compromise and lock the account. WebAuthn L2 §6.1.1 allows a
 * constant 0 to mean "this authenticator does not implement a counter", which
 * is the honest answer here. `lastUsedAt` on the vault item gives the user the
 * usage history a counter would otherwise hint at.
 */
const SIGN_COUNT = 0;

export interface StoredCredential {
    credentialId: string;
    rpId: string;
    userHandle: string;
    userName: string;
    privateKeyPkcs8: string;
    publicKeySpki: string;
}

export interface MakeCredentialResult {
    credentialId: string;
    clientDataJSON: string;
    attestationObject: string;
    authenticatorData: string;
    publicKeySpki: string;
    privateKeyPkcs8: string;
    rpId: string;
    rpName: string;
    userHandle: string;
    userName: string;
    userDisplayName: string;
}

export interface GetAssertionResult {
    credentialId: string;
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle: string;
}

/* ------------------------------------------------------------ rp id policy */

/**
 * A page may only act for its own registrable domain or a parent of it.
 * Without this check any site could ask us to mint or use a credential for
 * `google.com`, which is the whole attack WebAuthn's origin binding prevents.
 */
export function isRpIdAllowed(rpId: string, origin: string): boolean {
    let host: string;
    try {
        const url = new URL(origin);
        if (url.protocol !== 'https:' && url.hostname !== 'localhost') return false;
        host = url.hostname.toLowerCase();
    } catch {
        return false;
    }
    const target = rpId.toLowerCase();
    if (host === target) return true;
    return host.endsWith(`.${target}`);
}

export function defaultRpId(origin: string): string {
    return new URL(origin).hostname.toLowerCase();
}

/* --------------------------------------------------------- authenticator data */

async function sha256(data: Uint8Array): Promise<Uint8Array> {
    const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
    return new Uint8Array(digest);
}

function buildClientDataJSON(type: 'webauthn.create' | 'webauthn.get', challenge: string, origin: string): Uint8Array {
    // Key order is not significant to verifiers (they parse the JSON), but
    // matching the browser's own ordering keeps captured traces comparable.
    const clientData = {
        type,
        challenge,
        origin,
        crossOrigin: false,
    };
    return new TextEncoder().encode(JSON.stringify(clientData));
}

function signCountBytes(): Uint8Array {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, SIGN_COUNT, false);
    return bytes;
}

async function buildAuthenticatorData(
    rpId: string,
    flags: number,
    attestedCredentialData?: Uint8Array,
): Promise<Uint8Array> {
    const rpIdHash = await sha256(new TextEncoder().encode(rpId));
    const parts = [rpIdHash, new Uint8Array([flags]), signCountBytes()];
    if (attestedCredentialData) parts.push(attestedCredentialData);
    return concatBytes(...parts);
}

function buildAttestedCredentialData(credentialId: Uint8Array, coseKey: Uint8Array): Uint8Array {
    const idLength = new Uint8Array(2);
    new DataView(idLength.buffer).setUint16(0, credentialId.length, false);
    return concatBytes(AAGUID, idLength, credentialId, coseKey);
}

/* ------------------------------------------------------------------- keys */

async function generateKeyPair(): Promise<CryptoKeyPair> {
    // Extractable because the private key has to be persisted in the vault;
    // it is exported once here and immediately encrypted by the caller.
    return crypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' },
        true,
        ['sign', 'verify'],
    ) as Promise<CryptoKeyPair>;
}

async function importSigningKey(pkcs8: string): Promise<CryptoKey> {
    return crypto.subtle.importKey(
        'pkcs8',
        base64urlToBytes(pkcs8) as BufferSource,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['sign'],
    );
}

async function signWithCredential(key: CryptoKey, payload: Uint8Array): Promise<Uint8Array> {
    const raw = await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        key,
        payload as BufferSource,
    );
    return rawSignatureToDer(new Uint8Array(raw));
}

/* --------------------------------------------------------- make credential */

export function supportsRequestedAlgorithm(options: SerializedCreationOptions): boolean {
    // An empty list means "authenticator's choice" per the spec.
    if (!options.pubKeyCredParams?.length) return true;
    return options.pubKeyCredParams.some(p => p.alg === COSE_ALG_ES256);
}

export async function makeCredential(
    options: SerializedCreationOptions,
    origin: string,
    userVerified: boolean,
): Promise<MakeCredentialResult> {
    const rpId = options.rp.id ?? defaultRpId(origin);
    const credentialId = crypto.getRandomValues(new Uint8Array(32));

    const keyPair = await generateKeyPair();
    const rawPublicKey = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
    const spki = new Uint8Array(await crypto.subtle.exportKey('spki', keyPair.publicKey));
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));

    const coseKey = coseKeyFromRawPublicKey(rawPublicKey);
    const attestedCredentialData = buildAttestedCredentialData(credentialId, coseKey);

    let flags = FLAG_USER_PRESENT | FLAG_ATTESTED_DATA | FLAG_BACKUP_ELIGIBLE | FLAG_BACKED_UP;
    if (userVerified) flags |= FLAG_USER_VERIFIED;

    const authData = await buildAuthenticatorData(rpId, flags, attestedCredentialData);
    const clientDataJSON = buildClientDataJSON('webauthn.create', options.challenge, origin);

    const attestationObject = cborEncode(new Map<CborKey, CborValue>([
        ['fmt', 'none'],
        ['attStmt', new Map<CborKey, CborValue>()],
        ['authData', authData],
    ]));

    return {
        credentialId: bytesToBase64url(credentialId),
        clientDataJSON: bytesToBase64url(clientDataJSON),
        attestationObject: bytesToBase64url(attestationObject),
        authenticatorData: bytesToBase64url(authData),
        publicKeySpki: bytesToBase64url(spki),
        privateKeyPkcs8: bytesToBase64url(pkcs8),
        rpId,
        rpName: options.rp.name || rpId,
        userHandle: options.user.id,
        userName: options.user.name,
        userDisplayName: options.user.displayName || options.user.name,
    };
}

/* ----------------------------------------------------------- get assertion */

export async function getAssertion(
    options: SerializedRequestOptions,
    origin: string,
    credential: StoredCredential,
    userVerified: boolean,
): Promise<GetAssertionResult> {
    const rpId = options.rpId ?? defaultRpId(origin);

    let flags = FLAG_USER_PRESENT | FLAG_BACKUP_ELIGIBLE | FLAG_BACKED_UP;
    if (userVerified) flags |= FLAG_USER_VERIFIED;

    const authData = await buildAuthenticatorData(rpId, flags);
    const clientDataJSON = buildClientDataJSON('webauthn.get', options.challenge, origin);
    const clientDataHash = await sha256(clientDataJSON);

    const signingKey = await importSigningKey(credential.privateKeyPkcs8);
    const signature = await signWithCredential(
        signingKey,
        concatBytes(authData, clientDataHash),
    );

    return {
        credentialId: credential.credentialId,
        clientDataJSON: bytesToBase64url(clientDataJSON),
        authenticatorData: bytesToBase64url(authData),
        signature: bytesToBase64url(signature),
        userHandle: credential.userHandle,
    };
}

/**
 * Picks the credential to assert with. `allowCredentials` narrows to a specific
 * set; an empty list is a discoverable-credential request, so any credential
 * for the rpId qualifies.
 */
export function selectCredential(
    options: SerializedRequestOptions,
    available: StoredCredential[],
): StoredCredential | null {
    const allowed = options.allowCredentials ?? [];
    if (allowed.length === 0) return available[0] ?? null;

    const allowedIds = new Set(allowed.map(c => c.id));
    return available.find(c => allowedIds.has(c.credentialId)) ?? null;
}
