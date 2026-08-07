/**
 * The mobile vault.
 *
 * Read-only on purpose for now: unlock, find, copy. Editing from a phone means
 * re-sealing envelopes and pushing them, and getting that wrong on the device
 * least able to recover is not worth the convenience yet.
 *
 * What this cannot do, and no PWA can: fill a password into another app. iOS
 * gives that only to `ASCredentialProviderExtension`, which requires Xcode and a
 * paid developer account. The design answer is to make copying fast rather than
 * to imply parity.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    Search, Lock, Copy, Check, ChevronLeft, ShieldAlert, WifiOff,
    Eye, EyeOff, KeyRound, RefreshCw, Share, Plus,
} from 'lucide-react';
import type { VaultItem, LoginItem, CardItem, AddressItem, TotpItem, PasskeyItem } from '../types';
import { loginIdentifier } from '../types';
import { getInitials } from '../utils/domain';
import { generateTotpCode, getTotpRemainingSeconds } from '../utils/totp';
import { probeAccount, deriveMasterKey, openVault, searchItems, type AccountState, type UnlockedVault } from './session';
import { copySecret, cancelPendingClear, type ClipboardState } from './clipboard';

/* ------------------------------------------------------------------ chrome */

function StatusBanner({ state, onDismiss }: { state: ClipboardState; onDismiss: () => void }) {
    if (state.status === 'idle') return null;

    const tone = state.status === 'clear-failed' ? 'warn' : 'ok';
    const text =
        state.status === 'copied' ? `${state.label} copied — clearing in ${state.secondsLeft}s`
        : state.status === 'cleared' ? 'Clipboard cleared'
        : state.detail;

    return (
        <div className={`vw-toast vw-toast-${tone}`} role="status" onClick={onDismiss}>
            {state.status === 'clear-failed' ? <ShieldAlert size={16} /> : <Check size={16} />}
            <span>{text}</span>
        </div>
    );
}

/**
 * Prompt to install, but only where it changes an outcome.
 *
 * Safari evicts IndexedDB after roughly seven days without a visit for sites
 * that are not on the Home Screen. Nothing is lost permanently — the vault can
 * always be rebuilt from the server with the master password — but a vault that
 * empties itself looks like data loss, so it is worth one line of nagging.
 */
function InstallHint() {
    const standalone = useMemo(
        () => window.matchMedia('(display-mode: standalone)').matches
            || (window.navigator as unknown as { standalone?: boolean }).standalone === true,
        [],
    );
    const [dismissed, setDismissed] = useState(() => localStorage.getItem('vw_install_hint') === 'off');

    if (standalone || dismissed) return null;

    return (
        <div className="vw-install-hint">
            <p>
                Add this to your Home Screen — tap <Share size={14} aria-label="Share" /> then
                {' '}<Plus size={14} aria-label="Add" /> <strong>Add to Home Screen</strong>.
                Safari clears the offline copy after about a week otherwise.
            </p>
            <button
                type="button"
                onClick={() => { localStorage.setItem('vw_install_hint', 'off'); setDismissed(true); }}
            >
                Don&apos;t show again
            </button>
        </div>
    );
}

/* ------------------------------------------------------------------ unlock */

function UnlockScreen({
    account,
    onUnlocked,
    onRetryProbe,
}: {
    account: AccountState;
    onUnlocked: (masterKey: Uint8Array, vault: UnlockedVault) => void;
    onRetryProbe: () => void;
}) {
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    if (account.status === 'unreachable') {
        return (
            <div className="vw-gate">
                <WifiOff size={40} />
                <h1>Can&apos;t reach the vault</h1>
                <p>
                    vault-warden answers only on the tailnet. Check that Tailscale is
                    connected on this phone, then try again.
                </p>
                <p className="vw-detail">{account.detail}</p>
                <button type="button" className="vw-primary" onClick={onRetryProbe}>
                    <RefreshCw size={16} /> Try again
                </button>
            </div>
        );
    }

    if (account.status === 'not-enrolled') {
        return (
            <div className="vw-gate">
                <KeyRound size={40} />
                <h1>No master password yet</h1>
                <p>
                    This phone opens the vault with a master password, and none has been set.
                    Open the extension on your computer and finish enrollment there first —
                    it is the only device that currently holds the keys.
                </p>
                <button type="button" className="vw-primary" onClick={onRetryProbe}>
                    <RefreshCw size={16} /> Check again
                </button>
            </div>
        );
    }

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (busy || !password) return;
        setBusy(true);
        setError(null);

        // Yield a frame first: Argon2id at 64 MiB blocks the main thread for a
        // second or two on a phone, and without this the button never gets to
        // paint its busy state.
        await new Promise(resolve => setTimeout(resolve, 16));

        try {
            const masterKey = deriveMasterKey(account.accountKey, password);
            if (!masterKey) {
                setError('That password does not open this vault.');
                return;
            }
            const vault = await openVault(account.identityVaultId, masterKey);
            setPassword('');
            onUnlocked(masterKey, vault);
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setBusy(false);
        }
    };

    return (
        <form className="vw-gate" onSubmit={submit}>
            <Lock size={40} />
            <h1>VaultWares</h1>
            <p>Enter your master password.</p>
            <input
                type="password"
                inputMode="text"
                autoComplete="current-password"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="Master password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                disabled={busy}
                // eslint-disable-next-line jsx-a11y/no-autofocus
                autoFocus
            />
            {error && <p className="vw-error" role="alert">{error}</p>}
            <button type="submit" className="vw-primary" disabled={busy || !password}>
                {busy ? 'Deriving key…' : 'Unlock'}
            </button>
            <p className="vw-detail">
                Argon2id runs on this phone; the password never leaves it.
            </p>
        </form>
    );
}

/* -------------------------------------------------------------- item views */

function itemSubtitle(item: VaultItem): string {
    switch (item.itemType) {
        case 'login': return loginIdentifier(item.data as LoginItem);
        case 'card': {
            const card = item.data as CardItem;
            return `•••• ${card.cardNumber.slice(-4)}`;
        }
        case 'address': return (item.data as AddressItem).city;
        case 'totp': return (item.data as TotpItem).issuer ?? 'Authenticator';
        case 'passkey': return (item.data as PasskeyItem).rpId;
        default: return '';
    }
}

function CopyRow({
    label,
    value,
    secret = false,
    onCopy,
}: {
    label: string;
    value: string;
    secret?: boolean;
    onCopy: (value: string, label: string) => void;
}) {
    const [revealed, setRevealed] = useState(false);
    if (!value) return null;

    return (
        <div className="vw-row">
            <div className="vw-row-text">
                <span className="vw-row-label">{label}</span>
                <span className={`vw-row-value${secret && !revealed ? ' vw-masked' : ''}`}>
                    {secret && !revealed ? '••••••••••••' : value}
                </span>
            </div>
            {secret && (
                <button type="button" aria-label={revealed ? `Hide ${label}` : `Show ${label}`} onClick={() => setRevealed(r => !r)}>
                    {revealed ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
            )}
            <button type="button" aria-label={`Copy ${label}`} onClick={() => onCopy(value, label)}>
                <Copy size={18} />
            </button>
        </div>
    );
}

type TotpOptions = { digits?: number; period?: number; algorithm?: 'SHA1' | 'SHA256' | 'SHA512' };

function TotpRow({
    secretValue,
    options,
    onCopy,
}: {
    secretValue: string;
    options?: TotpOptions;
    onCopy: (v: string, l: string) => void;
}) {
    const [code, setCode] = useState('');
    const [remaining, setRemaining] = useState(0);
    // Depended on by value so a re-render with an equivalent literal does not
    // restart the interval and skip a tick.
    const key = JSON.stringify(options ?? {});

    useEffect(() => {
        const opts: TotpOptions = JSON.parse(key);
        const tick = () => {
            try {
                setCode(generateTotpCode(secretValue, opts));
                setRemaining(getTotpRemainingSeconds(opts.period ?? 30));
            } catch {
                setCode('');
            }
        };
        tick();
        const id = setInterval(tick, 1000);
        return () => clearInterval(id);
    }, [secretValue, key]);

    if (!code) return null;

    return (
        <div className="vw-row">
            <div className="vw-row-text">
                <span className="vw-row-label">One-time code · {remaining}s</span>
                <span className="vw-row-value vw-totp">{code}</span>
            </div>
            <button type="button" aria-label="Copy one-time code" onClick={() => onCopy(code, 'One-time code')}>
                <Copy size={18} />
            </button>
        </div>
    );
}

function ItemDetail({
    item,
    onBack,
    onCopy,
}: {
    item: VaultItem;
    onBack: () => void;
    onCopy: (value: string, label: string) => void;
}) {
    const rows: React.ReactNode[] = [];

    if (item.itemType === 'login') {
        const login = item.data as LoginItem;
        rows.push(<CopyRow key="url" label="Site" value={login.url} onCopy={onCopy} />);
        rows.push(<CopyRow key="email" label="Email" value={login.email ?? ''} onCopy={onCopy} />);
        rows.push(<CopyRow key="user" label="Username" value={login.username} onCopy={onCopy} />);
        rows.push(<CopyRow key="pw" label="Password" value={login.password} secret onCopy={onCopy} />);
        if (login.totpSecret) rows.push(<TotpRow key="totp" secretValue={login.totpSecret} onCopy={onCopy} />);
        rows.push(<CopyRow key="notes" label="Notes" value={login.notes ?? ''} onCopy={onCopy} />);
    } else if (item.itemType === 'card') {
        const card = item.data as CardItem;
        rows.push(<CopyRow key="holder" label="Cardholder" value={card.holderName} onCopy={onCopy} />);
        rows.push(<CopyRow key="num" label="Number" value={card.cardNumber} secret onCopy={onCopy} />);
        rows.push(<CopyRow key="exp" label="Expires" value={`${card.expiryMonth}/${card.expiryYear}`} onCopy={onCopy} />);
        rows.push(<CopyRow key="cvv" label="CVV" value={card.cvv} secret onCopy={onCopy} />);
        rows.push(<CopyRow key="notes" label="Notes" value={card.notes ?? ''} onCopy={onCopy} />);
    } else if (item.itemType === 'address') {
        const address = item.data as AddressItem;
        rows.push(<CopyRow key="name" label="Name" value={address.fullName} onCopy={onCopy} />);
        rows.push(<CopyRow key="street" label="Street" value={address.street} onCopy={onCopy} />);
        rows.push(<CopyRow key="city" label="City" value={address.city} onCopy={onCopy} />);
        rows.push(<CopyRow key="state" label="Region" value={address.state} onCopy={onCopy} />);
        rows.push(<CopyRow key="zip" label="Postal code" value={address.zipCode} onCopy={onCopy} />);
        rows.push(<CopyRow key="country" label="Country" value={address.country} onCopy={onCopy} />);
        rows.push(<CopyRow key="phone" label="Phone" value={address.phone ?? ''} onCopy={onCopy} />);
    } else if (item.itemType === 'totp') {
        const totp = item.data as TotpItem;
        rows.push(
            <TotpRow
                key="totp"
                secretValue={totp.secret}
                options={{ digits: totp.digits, period: totp.period, algorithm: totp.algorithm }}
                onCopy={onCopy}
            />,
        );
        rows.push(<CopyRow key="issuer" label="Issuer" value={totp.issuer ?? ''} onCopy={onCopy} />);
    } else if (item.itemType === 'passkey') {
        const passkey = item.data as PasskeyItem;
        rows.push(<CopyRow key="rp" label="Site" value={passkey.rpId} onCopy={onCopy} />);
        rows.push(<CopyRow key="user" label="Account" value={passkey.userName ?? passkey.userDisplayName ?? ''} onCopy={onCopy} />);
        rows.push(
            <p key="note" className="vw-detail vw-inline-note">
                Passkeys can only be used by the browser extension. iOS keeps WebAuthn for
                the system authenticator, so this one cannot sign in from the phone.
            </p>,
        );
    }

    return (
        <div className="vw-detail-view">
            <header className="vw-detail-header">
                <button type="button" onClick={onBack} aria-label="Back to the list">
                    <ChevronLeft size={22} />
                </button>
                <div>
                    <h2>{item.metadata.label}</h2>
                    <span>{itemSubtitle(item)}</span>
                </div>
            </header>
            <div className="vw-rows">{rows}</div>
        </div>
    );
}

/* -------------------------------------------------------------------- app */

export default function App() {
    const [account, setAccount] = useState<AccountState | null>(null);
    const [vault, setVault] = useState<UnlockedVault | null>(null);
    const [query, setQuery] = useState('');
    const [selected, setSelected] = useState<VaultItem | null>(null);
    const [clipboard, setClipboard] = useState<ClipboardState>({ status: 'idle' });

    // Held so a future WebAuthn unlock can re-wrap it without another Argon2id
    // pass. Memory only — see platform/store.ts.
    const masterKeyRef = useRef<Uint8Array | null>(null);

    const probe = useCallback(() => {
        setAccount(null);
        probeAccount().then(setAccount);
    }, []);

    useEffect(probe, [probe]);

    const lock = useCallback(() => {
        // Overwritten, not just dropped: the buffer can outlive the reference in
        // a heap snapshot, and this is the one secret worth the extra line.
        masterKeyRef.current?.fill(0);
        masterKeyRef.current = null;
        cancelPendingClear();
        setVault(null);
        setSelected(null);
        setQuery('');
        setClipboard({ status: 'idle' });
    }, []);

    // Locking when the tab goes away is the closest thing to an auto-lock a PWA
    // has: iOS reclaims backgrounded tabs on its own schedule, so leaning on a
    // timer would be theatre.
    useEffect(() => {
        const onHide = () => { if (document.visibilityState === 'hidden') lock(); };
        document.addEventListener('visibilitychange', onHide);
        return () => document.removeEventListener('visibilitychange', onHide);
    }, [lock]);

    const onCopy = useCallback((value: string, label: string) => {
        void copySecret(value, label, setClipboard);
    }, []);

    const visible = useMemo(
        () => (vault ? searchItems(vault.items, query) : []),
        [vault, query],
    );

    if (!account) {
        return <div className="vw-gate"><p>Connecting…</p></div>;
    }

    if (!vault) {
        return (
            <>
                <UnlockScreen
                    account={account}
                    onUnlocked={(masterKey, opened) => { masterKeyRef.current = masterKey; setVault(opened); }}
                    onRetryProbe={probe}
                />
                <InstallHint />
            </>
        );
    }

    if (selected) {
        return (
            <>
                <ItemDetail item={selected} onBack={() => setSelected(null)} onCopy={onCopy} />
                <StatusBanner state={clipboard} onDismiss={() => setClipboard({ status: 'idle' })} />
            </>
        );
    }

    return (
        <>
            <header className="vw-list-header">
                <div className="vw-search">
                    <Search size={18} />
                    <input
                        type="search"
                        inputMode="search"
                        autoCapitalize="none"
                        autoCorrect="off"
                        placeholder={`Search ${vault.items.length} items`}
                        value={query}
                        onChange={e => setQuery(e.target.value)}
                    />
                </div>
                <button type="button" onClick={lock} aria-label="Lock the vault">
                    <Lock size={20} />
                </button>
            </header>

            {vault.unreadable.length > 0 && (
                <p className="vw-error vw-inline-note" role="alert">
                    <ShieldAlert size={14} /> {vault.unreadable.length} item
                    {vault.unreadable.length === 1 ? '' : 's'} on the server would not open or
                    verify, and {vault.unreadable.length === 1 ? 'is' : 'are'} not shown.
                </p>
            )}

            <ul className="vw-list">
                {visible.map(item => (
                    <li key={item.id}>
                        <button type="button" onClick={() => setSelected(item)}>
                            <span className="vw-avatar" aria-hidden="true">
                                {getInitials(item.metadata.label)}
                            </span>
                            <span className="vw-list-text">
                                <span className="vw-list-label">{item.metadata.label}</span>
                                <span className="vw-list-sub">{itemSubtitle(item)}</span>
                            </span>
                        </button>
                    </li>
                ))}
            </ul>

            {visible.length === 0 && (
                <p className="vw-empty">
                    {vault.items.length === 0
                        ? 'This vault has no items yet.'
                        : `Nothing matches “${query}”.`}
                </p>
            )}

            <StatusBanner state={clipboard} onDismiss={() => setClipboard({ status: 'idle' })} />
        </>
    );
}
