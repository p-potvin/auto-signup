import { getEncryptedItems, getSyncCursor, setSyncCursor, replaceAllEncryptedItems } from '../utils/storage';
import { pushChanges, pullChanges } from '../api/sync';
import type { EncryptedVaultItem } from '../types';
import { localStore } from '../platform/store';

const QUEUE_KEY = 'vw_sync_queue';

interface QueueEntry {
    id: string;
    operation: 'create' | 'update' | 'delete';
    itemId: string;
    envelope?: any;
    attempts: number;
    createdAt: string;
}

async function getQueue(): Promise<QueueEntry[]> {
    const result = await localStore.get(QUEUE_KEY);
    return (result[QUEUE_KEY] as QueueEntry[]) ?? [];
}

async function saveQueue(queue: QueueEntry[]): Promise<void> {
    await localStore.set({ [QUEUE_KEY]: queue });
}

export async function enqueueCreate(item: EncryptedVaultItem): Promise<void> {
    const queue = await getQueue();
    queue.push({
        id: crypto.randomUUID(),
        operation: 'create',
        itemId: item.id,
        envelope: item.envelope,
        attempts: 0,
        createdAt: new Date().toISOString(),
    });
    await saveQueue(queue);
}

export async function enqueueUpdate(item: EncryptedVaultItem): Promise<void> {
    const queue = await getQueue();
    const existing = queue.find(q => q.itemId === item.id && q.operation === 'create');
    if (existing) {
        existing.envelope = item.envelope;
        await saveQueue(queue);
        return;
    }
    queue.push({
        id: crypto.randomUUID(),
        operation: 'update',
        itemId: item.id,
        envelope: item.envelope,
        attempts: 0,
        createdAt: new Date().toISOString(),
    });
    await saveQueue(queue);
}

export async function enqueueDelete(itemId: string): Promise<void> {
    const queue = await getQueue();
    const filtered = queue.filter(q => q.itemId !== itemId && q.operation !== 'delete');
    filtered.push({
        id: crypto.randomUUID(),
        operation: 'delete',
        itemId,
        attempts: 0,
        createdAt: new Date().toISOString(),
    });
    await saveQueue(filtered);
}

let processing = false;

// A deletion propagated to the server. Deleted items are removed from local
// storage, so we carry an explicit tombstone (no envelope) in the push batch.
export interface SyncTombstone {
    id: string;
    envelope: null;
    deletedAt: string;
}

export async function processQueue(): Promise<{ processed: number; failed: number }> {
    if (processing) return { processed: 0, failed: 0 };
    processing = true;

    try {
        const queue = await getQueue();
        // The local endpoints speak the batch push/pull protocol rather than
        // per-item CRUD, so a single fullSync covers all queued work. Queued
        // deletes become tombstones; everything else is captured by pushing the
        // current local item set.
        const tombstones: SyncTombstone[] = queue
            .filter(q => q.operation === 'delete')
            .map(q => ({ id: q.itemId, envelope: null, deletedAt: new Date().toISOString() }));

        const result = await fullSync(tombstones);
        if (result.ok) {
            await saveQueue([]);
            return { processed: queue.length, failed: 0 };
        }
        // Leave the queue in place; startAutoSync retries on its interval.
        return { processed: 0, failed: queue.length };
    } finally {
        processing = false;
    }
}

export async function fullSync(
    extraDeletes: SyncTombstone[] = [],
): Promise<{ pushed: number; pulled: number; ok: boolean }> {
    try {
        const localItems = await getEncryptedItems();
        const cursor = await getSyncCursor();

        const pushPayload = [...localItems, ...extraDeletes];
        const pushResp = await pushChanges(pushPayload, cursor);
        await setSyncCursor(pushResp.cursor);

        const pullResp = await pullChanges(pushResp.cursor);
        await setSyncCursor(pullResp.cursor);

        const merged = [...localItems];
        for (const remoteItem of pullResp.items) {
            const idx = merged.findIndex(i => i.id === remoteItem.id);
            if (remoteItem.deletedAt) {
                // Remote tombstone wins — drop it locally.
                if (idx >= 0) merged.splice(idx, 1);
                continue;
            }
            if (idx >= 0) {
                const remoteUpdated = new Date(remoteItem.envelope.updatedAt).getTime();
                const localUpdated = new Date(merged[idx].envelope.updatedAt).getTime();
                if (remoteUpdated > localUpdated) {
                    merged[idx] = remoteItem;
                }
            } else {
                merged.push(remoteItem);
            }
        }

        await replaceAllEncryptedItems(merged);
        return { pushed: pushPayload.length, pulled: pullResp.items.length, ok: true };
    } catch (e) {
        console.warn('Full sync failed:', e);
        return { pushed: 0, pulled: 0, ok: false };
    }
}

let syncTimer: ReturnType<typeof setInterval> | null = null;

export function startAutoSync(intervalMs: number = 60000): void {
    if (syncTimer) clearInterval(syncTimer);
    processQueue();
    syncTimer = setInterval(() => processQueue(), intervalMs);
}

export function stopAutoSync(): void {
    if (syncTimer) {
        clearInterval(syncTimer);
        syncTimer = null;
    }
}
