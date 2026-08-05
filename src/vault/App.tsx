import React, { useState, useEffect, useCallback } from 'react';
import {
    Shield, Lock, Search, Plus, Key, CreditCard, MapPin, Clock, Fingerprint,
    Settings, RefreshCw, Trash2, X, Copy, Eye, EyeOff, Check, Loader2,
    Download, Monitor, ChevronRight, Star, AlertCircle, Users, User, Sparkles
} from 'lucide-react';
import type { VaultItem, ItemType, VaultSettings, LoginItem, AddressItem, CardItem, TotpItem, PasskeyItem, Identity, GeneratedIdentityData } from '../types';
import type { SyncStatus } from '../background';
import { DEFAULT_SETTINGS } from '../types';
import { generatePassword, generatePassphrase, generateToken, generateFromPreset, measurePasswordStrength, strengthLabel, strengthColor, PRESETS, type GeneratorPreset, type PasswordOptions, type PassphraseOptions } from '../utils/password-generator';
import { generateTotpCode, getTotpRemainingSeconds } from '../utils/totp';
import { normalizeDomain, getFaviconUrl, getInitials } from '../utils/domain';
import { t } from '../i18n/strings';
import { useAutoUnlock } from '../utils/use-auto-unlock';

/** A blank persona for the manual create path — no generation service involved. */
function emptyIdentityData(): GeneratedIdentityData {
    return {
        fullName: '',
        gender: 'other',
        birthDate: '',
        nationality: '',
        bio: '',
        email: '',
        phone: '',
        address: { fullName: '', street: '', city: '', state: '', zipCode: '', country: '', phone: '' },
    };
}

function identityToEditable(identity: Identity): GeneratedIdentityData {
    return {
        fullName: identity.fullName,
        gender: identity.gender,
        birthDate: identity.birthDate,
        nationality: identity.nationality,
        bio: identity.bio,
        email: identity.email,
        phone: identity.phone,
        address: { ...identity.address, phone: identity.address.phone ?? '' },
    };
}

type IdentityEditorMode = 'create' | 'edit' | 'review';

interface IdentityEditorState {
    mode: IdentityEditorMode;
    data: GeneratedIdentityData;
    /** Set when editing an identity that already exists. */
    identity: Identity | null;
}

function send<T>(msg: { type: string; payload?: any }): Promise<{ success: boolean; data?: T; error?: string; locked?: boolean }> {
    return chrome.runtime.sendMessage(msg);
}

type Tab = 'identities' | 'all' | 'logins' | 'addresses' | 'cards' | 'totp' | 'passkeys' | 'generator' | 'settings' | 'devices';

const ITEM_TYPE_CONFIG: Record<ItemType, { label: string; icon: React.ReactNode; color: string }> = {
    login: { label: 'Login', icon: <Key className="w-4 h-4" />, color: 'text-vw-gold' },
    address: { label: 'Address', icon: <MapPin className="w-4 h-4" />, color: 'text-vw-signal-relay' },
    card: { label: 'Card', icon: <CreditCard className="w-4 h-4" />, color: 'text-vw-signal-online' },
    totp: { label: 'TOTP', icon: <Clock className="w-4 h-4" />, color: 'text-vw-signal-sync' },
    passkey: { label: 'Passkey', icon: <Fingerprint className="w-4 h-4" />, color: 'text-vw-violet' },
};

export default function App() {
    const [initialized, setInitialized] = useState<boolean | null>(null);
    const [unlocked, setUnlocked] = useState(false);
    const [pin, setPin] = useState('');
    const [error, setError] = useState('');
    const [items, setItems] = useState<VaultItem[]>([]);
    const [identities, setIdentities] = useState<Identity[]>([]);
    const [tab, setTab] = useState<Tab>('identities');
    const [search, setSearch] = useState('');
    const [editingItem, setEditingItem] = useState<VaultItem | null>(null);
    const [creatingType, setCreatingType] = useState<ItemType | null>(null);
    const [showTypeSelector, setShowTypeSelector] = useState(false);
    const [prefillUrl, setPrefillUrl] = useState('');
    const [settings, setSettings] = useState<VaultSettings | null>(null);
    const [loading, setLoading] = useState(false);
    const [dataLoading, setDataLoading] = useState(false);
    const [syncing, setSyncing] = useState(false);
    const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
    const [selectedIdentity, setSelectedIdentity] = useState<Identity | null>(null);
    const [generatingIdentity, setGeneratingIdentity] = useState(false);
    const [identityEditor, setIdentityEditor] = useState<IdentityEditorState | null>(null);
    const [identityError, setIdentityError] = useState('');

    const checkInit = useCallback(async () => {
        const resp = await send<{ initialized: boolean }>({ type: 'INIT_CHECK' });
        setInitialized(resp.data?.initialized ?? false);
    }, []);

    const checkUnlocked = useCallback(async () => {
        const resp = await send<{ unlocked: boolean }>({ type: 'GET_UNLOCKED' });
        setUnlocked(resp.data?.unlocked ?? false);
    }, []);

    /**
     * A locked vault decrypts nothing, so it answers with an empty list. Taking
     * that at face value paints the "no identities yet" empty state over a vault
     * that is merely locked, which reads as data loss. Bounce to the unlock
     * screen instead and leave the cached lists alone.
     */
    const loadItems = useCallback(async () => {
        const resp = await send<VaultItem[]>({ type: 'GET_ITEMS' });
        if (resp.locked) { setUnlocked(false); return; }
        if (resp.success && resp.data) setItems(resp.data);
    }, []);

    const loadIdentities = useCallback(async () => {
        const resp = await send<Identity[]>({ type: 'GET_IDENTITIES' });
        if (resp.locked) { setUnlocked(false); return; }
        if (resp.success && resp.data) setIdentities(resp.data);
    }, []);

    const loadSettings = useCallback(async () => {
        const resp = await send<VaultSettings>({ type: 'GET_SETTINGS' });
        if (resp.success && resp.data) setSettings(resp.data);
    }, []);

    useEffect(() => {
        checkInit();
        checkUnlocked();
    }, [checkInit, checkUnlocked]);

    useEffect(() => {
        if (!unlocked) return;

        // Decryption is not instant. Without this flag the lists render as []
        // first and the empty state flashes before the real data lands.
        setDataLoading(true);
        void Promise.all([loadItems(), loadIdentities(), loadSettings()])
            .finally(() => setDataLoading(false));
        void loadSyncStatus();

        const params = new URLSearchParams(window.location.search);
        if (params.get('action') === 'create') {
            const url = params.get('url') || '';
            if (url) {
                setCreatingType('login');
                setPrefillUrl(url);
            }
        }
    }, [unlocked, loadItems, loadIdentities, loadSettings]);

    const handleUnlocked = useCallback(() => {
        setUnlocked(true);
        setPin('');
        setError('');
    }, []);

    // Unlocks the moment the PIN is right, so no Enter press is needed.
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
            // Only an explicit submit reports failure; the background attempts
            // stay silent so a half-typed PIN does not read as an error.
            setError(resp.error ?? 'Unlock failed');
        }
    };

    const handleLock = async () => {
        await send({ type: 'LOCK' });
        setUnlocked(false);
        setItems([]);
        setIdentities([]);
    };

    const loadSyncStatus = useCallback(async () => {
        const resp = await send<SyncStatus>({ type: 'GET_SYNC_STATUS' });
        if (resp.success && resp.data) setSyncStatus(resp.data);
    }, []);

    const handleSync = async () => {
        setSyncing(true);
        const resp = await send<{ status: SyncStatus }>({ type: 'SYNC' });
        setSyncing(false);
        if (resp.data?.status) setSyncStatus(resp.data.status);
        else await loadSyncStatus();
        await loadItems();
        await loadIdentities();
    };

    const handleSaveItem = async (itemType: ItemType, data: any, metadata: any, id?: string) => {
        if (id) {
            await send({ type: 'UPDATE_ITEM', payload: { id, data, metadata } });
        } else {
            await send({ type: 'CREATE_ITEM', payload: { itemType, data, metadata } });
        }
        setEditingItem(null);
        setCreatingType(null);
        await loadItems();
    };

    const handleDeleteItem = async (id: string) => {
        await send({ type: 'DELETE_ITEM', payload: { id } });
        setEditingItem(null);
        await loadItems();
    };

    const handleCreateIdentityManually = () => {
        setIdentityError('');
        setIdentityEditor({ mode: 'create', data: emptyIdentityData(), identity: null });
    };

    const handleEditIdentity = (identity: Identity) => {
        setIdentityError('');
        setIdentityEditor({ mode: 'edit', data: identityToEditable(identity), identity });
    };

    /**
     * Optional convenience, not the way in: generation needs an endpoint
     * configured in settings, so a failure opens the blank editor rather than
     * leaving the user with nothing.
     */
    const handleGenerateIdentity = async () => {
        setGeneratingIdentity(true);
        setIdentityError('');
        const resp = await send<GeneratedIdentityData>({ type: 'GENERATE_IDENTITY' });
        setGeneratingIdentity(false);
        if (resp.success && resp.data) {
            setIdentityEditor({ mode: 'review', data: resp.data, identity: null });
        } else {
            setIdentityError(resp.error || 'Generation is unavailable — fill the identity in manually.');
            setIdentityEditor({ mode: 'create', data: emptyIdentityData(), identity: null });
        }
    };

    const handleSaveIdentity = async (data: GeneratedIdentityData) => {
        const editor = identityEditor;
        if (!editor) return;

        const resp = editor.identity
            ? await send<Identity>({
                type: 'UPDATE_IDENTITY',
                payload: { identity: { ...editor.identity, ...data, address: { ...editor.identity.address, ...data.address } } },
            })
            : await send<Identity>({ type: 'CREATE_IDENTITY', payload: { data } });

        if (!resp.success) {
            setIdentityError(resp.error || 'Could not save the identity');
            return;
        }

        setIdentityEditor(null);
        setIdentityError('');
        await loadIdentities();
        // Keep the detail view in step with what was just saved.
        if (editor.identity && resp.data) setSelectedIdentity(resp.data);
    };

    const handleDeleteIdentity = async (id: string) => {
        await send({ type: 'DELETE_IDENTITY', payload: { id } });
        setSelectedIdentity(null);
        await loadIdentities();
    };

    const handleAssignItem = async (itemId: string, identityId: string) => {
        await send({ type: 'ASSIGN_ITEM_TO_IDENTITY', payload: { itemId, identityId } });
        await loadItems();
    };

    const handleUnassignItem = async (itemId: string) => {
        await send({ type: 'UNASSIGN_ITEM_FROM_IDENTITY', payload: { itemId } });
        await loadItems();
    };

    if (initialized === null) {
        return (
            <div className="vw-console-shell min-h-screen flex items-center justify-center">
                <Loader2 className="w-8 h-8 text-vw-gold animate-spin" />
            </div>
        );
    }

    if (!initialized) {
        return (
            <div className="vw-warm-shell min-h-screen flex items-center justify-center p-8">
                <div className="vw-warm-card p-10 max-w-md text-center">
                    <Shield className="w-12 h-12 text-vw-gold mx-auto mb-4" />
                    <h1 className="text-xl font-bold text-[#161320] mb-2">Vault Not Set Up</h1>
                    <p className="text-sm text-[#161320]/70 mb-6">Complete the onboarding to create your encrypted vault.</p>
                    <button
                        onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') })}
                        className="w-full py-3 bg-[#D6A441] text-white rounded-lg font-medium hover:bg-[#C69431]"
                    >
                        Start Setup
                    </button>
                </div>
            </div>
        );
    }

    if (!unlocked) {
        return (
            <div className="vw-console-shell min-h-screen flex items-center justify-center">
                <div className="vw-card p-10 max-w-sm w-full mx-4">
                    <div className="flex items-center gap-3 mb-6">
                        <div className="w-10 h-10 rounded-lg bg-vw-gold/20 flex items-center justify-center">
                            <Lock className="w-5 h-5 text-vw-gold" />
                        </div>
                        <div>
                            <h1 className="text-lg font-semibold text-white">Unlock Vault</h1>
                            <p className="text-xs text-vw-console-text-secondary">Enter your PIN to decrypt locally</p>
                        </div>
                    </div>
                    <div className="relative mb-3">
                        <input
                            type="password"
                            value={pin}
                            onChange={(e) => { setPin(e.target.value); setError(''); }}
                            onKeyDown={(e) => e.key === 'Enter' && handleUnlock()}
                            placeholder="••••"
                            className="w-full px-4 py-3 pr-11 bg-vw-console-surface border border-vw-console-border rounded-lg text-white font-mono text-lg focus:outline-none focus:border-vw-gold"
                            autoFocus
                        />
                        {autoChecking && (
                            <Loader2 className="w-4 h-4 text-vw-gold animate-spin absolute right-4 top-1/2 -translate-y-1/2" />
                        )}
                    </div>
                    {error && <p className="text-sm text-vw-signal-alert mb-3">{error}</p>}
                    <button
                        onClick={handleUnlock}
                        disabled={loading || !pin}
                        className="w-full py-3 bg-vw-gold text-vw-console-bg rounded-lg font-medium hover:bg-[#C69431] disabled:opacity-50 flex items-center justify-center gap-2"
                    >
                        {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Lock className="w-4 h-4" />}
                        Unlock
                    </button>
                </div>
            </div>
        );
    }

    const filteredItems = items.filter(item => {
        if (tab !== 'all' && tab !== 'generator' && tab !== 'settings' && tab !== 'devices') {
            const typeMap: Record<string, ItemType> = { logins: 'login', addresses: 'address', cards: 'card', totp: 'totp', passkeys: 'passkey' };
            if (item.itemType !== typeMap[tab]) return false;
        }
        if (search) {
            const q = search.toLowerCase();
            return (
                item.metadata.label.toLowerCase().includes(q) ||
                item.metadata.domain?.toLowerCase().includes(q) ||
                item.metadata.tags.some(t => t.toLowerCase().includes(q))
            );
        }
        return true;
    });

    const navItems: { tab: Tab; label: string; icon: React.ReactNode }[] = [
        { tab: 'identities', label: 'Identities', icon: <Users className="w-4 h-4" /> },
        { tab: 'all', label: settings?.vaultSectionName ?? 'Vault', icon: <Shield className="w-4 h-4" /> },
        { tab: 'logins', label: 'Logins', icon: <Key className="w-4 h-4" /> },
        { tab: 'addresses', label: 'Addresses', icon: <MapPin className="w-4 h-4" /> },
        { tab: 'cards', label: 'Cards', icon: <CreditCard className="w-4 h-4" /> },
        { tab: 'totp', label: 'TOTP', icon: <Clock className="w-4 h-4" /> },
        { tab: 'passkeys', label: 'Passkeys', icon: <Fingerprint className="w-4 h-4" /> },
        { tab: 'generator', label: 'Generator', icon: <RefreshCw className="w-4 h-4" /> },
        { tab: 'devices', label: 'Devices', icon: <Monitor className="w-4 h-4" /> },
        { tab: 'settings', label: 'Settings', icon: <Settings className="w-4 h-4" /> },
    ];

    return (
        <div className="flex h-screen overflow-hidden">
            {/* Warm-mode sidebar */}
            <aside className="vw-warm-shell w-60 flex-shrink-0 flex flex-col border-r border-[#161320]/8">
                <div className="px-5 py-5 border-b border-[#161320]/8">
                    <div className="flex items-center gap-2.5">
                        <Shield className="w-7 h-7 text-[#D6A441]" />
                        <div>
                            <div className="text-sm font-bold text-[#161320]">VaultWares</div>
                            <div className="text-[10px] text-[#161320]/50 uppercase tracking-wider">Identity Vault</div>
                        </div>
                    </div>
                </div>
                <nav className="flex-1 px-3 py-3 space-y-0.5 overflow-y-auto">
                    {navItems.map(({ tab: t, label, icon }) => (
                        <button
                            key={t}
                            onClick={() => { setTab(t); setEditingItem(null); setCreatingType(null); }}
                            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors ${
                                tab === t
                                    ? 'bg-[#D6A441]/15 text-[#D6A441] font-medium'
                                    : 'text-[#161320]/70 hover:bg-[#161320]/5'
                            }`}
                        >
                            {icon}
                            {label}
                        </button>
                    ))}
                </nav>
                <div className="px-3 py-3 border-t border-[#161320]/8">
                    <button
                        onClick={handleSync}
                        disabled={syncing}
                        className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-[#161320]/70 hover:bg-[#161320]/5 transition-colors disabled:opacity-60"
                    >
                        <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
                        <span className="flex-1 text-left">Sync</span>
                        {!syncing && syncStatus?.state === 'ok' && (
                            <Check className="w-3.5 h-3.5 text-vw-signal-online" />
                        )}
                        {!syncing && syncStatus?.state === 'error' && (
                            <AlertCircle className="w-3.5 h-3.5 text-vw-signal-alert" />
                        )}
                    </button>
                    <SyncStatusLine status={syncStatus} syncing={syncing} />
                    <button
                        onClick={handleLock}
                        className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-[#161320]/70 hover:bg-[#161320]/5 transition-colors"
                    >
                        <Lock className="w-4 h-4" />
                        Lock Vault
                    </button>
                </div>
            </aside>

            {/* Console-mode content */}
            <main className="vw-console-shell flex-1 overflow-y-auto">
                <div className="p-8">
                    {/* Identities view */}
                    {tab === 'identities' && !selectedIdentity && (
                        <>
                            <div className="flex items-center justify-between mb-6">
                                <div>
                                    <h1 className="text-2xl font-bold text-white">Identities</h1>
                                    <p className="text-sm text-vw-console-text-secondary mt-1">
                                        {identities.length} {identities.length === 1 ? 'identity' : 'identities'}
                                    </p>
                                </div>
                                <div className="flex items-center gap-3">
                                    <div className="relative">
                                        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-vw-console-text-secondary" />
                                        <input
                                            type="search"
                                            value={search}
                                            onChange={(e) => setSearch(e.target.value)}
                                            placeholder="Search identities…"
                                            className="pl-9 pr-4 py-2 bg-vw-console-surface border border-vw-console-border rounded-lg text-sm text-white focus:outline-none focus:border-vw-gold w-64"
                                        />
                                    </div>
                                    <button
                                        onClick={handleCreateIdentityManually}
                                        className="flex items-center gap-2 px-4 py-2 bg-vw-gold text-vw-console-bg rounded-lg text-sm font-medium hover:bg-[#C69431]"
                                    >
                                        <Plus className="w-4 h-4" />
                                        {t('identityCreateManual')}
                                    </button>
                                    <button
                                        onClick={handleGenerateIdentity}
                                        disabled={generatingIdentity}
                                        title="Requires a generation endpoint in Settings"
                                        className="flex items-center gap-2 px-4 py-2 border border-vw-console-border text-vw-console-text-secondary rounded-lg text-sm font-medium hover:text-white hover:bg-vw-console-raised disabled:opacity-50"
                                    >
                                        {generatingIdentity ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                                        Generate
                                    </button>
                                </div>
                            </div>

                            {identityError && (
                                <div className="flex items-start gap-2 mb-4 px-3 py-2 rounded-lg border border-vw-console-border bg-vw-console-surface text-xs text-vw-signal-warning">
                                    <AlertCircle className="w-4 h-4 flex-shrink-0 mt-px" />
                                    <span>{identityError}</span>
                                </div>
                            )}

                            {dataLoading ? (
                                <div className="text-center py-20">
                                    <Loader2 className="w-8 h-8 text-vw-gold animate-spin mx-auto mb-3" />
                                    <p className="text-sm text-vw-console-text-secondary">Decrypting vault…</p>
                                </div>
                            ) : identities.length === 0 && !generatingIdentity ? (
                                <div className="text-center py-20">
                                    <Users className="w-12 h-12 text-vw-console-text-secondary/30 mx-auto mb-3" />
                                    <p className="text-vw-console-text-secondary mb-4">No identities yet. Create one by hand, or generate one if you have an endpoint configured.</p>
                                    <div className="flex items-center justify-center gap-3">
                                        <button
                                            onClick={handleCreateIdentityManually}
                                            className="inline-flex items-center gap-2 px-4 py-2 bg-vw-gold text-vw-console-bg rounded-lg text-sm font-medium hover:bg-[#C69431]"
                                        >
                                            <Plus className="w-4 h-4" /> {t('identityCreateManual')}
                                        </button>
                                        <button
                                            onClick={handleGenerateIdentity}
                                            className="inline-flex items-center gap-2 px-4 py-2 border border-vw-console-border text-vw-console-text-secondary rounded-lg text-sm font-medium hover:text-white hover:bg-vw-console-raised"
                                        >
                                            <Sparkles className="w-4 h-4" /> Generate
                                        </button>
                                    </div>
                                </div>
                            ) : (
                                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                                    {identities
                                        .filter(id => !search || id.fullName.toLowerCase().includes(search.toLowerCase()) || id.nationality.toLowerCase().includes(search.toLowerCase()) || id.email.toLowerCase().includes(search.toLowerCase()))
                                        .sort((a, b) => {
                                            if (a.metadata.favorite !== b.metadata.favorite) return b.metadata.favorite ? 1 : -1;
                                            return 0;
                                        })
                                        .map((identity) => (
                                            <IdentityCard
                                                key={identity.id}
                                                identity={identity}
                                                itemCount={items.filter(i => i.identityId === identity.id).length}
                                                onClick={() => setSelectedIdentity(identity)}
                                            />
                                        ))
                                    }
                                </div>
                            )}

                        </>
                    )}

                    {/* Identity detail view */}
                    {tab === 'identities' && selectedIdentity && (
                        <IdentityDetailView
                            identity={selectedIdentity}
                            items={items.filter(i => i.identityId === selectedIdentity.id)}
                            allItems={items}
                            onBack={() => setSelectedIdentity(null)}
                            onDelete={() => handleDeleteIdentity(selectedIdentity.id)}
                            onEdit={() => handleEditIdentity(selectedIdentity)}
                            onEditItem={(item) => setEditingItem(item)}
                            onAssignItem={(itemId) => handleAssignItem(itemId, selectedIdentity.id)}
                            onUnassignItem={handleUnassignItem}
                            onCreateItem={() => setShowTypeSelector(true)}
                        />
                    )}

                    {/* Rendered outside both branches so editing works from the
                        list and from an open identity alike. */}
                    {tab === 'identities' && identityEditor && (
                        <IdentityEditorModal
                            mode={identityEditor.mode}
                            data={identityEditor.data}
                            onSave={handleSaveIdentity}
                            onCancel={() => { setIdentityEditor(null); setIdentityError(''); }}
                        />
                    )}

                    {/* Existing item views (not identities, generator, settings, devices) */}
                    {tab !== 'identities' && tab !== 'generator' && tab !== 'settings' && tab !== 'devices' && (
                        <>
                            <div className="flex items-center justify-between mb-6">
                                <div>
                                    <h1 className="text-2xl font-bold text-white capitalize">
                                        {tab === 'all' ? 'All Items' : tab}
                                    </h1>
                                    <p className="text-sm text-vw-console-text-secondary mt-1">
                                        {filteredItems.length} {filteredItems.length === 1 ? 'item' : 'items'}
                                    </p>
                                </div>
                                <div className="flex items-center gap-3">
                                    <div className="relative">
                                        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-vw-console-text-secondary" />
                                        <input
                                            type="search"
                                            value={search}
                                            onChange={(e) => setSearch(e.target.value)}
                                            placeholder="Search…"
                                            className="pl-9 pr-4 py-2 bg-vw-console-surface border border-vw-console-border rounded-lg text-sm text-white focus:outline-none focus:border-vw-gold w-64"
                                        />
                                    </div>
                                    <button
                                        onClick={() => setShowTypeSelector(true)}
                                        className="flex items-center gap-2 px-4 py-2 bg-vw-gold text-vw-console-bg rounded-lg text-sm font-medium hover:bg-[#C69431]"
                                    >
                                        <Plus className="w-4 h-4" />
                                        New Item
                                    </button>
                                </div>
                            </div>

                            {dataLoading ? (
                                <div className="text-center py-20">
                                    <Loader2 className="w-8 h-8 text-vw-gold animate-spin mx-auto mb-3" />
                                    <p className="text-sm text-vw-console-text-secondary">Decrypting vault…</p>
                                </div>
                            ) : filteredItems.length === 0 ? (
                                <div className="text-center py-20">
                                    <Shield className="w-12 h-12 text-vw-console-text-secondary/30 mx-auto mb-3" />
                                    <p className="text-vw-console-text-secondary">No items yet. Create your first vault item.</p>
                                </div>
                            ) : (
                                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                                    {filteredItems.map((item) => (
                                        <ItemCard key={item.id} item={item} onClick={() => setEditingItem(item)} />
                                    ))}
                                </div>
                            )}

                            {showTypeSelector && (
                                <ItemTypeSelector onSelect={(type) => { setCreatingType(type); setShowTypeSelector(false); }} onCancel={() => setShowTypeSelector(false)} />
                            )}

                            {creatingType && (
                                <ItemEditor
                                    itemType={creatingType}
                                    prefillUrl={prefillUrl}
                                    onSave={(data, metadata) => handleSaveItem(creatingType, data, metadata)}
                                    onCancel={() => { setCreatingType(null); setPrefillUrl(''); }}
                                />
                            )}

                            {editingItem && (
                                <ItemEditor
                                    item={editingItem}
                                    itemType={editingItem.itemType}
                                    onSave={(data, metadata) => handleSaveItem(editingItem.itemType, data, metadata, editingItem.id)}
                                    onCancel={() => setEditingItem(null)}
                                    onDelete={() => handleDeleteItem(editingItem.id)}
                                />
                            )}
                        </>
                    )}

                    {tab === 'generator' && <PasswordGeneratorPanel settings={settings} />}
                    {tab === 'settings' && <SettingsPanel settings={settings} onSave={async (s) => { await send({ type: 'SAVE_SETTINGS', payload: s }); setSettings(s); }} />}
                    {tab === 'devices' && <DevicesPanel />}
                </div>
            </main>
        </div>
    );
}

function ItemCard({ item, onClick }: { item: VaultItem; onClick: () => void }) {
    const config = ITEM_TYPE_CONFIG[item.itemType];
    const [showTotp, setShowTotp] = useState(false);
    const [totpCode, setTotpCode] = useState('');
    const [totpSeconds, setTotpSeconds] = useState(30);

    useEffect(() => {
        if (item.itemType === 'totp' && showTotp) {
            const data = item.data as TotpItem;
            const update = () => {
                setTotpCode(generateTotpCode(data.secret, { digits: data.digits, period: data.period, algorithm: data.algorithm }));
                setTotpSeconds(getTotpRemainingSeconds(data.period));
            };
            update();
            const interval = setInterval(update, 1000);
            return () => clearInterval(interval);
        }
    }, [item, showTotp]);

    return (
        <div
            onClick={onClick}
            className="vw-card p-4 cursor-pointer hover:border-vw-gold/30 transition-colors group"
        >
            <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-lg bg-vw-console-elevated flex items-center justify-center flex-shrink-0">
                    {item.metadata.iconRef ? (
                        <img src={item.metadata.iconRef} alt="" className="w-6 h-6 rounded" />
                    ) : (
                        <span className={`text-sm font-bold ${config.color}`}>{getInitials(item.metadata.label)}</span>
                    )}
                </div>
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-white truncate">{item.metadata.label}</span>
                        {item.metadata.favorite && <Star className="w-3 h-3 text-vw-gold fill-vw-gold flex-shrink-0" />}
                    </div>
                    <p className="text-xs text-vw-console-text-secondary truncate mt-0.5">
                        {item.itemType === 'login' && (item.data as LoginItem).username}
                        {item.itemType === 'address' && `${(item.data as AddressItem).fullName}`}
                        {item.itemType === 'card' && `•••• ${(item.data as CardItem).cardNumber.slice(-4)}`}
                        {item.itemType === 'totp' && (item.data as TotpItem).issuer || (item.data as TotpItem).label}
                        {item.itemType === 'passkey' && ((item.data as PasskeyItem).userName || (item.data as PasskeyItem).rpId)}
                    </p>
                </div>
                <div className={`flex-shrink-0 ${config.color}`}>
                    {config.icon}
                </div>
            </div>

            {item.itemType === 'totp' && (
                <div className="mt-3 pt-3 border-t border-vw-console-border">
                    {showTotp ? (
                        <div className="flex items-center justify-between">
                            <span className="font-mono text-lg text-vw-signal-online tracking-wider">{totpCode}</span>
                            <div className="flex items-center gap-2">
                                <span className="text-xs text-vw-console-text-secondary">{totpSeconds}s</span>
                                <button onClick={(e) => { e.stopPropagation(); setShowTotp(false); }} className="text-vw-console-text-secondary hover:text-white">
                                    <EyeOff className="w-3.5 h-3.5" />
                                </button>
                            </div>
                        </div>
                    ) : (
                        <button onClick={(e) => { e.stopPropagation(); setShowTotp(true); }} className="text-xs text-vw-gold hover:underline flex items-center gap-1">
                            <Eye className="w-3.5 h-3.5" /> Show code
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}

function ItemEditor({ item, itemType, onSave, onCancel, onDelete, prefillUrl }: {
    item?: VaultItem;
    itemType: ItemType;
    onSave: (data: any, metadata: any) => void;
    onCancel: () => void;
    onDelete?: () => void;
    prefillUrl?: string;
}) {
    const [label, setLabel] = useState(item?.metadata.label ?? (prefillUrl ? normalizeDomain(prefillUrl) : ''));
    const [favorite, setFavorite] = useState(item?.metadata.favorite ?? false);
    const [showPassword, setShowPassword] = useState(false);

    const [loginData, setLoginData] = useState<LoginItem>(item?.itemType === 'login' ? item.data as LoginItem : { url: prefillUrl || '', username: '', password: '', notes: '', totpSecret: '' });
    const [addressData, setAddressData] = useState<AddressItem>(item?.itemType === 'address' ? item.data as AddressItem : { fullName: '', street: '', city: '', state: '', zipCode: '', country: '', phone: '' });
    const [cardData, setCardData] = useState<CardItem>(item?.itemType === 'card' ? item.data as CardItem : { holderName: '', cardNumber: '', expiryMonth: '', expiryYear: '', cvv: '', notes: '' });
    const [totpData, setTotpData] = useState<TotpItem>(item?.itemType === 'totp' ? item.data as TotpItem : { label: '', secret: '', issuer: '', digits: 6, period: 30, algorithm: 'SHA1' });
    const [passkeyData, setPasskeyData] = useState<PasskeyItem>(item?.itemType === 'passkey' ? item.data as PasskeyItem : { rpId: '', credentialId: '', privateKey: '', userHandle: '', notes: '' });

    const handleSave = () => {
        const metadata = { label: label || getDefaultLabel(), domain: getDomain(), iconRef: getIcon(), tags: [], favorite };
        let data: any;
        switch (itemType) {
            case 'login': data = loginData; break;
            case 'address': data = addressData; break;
            case 'card': data = cardData; break;
            case 'totp': data = totpData; break;
            case 'passkey': data = passkeyData; break;
        }
        onSave(data, metadata);
    };

    const getDefaultLabel = () => {
        switch (itemType) {
            case 'login': return normalizeDomain(loginData.url) || loginData.username || 'Login';
            case 'address': return addressData.fullName || 'Address';
            case 'card': return cardData.holderName || 'Card';
            case 'totp': return totpData.label || totpData.issuer || 'TOTP';
            case 'passkey': return passkeyData.rpId || 'Passkey';
        }
    };

    const getDomain = () => {
        if (itemType === 'login') return normalizeDomain(loginData.url);
        if (itemType === 'passkey') return passkeyData.rpId;
        return undefined;
    };

    const getIcon = () => {
        if (itemType === 'login' && loginData.url) return getFaviconUrl(loginData.url);
        return undefined;
    };

    const inputClass = "w-full px-3 py-2 bg-vw-console-surface border border-vw-console-border rounded-lg text-sm text-white focus:outline-none focus:border-vw-gold";
    const labelClass = "block text-xs font-medium text-vw-console-text-secondary mb-1.5";

    return (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onCancel}>
            <div className="vw-card p-6 max-w-lg w-full max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-between mb-6">
                    <h2 className="text-lg font-semibold text-white">{item ? 'Edit' : 'New'} {ITEM_TYPE_CONFIG[itemType].label}</h2>
                    <button onClick={onCancel} className="text-vw-console-text-secondary hover:text-white"><X className="w-5 h-5" /></button>
                </div>

                <div className="space-y-4">
                    <div>
                        <label className={labelClass}>Label</label>
                        <input className={inputClass} value={label} onChange={(e) => setLabel(e.target.value)} placeholder={getDefaultLabel()} />
                    </div>

                    {itemType === 'login' && (
                        <>
                            <div>
                                <label className={labelClass}>URL</label>
                                <input className={inputClass} value={loginData.url} onChange={(e) => setLoginData({ ...loginData, url: e.target.value })} placeholder="https://example.com" />
                            </div>
                            <div>
                                <label className={labelClass}>Username or Email</label>
                                <input className={inputClass} value={loginData.username} onChange={(e) => setLoginData({ ...loginData, username: e.target.value })} />
                            </div>
                            <div>
                                <label className={labelClass}>Password</label>
                                <div className="flex gap-2">
                                    <input className={inputClass} type={showPassword ? 'text' : 'password'} value={loginData.password} onChange={(e) => setLoginData({ ...loginData, password: e.target.value })} />
                                    <button onClick={() => setShowPassword(!showPassword)} className="px-3 bg-vw-console-surface border border-vw-console-border rounded-lg text-vw-console-text-secondary hover:text-white">
                                        {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                    </button>
                                </div>
                            </div>
                            <div>
                                <label className={labelClass}>TOTP Secret (optional)</label>
                                <input className={inputClass} value={loginData.totpSecret ?? ''} onChange={(e) => setLoginData({ ...loginData, totpSecret: e.target.value })} placeholder="Base32 secret" />
                            </div>
                            <div>
                                <label className={labelClass}>Notes</label>
                                <textarea className={inputClass} rows={2} value={loginData.notes ?? ''} onChange={(e) => setLoginData({ ...loginData, notes: e.target.value })} />
                            </div>
                        </>
                    )}

                    {itemType === 'address' && (
                        <>
                            <div><label className={labelClass}>Full Name</label><input className={inputClass} value={addressData.fullName} onChange={(e) => setAddressData({ ...addressData, fullName: e.target.value })} /></div>
                            <div><label className={labelClass}>Street</label><input className={inputClass} value={addressData.street} onChange={(e) => setAddressData({ ...addressData, street: e.target.value })} /></div>
                            <div className="grid grid-cols-2 gap-3">
                                <div><label className={labelClass}>City</label><input className={inputClass} value={addressData.city} onChange={(e) => setAddressData({ ...addressData, city: e.target.value })} /></div>
                                <div><label className={labelClass}>State/Province</label><input className={inputClass} value={addressData.state} onChange={(e) => setAddressData({ ...addressData, state: e.target.value })} /></div>
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                                <div><label className={labelClass}>ZIP/Postal Code</label><input className={inputClass} value={addressData.zipCode} onChange={(e) => setAddressData({ ...addressData, zipCode: e.target.value })} /></div>
                                <div><label className={labelClass}>Country</label><input className={inputClass} value={addressData.country} onChange={(e) => setAddressData({ ...addressData, country: e.target.value })} /></div>
                            </div>
                            <div><label className={labelClass}>Phone (optional)</label><input className={inputClass} value={addressData.phone ?? ''} onChange={(e) => setAddressData({ ...addressData, phone: e.target.value })} /></div>
                        </>
                    )}

                    {itemType === 'card' && (
                        <>
                            <div><label className={labelClass}>Cardholder Name</label><input className={inputClass} value={cardData.holderName} onChange={(e) => setCardData({ ...cardData, holderName: e.target.value })} /></div>
                            <div><label className={labelClass}>Card Number</label><input className={`${inputClass} font-mono`} value={cardData.cardNumber} onChange={(e) => setCardData({ ...cardData, cardNumber: e.target.value })} placeholder="0000 0000 0000 0000" /></div>
                            <div className="grid grid-cols-3 gap-3">
                                <div><label className={labelClass}>Month</label><input className={inputClass} value={cardData.expiryMonth} onChange={(e) => setCardData({ ...cardData, expiryMonth: e.target.value })} placeholder="MM" /></div>
                                <div><label className={labelClass}>Year</label><input className={inputClass} value={cardData.expiryYear} onChange={(e) => setCardData({ ...cardData, expiryYear: e.target.value })} placeholder="YY" /></div>
                                <div><label className={labelClass}>CVV</label><input className={inputClass} type={showPassword ? 'text' : 'password'} value={cardData.cvv} onChange={(e) => setCardData({ ...cardData, cvv: e.target.value })} /></div>
                            </div>
                            <div><label className={labelClass}>Notes</label><textarea className={inputClass} rows={2} value={cardData.notes ?? ''} onChange={(e) => setCardData({ ...cardData, notes: e.target.value })} /></div>
                        </>
                    )}

                    {itemType === 'totp' && (
                        <>
                            <div><label className={labelClass}>Label</label><input className={inputClass} value={totpData.label} onChange={(e) => setTotpData({ ...totpData, label: e.target.value })} /></div>
                            <div><label className={labelClass}>Issuer (optional)</label><input className={inputClass} value={totpData.issuer ?? ''} onChange={(e) => setTotpData({ ...totpData, issuer: e.target.value })} /></div>
                            <div><label className={labelClass}>Secret (Base32)</label><input className={`${inputClass} font-mono`} value={totpData.secret} onChange={(e) => setTotpData({ ...totpData, secret: e.target.value.toUpperCase() })} /></div>
                            <div className="grid grid-cols-3 gap-3">
                                <div><label className={labelClass}>Digits</label><select className={inputClass} value={totpData.digits} onChange={(e) => setTotpData({ ...totpData, digits: parseInt(e.target.value) })}><option value={6}>6</option><option value={8}>8</option></select></div>
                                <div><label className={labelClass}>Period</label><select className={inputClass} value={totpData.period} onChange={(e) => setTotpData({ ...totpData, period: parseInt(e.target.value) })}><option value={30}>30s</option><option value={60}>60s</option></select></div>
                                <div><label className={labelClass}>Algorithm</label><select className={inputClass} value={totpData.algorithm} onChange={(e) => setTotpData({ ...totpData, algorithm: e.target.value as any })}><option value="SHA1">SHA1</option><option value="SHA256">SHA256</option><option value="SHA512">SHA512</option></select></div>
                            </div>
                        </>
                    )}

                    {itemType === 'passkey' && (
                        passkeyData.createdByAuthenticator ? (
                            /* Created by the built-in authenticator. The key material is
                               what the site verifies against, so it is shown read-only —
                               editing any of it would silently break sign-in. */
                            <>
                                <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-vw-console-border bg-vw-console-surface text-xs text-vw-console-text-secondary">
                                    <Fingerprint className="w-4 h-4 text-vw-violet flex-shrink-0" />
                                    <span>Created by VaultWares on {passkeyData.createdAt ? new Date(passkeyData.createdAt).toLocaleDateString() : 'this device'}. Key material is read-only.</span>
                                </div>
                                <div><label className={labelClass}>Relying Party</label><input className={inputClass} value={passkeyData.rpName || passkeyData.rpId} readOnly /></div>
                                <div><label className={labelClass}>Relying Party ID</label><input className={`${inputClass} font-mono`} value={passkeyData.rpId} readOnly /></div>
                                <div><label className={labelClass}>Account</label><input className={inputClass} value={passkeyData.userDisplayName || passkeyData.userName || ''} readOnly /></div>
                                <div><label className={labelClass}>Credential ID</label><input className={`${inputClass} font-mono`} value={passkeyData.credentialId} readOnly /></div>
                                <div><label className={labelClass}>Algorithm</label><input className={inputClass} value={passkeyData.algorithm === -7 ? 'ES256 (ECDSA P-256)' : String(passkeyData.algorithm ?? '')} readOnly /></div>
                                <div><label className={labelClass}>Notes</label><textarea className={inputClass} rows={2} value={passkeyData.notes ?? ''} onChange={(e) => setPasskeyData({ ...passkeyData, notes: e.target.value })} /></div>
                            </>
                        ) : (
                            <>
                                <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-vw-console-border bg-vw-console-surface text-xs text-vw-signal-warning">
                                    <AlertCircle className="w-4 h-4 flex-shrink-0 mt-px" />
                                    <span>Imported passkeys are stored but cannot be used to sign in — the authenticator only asserts with credentials it created.</span>
                                </div>
                                <div><label className={labelClass}>Relying Party ID</label><input className={inputClass} value={passkeyData.rpId} onChange={(e) => setPasskeyData({ ...passkeyData, rpId: e.target.value })} placeholder="example.com" /></div>
                                <div><label className={labelClass}>Credential ID</label><input className={`${inputClass} font-mono`} value={passkeyData.credentialId} onChange={(e) => setPasskeyData({ ...passkeyData, credentialId: e.target.value })} /></div>
                                <div><label className={labelClass}>Private Key</label><textarea className={`${inputClass} font-mono`} rows={3} value={passkeyData.privateKey} onChange={(e) => setPasskeyData({ ...passkeyData, privateKey: e.target.value })} /></div>
                                <div><label className={labelClass}>User Handle</label><input className={inputClass} value={passkeyData.userHandle} onChange={(e) => setPasskeyData({ ...passkeyData, userHandle: e.target.value })} /></div>
                                <div><label className={labelClass}>Notes</label><textarea className={inputClass} rows={2} value={passkeyData.notes ?? ''} onChange={(e) => setPasskeyData({ ...passkeyData, notes: e.target.value })} /></div>
                            </>
                        )
                    )}

                    <div className="flex items-center gap-2">
                        <button onClick={() => setFavorite(!favorite)} className={`flex items-center gap-1.5 text-xs ${favorite ? 'text-vw-gold' : 'text-vw-console-text-secondary'}`}>
                            <Star className={`w-4 h-4 ${favorite ? 'fill-vw-gold' : ''}`} /> Favorite
                        </button>
                    </div>
                </div>

                <div className="flex items-center justify-between mt-6 pt-4 border-t border-vw-console-border">
                    <div>
                        {onDelete && (
                            <button onClick={onDelete} className="flex items-center gap-1.5 px-3 py-2 text-sm text-vw-signal-alert hover:bg-vw-signal-alert/10 rounded-lg">
                                <Trash2 className="w-4 h-4" /> Delete
                            </button>
                        )}
                    </div>
                    <div className="flex items-center gap-2">
                        <button onClick={onCancel} className="px-4 py-2 text-sm text-vw-console-text-secondary hover:text-white">Cancel</button>
                        <button onClick={handleSave} className="px-4 py-2 bg-vw-gold text-vw-console-bg rounded-lg text-sm font-medium hover:bg-[#C69431]">Save</button>
                    </div>
                </div>
            </div>
        </div>
    );
}

function PasswordGeneratorPanel({ settings }: { settings: VaultSettings | null }) {
    const [password, setPassword] = useState('');
    const [activePresetId, setActivePresetId] = useState<string>(settings?.defaultGeneratorPreset ?? 'classic');
    const [copied, setCopied] = useState(false);

    const [pwOpts, setPwOpts] = useState<PasswordOptions>(PRESETS[0].passwordOpts ?? {
        length: 20, uppercase: true, lowercase: true, numbers: true, symbols: true, standardSymbolsOnly: true,
    });
    const [ppOpts, setPpOpts] = useState<PassphraseOptions>(PRESETS[1].passphraseOpts ?? {
        wordCount: 4, delimiter: '-', capitalize: true, suffixType: 'numeric', suffixLength: 3,
    });

    const activePreset = PRESETS.find(p => p.id === activePresetId) ?? PRESETS[0];

    const generate = async () => {
        if (activePreset.type === 'password') {
            setPassword(generatePassword(pwOpts));
        } else if (activePreset.type === 'passphrase') {
            setPassword(generatePassphrase(ppOpts));
        } else {
            setPassword(await generateToken());
        }
    };

    useEffect(() => { generate(); }, []);

    const score = measurePasswordStrength(password);
    const copy = () => { navigator.clipboard.writeText(password); setCopied(true); setTimeout(() => setCopied(false), 1500); };

    const inputClass = "w-full px-3 py-2 bg-vw-console-surface border border-vw-console-border rounded-lg text-sm text-white focus:outline-none focus:border-vw-gold";

    return (
        <div className="max-w-xl">
            <h1 className="text-2xl font-bold text-white mb-2">Password Generator</h1>
            <p className="text-sm text-vw-console-text-secondary mb-6">Generate cryptographically secure passwords</p>

            <div className="vw-card p-6 space-y-5">
                {/* Preset selector */}
                <div>
                    <label className="block text-xs font-medium text-vw-console-text-secondary mb-2">Preset</label>
                    <div className="flex gap-2">
                        {PRESETS.map(preset => (
                            <button
                                key={preset.id}
                                onClick={() => {
                                    setActivePresetId(preset.id);
                                    if (preset.passwordOpts) setPwOpts(preset.passwordOpts);
                                    if (preset.passphraseOpts) setPpOpts(preset.passphraseOpts);
                                }}
                                className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${
                                    activePresetId === preset.id
                                        ? 'bg-vw-gold text-vw-console-bg font-medium'
                                        : 'bg-vw-console-surface text-vw-console-text-secondary border border-vw-console-border hover:text-white'
                                }`}
                            >
                                {preset.label}
                            </button>
                        ))}
                    </div>
                    <p className="text-xs text-vw-console-text-secondary mt-1.5">{activePreset.description}</p>
                </div>

                {/* Generated output */}
                <div className="flex items-center gap-3">
                    <input
                        type="text"
                        readOnly
                        value={password}
                        className="flex-1 px-4 py-3 bg-vw-console-surface border border-vw-console-border rounded-lg text-white font-mono text-sm break-all"
                    />
                    <button onClick={copy} className="px-3 py-3 bg-vw-console-surface border border-vw-console-border rounded-lg text-vw-console-text-secondary hover:text-white">
                        {copied ? <Check className="w-4 h-4 text-vw-signal-online" /> : <Copy className="w-4 h-4" />}
                    </button>
                    <button onClick={generate} className="px-3 py-3 bg-vw-console-surface border border-vw-console-border rounded-lg text-vw-console-text-secondary hover:text-white">
                        <RefreshCw className="w-4 h-4" />
                    </button>
                </div>

                <div>
                    <div className="h-1.5 bg-vw-console-surface rounded-full overflow-hidden mb-1">
                        <div className="h-full rounded-full transition-all" style={{ width: `${((score + 1) / 5) * 100}%`, background: strengthColor(score) }} />
                    </div>
                    <p className="text-xs text-right text-vw-console-text-secondary">{strengthLabel(score)}</p>
                </div>

                {/* Password-type options */}
                {activePreset.type === 'password' && (
                    <>
                        <div>
                            <div className="flex items-center justify-between mb-2">
                                <label className="text-sm text-vw-console-text-secondary">Length: {pwOpts.length}</label>
                            </div>
                            <input type="range" min="8" max="64" value={pwOpts.length} onChange={(e) => setPwOpts({ ...pwOpts, length: parseInt(e.target.value) })} className="w-full accent-vw-gold" />
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                            {[
                                { label: 'Uppercase (A-Z)', key: 'uppercase' as const },
                                { label: 'Lowercase (a-z)', key: 'lowercase' as const },
                                { label: 'Numbers (0-9)', key: 'numbers' as const },
                                { label: 'Symbols (!@#)', key: 'symbols' as const },
                            ].map(({ label, key }) => (
                                <label key={label} className="flex items-center gap-2 text-sm text-vw-console-text-secondary cursor-pointer">
                                    <input type="checkbox" checked={pwOpts[key]} onChange={(e) => setPwOpts({ ...pwOpts, [key]: e.target.checked })} className="accent-vw-gold" />
                                    {label}
                                </label>
                            ))}
                        </div>
                        {pwOpts.symbols && (
                            <label className="flex items-center gap-2 text-sm text-vw-console-text-secondary cursor-pointer">
                                <input type="checkbox" checked={pwOpts.standardSymbolsOnly} onChange={(e) => setPwOpts({ ...pwOpts, standardSymbolsOnly: e.target.checked })} className="accent-vw-gold" />
                                Standard symbols only (!@#$%^&*()-_=+)
                            </label>
                        )}
                    </>
                )}

                {/* Passphrase-type options */}
                {activePreset.type === 'passphrase' && (
                    <>
                        <div>
                            <label className="block text-xs font-medium text-vw-console-text-secondary mb-1.5">Word count: {ppOpts.wordCount}</label>
                            <input type="range" min="2" max="8" value={ppOpts.wordCount} onChange={(e) => setPpOpts({ ...ppOpts, wordCount: parseInt(e.target.value) })} className="w-full accent-vw-gold" />
                        </div>
                        <div>
                            <label className="block text-xs font-medium text-vw-console-text-secondary mb-1.5">Delimiter</label>
                            <input className={inputClass} value={ppOpts.delimiter} onChange={(e) => setPpOpts({ ...ppOpts, delimiter: e.target.value })} maxLength={3} />
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <label className="block text-xs font-medium text-vw-console-text-secondary mb-1.5">Suffix type</label>
                                <select className={inputClass} value={ppOpts.suffixType} onChange={(e) => setPpOpts({ ...ppOpts, suffixType: e.target.value as any })}>
                                    <option value="none">None</option>
                                    <option value="numeric">Numeric</option>
                                    <option value="alphanumeric">Alphanumeric</option>
                                </select>
                            </div>
                            <div>
                                <label className="block text-xs font-medium text-vw-console-text-secondary mb-1.5">Suffix length: {ppOpts.suffixLength}</label>
                                <input type="range" min="0" max="8" value={ppOpts.suffixLength} onChange={(e) => setPpOpts({ ...ppOpts, suffixLength: parseInt(e.target.value) })} className="w-full accent-vw-gold" />
                            </div>
                        </div>
                        <label className="flex items-center gap-2 text-sm text-vw-console-text-secondary cursor-pointer">
                            <input type="checkbox" checked={ppOpts.capitalize} onChange={(e) => setPpOpts({ ...ppOpts, capitalize: e.target.checked })} className="accent-vw-gold" />
                            Capitalize first letter of each word
                        </label>
                    </>
                )}

                {/* Token type info */}
                {activePreset.type === 'token' && (
                    <p className="text-xs text-vw-console-text-secondary">
                        Generates a JWT-like token with three base64url segments separated by dots. No configuration needed.
                    </p>
                )}

                <button onClick={generate} className="w-full py-2.5 bg-vw-gold text-vw-console-bg rounded-lg font-medium hover:bg-[#C69431] flex items-center justify-center gap-2">
                    <RefreshCw className="w-4 h-4" /> Generate
                </button>
            </div>
        </div>
    );
}

function ItemTypeSelector({ onSelect, onCancel }: {
    onSelect: (type: ItemType) => void;
    onCancel: () => void;
}) {
    const types: { type: ItemType; label: string; icon: React.ReactNode; desc: string }[] = [
        { type: 'login', label: 'Login', icon: <Key className="w-6 h-6" />, desc: 'Username, password, URL' },
        { type: 'address', label: 'Address', icon: <MapPin className="w-6 h-6" />, desc: 'Full postal address' },
        { type: 'card', label: 'Card', icon: <CreditCard className="w-6 h-6" />, desc: 'Credit/debit card details' },
        { type: 'totp', label: 'TOTP', icon: <Clock className="w-6 h-6" />, desc: 'Authenticator secret' },
        { type: 'passkey', label: 'Passkey', icon: <Fingerprint className="w-6 h-6" />, desc: 'WebAuthn credential' },
    ];

    return (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onCancel}>
            <div className="vw-card p-6 max-w-md w-full" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-between mb-6">
                    <h2 className="text-lg font-semibold text-white">New Item Type</h2>
                    <button onClick={onCancel} className="text-vw-console-text-secondary hover:text-white"><X className="w-5 h-5" /></button>
                </div>
                <div className="space-y-2">
                    {types.map(({ type, label, icon, desc }) => (
                        <button
                            key={type}
                            onClick={() => onSelect(type)}
                            className="w-full flex items-center gap-4 p-4 bg-vw-console-surface border border-vw-console-border rounded-lg hover:border-vw-gold/30 transition-colors text-left"
                        >
                            <div className="w-12 h-12 rounded-lg bg-vw-console-elevated flex items-center justify-center text-vw-gold flex-shrink-0">
                                {icon}
                            </div>
                            <div>
                                <div className="text-sm font-medium text-white">{label}</div>
                                <div className="text-xs text-vw-console-text-secondary">{desc}</div>
                            </div>
                            <ChevronRight className="w-4 h-4 text-vw-console-text-secondary ml-auto" />
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
}

function SettingsPanel({ settings, onSave }: { settings: VaultSettings | null; onSave: (s: VaultSettings) => Promise<void> }) {
    const [local, setLocal] = useState<VaultSettings>(settings ?? DEFAULT_SETTINGS);
    const [saved, setSaved] = useState(false);

    const handleSave = async () => {
        await onSave(local);
        setSaved(true);
        setTimeout(() => setSaved(false), 1500);
    };

    const inputClass = "px-3 py-2 bg-vw-console-surface border border-vw-console-border rounded-lg text-sm text-white focus:outline-none focus:border-vw-gold";

    return (
        <div className="max-w-xl">
            <h1 className="text-2xl font-bold text-white mb-6">Settings</h1>
            <div className="vw-card p-6 space-y-5">
                <div>
                    <label className="block text-xs font-medium text-vw-console-text-secondary mb-1.5">Auto-lock (minutes)</label>
                    <input type="number" min="0" max="120" className={inputClass} value={local.autoLockMinutes} onChange={(e) => setLocal({ ...local, autoLockMinutes: parseInt(e.target.value) || 0 })} />
                </div>
                <div>
                    <label className="block text-xs font-medium text-vw-console-text-secondary mb-1.5">Default password length</label>
                    <input type="number" min="8" max="64" className={inputClass} value={local.defaultPasswordLength} onChange={(e) => setLocal({ ...local, defaultPasswordLength: parseInt(e.target.value) || 20 })} />
                </div>
                <div>
                    <label className="block text-xs font-medium text-vw-console-text-secondary mb-1.5">Default complexity</label>
                    <select className={inputClass} value={local.defaultPasswordComplexity} onChange={(e) => setLocal({ ...local, defaultPasswordComplexity: e.target.value as any })}>
                        <option value="medium">Medium</option>
                        <option value="high">High</option>
                        <option value="maximum">Maximum</option>
                    </select>
                </div>
                <div>
                    <label className="block text-xs font-medium text-vw-console-text-secondary mb-1.5">Default generator preset</label>
                    <select className={inputClass} value={local.defaultGeneratorPreset} onChange={(e) => setLocal({ ...local, defaultGeneratorPreset: e.target.value })}>
                        {PRESETS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                    </select>
                </div>
                <label className="flex items-center gap-2 text-sm text-vw-console-text-secondary cursor-pointer">
                    <input type="checkbox" checked={local.autoFillEnabled} onChange={(e) => setLocal({ ...local, autoFillEnabled: e.target.checked })} className="accent-vw-gold" />
                    Auto-fill forms
                </label>
                <label className="flex items-center gap-2 text-sm text-vw-console-text-secondary cursor-pointer">
                    <input type="checkbox" checked={local.autoDetectEnabled} onChange={(e) => setLocal({ ...local, autoDetectEnabled: e.target.checked })} className="accent-vw-gold" />
                    Auto-detect login/signup forms
                </label>
                <label className="flex items-center gap-2 text-sm text-vw-console-text-secondary cursor-pointer">
                    <input type="checkbox" checked={local.savePromptEnabled} onChange={(e) => setLocal({ ...local, savePromptEnabled: e.target.checked })} className="accent-vw-gold" />
                    Offer to save logins after sign-in
                </label>
                <div>
                    <label className="flex items-center gap-2 text-sm text-vw-console-text-secondary cursor-pointer">
                        <input type="checkbox" checked={local.passkeysEnabled} onChange={(e) => setLocal({ ...local, passkeysEnabled: e.target.checked })} className="accent-vw-gold" />
                        Handle passkeys in VaultWares
                    </label>
                    <p className="text-[11px] text-vw-console-text-secondary/60 mt-1 ml-6">
                        Off hands every passkey prompt to your browser or security key instead.
                    </p>
                </div>
                <button onClick={handleSave} className="w-full py-2.5 bg-vw-gold text-vw-console-bg rounded-lg font-medium hover:bg-[#C69431] flex items-center justify-center gap-2">
                    {saved ? <><Check className="w-4 h-4" /> Saved</> : 'Save Settings'}
                </button>
            </div>
        </div>
    );
}

function DevicesPanel() {
    const [devices, setDevices] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        import('../api/devices').then(({ listDevices }) => {
            listDevices().then((resp) => {
                setDevices(resp.devices);
                setLoading(false);
            }).catch(() => setLoading(false));
        });
    }, []);

    return (
        <div className="max-w-xl">
            <h1 className="text-2xl font-bold text-white mb-6">Devices</h1>
            {loading ? (
                <div className="flex items-center gap-2 text-vw-console-text-secondary"><Loader2 className="w-4 h-4 animate-spin" /> Loading devices…</div>
            ) : devices.length === 0 ? (
                <div className="vw-card p-6 text-center">
                    <Monitor className="w-10 h-10 text-vw-console-text-secondary/30 mx-auto mb-2" />
                    <p className="text-sm text-vw-console-text-secondary">No devices registered yet.</p>
                </div>
            ) : (
                <div className="space-y-3">
                    {devices.map((dev) => (
                        <div key={dev.id} className="vw-card p-4 flex items-center gap-4">
                            <Monitor className="w-5 h-5 text-vw-console-text-secondary" />
                            <div className="flex-1">
                                <div className="text-sm font-medium text-white">{dev.deviceName}</div>
                                <div className="text-xs text-vw-console-text-secondary">{dev.platform} · {dev.deviceClass}</div>
                            </div>
                            <div className="flex items-center gap-2">
                                {dev.deviceRole === 'master' && (
                                    <span className="px-2 py-0.5 text-xs bg-vw-gold/20 text-vw-gold rounded-full font-medium">Master</span>
                                )}
                                <span className={`w-2 h-2 rounded-full vw-led ${dev.approvalState === 'approved' ? 'bg-vw-signal-online' : dev.approvalState === 'pending' ? 'bg-vw-signal-warning' : 'bg-vw-signal-alert'}`} />
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

function relativeTime(iso: string): string {
    const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (seconds < 60) return 'just now';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
}

function SyncStatusLine({ status, syncing }: { status: SyncStatus | null; syncing: boolean }) {
    let text: string;
    let tone = 'text-[#161320]/45';

    if (syncing) {
        text = 'Syncing…';
    } else if (status?.state === 'error') {
        text = status.error ?? 'Sync failed';
        tone = 'text-vw-signal-alert';
    } else if (status?.lastSuccessAt) {
        text = `Synced ${relativeTime(status.lastSuccessAt)}`;
    } else {
        text = 'Not synced yet';
    }

    return (
        <div className="px-3 pb-1">
            <p className={`text-[10px] ${tone}`}>{text}</p>
            {/* Sync only covers vault items today — identities live on this
                device alone. Saying so beats letting the user assume otherwise. */}
            <p className="text-[10px] text-[#161320]/35">Items only — identities stay local</p>
        </div>
    );
}

function IdentityCard({ identity, itemCount, onClick }: { identity: Identity; itemCount: number; onClick: () => void }) {
    return (
        <div onClick={onClick} className="vw-card p-5 cursor-pointer hover:border-vw-gold/30 transition-colors group">
            <div className="flex items-start gap-4">
                <div className="w-14 h-14 rounded-xl bg-vw-console-surface flex items-center justify-center flex-shrink-0 overflow-hidden">
                    {identity.facePhoto ? (
                        <img src={identity.facePhoto} alt="" className="w-full h-full object-cover" />
                    ) : (
                        <User className="w-6 h-6 text-vw-gold" />
                    )}
                </div>
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                        <h3 className="text-sm font-semibold text-white truncate">{identity.fullName}</h3>
                        {identity.metadata.favorite && <Star className="w-3 h-3 text-vw-gold fill-vw-gold flex-shrink-0" />}
                    </div>
                    <p className="text-xs text-vw-console-text-secondary truncate">{identity.nationality} · {identity.email}</p>
                    <p className="text-[10px] text-vw-console-text-secondary/60 mt-1 line-clamp-2">{identity.bio}</p>
                    <div className="flex items-center gap-2 mt-2">
                        <span className="text-[10px] px-2 py-0.5 bg-vw-console-surface rounded-full text-vw-console-text-secondary">
                            {itemCount} {itemCount === 1 ? 'item' : 'items'}
                        </span>
                    </div>
                </div>
            </div>
        </div>
    );
}

function IdentityEditorModal({ mode, data, onSave, onCancel }: {
    mode: IdentityEditorMode;
    data: GeneratedIdentityData;
    onSave: (data: GeneratedIdentityData) => void;
    onCancel: () => void;
}) {
    const [local, setLocal] = useState<GeneratedIdentityData>(data);
    const [validationError, setValidationError] = useState('');

    const inputClass = "w-full px-3 py-2 bg-vw-console-surface border border-vw-console-border rounded-lg text-sm text-white focus:outline-none focus:border-vw-gold";
    const labelClass = "block text-xs font-medium text-vw-console-text-secondary mb-1.5";

    const title = mode === 'review'
        ? t('identityReviewTitle')
        : mode === 'edit' ? t('identityEditTitle') : t('identityNewTitle');

    const submit = () => {
        if (!local.fullName.trim()) {
            setValidationError(t('identityNameRequired'));
            return;
        }
        setValidationError('');
        // A record written by an older version — or returned by a generation
        // endpoint that omitted the block — may have no address at all, so it
        // is defaulted rather than destructured blind.
        const address = local.address ?? emptyIdentityData().address;
        // The address carries its own name field; keep it in step with the
        // persona so autofill does not put two different names on one form.
        onSave({
            ...local,
            address: {
                ...address,
                fullName: (address.fullName ?? '').trim() || local.fullName,
                phone: address.phone || local.phone,
            },
        });
    };

    return (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onCancel}>
            <div className="vw-card p-6 max-w-lg w-full max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-between mb-6">
                    <div className="flex items-center gap-2">
                        {mode === 'review' ? <Sparkles className="w-5 h-5 text-vw-gold" /> : <User className="w-5 h-5 text-vw-gold" />}
                        <h2 className="text-lg font-semibold text-white">{title}</h2>
                    </div>
                    <button onClick={onCancel} className="text-vw-console-text-secondary hover:text-white"><X className="w-5 h-5" /></button>
                </div>

                {validationError && (
                    <div className="flex items-center gap-2 mb-4 px-3 py-2 rounded-lg border border-vw-signal-alert/40 bg-vw-signal-alert/10 text-xs text-vw-signal-alert">
                        <AlertCircle className="w-4 h-4 flex-shrink-0" />
                        <span>{validationError}</span>
                    </div>
                )}

                <div className="space-y-4">
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className={labelClass}>Full Name</label>
                            <input
                                className={inputClass}
                                value={local.fullName}
                                autoFocus
                                placeholder="Jean Tremblay"
                                onChange={(e) => setLocal({ ...local, fullName: e.target.value })}
                            />
                        </div>
                        <div>
                            <label className={labelClass}>Gender</label>
                            <select className={inputClass} value={local.gender} onChange={(e) => setLocal({ ...local, gender: e.target.value as any })}>
                                <option value="male">Male</option>
                                <option value="female">Female</option>
                                <option value="non-binary">Non-binary</option>
                                <option value="other">Other</option>
                            </select>
                        </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className={labelClass}>Birth Date</label>
                            <input type="date" className={inputClass} value={local.birthDate} onChange={(e) => setLocal({ ...local, birthDate: e.target.value })} />
                        </div>
                        <div>
                            <label className={labelClass}>Nationality</label>
                            <input className={inputClass} placeholder="Canada" value={local.nationality} onChange={(e) => setLocal({ ...local, nationality: e.target.value })} />
                        </div>
                    </div>
                    <div>
                        <label className={labelClass}>Bio</label>
                        <textarea className={inputClass} rows={2} value={local.bio} onChange={(e) => setLocal({ ...local, bio: e.target.value })} />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className={labelClass}>Email</label>
                            <input className={inputClass} value={local.email} onChange={(e) => setLocal({ ...local, email: e.target.value })} />
                        </div>
                        <div>
                            <label className={labelClass}>Phone</label>
                            <input className={inputClass} value={local.phone} onChange={(e) => setLocal({ ...local, phone: e.target.value })} />
                        </div>
                    </div>
                    <div className="border-t border-vw-console-border pt-4">
                        <p className="text-xs font-medium text-vw-console-text-secondary mb-3">Address</p>
                        <div className="space-y-3">
                            <input className={inputClass} placeholder="Street" value={local.address.street} onChange={(e) => setLocal({ ...local, address: { ...local.address, street: e.target.value } })} />
                            <div className="grid grid-cols-2 gap-3">
                                <input className={inputClass} placeholder="City" value={local.address.city} onChange={(e) => setLocal({ ...local, address: { ...local.address, city: e.target.value } })} />
                                <input className={inputClass} placeholder="State" value={local.address.state} onChange={(e) => setLocal({ ...local, address: { ...local.address, state: e.target.value } })} />
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                                <input className={inputClass} placeholder="ZIP" value={local.address.zipCode} onChange={(e) => setLocal({ ...local, address: { ...local.address, zipCode: e.target.value } })} />
                                <input className={inputClass} placeholder="Country" value={local.address.country} onChange={(e) => setLocal({ ...local, address: { ...local.address, country: e.target.value } })} />
                            </div>
                        </div>
                    </div>
                </div>

                <div className="flex items-center justify-end gap-3 mt-6">
                    <button onClick={onCancel} className="px-4 py-2 text-sm text-vw-console-text-secondary hover:text-white">Discard</button>
                    <button onClick={submit} className="px-4 py-2 bg-vw-gold text-vw-console-bg rounded-lg text-sm font-medium hover:bg-[#C69431]">
                        {t('identitySave')}
                    </button>
                </div>
            </div>
        </div>
    );
}

function IdentityDetailView({ identity, items, allItems, onBack, onDelete, onEdit, onEditItem, onAssignItem, onUnassignItem, onCreateItem }: {
    identity: Identity;
    items: VaultItem[];
    allItems: VaultItem[];
    onBack: () => void;
    onDelete: () => void;
    onEdit: () => void;
    onEditItem: (item: VaultItem) => void;
    onAssignItem: (itemId: string) => void;
    onUnassignItem: (itemId: string) => void;
    onCreateItem: () => void;
}) {
    const [showAssignList, setShowAssignList] = useState(false);
    const unassignedItems = allItems.filter(i => !i.identityId && !i.deletedAt);

    return (
        <div>
            <div className="flex items-center gap-3 mb-6">
                <button onClick={onBack} className="text-vw-console-text-secondary hover:text-white flex items-center gap-1 text-sm">
                    <ChevronRight className="w-4 h-4 rotate-180" /> Back
                </button>
            </div>

            <div className="flex items-start gap-6 mb-8">
                <div className="w-20 h-20 rounded-2xl bg-vw-console-surface flex items-center justify-center flex-shrink-0 overflow-hidden">
                    {identity.facePhoto ? (
                        <img src={identity.facePhoto} alt="" className="w-full h-full object-cover" />
                    ) : (
                        <User className="w-8 h-8 text-vw-gold" />
                    )}
                </div>
                <div className="flex-1">
                    <h1 className="text-2xl font-bold text-white">{identity.fullName}</h1>
                    <p className="text-sm text-vw-console-text-secondary mt-1">{identity.gender} · {identity.birthDate} · {identity.nationality}</p>
                    <p className="text-sm text-vw-console-text-secondary/80 mt-2">{identity.bio}</p>
                </div>
                <div className="flex items-center gap-4">
                    <button onClick={onEdit} className="text-vw-console-text-secondary hover:text-white text-sm flex items-center gap-1">
                        <Settings className="w-4 h-4" /> Edit
                    </button>
                    <button onClick={onDelete} className="text-vw-signal-alert/60 hover:text-vw-signal-alert text-sm flex items-center gap-1">
                        <Trash2 className="w-4 h-4" /> Delete
                    </button>
                </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
                <div className="vw-card p-4">
                    <p className="text-xs font-medium text-vw-console-text-secondary uppercase tracking-wider mb-2">Contact</p>
                    <div className="space-y-1.5">
                        <div className="flex items-center gap-2 text-sm text-white">
                            <span className="text-vw-console-text-secondary text-xs w-16">Email</span> {identity.email}
                        </div>
                        <div className="flex items-center gap-2 text-sm text-white">
                            <span className="text-vw-console-text-secondary text-xs w-16">Phone</span> {identity.phone}
                        </div>
                    </div>
                </div>
                <div className="vw-card p-4">
                    <p className="text-xs font-medium text-vw-console-text-secondary uppercase tracking-wider mb-2">Address</p>
                    <div className="text-sm text-white space-y-0.5">
                        <p>{identity.address.street}</p>
                        <p>{identity.address.city}, {identity.address.state} {identity.address.zipCode}</p>
                        <p>{identity.address.country}</p>
                    </div>
                </div>
            </div>

            <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold text-white">Linked Items ({items.length})</h2>
                <div className="flex items-center gap-2">
                    <button onClick={() => setShowAssignList(!showAssignList)} className="text-xs text-vw-gold hover:underline">
                        {showAssignList ? 'Cancel' : 'Assign existing item'}
                    </button>
                    <button onClick={onCreateItem} className="flex items-center gap-1 text-xs text-vw-gold hover:underline">
                        <Plus className="w-3 h-3" /> New item
                    </button>
                </div>
            </div>

            {showAssignList && unassignedItems.length > 0 && (
                <div className="vw-card p-3 mb-4 space-y-1">
                    {unassignedItems.map((item) => (
                        <div key={item.id} className="flex items-center justify-between p-2 hover:bg-vw-console-surface rounded-lg cursor-pointer" onClick={() => { onAssignItem(item.id); setShowAssignList(false); }}>
                            <div className="flex items-center gap-2">
                                <span className="text-xs text-vw-console-text-secondary uppercase">{item.itemType}</span>
                                <span className="text-sm text-white">{item.metadata.label}</span>
                            </div>
                            <Plus className="w-3 h-3 text-vw-gold" />
                        </div>
                    ))}
                </div>
            )}

            {items.length === 0 ? (
                <p className="text-sm text-vw-console-text-secondary py-8 text-center">No items linked to this identity yet.</p>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {items.map((item) => (
                        <div key={item.id} className="vw-card p-4 group">
                            <div className="flex items-start justify-between">
                                <div className="flex items-center gap-3 flex-1 min-w-0 cursor-pointer" onClick={() => onEditItem(item)}>
                                    <div className="w-9 h-9 rounded-lg bg-vw-console-surface flex items-center justify-center flex-shrink-0">
                                        {ITEM_TYPE_CONFIG[item.itemType]?.icon}
                                    </div>
                                    <div className="min-w-0">
                                        <div className="text-sm font-medium text-white truncate">{item.metadata.label}</div>
                                        <div className="text-xs text-vw-console-text-secondary capitalize">{item.itemType}</div>
                                    </div>
                                </div>
                                <button onClick={() => onUnassignItem(item.id)} className="text-vw-console-text-secondary hover:text-vw-signal-alert opacity-0 group-hover:opacity-100 transition-opacity text-xs" title="Unassign">
                                    <X className="w-3.5 h-3.5" />
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
