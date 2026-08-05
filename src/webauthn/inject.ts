/**
 * Runs in the page's own JavaScript world at document_start.
 *
 * It replaces `navigator.credentials.create` and `.get` so that WebAuthn
 * ceremonies are served by the vault. It holds no key material and makes no
 * decisions — it serializes the request, hands it to the content script, and
 * rebuilds a `PublicKeyCredential` from the answer.
 *
 * The native implementations are kept so the user can still pick their browser
 * profile or a hardware key from the consent prompt.
 */

import { base64urlToBytes, bytesToBase64url } from './encoding';
import { PAGE_SOURCE, CONTENT_SOURCE, type PageRequest, type PageReply } from './protocol';
import type {
    SerializedCreationOptions,
    SerializedRequestOptions,
    SerializedAttestationResponse,
    SerializedAssertionResponse,
    SerializedDescriptor,
} from './types';

declare const __VW_VERSION__: string;

function toBase64url(source: BufferSource): string {
    const bytes = source instanceof ArrayBuffer
        ? new Uint8Array(source)
        : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    return bytesToBase64url(bytes);
}

function toArrayBuffer(value: string): ArrayBuffer {
    const bytes = base64urlToBytes(value);
    // Copy into a standalone buffer: the page may hold onto it indefinitely.
    return bytes.slice().buffer;
}

function serializeDescriptors(list?: PublicKeyCredentialDescriptor[]): SerializedDescriptor[] | undefined {
    if (!list) return undefined;
    return list.map(descriptor => ({
        id: toBase64url(descriptor.id),
        type: descriptor.type,
        transports: descriptor.transports ? [...descriptor.transports] : undefined,
    }));
}

/* ----------------------------------------------------------- request relay */

let requestCounter = 0;
const pending = new Map<string, (reply: PageReply) => void>();

window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window) return;
    const data = event.data as PageReply | undefined;
    if (!data || data.source !== CONTENT_SOURCE) return;
    const resolve = pending.get(data.requestId);
    if (!resolve) return;
    pending.delete(data.requestId);
    resolve(data);
});

function sendToBridge(request: Omit<PageRequest, 'source'>): Promise<PageReply> {
    return new Promise(resolve => {
        pending.set(request.requestId, resolve);
        window.postMessage({ ...request, source: PAGE_SOURCE } satisfies PageRequest, window.location.origin);
    });
}

function abortRequest(requestId: string): void {
    pending.delete(requestId);
    window.postMessage(
        { source: PAGE_SOURCE, requestId, kind: 'abort', origin: window.location.origin } satisfies PageRequest,
        window.location.origin,
    );
}

/* ------------------------------------------------- credential construction */

/**
 * Built on the real `PublicKeyCredential.prototype` so relying-party libraries
 * that gate on `instanceof PublicKeyCredential` accept the result. Own
 * properties shadow the prototype's native getters, which would otherwise
 * throw on an object with no internal slots.
 */
function buildCredential(
    base: SerializedAttestationResponse | SerializedAssertionResponse,
    response: Record<string, unknown>,
): PublicKeyCredential {
    const credential = Object.create(PublicKeyCredential.prototype) as Record<string, unknown>;

    Object.defineProperties(credential, {
        id: { value: base.id, enumerable: true },
        rawId: { value: toArrayBuffer(base.rawId), enumerable: true },
        type: { value: 'public-key', enumerable: true },
        authenticatorAttachment: { value: base.authenticatorAttachment, enumerable: true },
        response: { value: response, enumerable: true },
        getClientExtensionResults: { value: () => ({ ...base.clientExtensionResults }) },
        toJSON: { value: () => ({ ...base, response: { ...base.response } }) },
    });

    return credential as unknown as PublicKeyCredential;
}

/**
 * Builds the `response` object on the matching native prototype, so libraries
 * that gate on `instanceof AuthenticatorAttestationResponse` (or the assertion
 * equivalent) accept it.
 *
 * Properties are installed with `defineProperty`, never `Object.assign`. Those
 * prototypes expose `clientDataJSON` and friends as getter-only accessors;
 * assignment walks the chain, finds an accessor with no setter, and throws in
 * strict mode. Defining own data properties shadows the accessors instead.
 */
function buildResponse<T extends Record<string, unknown>>(
    prototypeName: 'AuthenticatorAttestationResponse' | 'AuthenticatorAssertionResponse',
    properties: T,
): T {
    const constructor = (window as unknown as Record<string, unknown>)[prototypeName] as
        | (Function & { prototype: object })
        | undefined;

    // Absent outside a secure context; a plain object still works for every
    // library that does not run the instanceof check.
    const response = typeof constructor === 'function'
        ? Object.create(constructor.prototype)
        : {};

    for (const [key, value] of Object.entries(properties)) {
        Object.defineProperty(response, key, {
            value,
            enumerable: true,
            configurable: true,
        });
    }
    return response as T;
}

function buildAttestationCredential(result: SerializedAttestationResponse): PublicKeyCredential {
    const response = buildResponse('AuthenticatorAttestationResponse', {
        clientDataJSON: toArrayBuffer(result.response.clientDataJSON),
        attestationObject: toArrayBuffer(result.response.attestationObject),
        // SimpleWebAuthn and most server SDKs call these during registration;
        // omitting them breaks otherwise-valid integrations.
        getTransports: () => [...result.response.transports],
        getAuthenticatorData: () => toArrayBuffer(result.response.authenticatorData),
        getPublicKey: () => (result.response.publicKey ? toArrayBuffer(result.response.publicKey) : null),
        getPublicKeyAlgorithm: () => result.response.publicKeyAlgorithm,
    });
    return buildCredential(result, response);
}

function buildAssertionCredential(result: SerializedAssertionResponse): PublicKeyCredential {
    const response = buildResponse('AuthenticatorAssertionResponse', {
        clientDataJSON: toArrayBuffer(result.response.clientDataJSON),
        authenticatorData: toArrayBuffer(result.response.authenticatorData),
        signature: toArrayBuffer(result.response.signature),
        userHandle: result.response.userHandle ? toArrayBuffer(result.response.userHandle) : null,
    });
    return buildCredential(result, response);
}

/* -------------------------------------------------------------- overrides */

const credentials = navigator.credentials;
const nativeCreate = credentials.create.bind(credentials);
const nativeGet = credentials.get.bind(credentials);

function nextRequestId(): string {
    requestCounter += 1;
    return `vw-${Date.now().toString(36)}-${requestCounter}`;
}

/**
 * Shared ceremony driver: relay to the bridge, honour an `AbortSignal`, and
 * translate the reply into either a credential, a native fallback, or the
 * DOMException the caller expects.
 */
async function runCeremony<T extends PublicKeyCredential>(
    kind: 'create' | 'get',
    options: SerializedCreationOptions | SerializedRequestOptions,
    signal: AbortSignal | undefined,
    build: (result: never) => T,
    native: () => Promise<Credential | null>,
): Promise<Credential | null> {
    const requestId = nextRequestId();

    const onAbort = () => abortRequest(requestId);
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
        const reply = await Promise.race([
            sendToBridge({ requestId, kind, origin: window.location.origin, options }),
            new Promise<never>((_, reject) => {
                if (!signal) return;
                signal.addEventListener(
                    'abort',
                    () => reject(new DOMException('The operation was aborted.', 'AbortError')),
                    { once: true },
                );
            }),
        ]);

        if (reply.status === 'fallback') {
            return native();
        }
        if (reply.status === 'error') {
            throw new DOMException(reply.error.message, reply.error.errorName);
        }
        return build(reply.result as never);
    } finally {
        signal?.removeEventListener('abort', onAbort);
        pending.delete(requestId);
    }
}

credentials.create = async function create(options?: CredentialCreationOptions): Promise<Credential | null> {
    const publicKey = options?.publicKey;
    if (!publicKey) return nativeCreate(options);

    const serialized: SerializedCreationOptions = {
        challenge: toBase64url(publicKey.challenge),
        rp: { id: publicKey.rp.id, name: publicKey.rp.name },
        user: {
            id: toBase64url(publicKey.user.id),
            name: publicKey.user.name,
            displayName: publicKey.user.displayName,
        },
        pubKeyCredParams: publicKey.pubKeyCredParams.map(p => ({ type: p.type, alg: p.alg })),
        timeout: publicKey.timeout,
        excludeCredentials: serializeDescriptors(publicKey.excludeCredentials),
        authenticatorSelection: publicKey.authenticatorSelection
            ? { ...publicKey.authenticatorSelection }
            : undefined,
        attestation: publicKey.attestation,
    };

    return runCeremony(
        'create',
        serialized,
        options?.signal ?? undefined,
        buildAttestationCredential,
        () => nativeCreate(options),
    );
};

credentials.get = async function get(options?: CredentialRequestOptions): Promise<Credential | null> {
    const publicKey = options?.publicKey;
    if (!publicKey) return nativeGet(options);

    // Conditional mediation is the passkey-in-autofill flow. We do not
    // implement it yet, so hand it straight back to the browser rather than
    // silently swallowing the request and leaving the field with no UI.
    if (options?.mediation === 'conditional') return nativeGet(options);

    const serialized: SerializedRequestOptions = {
        challenge: toBase64url(publicKey.challenge),
        rpId: publicKey.rpId,
        allowCredentials: serializeDescriptors(publicKey.allowCredentials),
        userVerification: publicKey.userVerification,
        timeout: publicKey.timeout,
    };

    return runCeremony(
        'get',
        serialized,
        options?.signal ?? undefined,
        buildAssertionCredential,
        () => nativeGet(options),
    );
};

/* ------------------------------------------------------ capability probes */

if (typeof PublicKeyCredential !== 'undefined') {
    // The vault is always available to verify the user, so sites that gate
    // their passkey UI on this probe will offer it.
    PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = async () => true;

    if ('isConditionalMediationAvailable' in PublicKeyCredential) {
        // Left to the browser: claiming support without implementing the
        // autofill flow makes sites render a passkey affordance that never
        // resolves.
        const nativeConditional = PublicKeyCredential.isConditionalMediationAvailable;
        PublicKeyCredential.isConditionalMediationAvailable = nativeConditional.bind(PublicKeyCredential);
    }
}

// Version marker for support triage. Deliberately a DOM attribute rather than
// a console log, per the VaultWares versioning rule.
document.documentElement.setAttribute('data-vw-webauthn', __VW_VERSION__);
