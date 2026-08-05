/**
 * Wire types for the WebAuthn bridge.
 *
 * `PublicKeyCredentialCreationOptions` carries `ArrayBuffer`s, which do not
 * survive `postMessage` to a content script and `chrome.runtime` to the
 * background intact across every browser. Every buffer is base64url on this
 * path and is only rehydrated at the two ends.
 */

export interface SerializedDescriptor {
    id: string;
    type: string;
    transports?: string[];
}

export interface SerializedCreationOptions {
    challenge: string;
    rp: { id?: string; name: string };
    user: { id: string; name: string; displayName: string };
    pubKeyCredParams: { type: string; alg: number }[];
    timeout?: number;
    excludeCredentials?: SerializedDescriptor[];
    authenticatorSelection?: {
        authenticatorAttachment?: string;
        residentKey?: string;
        requireResidentKey?: boolean;
        userVerification?: string;
    };
    attestation?: string;
}

export interface SerializedRequestOptions {
    challenge: string;
    rpId?: string;
    allowCredentials?: SerializedDescriptor[];
    userVerification?: string;
    timeout?: number;
}

export interface SerializedAttestationResponse {
    id: string;
    rawId: string;
    type: 'public-key';
    authenticatorAttachment: string;
    clientExtensionResults: Record<string, unknown>;
    response: {
        clientDataJSON: string;
        attestationObject: string;
        transports: string[];
        publicKeyAlgorithm: number;
        publicKey: string | null;
        authenticatorData: string;
    };
}

export interface SerializedAssertionResponse {
    id: string;
    rawId: string;
    type: 'public-key';
    authenticatorAttachment: string;
    clientExtensionResults: Record<string, unknown>;
    response: {
        clientDataJSON: string;
        authenticatorData: string;
        signature: string;
        userHandle: string | null;
    };
}

/** Summary shown in the consent prompt. Deliberately carries no key material. */
export interface CeremonySummary {
    rpId: string;
    rpName: string;
    userName: string;
    userDisplayName: string;
    credentialCount: number;
}

/** Names mirror the DOMException names a real authenticator throws. */
export type WebAuthnErrorName =
    | 'NotAllowedError'
    | 'InvalidStateError'
    | 'SecurityError'
    | 'NotSupportedError'
    | 'ConstraintError';

export interface WebAuthnFailure {
    errorName: WebAuthnErrorName;
    message: string;
}
