/**
 * HTTP client for the vault-warden this account syncs to.
 *
 * Deliberately not the cloud api.vaultwares.ca client in `client.ts`: vault sync
 * goes to vault-warden, which is tailnet-only.
 *
 * Authentication is the tailnet. vault-warden binds identity with
 * `tailscale whois` on the source address, so any device already on the tailnet
 * is already authenticated and there is nothing for the user to copy onto a
 * phone. `X-VW-Local-Token` is the separate machine-automation path and is only
 * ever sent to a loopback address — see the guard below.
 */
import { getSettings } from '../utils/storage';

/**
 * greencloud over the tailnet, not this machine.
 *
 * There is no vault-warden on a workstation; the service runs on greencloud
 * (nginx on `warden.vaultwares.ca` in front of `127.0.0.1:9444`), which is
 * always on, so the phone does not lose the vault when the desktop sleeps.
 * Pointing here by default also means the extension and the PWA arrive as the
 * same tailnet user and therefore land on the same identity vault.
 */
export const DEFAULT_SYNC_BASE = 'https://warden.vaultwares.ca/v1';

/**
 * Whether `base` is this machine.
 *
 * The local token is a shared secret for machine automation on the VPS. Sending
 * it to a remote vault-warden hands it to whatever terminates that connection,
 * and — before the server-side fix — was answered as the synthetic *local* user
 * rather than the tailnet one, quietly putting this device on a different
 * account from every other. It never leaves the loopback interface now.
 */
function isLoopbackBase(base: string): boolean {
    try {
        const { hostname } = new URL(base);
        return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
    } catch {
        // An unparseable base is about to fail the fetch anyway; treat it as
        // remote so a typo cannot leak the token.
        return false;
    }
}

export async function localFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
    const settings = await getSettings();
    const base = (settings.syncServerUrl || DEFAULT_SYNC_BASE).replace(/\/$/, '');

    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(options.headers as Record<string, string>),
    };
    if (settings.syncLocalToken && isLoopbackBase(base)) {
        headers['X-VW-Local-Token'] = settings.syncLocalToken;
    }

    let resp: Response;
    try {
        resp = await fetch(`${base}${path}`, { ...options, headers });
    } catch (e) {
        throw new Error(`cannot reach vault-warden at ${base} (on the tailnet?): ${(e as Error).message}`);
    }

    if (!resp.ok) {
        let detail = `HTTP ${resp.status}`;
        try {
            const body = await resp.json();
            detail = body.detail ?? body.error ?? detail;
        } catch {
            // non-JSON error body
        }
        throw new Error(`vault-warden ${path} failed: ${detail}`);
    }

    return resp.json() as Promise<T>;
}
