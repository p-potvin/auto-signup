import React, { useCallback, useEffect, useState } from 'react';
import { Smartphone, AlertCircle, Check, Loader2, Lock, Eye, EyeOff } from 'lucide-react';
import { describeEnrollment, type EnrollmentState } from '../crypto/enrollment';
import { MIN_MASTER_PASSWORD_LENGTH } from '../crypto/account-key';

/**
 * Setting a master password so other devices can open this vault.
 *
 * The distinction this screen has to land is why there are now two secrets. The
 * PIN never leaves the browser and stays as the quick unlock. The master
 * password wraps the copy of the key that vault-warden holds, which is the only
 * thing a phone can start from — and because that copy is reachable by anything
 * on the tailnet, it has to survive offline attack in a way a four-digit PIN
 * cannot.
 */
export function EnrollPanel({ unlocked }: { unlocked: boolean }) {
    const [state, setState] = useState<EnrollmentState | null>(null);
    const [reachable, setReachable] = useState(true);
    const [password, setPassword] = useState('');
    const [confirmation, setConfirmation] = useState('');
    const [reveal, setReveal] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [done, setDone] = useState(false);

    const load = useCallback(async () => {
        const response = await chrome.runtime.sendMessage({ type: 'GET_ENROLLMENT_STATE' }) as
            { success: boolean; data?: EnrollmentState; reachable?: boolean };
        if (response?.success && response.data) {
            setState(response.data);
            setReachable(response.reachable !== false);
        }
    }, []);

    useEffect(() => { void load(); }, [load]);

    const enroll = async () => {
        setError('');
        setBusy(true);
        const response = await chrome.runtime.sendMessage({
            type: 'ENROLL_MASTER_PASSWORD',
            payload: { password, confirmation },
        }) as { success: boolean; error?: string };
        setBusy(false);

        if (!response?.success) {
            setError(response?.error ?? 'Enrollment failed');
            return;
        }
        setPassword('');
        setConfirmation('');
        setDone(true);
        await load();
    };

    if (!state) {
        return (
            <div className="vw-card p-5 flex items-center gap-2 text-xs text-vw-console-text-secondary">
                <Loader2 className="w-4 h-4 animate-spin" /> Checking device status…
            </div>
        );
    }

    const tooShort = password.length > 0 && password.length < MIN_MASTER_PASSWORD_LENGTH;
    const mismatch = confirmation.length > 0 && password !== confirmation;

    return (
        <div className="vw-card p-5">
            <div className="flex items-center gap-2 mb-1">
                <Smartphone className="w-4 h-4 text-vw-gold" />
                <h3 className="text-sm font-semibold text-white">Other devices</h3>
            </div>
            <p className="text-xs text-vw-console-text-secondary mb-4">{describeEnrollment(state)}</p>

            {!reachable && (
                <div className="flex items-start gap-2 mb-4 px-3 py-2 rounded-lg border border-vw-console-border bg-vw-console-surface text-xs text-vw-signal-warning">
                    <AlertCircle className="w-4 h-4 flex-shrink-0 mt-px" />
                    <span>
                        vault-warden is unreachable, so this shows local state only. Check the
                        sync server address in Settings and that the host is on your tailnet.
                    </span>
                </div>
            )}

            {state.status === 'enrolled' && (
                <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-vw-signal-online/40 bg-vw-signal-online/10 text-xs text-vw-signal-online">
                    <Check className="w-4 h-4 flex-shrink-0 mt-px" />
                    <span>
                        On another device, open the vault and choose “I already have a master
                        password”. Your PIN stays local to this browser.
                    </span>
                </div>
            )}

            {state.status === 'local-only' && (
                <>
                    {!unlocked && (
                        <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-vw-console-border bg-vw-console-surface text-xs text-vw-console-text-secondary">
                            <Lock className="w-4 h-4 flex-shrink-0" />
                            <span>Unlock the vault first — the key being wrapped only exists while it is open.</span>
                        </div>
                    )}

                    {unlocked && (
                        <div className="space-y-3">
                            <div>
                                <label className="block text-xs font-medium text-vw-console-text-secondary mb-1.5">
                                    Master password
                                </label>
                                <div className="flex gap-2">
                                    <input
                                        type={reveal ? 'text' : 'password'}
                                        value={password}
                                        onChange={(e) => { setPassword(e.target.value); setError(''); }}
                                        placeholder={`At least ${MIN_MASTER_PASSWORD_LENGTH} characters`}
                                        className="w-full px-3 py-2 bg-vw-console-surface border border-vw-console-border rounded-lg text-sm text-white focus:outline-none focus:border-vw-gold"
                                    />
                                    <button
                                        onClick={() => setReveal(!reveal)}
                                        className="px-3 bg-vw-console-surface border border-vw-console-border rounded-lg text-vw-console-text-secondary hover:text-white"
                                    >
                                        {reveal ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                    </button>
                                </div>
                                {tooShort && (
                                    <p className="text-[11px] text-vw-signal-warning mt-1">
                                        {password.length}/{MIN_MASTER_PASSWORD_LENGTH} characters
                                    </p>
                                )}
                            </div>

                            <div>
                                <label className="block text-xs font-medium text-vw-console-text-secondary mb-1.5">
                                    Confirm
                                </label>
                                <input
                                    type={reveal ? 'text' : 'password'}
                                    value={confirmation}
                                    onChange={(e) => { setConfirmation(e.target.value); setError(''); }}
                                    className="w-full px-3 py-2 bg-vw-console-surface border border-vw-console-border rounded-lg text-sm text-white focus:outline-none focus:border-vw-gold"
                                />
                                {mismatch && (
                                    <p className="text-[11px] text-vw-signal-warning mt-1">The two entries do not match.</p>
                                )}
                            </div>

                            <p className="text-[11px] text-vw-console-text-secondary/70 leading-relaxed">
                                Your items are not re-encrypted — this wraps the existing key, so
                                nothing in the vault changes and a later password change will not
                                touch them either. There is no recovery if you forget it.
                            </p>

                            {error && (
                                <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-vw-signal-alert/40 bg-vw-signal-alert/10 text-xs text-vw-signal-alert">
                                    <AlertCircle className="w-4 h-4 flex-shrink-0 mt-px" />
                                    <span>{error}</span>
                                </div>
                            )}

                            <button
                                onClick={enroll}
                                disabled={busy || password.length < MIN_MASTER_PASSWORD_LENGTH || password !== confirmation}
                                className="w-full py-2.5 bg-vw-gold text-vw-console-bg rounded-lg text-sm font-medium hover:bg-[#C69431] disabled:opacity-50 flex items-center justify-center gap-2"
                            >
                                {busy
                                    ? <><Loader2 className="w-4 h-4 animate-spin" /> Enrolling…</>
                                    : 'Set master password'}
                            </button>
                        </div>
                    )}
                </>
            )}

            {state.status === 'remote-available' && (
                <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-vw-console-border bg-vw-console-surface text-xs text-vw-console-text-secondary">
                    <AlertCircle className="w-4 h-4 flex-shrink-0 mt-px" />
                    <span>
                        This account is already enrolled elsewhere. Bring this browser online from
                        the unlock screen rather than setting a new password here, which would
                        strand the other devices.
                    </span>
                </div>
            )}

            {done && state.status === 'enrolled' && (
                <p className="text-[11px] text-vw-signal-online mt-3">Master password set.</p>
            )}
        </div>
    );
}
