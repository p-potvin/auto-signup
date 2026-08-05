/**
 * Unlocks the vault as soon as the entered PIN is correct, without a button
 * press.
 *
 * The trade-off, stated plainly: it lets someone at the keyboard confirm a
 * guess a fraction of a second sooner. It changes nothing for an attacker with
 * filesystem access, who takes the wrapped blob and brute-forces Argon2id
 * offline at whatever rate their hardware allows — a rate this UI does not
 * influence. Against that, having to press Enter after every auto-lock is the
 * kind of friction that makes people stop using a password manager.
 *
 * Two constraints shape the implementation. Argon2id here is t=3, m=64MiB, so
 * an attempt is expensive and they must not pile up: entries are debounced and
 * strictly serialized. And a wrong-so-far PIN is not an error — it is someone
 * halfway through typing — so failures are silent until an explicit submit.
 */

import { useEffect, useRef, useState } from 'react';

interface AutoUnlockOptions {
    /** Only run while the vault is actually locked and ready for a PIN. */
    enabled: boolean;
    pin: string;
    onUnlocked: () => void;
    /** Below this length an attempt is not worth 64MiB of hashing. */
    minLength?: number;
    debounceMs?: number;
}

type UnlockResponse = { success: boolean; error?: string };

export function useAutoUnlock({
    enabled,
    pin,
    onUnlocked,
    minLength = 4,
    debounceMs = 300,
}: AutoUnlockOptions): { checking: boolean } {
    const [checking, setChecking] = useState(false);

    // Serializes attempts: each waits on the previous so two Argon2id
    // derivations never run at once.
    const inFlight = useRef<Promise<unknown>>(Promise.resolve());
    // Attempts already made, so backspacing to a previously wrong PIN does not
    // re-derive it.
    const attempted = useRef<Set<string>>(new Set());
    const latestPin = useRef(pin);
    const onUnlockedRef = useRef(onUnlocked);

    latestPin.current = pin;
    onUnlockedRef.current = onUnlocked;

    useEffect(() => {
        if (!enabled) {
            attempted.current.clear();
            return;
        }
        if (pin.length < minLength || attempted.current.has(pin)) return;

        const timer = setTimeout(() => {
            const candidate = pin;
            attempted.current.add(candidate);

            inFlight.current = inFlight.current
                .then(async () => {
                    // The user may have kept typing while we queued.
                    if (latestPin.current !== candidate) return;

                    setChecking(true);
                    try {
                        const response = await chrome.runtime.sendMessage({
                            type: 'UNLOCK',
                            payload: { pin: candidate },
                        }) as UnlockResponse | undefined;

                        if (response?.success) {
                            attempted.current.clear();
                            onUnlockedRef.current();
                        }
                        // A failure here is just an incomplete PIN. Reporting it
                        // would flash "Invalid PIN" on every keystroke.
                    } catch (e) {
                        console.warn('Auto-unlock attempt failed:', (e as Error).message);
                    } finally {
                        setChecking(false);
                    }
                });
        }, debounceMs);

        return () => clearTimeout(timer);
    }, [enabled, pin, minLength, debounceMs]);

    return { checking };
}
