/**
 * Content-script half of the WebAuthn bridge (isolated world, document_start).
 *
 * Sits between the page script, which can be hostile, and the background, which
 * holds the keys. Its job is to refuse to be a straight pipe: it re-derives the
 * origin from its own context rather than trusting the page's claim, and it
 * makes the user approve every ceremony before the background is asked to sign
 * anything.
 */

import { PAGE_SOURCE, CONTENT_SOURCE, type PageRequest, type PageReply } from './protocol';
import { requestConsent, dismissConsent, type ConsentAccount } from './consent';
import type {
    CeremonySummary,
    SerializedAssertionResponse,
    SerializedAttestationResponse,
    SerializedCreationOptions,
    SerializedRequestOptions,
    WebAuthnFailure,
} from './types';

const DEFAULT_TIMEOUT_MS = 60_000;
const MIN_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 300_000;
const UNLOCK_POLL_MS = 700;

interface PrepareResult {
    enabled: boolean;
    locked: boolean;
    summary: CeremonySummary;
    accounts: ConsentAccount[];
}

interface BackgroundResponse<T> {
    success: boolean;
    data?: T;
    error?: string;
    errorName?: WebAuthnFailure['errorName'];
}

function sendToBackground<T>(type: string, payload: unknown): Promise<BackgroundResponse<T>> {
    return new Promise(resolve => {
        chrome.runtime.sendMessage({ type, payload }, (response: BackgroundResponse<T>) => {
            if (chrome.runtime.lastError) {
                resolve({ success: false, error: chrome.runtime.lastError.message });
                return;
            }
            resolve(response ?? { success: false, error: 'No response from VaultWares' });
        });
    });
}

function reply(message: PageReply): void {
    window.postMessage(message, window.location.origin);
}

function fail(requestId: string, errorName: WebAuthnFailure['errorName'], message: string): void {
    reply({ source: CONTENT_SOURCE, requestId, status: 'error', error: { errorName, message } });
}

function clampTimeout(requested?: number): number {
    if (!requested || Number.isNaN(requested)) return DEFAULT_TIMEOUT_MS;
    return Math.min(Math.max(requested, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

/* --------------------------------------------------------------- unlocking */

/**
 * Polls the background until the vault reports unlocked. The PIN is entered in
 * the extension's own UI; this side only ever learns the boolean.
 */
function waitForUnlock(deadline: number): Promise<boolean> {
    return new Promise(resolve => {
        const tick = async () => {
            if (Date.now() > deadline) {
                resolve(false);
                return;
            }
            const response = await sendToBackground<{ unlocked: boolean }>('GET_UNLOCKED', {});
            if (response.success && response.data?.unlocked) {
                resolve(true);
                return;
            }
            setTimeout(() => void tick(), UNLOCK_POLL_MS);
        };
        setTimeout(() => void tick(), UNLOCK_POLL_MS);
    });
}

/* --------------------------------------------------------------- ceremonies */

const inFlight = new Set<string>();

async function handleCeremony(request: PageRequest): Promise<void> {
    const { requestId, kind } = request;
    if (kind === 'abort') {
        inFlight.delete(requestId);
        dismissConsent();
        return;
    }
    if (!request.options) {
        fail(requestId, 'NotSupportedError', 'Missing publicKey options');
        return;
    }

    // The page supplies an origin in its message, but a compromised page can
    // lie about it. The content script's own location is authoritative and is
    // what gets signed into clientDataJSON.
    const origin = window.location.origin;
    const timeoutMs = clampTimeout(request.options.timeout);
    const deadline = Date.now() + timeoutMs;

    inFlight.add(requestId);

    const prepared = await sendToBackground<PrepareResult>('WEBAUTHN_PREPARE', {
        kind,
        origin,
        options: request.options,
    });

    if (!inFlight.has(requestId)) return;

    if (!prepared.success || !prepared.data) {
        fail(requestId, prepared.errorName ?? 'NotAllowedError', prepared.error ?? 'VaultWares could not start the ceremony');
        inFlight.delete(requestId);
        return;
    }

    // Passkey handling switched off in settings: give the ceremony back to the
    // browser rather than failing it.
    if (!prepared.data.enabled) {
        reply({ source: CONTENT_SOURCE, requestId, status: 'fallback' });
        inFlight.delete(requestId);
        return;
    }

    const decision = await requestConsent({
        kind,
        summary: prepared.data.summary,
        accounts: prepared.data.accounts,
        locked: prepared.data.locked,
        timeoutMs,
        onUnlockRequested: () => void sendToBackground('OPEN_VAULT_UNLOCK', {}),
        waitForUnlock: async () => {
            const unlocked = await waitForUnlock(deadline);
            if (!unlocked) return false;
            // Re-prepare: the account list was empty while locked.
            const refreshed = await sendToBackground<PrepareResult>('WEBAUTHN_PREPARE', {
                kind,
                origin,
                options: request.options,
            });
            if (refreshed.success && refreshed.data) {
                prepared.data = refreshed.data;
            }
            return true;
        },
    });

    if (!inFlight.has(requestId)) return;

    if (decision.action === 'cancel') {
        fail(requestId, 'NotAllowedError', 'The passkey request was cancelled.');
        inFlight.delete(requestId);
        return;
    }
    if (decision.action === 'fallback') {
        reply({ source: CONTENT_SOURCE, requestId, status: 'fallback' });
        inFlight.delete(requestId);
        return;
    }

    const messageType = kind === 'create' ? 'WEBAUTHN_CREATE' : 'WEBAUTHN_GET';
    const result = await sendToBackground<SerializedAttestationResponse | SerializedAssertionResponse>(
        messageType,
        {
            origin,
            options: request.options as SerializedCreationOptions & SerializedRequestOptions,
            credentialId: decision.credentialId,
        },
    );

    if (!inFlight.has(requestId)) return;
    inFlight.delete(requestId);

    if (!result.success || !result.data) {
        fail(requestId, result.errorName ?? 'NotAllowedError', result.error ?? 'VaultWares could not complete the ceremony');
        return;
    }

    reply({
        source: CONTENT_SOURCE,
        requestId,
        status: 'ok',
        result: result.data as never,
    });
}

window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window) return;
    const data = event.data as PageRequest | undefined;
    if (!data || data.source !== PAGE_SOURCE) return;
    if (typeof data.requestId !== 'string') return;

    void handleCeremony(data).catch(error => {
        inFlight.delete(data.requestId);
        dismissConsent();
        fail(data.requestId, 'NotAllowedError', (error as Error).message);
    });
});
