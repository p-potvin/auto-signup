/**
 * vault-warden client for the account key and the portable keychain.
 *
 * Scope is deliberately narrow: this is what a *new device* needs to bootstrap
 * itself, and nothing else. Item sync keeps using `api/sync.ts`.
 *
 * Authentication is the tailnet itself — vault-warden binds identity with
 * `tailscale whois`, so a device that is on the tailnet is already
 * authenticated and there is no token for the user to copy onto a phone. The
 * local token header is only for loopback calls.
 */

import { localFetch } from './local-client';
import type { AccountKeyBlob } from '../crypto/account-key';

/**
 * Name of the item holding the sealed keychain.
 *
 * For user-mode vaults vault-warden treats `name` as an opaque client blob, so
 * a fixed literal is safe to use as a lookup key — the client chooses what goes
 * there. It leaks only that this account uses the extension, which having an
 * `identity` vault already reveals.
 */
export const KEYCHAIN_ITEM_NAME = 'vw:keychain:v1';

export interface WardenVault {
    id: number;
    kind: 'personal' | 'identity' | 'org_machine';
}

interface WardenItemSummary {
    id: number;
    kind: string;
    name: string;
    mode: 'user' | 'server';
    updated_at: string;
}

/* ------------------------------------------------------------- identity */

export interface WardenWhoami {
    login: string;
    display_name: string;
    node: string;
    is_local: boolean;
    enrolled: boolean;
}

/**
 * The tailnet identity this device resolves to.
 *
 * Worth showing on an unlock screen for its own sake, and required by iOS:
 * Password AutoFill will not reliably offer a saved credential back to a form
 * that is a lone password box, so the unlock form needs a real username to
 * associate with this origin.
 */
export async function fetchWhoami(): Promise<WardenWhoami> {
    return localFetch<WardenWhoami>('/whoami');
}

/* ---------------------------------------------------------- account key */

/** Returns null when no key is enrolled yet (vault-warden answers 404). */
export async function fetchAccountKey(): Promise<AccountKeyBlob | null> {
    try {
        return await localFetch<AccountKeyBlob>('/account/key');
    } catch (e) {
        if (/404|no key enrolled/i.test((e as Error).message)) return null;
        throw e;
    }
}

export async function putAccountKey(blob: AccountKeyBlob): Promise<void> {
    await localFetch('/account/key', {
        method: 'PUT',
        body: JSON.stringify(blob),
    });
}

/* -------------------------------------------------------------- vaults */

export async function listVaults(): Promise<WardenVault[]> {
    const response = await localFetch<{ vaults: WardenVault[] }>('/vaults');
    return response.vaults ?? [];
}

/**
 * The per-user vault the extension owns.
 *
 * vault-warden keeps this separate from `personal` on purpose: `identity` holds
 * the extension's own envelopes rather than items encrypted under the account
 * key directly.
 */
export async function getIdentityVaultId(): Promise<number> {
    const vaults = await listVaults();
    const identity = vaults.find(v => v.kind === 'identity');
    if (!identity) {
        throw new Error('vault-warden returned no identity vault for this user');
    }
    return identity.id;
}

/* --------------------------------------------------- portable keychain */

async function findKeychainItem(vaultId: number): Promise<WardenItemSummary | null> {
    const response = await localFetch<{ items: WardenItemSummary[] }>(`/vaults/${vaultId}/items`);
    const matches = (response.items ?? []).filter(i => i.name === KEYCHAIN_ITEM_NAME);
    if (matches.length === 0) return null;
    // There is no update endpoint, so a re-upload leaves the old row behind.
    // The newest id wins.
    return matches.reduce((newest, item) => (item.id > newest.id ? item : newest));
}

export async function fetchSealedKeychain(vaultId: number): Promise<string | null> {
    const summary = await findKeychainItem(vaultId);
    if (!summary) return null;

    const item = await localFetch<{ cipher?: string }>(`/vaults/${vaultId}/items/${summary.id}`);
    return item.cipher ?? null;
}

/**
 * Stores the sealed keychain, replacing any previous copy.
 *
 * Written before the old one is deleted: if the delete fails the account still
 * has a usable keychain, whereas the reverse order can leave a device unable to
 * bootstrap.
 */
export async function putSealedKeychain(vaultId: number, sealed: string): Promise<void> {
    const previous = await findKeychainItem(vaultId);

    await localFetch(`/vaults/${vaultId}/items`, {
        method: 'POST',
        body: JSON.stringify({
            kind: 'note',
            name: KEYCHAIN_ITEM_NAME,
            cipher: sealed,
        }),
    });

    if (previous) {
        try {
            await localFetch(`/vaults/${vaultId}/items/${previous.id}`, { method: 'DELETE' });
        } catch (e) {
            // Not fatal: findKeychainItem takes the newest id, so a leftover row
            // is inert. Worth knowing about, not worth failing enrollment over.
            console.warn('Could not remove the previous keychain blob:', (e as Error).message);
        }
    }
}

/** Cheap check used by the UI before offering enrollment. */
export async function isWardenReachable(): Promise<boolean> {
    try {
        await listVaults();
        return true;
    } catch {
        return false;
    }
}
