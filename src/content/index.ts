/**
 * Page agent: detects credential forms, offers vault entries, fills them, and
 * offers to save what the user submits.
 *
 * Runs at document_idle in the isolated world. The passkey authenticator is a
 * separate pair of scripts (`webauthn-inject` / `webauthn-bridge`) because it
 * has to be in place at document_start.
 */

import {
    detectForms,
    formForElement,
    fillForm,
    isVisible,
    type DetectedForm,
    type DetectedField,
    type FieldRole,
} from './detect';
import { showMenu, closeMenu, isMenuOpen } from './menu';
import { showSavePrompt } from './save-prompt';
import { t } from '../i18n/strings';
import type { VaultItem, LoginItem, CardItem, AddressItem, PasskeyItem, VaultSettings } from '../types';

const RESCAN_DEBOUNCE_MS = 300;
const PROACTIVE_DELAY_MS = 700;

/** Roles worth opening the menu for when focused. */
const TRIGGER_ROLES: ReadonlySet<FieldRole> = new Set<FieldRole>([
    'username', 'email', 'password', 'newPassword', 'totp', 'cardNumber',
]);

interface PendingSaveDecision {
    status: 'new' | 'existing' | 'locked';
    itemId?: string;
    samePassword?: boolean;
}

function send<T>(type: string, payload?: unknown): Promise<{ success: boolean; data?: T; error?: string }> {
    return new Promise(resolve => {
        chrome.runtime.sendMessage({ type, payload }, response => {
            if (chrome.runtime.lastError) {
                resolve({ success: false, error: chrome.runtime.lastError.message });
                return;
            }
            resolve(response ?? { success: false, error: 'No response' });
        });
    });
}

/* ------------------------------------------------------------------ state */

let settings: VaultSettings | null = null;
let forms: DetectedForm[] = [];
const wiredFields = new WeakSet<HTMLInputElement>();
let proactiveShown = false;

/* ---------------------------------------------------------------- filling */

function fillDataForItem(item: VaultItem): Partial<Record<FieldRole, string>> {
    switch (item.itemType) {
        case 'login': {
            const login = item.data as LoginItem;
            return {
                username: login.username || '',
                email: login.username?.includes('@') ? login.username : '',
                password: login.password || '',
                newPassword: login.password || '',
                totp: login.totpSecret || '',
            };
        }
        case 'card': {
            const card = item.data as CardItem;
            return {
                cardNumber: card.cardNumber || '',
                cardHolder: card.holderName || '',
                cvv: card.cvv || '',
                expiry: card.expiryMonth && card.expiryYear
                    ? `${card.expiryMonth}/${card.expiryYear}`
                    : '',
            };
        }
        case 'address': {
            const address = item.data as AddressItem;
            return {
                fullName: address.fullName || '',
                street: address.street || '',
                city: address.city || '',
                state: address.state || '',
                zipCode: address.zipCode || '',
                country: address.country || '',
                phone: address.phone || '',
            };
        }
        default:
            return {};
    }
}

function subtitleFor(item: VaultItem): string {
    switch (item.itemType) {
        case 'login': return (item.data as LoginItem).username || '';
        case 'card': return `•••• ${(item.data as CardItem).cardNumber.slice(-4)}`;
        case 'address': return (item.data as AddressItem).city || '';
        case 'passkey': return (item.data as PasskeyItem).userName || (item.data as PasskeyItem).rpId;
        default: return '';
    }
}

/* ------------------------------------------------------------------- menu */

async function openMenuFor(field: DetectedField): Promise<void> {
    const form = formForElement(forms, field.element);
    if (!form) return;

    const response = await send<VaultItem[]>('GET_PAGE_MATCHES', { url: window.location.href });
    const matches = response.data ?? [];

    // Passkeys are listed for awareness only. A ceremony can only be started by
    // the site calling navigator.credentials.get(), so a clickable entry here
    // would promise a sign-in this menu cannot perform.
    const passkeys = matches.filter(item => item.itemType === 'passkey');
    const fillable = matches.filter(item => item.itemType !== 'passkey');

    const grouped = [...fillable].sort((a, b) => {
        if (!!a.identityId !== !!b.identityId) return a.identityId ? -1 : 1;
        return (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? '');
    });

    showMenu({
        anchor: field.element,
        header: form.kind === 'signup' ? t('menuSignupHeader') : t('menuLoginsHeader'),
        notice: passkeys.length
            ? `${t('menuPasskeyBadge')}: ${passkeys[0].metadata.label}`
            : undefined,
        emptyMessage: response.success ? t('menuNoMatches') : t('menuLocked'),
        entries: grouped.map(item => ({
            id: item.id,
            label: item.metadata.label,
            sublabel: subtitleFor(item),
            group: item.identityId ? (item.metadata.label.split(' ')[0] || t('menuIdentityFallback')) : undefined,
            onChoose: () => {
                fillForm(form, fillDataForItem(item));
                void send('UPDATE_ITEM_LAST_USED', { itemId: item.id });
            },
        })),
        footerLabel: t('menuCreateForSite'),
        onFooter: () => {
            void send('OPEN_POPUP_CREATE', { url: window.location.href });
        },
    });
}

/* ------------------------------------------------------------ save prompt */

function readCredentials(form: DetectedForm): { username: string; password: string } | null {
    const password = form.fields.find(f => f.role === 'password' || f.role === 'newPassword');
    if (!password?.element.value) return null;

    const identifier = form.fields.find(f => f.role === 'username' || f.role === 'email');
    return {
        username: identifier?.element.value ?? '',
        password: password.element.value,
    };
}

async function offerToSave(form: DetectedForm): Promise<void> {
    if (!settings?.savePromptEnabled) return;
    if (form.kind === 'payment') return;

    const credentials = readCredentials(form);
    if (!credentials) return;

    const response = await send<PendingSaveDecision>('QUEUE_SAVE_PROMPT', {
        url: window.location.href,
        ...credentials,
    });

    const decision = response.data;
    if (!decision || decision.status === 'locked') return;
    if (decision.status === 'existing' && decision.samePassword) return;

    showSavePrompt({
        mode: decision.status === 'existing' ? 'update' : 'save',
        domain: window.location.hostname,
        username: credentials.username,
        onConfirm: () => {
            void send('SAVE_LOGIN_FROM_PAGE', {
                url: window.location.href,
                ...credentials,
                itemId: decision.itemId,
            });
            void send('CLEAR_PENDING_SAVE');
        },
        onDismiss: () => { void send('CLEAR_PENDING_SAVE'); },
    });
}

/**
 * A submit that navigates kills this script before the prompt can be answered,
 * so the background holds the pending save and the next page load picks it up.
 */
async function showPendingSaveFromPreviousPage(): Promise<void> {
    if (!settings?.savePromptEnabled) return;

    const response = await send<{
        url: string;
        username: string;
        password: string;
        decision: PendingSaveDecision;
    } | null>('GET_PENDING_SAVE');

    const pending = response.data;
    if (!pending) return;

    showSavePrompt({
        mode: pending.decision.status === 'existing' ? 'update' : 'save',
        domain: new URL(pending.url).hostname,
        username: pending.username,
        onConfirm: () => {
            void send('SAVE_LOGIN_FROM_PAGE', {
                url: pending.url,
                username: pending.username,
                password: pending.password,
                itemId: pending.decision.itemId,
            });
            void send('CLEAR_PENDING_SAVE');
        },
        onDismiss: () => { void send('CLEAR_PENDING_SAVE'); },
    });
}

/* ----------------------------------------------------------------- wiring */

function wireForm(form: DetectedForm): void {
    for (const field of form.fields) {
        if (wiredFields.has(field.element)) continue;
        if (!TRIGGER_ROLES.has(field.role)) continue;
        wiredFields.add(field.element);

        field.element.addEventListener('focus', () => {
            if (!settings?.autoFillEnabled) return;
            void openMenuFor(field);
        });
    }

    if (form.scope instanceof HTMLFormElement && !form.scope.dataset.vwSubmitWired) {
        form.scope.dataset.vwSubmitWired = '1';
        form.scope.addEventListener('submit', () => { void offerToSave(form); }, true);
    }
}

/**
 * Sites that never fire a real `submit` (most SPA login pages post via fetch)
 * still have a button the user presses. Capturing at the document level catches
 * both without needing per-site rules.
 */
function wireGlobalSubmitFallback(): void {
    document.addEventListener('click', event => {
        const target = event.target as HTMLElement | null;
        const button = target?.closest('button, input[type=submit], [role=button]');
        if (!button) return;

        const form = forms.find(f => f.scope.contains(button) || f.scope === button);
        if (!form) return;
        // Let the page's own handler run first, then read the fields.
        setTimeout(() => { void offerToSave(form); }, 150);
    }, true);

    document.addEventListener('keydown', event => {
        if (event.key !== 'Enter') return;
        const active = document.activeElement;
        if (!(active instanceof HTMLInputElement)) return;
        const form = formForElement(forms, active);
        if (!form) return;
        setTimeout(() => { void offerToSave(form); }, 150);
    }, true);
}

/* ------------------------------------------------------------------ scan */

function rescan(): void {
    if (!settings?.autoDetectEnabled) return;

    forms = detectForms();
    for (const form of forms) wireForm(form);

    // Close a menu whose field has been removed or hidden by a re-render.
    if (isMenuOpen()) {
        const active = document.activeElement;
        if (!(active instanceof HTMLInputElement) || !isVisible(active)) closeMenu();
    }
}

function scheduleRescan(): void {
    if (scheduleRescan.handle) clearTimeout(scheduleRescan.handle);
    scheduleRescan.handle = setTimeout(rescan, RESCAN_DEBOUNCE_MS);
}
scheduleRescan.handle = undefined as ReturnType<typeof setTimeout> | undefined;

function observeDom(): void {
    // Debounced because SPA pages mutate constantly; a scan per mutation would
    // blow the 16.7ms frame budget on any busy page.
    const observer = new MutationObserver(mutations => {
        for (const mutation of mutations) {
            if (mutation.type !== 'childList') continue;
            if (mutation.addedNodes.length === 0) continue;
            scheduleRescan();
            return;
        }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
}

/* ------------------------------------------------------------------- init */

async function init(): Promise<void> {
    const response = await send<VaultSettings>('GET_SETTINGS');
    settings = response.data ?? null;
    if (!settings) return;

    rescan();
    observeDom();
    wireGlobalSubmitFallback();
    void showPendingSaveFromPreviousPage();

    // A login page the user landed on directly: offer matches without making
    // them click into the field first.
    if (settings.autoFillEnabled) {
        setTimeout(() => {
            if (proactiveShown || isMenuOpen()) return;
            const loginForm = forms.find(f => f.kind === 'login' && f.score >= 65);
            const field = loginForm?.fields.find(f => TRIGGER_ROLES.has(f.role));
            if (!field || !isVisible(field.element)) return;
            proactiveShown = true;
            void openMenuFor(field);
        }, PROACTIVE_DELAY_MS);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => void init());
} else {
    void init();
}

/* ------------------------------------------------- popup-triggered autofill */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type !== 'AUTOFILL') return false;

    if (forms.length === 0) rescan();
    const target = forms.find(f => f.kind !== 'payment') ?? forms[0];
    if (!target) {
        sendResponse({ success: false, error: 'No form detected on this page' });
        return true;
    }

    const filled = fillForm(target, message.payload ?? {});
    sendResponse({ success: filled > 0, error: filled > 0 ? undefined : 'No matching fields on this page' });
    return true;
});
