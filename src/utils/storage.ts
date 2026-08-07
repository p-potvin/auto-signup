import type { EncryptedVaultItem, VaultSettings } from '../types';
import { DEFAULT_SETTINGS } from '../types';
import { localStore } from '../platform/store';

const VAULT_ITEMS_KEY = 'vw_vault_items';
const SETTINGS_KEY = 'vw_settings';
const SYNC_CURSOR_KEY = 'vw_sync_cursor';

/** The loopback default shipped before vault-warden moved to greencloud. */
const RETIRED_SYNC_URLS = ['http://127.0.0.1:9444/v1', 'http://localhost:9444/v1'];

export async function getEncryptedItems(): Promise<EncryptedVaultItem[]> {
    const result = await localStore.get(VAULT_ITEMS_KEY);
    return (result[VAULT_ITEMS_KEY] as EncryptedVaultItem[]) ?? [];
}

export async function saveEncryptedItem(item: EncryptedVaultItem): Promise<void> {
    const items = await getEncryptedItems();
    const idx = items.findIndex(i => i.id === item.id);
    if (idx >= 0) {
        items[idx] = item;
    } else {
        items.push(item);
    }
    await localStore.set({ [VAULT_ITEMS_KEY]: items });
}

export async function deleteEncryptedItem(id: string): Promise<void> {
    const items = await getEncryptedItems();
    const filtered = items.filter(i => i.id !== id);
    await localStore.set({ [VAULT_ITEMS_KEY]: filtered });
}

export async function getSettings(): Promise<VaultSettings> {
    const result = await localStore.get(SETTINGS_KEY);
    const stored = result[SETTINGS_KEY] as Partial<VaultSettings> | undefined;
    // Merged rather than returned as-is: a settings blob written by an older
    // version has no key for a newly added setting, and a missing boolean would
    // read as `false` and silently disable the feature it gates.
    const settings = { ...DEFAULT_SETTINGS, ...(stored ?? {}) };

    // A stored value beats the default, which is right for a setting the user
    // chose and wrong for one they never touched. Nothing listens on
    // 127.0.0.1:9444 on a workstation, so an install carrying the old default
    // would silently fail to sync and read as "vault-warden is down".
    if (RETIRED_SYNC_URLS.includes(settings.syncServerUrl)) {
        settings.syncServerUrl = DEFAULT_SETTINGS.syncServerUrl;
    }
    return settings;
}

export async function saveSettings(settings: VaultSettings): Promise<void> {
    await localStore.set({ [SETTINGS_KEY]: settings });
}

export async function getSyncCursor(): Promise<string | null> {
    const result = await localStore.get(SYNC_CURSOR_KEY);
    return (result[SYNC_CURSOR_KEY] as string) ?? null;
}

export async function setSyncCursor(cursor: string): Promise<void> {
    await localStore.set({ [SYNC_CURSOR_KEY]: cursor });
}

export async function replaceAllEncryptedItems(items: EncryptedVaultItem[]): Promise<void> {
    await localStore.set({ [VAULT_ITEMS_KEY]: items });
}
