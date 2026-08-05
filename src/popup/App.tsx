import React, { useState, useEffect, useCallback } from 'react';
import {
    Shield, Lock, Key, RefreshCw, Copy, Check, Loader2, ExternalLink,
    Clock, Search, ChevronRight, Wand2, Plus, User, Sparkles
} from 'lucide-react';
import { generatePassword, measurePasswordStrength, strengthLabel, strengthColor } from '../utils/password-generator';
import { generateTotpCode, getTotpRemainingSeconds } from '../utils/totp';
import { normalizeDomain, getHost, getFaviconUrl, normalizeStoredUrl } from '../utils/domain';
import { loginIdentifier } from '../types';
import type { VaultItem, LoginItem, TotpItem, VaultItemMetadata, Identity, VaultSettings } from '../types';

import { useAutoUnlock } from '../utils/use-auto-unlock';

function send<T>(msg: { type: string; payload?: any }): Promise<{ success: boolean; data?: T; error?: string; locked?: boolean }> {
    return chrome.runtime.sendMessage(msg);
}

export default function App() {
    const [initialized, setInitialized] = useState<boolean | null>(null);
    const [unlocked, setUnlocked] = useState(false);
    const [pin, setPin] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const [dataLoading, setDataLoading] = useState(false);
    const [password, setPassword] = useState('');
    const [copied, setCopied] = useState(false);
    const [matches, setMatches] = useState<VaultItem[]>([]);
    const [identities, setIdentities] = useState<Identity[]>([]);
    const [currentTab, setCurrentTab] = useState<chrome.tabs.Tab | null>(null);
    const [itemCount, setItemCount] = useState(0);

    const checkInit = useCallback(async () => {
        const resp = await send<{ initialized: boolean }>({ type: 'INIT_CHECK' });
        setInitialized(resp.data?.initialized ?? false);
    }, []);

    const checkUnlocked = useCallback(async () => {
        const resp = await send<{ unlocked: boolean }>({ type: 'GET_UNLOCKED' });
        setUnlocked(resp.data?.unlocked ?? false);
    }, []);

    const loadMatches = useCallback(async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.url) return;
        setCurrentTab(tab);
        const resp = await send<VaultItem[]>({ type: 'GET_PAGE_MATCHES', payload: { url: tab.url } });
        if (resp.locked) { setUnlocked(false); return; }
        if (resp.success && resp.data) setMatches(resp.data);
    }, []);

    const loadIdentities = useCallback(async () => {
        const resp = await send<Identity[]>({ type: 'GET_IDENTITIES' });
        if (resp.locked) { setUnlocked(false); return; }
        if (resp.success && resp.data) setIdentities(resp.data);
    }, []);

    const loadItemCount = useCallback(async () => {
        const resp = await send<VaultItem[]>({ type: 'GET_ITEMS' });
        if (resp.locked) { setUnlocked(false); return; }
        if (resp.success && resp.data) setItemCount(resp.data.length);
    }, []);

    useEffect(() => {
        checkInit();
        checkUnlocked();
        generateNewPassword();
    }, [checkInit, checkUnlocked]);

    useEffect(() => {
        if (!unlocked) return;
        // Decryption takes a moment; without this the popup shows "no matches"
        // before the real answer arrives.
        setDataLoading(true);
        void Promise.all([loadMatches(), loadItemCount(), loadIdentities()])
            .finally(() => setDataLoading(false));
    }, [unlocked, loadMatches, loadItemCount, loadIdentities]);

    const [showQuickGen, setShowQuickGen] = useState(false);
    const [creating, setCreating] = useState(false);
    const [created, setCreated] = useState(false);

    const generateNewPassword = async () => {
        const { generateFromPreset, PRESETS } = await import('../utils/password-generator');
        // Honour the configured default; hardcoding PRESETS[0] meant the popup
        // handed out passwords in a different shape from the vault generator.
        const settingsResp = await send<VaultSettings>({ type: 'GET_SETTINGS' });
        const presetId = settingsResp.data?.defaultGeneratorPreset;
        const preset = PRESETS.find(p => p.id === presetId) ?? PRESETS[0];
        setPassword(await generateFromPreset(preset));
    };

    const copyPassword = () => {
        navigator.clipboard.writeText(password);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
    };

    const handleUnlocked = useCallback(() => {
        setUnlocked(true);
        setPin('');
        setError('');
    }, []);

    // Unlocks as soon as the PIN is right, with no Enter press.
    const { checking: autoChecking } = useAutoUnlock({
        enabled: initialized === true && !unlocked,
        pin,
        onUnlocked: handleUnlocked,
    });

    const handleUnlock = async () => {
        setLoading(true);
        const resp = await send({ type: 'UNLOCK', payload: { pin } });
        setLoading(false);
        if (resp.success) {
            handleUnlocked();
        } else {
            setError(resp.error ?? 'Unlock failed');
        }
    };

    const openItemInVault = (item: VaultItem) => {
        void send({ type: 'OPEN_VAULT', payload: { query: `?item=${encodeURIComponent(item.id)}` } });
        window.close();
    };

    const openVault = () => {
        void send({ type: 'OPEN_VAULT' });
        window.close();
    };

    const openOnboarding = () => {
        chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
        window.close();
    };

    const handleCreateItemFromTab = async () => {
        if (!currentTab?.url) return;
        setCreating(true);
        const tabUrl = currentTab.url;
        const tabHost = getHost(tabUrl);
        const favicon = getFaviconUrl(tabUrl);
        const generatedPw = password || await (async () => {
            const { generateFromPreset, PRESETS } = await import('../utils/password-generator');
            return generateFromPreset(PRESETS[0]);
        })();
        const data: LoginItem = {
            url: normalizeStoredUrl(tabUrl),
            username: '',
            email: '',
            password: generatedPw,
            notes: '',
            totpSecret: '',
        };
        const metadata: VaultItemMetadata = {
            label: tabHost || 'New Login',
            domain: tabHost,
            iconRef: favicon,
            tags: [],
            favorite: false,
        };
        const resp = await send({ type: 'CREATE_ITEM', payload: { itemType: 'login', data, metadata } });
        setCreating(false);
        if (resp.success) {
            setCreated(true);
            setTimeout(() => setCreated(false), 2000);
            loadItemCount();
            loadMatches();
        }
    };

    const handleAutofill = async (item: VaultItem) => {
        if (item.itemType !== 'login') return;
        const login = item.data as LoginItem;
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) return;
        chrome.tabs.sendMessage(tab.id, {
            type: 'AUTOFILL',
            payload: {
                username: login.username || login.email || '',
                email: login.email || login.username || '',
                password: login.password,
                totp: login.totpSecret || '',
            },
        });
        send({ type: 'UPDATE_ITEM_LAST_USED', payload: { itemId: item.id } });
        window.close();
    };

    if (initialized === null) {
        return (
            <div className="vw-console-shell w-[360px] min-h-[480px] flex items-center justify-center">
                <Loader2 className="w-6 h-6 text-vw-gold animate-spin" />
            </div>
        );
    }

    if (!initialized) {
        return (
            <div className="vw-console-shell w-[360px] min-h-[480px] flex items-center justify-center p-6">
                <div className="text-center">
                    <Shield className="w-10 h-10 text-vw-gold mx-auto mb-3" />
                    <h1 className="text-base font-semibold text-white mb-1">Welcome to VaultWares</h1>
                    <p className="text-xs text-vw-console-text-secondary mb-4">Set up your encrypted vault to get started.</p>
                    <button onClick={openOnboarding} className="px-4 py-2 bg-vw-gold text-vw-console-bg rounded-lg text-sm font-medium hover:bg-[#C69431]">
                        Start Setup
                    </button>
                </div>
            </div>
        );
    }

    if (!unlocked) {
        return (
            <div className="vw-console-shell w-[360px] min-h-[480px] flex items-center justify-center p-6">
                <div className="w-full">
                    <div className="flex items-center gap-2.5 mb-6">
                        <div className="w-9 h-9 rounded-lg bg-vw-gold/20 flex items-center justify-center">
                            <Lock className="w-4.5 h-4.5 text-vw-gold" />
                        </div>
                        <div>
                            <h1 className="text-base font-semibold text-white">Unlock Vault</h1>
                            <p className="text-[11px] text-vw-console-text-secondary">Enter PIN to decrypt locally</p>
                        </div>
                    </div>
                    <div className="relative mb-2">
                        <input
                            type="password"
                            value={pin}
                            onChange={(e) => { setPin(e.target.value); setError(''); }}
                            onKeyDown={(e) => e.key === 'Enter' && handleUnlock()}
                            placeholder="••••"
                            className="w-full px-4 py-2.5 pr-10 bg-vw-console-surface border border-vw-console-border rounded-lg text-white font-mono text-base focus:outline-none focus:border-vw-gold"
                            autoFocus
                        />
                        {autoChecking && (
                            <span className="absolute right-3.5 top-1/2 -translate-y-1/2 flex items-center">
                                <Loader2 className="w-4 h-4 text-vw-gold animate-spin" />
                            </span>
                        )}
                    </div>
                    {error && <p className="text-xs text-vw-signal-alert mb-2">{error}</p>}
                    <button
                        onClick={handleUnlock}
                        disabled={loading || !pin}
                        className="w-full py-2.5 bg-vw-gold text-vw-console-bg rounded-lg text-sm font-medium hover:bg-[#C69431] disabled:opacity-50 flex items-center justify-center gap-2"
                    >
                        {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Lock className="w-4 h-4" />}
                        Unlock
                    </button>
                </div>
            </div>
        );
    }

    const score = measurePasswordStrength(password);
    const domain = currentTab?.url ? normalizeDomain(currentTab.url) : '';

    return (
        <div className="vw-console-shell w-[360px] min-h-[480px] flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-vw-console-border">
                <div className="flex items-center gap-2">
                    <Shield className="w-5 h-5 text-vw-gold" />
                    <span className="text-sm font-semibold text-white">VaultWares</span>
                </div>
                <button onClick={openVault} className="flex items-center gap-1.5 text-vw-console-text-secondary hover:text-white text-xs" title="Open full vault">
                    <ExternalLink className="w-4 h-4" /> Open Vault
                </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {/* Page matches — identities + unassigned logins sorted by last used */}
                {domain && (() => {
                    const matchesWithIdentity = matches.filter(m => m.identityId);
                    const unassignedMatches = matches.filter(m => !m.identityId);
                    const identityIds = [...new Set(matchesWithIdentity.map(m => m.identityId))];
                    const matchingIdentities = identities.filter(id => identityIds.includes(id.id));

                    const sortedIdentities = matchingIdentities.sort((a, b) => {
                        const aLast = Math.max(...matchesWithIdentity.filter(m => m.identityId === a.id).map(m => m.lastUsedAt ? new Date(m.lastUsedAt).getTime() : 0));
                        const bLast = Math.max(...matchesWithIdentity.filter(m => m.identityId === b.id).map(m => m.lastUsedAt ? new Date(m.lastUsedAt).getTime() : 0));
                        return bLast - aLast;
                    });
                    const sortedUnassigned = unassignedMatches.sort((a, b) => {
                        const aTime = a.lastUsedAt ? new Date(a.lastUsedAt).getTime() : 0;
                        const bTime = b.lastUsedAt ? new Date(b.lastUsedAt).getTime() : 0;
                        return bTime - aTime;
                    });

                    if (matches.length === 0) {
                        return (
                            <div>
                                <div className="flex items-center gap-1.5 mb-2">
                                    <Search className="w-3 h-3 text-vw-console-text-secondary" />
                                    <span className="text-[11px] font-medium text-vw-console-text-secondary uppercase tracking-wider">
                                        Matches for {domain}
                                    </span>
                                </div>
                                <p className="text-xs text-vw-console-text-secondary/60 px-1">No items for this site.</p>
                            </div>
                        );
                    }

                    return (
                        <div>
                            <div className="flex items-center gap-1.5 mb-2">
                                <Search className="w-3 h-3 text-vw-console-text-secondary" />
                                <span className="text-[11px] font-medium text-vw-console-text-secondary uppercase tracking-wider">
                                    Matches for {domain}
                                </span>
                            </div>
                            <div className="space-y-2">
                                {sortedIdentities.map((identity) => {
                                    const idMatches = matchesWithIdentity.filter(m => m.identityId === identity.id);
                                    return (
                                        <div key={identity.id} className="space-y-1">
                                            <div className="flex items-center gap-2 px-1">
                                                <div className="w-5 h-5 rounded bg-vw-console-surface flex items-center justify-center flex-shrink-0 overflow-hidden">
                                                    {identity.facePhoto ? (
                                                        <img src={identity.facePhoto} alt="" className="w-full h-full object-cover" />
                                                    ) : (
                                                        <User className="w-3 h-3 text-vw-gold" />
                                                    )}
                                                </div>
                                                <span className="text-[10px] font-medium text-vw-console-text-secondary truncate">{identity.fullName}</span>
                                            </div>
                                            {idMatches.slice(0, 3).map((item) => (
                                                <PopupItemRow key={item.id} item={item} onAutofill={handleAutofill} onOpen={openItemInVault} />
                                            ))}
                                        </div>
                                    );
                                })}
                                {sortedUnassigned.length > 0 && sortedIdentities.length > 0 && (
                                    <div className="border-t border-vw-console-border pt-1" />
                                )}
                                {sortedUnassigned.slice(0, 5).map((item) => (
                                    <PopupItemRow key={item.id} item={item} onAutofill={handleAutofill} onOpen={openItemInVault} />
                                ))}
                            </div>
                        </div>
                    );
                })()}

                {/* Quick password - hidden behind button */}
                {showQuickGen ? (
                    <div className="vw-card p-3.5">
                        <div className="flex items-center justify-between mb-2">
                            <span className="text-[11px] font-medium text-vw-console-text-secondary uppercase tracking-wider">Quick Password</span>
                            <div className="flex items-center gap-1.5">
                                <button onClick={generateNewPassword} className="text-vw-console-text-secondary hover:text-white">
                                    <RefreshCw className="w-3.5 h-3.5" />
                                </button>
                                <button onClick={() => setShowQuickGen(false)} className="text-vw-console-text-secondary hover:text-white">
                                    <span className="text-[10px]">hide</span>
                                </button>
                            </div>
                        </div>
                        <div className="flex items-center gap-2 mb-2">
                            <input
                                type="text"
                                readOnly
                                value={password}
                                className="flex-1 px-2.5 py-1.5 bg-vw-console-surface border border-vw-console-border rounded text-white font-mono text-xs"
                            />
                            <button onClick={copyPassword} className="px-2 py-1.5 bg-vw-console-surface border border-vw-console-border rounded text-vw-console-text-secondary hover:text-white">
                                {copied ? <Check className="w-3.5 h-3.5 text-vw-signal-online" /> : <Copy className="w-3.5 h-3.5" />}
                            </button>
                        </div>
                        <div className="h-1 bg-vw-console-surface rounded-full overflow-hidden">
                            <div className="h-full rounded-full transition-all" style={{ width: `${((score + 1) / 5) * 100}%`, background: strengthColor(score) }} />
                        </div>
                        <p className="text-[10px] text-right text-vw-console-text-secondary mt-0.5">{strengthLabel(score)}</p>
                    </div>
                ) : (
                    <button
                        onClick={() => { setShowQuickGen(true); generateNewPassword(); }}
                        className="w-full flex items-center justify-center gap-2 py-2.5 bg-vw-console-surface border border-vw-console-border rounded-lg text-xs text-vw-console-text-secondary hover:text-white hover:border-vw-gold/30 transition-colors"
                    >
                        <Wand2 className="w-3.5 h-3.5" /> Generate Quick Password
                    </button>
                )}

                {/* Stats */}
                <div className="flex gap-2">
                    <div className="vw-card flex-1 p-3 text-center">
                        <div className="text-lg font-bold text-vw-gold">{itemCount}</div>
                        <div className="text-[10px] text-vw-console-text-secondary uppercase tracking-wider">Items</div>
                    </div>
                    <div className="vw-card flex-1 p-3 text-center">
                        <div className="text-lg font-bold text-vw-signal-online">{matches.length}</div>
                        <div className="text-[10px] text-vw-console-text-secondary uppercase tracking-wider">Matches</div>
                    </div>
                </div>
            </div>

            {/* Footer */}
            <div className="px-4 py-2.5 border-t border-vw-console-border flex items-center justify-between">
                <button
                    onClick={async () => { await send({ type: 'LOCK' }); setUnlocked(false); }}
                    className="flex items-center gap-1.5 text-xs text-vw-console-text-secondary hover:text-white"
                >
                    <Lock className="w-3.5 h-3.5" /> Lock
                </button>
                <button
                    onClick={handleCreateItemFromTab}
                    disabled={creating || !currentTab?.url}
                    className="flex items-center gap-1.5 text-xs text-vw-gold hover:underline disabled:opacity-50"
                >
                    {created ? <><Check className="w-3 h-3" /> Saved!</> : creating ? <Loader2 className="w-3 h-3 animate-spin" /> : <><Plus className="w-3 h-3" /> New Item for this site</>}
                </button>
            </div>
        </div>
    );
}

function PopupItemRow({ item, onAutofill, onOpen }: {
    item: VaultItem;
    onAutofill: (item: VaultItem) => void;
    onOpen: (item: VaultItem) => void;
}) {
    const [showTotp, setShowTotp] = useState(false);
    const [totpCode, setTotpCode] = useState('');
    const [totpSeconds, setTotpSeconds] = useState(30);
    const [copiedField, setCopiedField] = useState('');

    useEffect(() => {
        if (showTotp && item.itemType === 'totp') {
            const data = item.data as TotpItem;
            const update = () => {
                setTotpCode(generateTotpCode(data.secret, { digits: data.digits, period: data.period, algorithm: data.algorithm }));
                setTotpSeconds(getTotpRemainingSeconds(data.period));
            };
            update();
            const interval = setInterval(update, 1000);
            return () => clearInterval(interval);
        }
    }, [showTotp, item]);

    const loginData = item.itemType === 'login' ? item.data as LoginItem : null;

    const copyField = (e: React.MouseEvent, value: string, field: string) => {
        e.stopPropagation();
        navigator.clipboard.writeText(value);
        setCopiedField(field);
        setTimeout(() => setCopiedField(''), 1200);
    };

    return (
        <div
            role="button"
            tabIndex={0}
            onClick={() => onOpen(item)}
            onKeyDown={(e) => { if (e.key === 'Enter') onOpen(item); }}
            title="Open in vault"
            className="flex items-center gap-2.5 p-2 bg-vw-console-surface rounded-lg hover:bg-vw-console-raised transition-colors cursor-pointer group"
        >
            <div className="w-7 h-7 rounded bg-vw-console-elevated flex items-center justify-center flex-shrink-0">
                {item.metadata.iconRef ? (
                    <img src={item.metadata.iconRef} alt="" className="w-4 h-4 rounded" />
                ) : (
                    <Key className="w-3.5 h-3.5 text-vw-gold" />
                )}
            </div>
            <div className="flex-1 min-w-0">
                <div className="text-xs font-medium text-white truncate">{item.metadata.label}</div>
                <div className="text-[10px] text-vw-console-text-secondary truncate">
                    {(loginData && loginIdentifier(loginData)) || (item.data as TotpItem).issuer || item.itemType}
                </div>
            </div>
            {item.itemType === 'totp' && (
                <button onClick={(e) => { e.stopPropagation(); setShowTotp(!showTotp); }} className="text-vw-signal-online hover:scale-110 transition-transform">
                    <Clock className="w-3.5 h-3.5" />
                </button>
            )}
            {loginData && loginIdentifier(loginData) && (
                <button
                    onClick={(e) => copyField(e, loginIdentifier(loginData), 'username')}
                    className="text-vw-console-text-secondary hover:text-white opacity-0 group-hover:opacity-100 transition-opacity"
                    title="Copy username"
                >
                    {copiedField === 'username' ? <Check className="w-3.5 h-3.5 text-vw-signal-online" /> : <Copy className="w-3.5 h-3.5" />}
                </button>
            )}
            {loginData?.password && (
                <button
                    onClick={(e) => copyField(e, loginData.password, 'password')}
                    className="text-vw-console-text-secondary hover:text-white opacity-0 group-hover:opacity-100 transition-opacity"
                    title="Copy password"
                >
                    {copiedField === 'password' ? <Check className="w-3.5 h-3.5 text-vw-signal-online" /> : <Key className="w-3.5 h-3.5" />}
                </button>
            )}
            {loginData && (
                <button
                    onClick={(e) => { e.stopPropagation(); onAutofill(item); }}
                    className="text-vw-gold hover:scale-110 transition-transform opacity-0 group-hover:opacity-100"
                    title="Autofill"
                >
                    <ChevronRight className="w-3.5 h-3.5" />
                </button>
            )}
            {showTotp && (
                <div className="absolute right-0 top-full mt-1 bg-vw-console-elevated border border-vw-console-border rounded-lg p-2 text-xs font-mono text-vw-signal-online z-10">
                    {totpCode} <span className="text-vw-console-text-secondary text-[10px]">{totpSeconds}s</span>
                </div>
            )}
        </div>
    );
}
