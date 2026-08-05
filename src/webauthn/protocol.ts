/**
 * The message contract between the injected page script and the content
 * script. Kept in its own module so both worlds compile against one definition
 * and a rename cannot silently break the bridge.
 */

import type {
    SerializedCreationOptions,
    SerializedRequestOptions,
    SerializedAttestationResponse,
    SerializedAssertionResponse,
    WebAuthnFailure,
} from './types';

export const PAGE_SOURCE = 'vw-webauthn-page';
export const CONTENT_SOURCE = 'vw-webauthn-content';

export interface PageRequest {
    source: typeof PAGE_SOURCE;
    requestId: string;
    kind: 'create' | 'get' | 'abort';
    origin: string;
    options?: SerializedCreationOptions | SerializedRequestOptions;
}

export type PageReply =
    | {
        source: typeof CONTENT_SOURCE;
        requestId: string;
        status: 'ok';
        result: SerializedAttestationResponse | SerializedAssertionResponse;
    }
    | {
        source: typeof CONTENT_SOURCE;
        requestId: string;
        status: 'error';
        error: WebAuthnFailure;
    }
    /** The user chose their browser/security key instead of the vault. */
    | {
        source: typeof CONTENT_SOURCE;
        requestId: string;
        status: 'fallback';
    };
