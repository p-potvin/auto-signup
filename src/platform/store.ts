/**
 * Key/value storage, on whichever platform this bundle happens to be running.
 *
 * The vault core (`crypto/`, `utils/`) was written against `chrome.storage`,
 * which is the one thing standing between it and a PWA. Everything now goes
 * through the two areas below; the extension backs them with `chrome.storage`
 * and the web build with IndexedDB.
 *
 * The `chrome.storage` shape is kept deliberately — get/set/remove over a
 * record — rather than inventing a nicer one. It is what every call site
 * already speaks, so the refactor is mechanical and nothing has to be
 * re-reviewed for a subtle change in semantics.
 */

export interface AreaStore {
    get(keys: string | string[]): Promise<Record<string, unknown>>;
    set(values: Record<string, unknown>): Promise<void>;
    remove(keys: string | string[]): Promise<void>;
}

function asArray(keys: string | string[]): string[] {
    return typeof keys === 'string' ? [keys] : keys;
}

/* ------------------------------------------------------------- extension */

declare const chrome: any;

export const isExtensionRuntime: boolean =
    typeof chrome !== 'undefined' && !!chrome?.storage?.local;

function chromeArea(area: 'local' | 'session'): AreaStore {
    return {
        get: keys => chrome.storage[area].get(keys),
        set: values => chrome.storage[area].set(values),
        remove: keys => chrome.storage[area].remove(keys),
    };
}

/* ------------------------------------------------------------------- web */

const DB_NAME = 'vaultwares';
const DB_VERSION = 1;
const OBJECT_STORE = 'kv';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
    if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = () => {
                if (!request.result.objectStoreNames.contains(OBJECT_STORE)) {
                    request.result.createObjectStore(OBJECT_STORE);
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error ?? new Error('could not open the local database'));
        });
    }
    return dbPromise;
}

function transact<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T> | null): Promise<T | undefined> {
    return openDatabase().then(db => new Promise<T | undefined>((resolve, reject) => {
        const tx = db.transaction(OBJECT_STORE, mode);
        const request = run(tx.objectStore(OBJECT_STORE));
        tx.onerror = () => reject(tx.error ?? new Error('local database transaction failed'));
        tx.onabort = () => reject(tx.error ?? new Error('local database transaction aborted'));
        // Resolving on the transaction rather than the request: a write is not
        // durable until the transaction commits, and returning early from a
        // successful request would let a caller believe a save survived a crash
        // that it would not have.
        tx.oncomplete = () => resolve(request ? request.result : undefined);
    }));
}

const indexedDbArea: AreaStore = {
    async get(keys) {
        const wanted = asArray(keys);
        const out: Record<string, unknown> = {};
        const db = await openDatabase();
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(OBJECT_STORE, 'readonly');
            const store = tx.objectStore(OBJECT_STORE);
            for (const key of wanted) {
                const request = store.get(key);
                request.onsuccess = () => {
                    // Absent keys are omitted, matching chrome.storage — call
                    // sites distinguish "never written" from "written as
                    // undefined" by key presence.
                    if (request.result !== undefined) out[key] = request.result;
                };
            }
            tx.onerror = () => reject(tx.error ?? new Error('local database read failed'));
            tx.oncomplete = () => resolve();
        });
        return out;
    },

    async set(values) {
        await transact('readwrite', store => {
            let last: IDBRequest | null = null;
            for (const [key, value] of Object.entries(values)) last = store.put(value, key);
            return last as IDBRequest<undefined> | null;
        });
    },

    async remove(keys) {
        await transact('readwrite', store => {
            let last: IDBRequest | null = null;
            for (const key of asArray(keys)) last = store.delete(key);
            return last as IDBRequest<undefined> | null;
        });
    },
};

/**
 * The web session area is memory, and only memory.
 *
 * It holds the unwrapped master key. `sessionStorage` would put that on disk
 * where the browser — and anything that can read the profile — outlives the
 * tab, and Cache Storage would survive even a closed browser. The cost is that
 * a reload asks for the master password again, which on iOS Safari is often;
 * that is what the WebAuthn unlock is for, not a reason to persist the key.
 */
function memoryArea(): AreaStore {
    const memory = new Map<string, unknown>();
    return {
        async get(keys) {
            const out: Record<string, unknown> = {};
            for (const key of asArray(keys)) {
                if (memory.has(key)) out[key] = memory.get(key);
            }
            return out;
        },
        async set(values) {
            for (const [key, value] of Object.entries(values)) memory.set(key, value);
        },
        async remove(keys) {
            for (const key of asArray(keys)) memory.delete(key);
        },
    };
}

/* --------------------------------------------------------------- exports */

export const localStore: AreaStore = isExtensionRuntime ? chromeArea('local') : indexedDbArea;
export const sessionStore: AreaStore = isExtensionRuntime ? chromeArea('session') : memoryArea();

/** Wipes every vault key this device holds. Used by lock-and-forget and by tests. */
export async function clearLocalStore(): Promise<void> {
    if (isExtensionRuntime) {
        await chrome.storage.local.clear();
        return;
    }
    await transact('readwrite', store => store.clear() as IDBRequest<undefined>);
}
