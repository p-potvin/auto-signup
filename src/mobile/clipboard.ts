/**
 * Copying secrets on a phone, and taking them back afterwards.
 *
 * Copy-paste is the whole interaction model here: iOS reserves real autofill
 * for `ASCredentialProviderExtension`, which needs Xcode and a developer
 * account, so a PWA cannot have it. That makes the clipboard the most exposed
 * place a password will sit, and worth clearing.
 */

/**
 * How long a copied secret stays on the clipboard.
 *
 * Two minutes rather than thirty seconds: pasting on a phone means leaving this
 * app, and a password that evaporates while you are still finding the field is
 * worse than useless — you go back and copy it again, so the secret spends
 * *more* time on the clipboard, not less.
 */
const CLEAR_AFTER_MS = 120_000;

export type ClipboardState =
    | { status: 'idle' }
    | { status: 'copied'; label: string; secondsLeft: number }
    | { status: 'cleared' }
    /** The clear was attempted and refused. Said out loud rather than assumed. */
    | { status: 'clear-failed'; detail: string };

let timer: ReturnType<typeof setInterval> | null = null;

export function cancelPendingClear(): void {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
}

/**
 * Copies `value` and starts a countdown to wipe it.
 *
 * The clear is genuinely best-effort. Safari only allows a clipboard write from
 * a user gesture, and a write fired by a timer thirty seconds later is not one —
 * so it can be refused, and when it is, `onState` says so instead of leaving the
 * user believing a password has been taken back that has not.
 */
export async function copySecret(
    value: string,
    label: string,
    onState: (state: ClipboardState) => void,
): Promise<void> {
    cancelPendingClear();

    try {
        await navigator.clipboard.writeText(value);
    } catch (e) {
        onState({ status: 'clear-failed', detail: `could not copy: ${(e as Error).message}` });
        return;
    }

    let secondsLeft = Math.round(CLEAR_AFTER_MS / 1000);
    onState({ status: 'copied', label, secondsLeft });

    timer = setInterval(() => {
        secondsLeft -= 1;
        if (secondsLeft > 0) {
            onState({ status: 'copied', label, secondsLeft });
            return;
        }

        cancelPendingClear();
        navigator.clipboard.writeText('').then(
            () => onState({ status: 'cleared' }),
            (e: Error) => onState({
                status: 'clear-failed',
                detail: `the clipboard still holds ${label} — ${e.message}`,
            }),
        );
    }, 1000);
}
