/**
 * "Save this login?" prompt, shown after a credential is submitted.
 *
 * Without this, a password generated in the popup and typed into a sign-up form
 * is lost the moment the page navigates — the single most common way to get
 * locked out of an account a password manager just created for you.
 */

import { TOKENS, HOST_RESET, BASE_FONT_STYLE } from './tokens';
import { t } from '../i18n/strings';

const HOST_ID = 'vw-save-prompt';

export interface SavePromptOptions {
    mode: 'save' | 'update';
    domain: string;
    username: string;
    onConfirm: () => void;
    onDismiss: () => void;
}

function styleSheet(): string {
    return `
        ${BASE_FONT_STYLE}
        .toast {
            position: fixed;
            top: 16px;
            right: 16px;
            width: 320px;
            background: ${TOKENS.consoleSurface};
            border: 1px solid ${TOKENS.consoleBorderSubtle};
            border-radius: ${TOKENS.radiusLg};
            box-shadow: ${TOKENS.shadowOverlay};
            padding: 16px;
            color: ${TOKENS.consoleTextStrong};
        }
        .brand {
            display: flex; align-items: center; gap: 8px;
            font-size: 10px; font-weight: 600;
            letter-spacing: 0.5px; text-transform: uppercase;
            color: ${TOKENS.gold};
            margin-bottom: 8px;
        }
        .brand .dot { width: 7px; height: 7px; border-radius: 50%; background: ${TOKENS.gold}; }
        .title { font-size: 14px; font-weight: 600; line-height: 1.35; margin-bottom: 8px; }
        .detail {
            font-size: 12px;
            color: ${TOKENS.consoleTextSecondary};
            background: ${TOKENS.consoleBg};
            border: 1px solid ${TOKENS.consoleBorderSubtle};
            border-radius: ${TOKENS.radiusSm};
            padding: 8px 10px;
            margin-bottom: 12px;
            overflow-wrap: anywhere;
        }
        .detail .who { color: ${TOKENS.consoleTextStrong}; }
        .actions { display: flex; gap: 8px; }
        .primary {
            flex: 1;
            padding: 9px 12px;
            border-radius: ${TOKENS.radiusMd};
            background: ${TOKENS.gold};
            color: ${TOKENS.consoleBg};
            font-size: 13px; font-weight: 600;
        }
        .secondary {
            flex: 1;
            padding: 9px 12px;
            border-radius: ${TOKENS.radiusMd};
            border: 1px solid ${TOKENS.consoleBorderSubtle};
            color: ${TOKENS.consoleTextSecondary};
            font-size: 13px;
        }
        .secondary:hover { background: ${TOKENS.consoleRaised}; color: ${TOKENS.consoleTextStrong}; }
    `;
}

export function dismissSavePrompt(): void {
    document.getElementById(HOST_ID)?.remove();
}

export function showSavePrompt(options: SavePromptOptions): void {
    dismissSavePrompt();

    const host = document.createElement('div');
    host.id = HOST_ID;
    host.setAttribute('style', HOST_RESET);
    const root = host.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = styleSheet();
    root.appendChild(style);

    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.setAttribute('role', 'dialog');

    const brand = document.createElement('div');
    brand.className = 'brand';
    const dot = document.createElement('span');
    dot.className = 'dot';
    brand.append(dot, document.createTextNode('VaultWares'));

    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = options.mode === 'update'
        ? t('savePromptUpdateTitle')
        : t('savePromptTitle');

    const detail = document.createElement('div');
    detail.className = 'detail';
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = options.username || options.domain;
    detail.append(who, document.createTextNode(` — ${options.domain}`));

    const actions = document.createElement('div');
    actions.className = 'actions';

    const confirm = document.createElement('button');
    confirm.className = 'primary';
    confirm.textContent = options.mode === 'update' ? t('savePromptUpdate') : t('savePromptSave');
    confirm.addEventListener('click', () => {
        dismissSavePrompt();
        options.onConfirm();
    });

    const dismiss = document.createElement('button');
    dismiss.className = 'secondary';
    dismiss.textContent = t('savePromptDismiss');
    dismiss.addEventListener('click', () => {
        dismissSavePrompt();
        options.onDismiss();
    });

    actions.append(confirm, dismiss);
    toast.append(brand, title, detail, actions);
    root.appendChild(toast);
    document.documentElement.appendChild(host);

    confirm.focus();

    // Auto-dismiss so a prompt the user ignores does not sit on the page for
    // the rest of the session.
    setTimeout(() => {
        if (document.getElementById(HOST_ID) === host) {
            dismissSavePrompt();
            options.onDismiss();
        }
    }, 30_000);
}
