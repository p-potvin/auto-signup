import type { EncryptedVaultItem, VaultItem, VaultSettings } from '../types';
import { DEFAULT_SETTINGS } from '../types';

const VAULT_ITEMS_KEY = 'vw_vault_items';
const SETTINGS_KEY = 'vw_settings';
const SYNC_CURSOR_KEY = 'vw_sync_cursor';

export async function getEncryptedItems(): Promise<EncryptedVaultItem[]> {
    const result = await chrome.storage.local.get(VAULT_ITEMS_KEY) as Record<string, any>;
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
    await chrome.storage.local.set({ [VAULT_ITEMS_KEY]: items });
}

export async function deleteEncryptedItem(id: string): Promise<void> {
    const items = await getEncryptedItems();
    const filtered = items.filter(i => i.id !== id);
    await chrome.storage.local.set({ [VAULT_ITEMS_KEY]: filtered });
}

export async function getSettings(): Promise<VaultSettings> {
    const result = await chrome.storage.local.get(SETTINGS_KEY) as Record<string, any>;
    const stored = result[SETTINGS_KEY] as Partial<VaultSettings> | undefined;
    // Merged rather than returned as-is: a settings blob written by an older
    // version has no key for a newly added setting, and a missing boolean would
    // read as `false` and silently disable the feature it gates.
    return { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
}

export async function saveSettings(settings: VaultSettings): Promise<void> {
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

export async function getSyncCursor(): Promise<string | null> {
    const result = await chrome.storage.local.get(SYNC_CURSOR_KEY) as Record<string, any>;
    return (result[SYNC_CURSOR_KEY] as string) ?? null;
}

export async function setSyncCursor(cursor: string): Promise<void> {
    await chrome.storage.local.set({ [SYNC_CURSOR_KEY]: cursor });
}

export async function replaceAllEncryptedItems(items: EncryptedVaultItem[]): Promise<void> {
    await chrome.storage.local.set({ [VAULT_ITEMS_KEY]: items });
}
