/**
 * The user-presence prompt for a passkey ceremony.
 *
 * Every WebAuthn ceremony needs a deliberate human act — that is what the User
 * Present flag asserts. This renders that prompt in a closed shadow root so the
 * page cannot read it, restyle it, or synthesise a click on it.
 *
 * It never asks for the PIN. A page-hosted PIN field would be both phishable
 * and readable by a compromised page, so a locked vault sends the user to the
 * extension's own UI and this prompt waits for the unlock.
 */

import { TOKENS, HOST_RESET, BASE_FONT_STYLE } from '../content/tokens';
import { t } from '../i18n/strings';
import type { CeremonySummary } from './types';

export type ConsentDecision =
    | { action: 'approve'; credentialId?: string }
    | { action: 'fallback' }
    | { action: 'cancel' };

export interface ConsentAccount {
    credentialId: string;
    userName: string;
    userDisplayName: string;
}

export interface ConsentRequest {
    kind: 'create' | 'get';
    summary: CeremonySummary;
    accounts: ConsentAccount[];
    locked: boolean;
    /** Ceremony deadline in ms; the prompt self-cancels when it passes. */
    timeoutMs: number;
    onUnlockRequested: () => void;
    /** Resolves true once the vault reports unlocked. */
    waitForUnlock: () => Promise<boolean>;
}

const HOST_ID = 'vw-passkey-consent';

function styleSheet(): string {
    return `
        ${BASE_FONT_STYLE}
        .backdrop {
            position: fixed;
            inset: 0;
            background: rgba(6, 4, 12, 0.62);
            backdrop-filter: blur(2px);
            display: flex;
            align-items: flex-start;
            justify-content: center;
            padding: 48px 16px 16px;
        }
        .card {
            width: 100%;
            max-width: 420px;
            background: ${TOKENS.consoleSurface};
            border: 1px solid ${TOKENS.consoleBorderSubtle};
            border-radius: ${TOKENS.radiusLg};
            box-shadow: ${TOKENS.shadowOverlay};
            padding: 20px;
            color: ${TOKENS.consoleTextStrong};
        }
        .brand {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 11px;
            font-weight: 600;
            letter-spacing: 0.5px;
            text-transform: uppercase;
            color: ${TOKENS.gold};
            margin-bottom: 12px;
        }
        .brand .dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: ${TOKENS.gold};
        }
        h1 { font-size: 17px; font-weight: 600; line-height: 1.3; margin-bottom: 6px; }
        p.body {
            font-size: 13px;
            line-height: 1.5;
            color: ${TOKENS.consoleTextSecondary};
            margin-bottom: 14px;
        }
        .rp {
            display: block;
            font-family: ${TOKENS.fontMono};
            font-size: 12px;
            color: ${TOKENS.violet};
            background: ${TOKENS.consoleBg};
            border: 1px solid ${TOKENS.consoleBorderSubtle};
            border-radius: ${TOKENS.radiusSm};
            padding: 8px 10px;
            margin-bottom: 14px;
            overflow-wrap: anywhere;
        }
        .accounts { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; }
        .account-label {
            font-size: 10px;
            font-weight: 600;
            letter-spacing: 0.5px;
            text-transform: uppercase;
            color: ${TOKENS.consoleTextMuted};
        }
        .account {
            display: flex;
            align-items: center;
            gap: 10px;
            width: 100%;
            text-align: left;
            padding: 9px 10px;
            border-radius: ${TOKENS.radiusSm};
            border: 1px solid ${TOKENS.consoleBorderSubtle};
            background: ${TOKENS.consoleRaised};
        }
        .account:hover, .account[aria-selected="true"] { background: ${TOKENS.consoleElevated}; }
        .account .avatar {
            width: 26px; height: 26px; flex-shrink: 0;
            border-radius: 6px;
            background: ${TOKENS.consoleActive};
            display: flex; align-items: center; justify-content: center;
            font-size: 12px; font-weight: 700; color: ${TOKENS.gold};
        }
        .account .who { min-width: 0; }
        .account .name {
            font-size: 13px; font-weight: 500;
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .account .sub {
            font-size: 11px; color: ${TOKENS.consoleTextSecondary};
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .empty {
            font-size: 12px;
            color: ${TOKENS.signalAlert};
            padding: 10px;
            border: 1px solid ${TOKENS.consoleBorderSubtle};
            border-radius: ${TOKENS.radiusSm};
            margin-bottom: 14px;
        }
        .actions { display: flex; flex-direction: column; gap: 8px; }
        .primary {
            width: 100%;
            padding: 11px 14px;
            border-radius: ${TOKENS.radiusMd};
            background: ${TOKENS.gold};
            color: ${TOKENS.consoleBg};
            font-size: 14px;
            font-weight: 600;
        }
        .primary:disabled { opacity: 0.45; cursor: not-allowed; }
        .secondary {
            width: 100%;
            padding: 9px 14px;
            border-radius: ${TOKENS.radiusMd};
            border: 1px solid ${TOKENS.consoleBorderSubtle};
            color: ${TOKENS.consoleTextSecondary};
            font-size: 13px;
        }
        .secondary:hover { background: ${TOKENS.consoleRaised}; color: ${TOKENS.consoleTextStrong}; }
        .waiting {
            font-size: 12px;
            color: ${TOKENS.consoleTextMuted};
            text-align: center;
            padding-top: 4px;
        }
    `;
}

function initials(value: string): string {
    const trimmed = value.trim();
    return (trimmed[0] ?? 'V').toUpperCase();
}

/**
 * Shows the prompt and resolves with the user's decision. Resolves `cancel` on
 * Escape, on backdrop click, and when the ceremony timeout elapses.
 */
export function requestConsent(request: ConsentRequest): Promise<ConsentDecision> {
    document.getElementById(HOST_ID)?.remove();

    const host = document.createElement('div');
    host.id = HOST_ID;
    host.setAttribute('style', HOST_RESET);
    const root = host.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = styleSheet();
    root.appendChild(style);

    const backdrop = document.createElement('div');
    backdrop.className = 'backdrop';
    const card = document.createElement('div');
    card.className = 'card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    backdrop.appendChild(card);
    root.appendChild(backdrop);

    return new Promise<ConsentDecision>(resolve => {
        let settled = false;
        let selectedCredentialId = request.accounts[0]?.credentialId;

        const cleanup = () => {
            clearTimeout(timeoutHandle);
            document.removeEventListener('keydown', onKeyDown, true);
            host.remove();
        };

        const settle = (decision: ConsentDecision) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(decision);
        };

        const timeoutHandle = setTimeout(() => settle({ action: 'cancel' }), request.timeoutMs);

        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.stopPropagation();
                settle({ action: 'cancel' });
            }
        };
        document.addEventListener('keydown', onKeyDown, true);

        backdrop.addEventListener('mousedown', event => {
            if (event.target === backdrop) settle({ action: 'cancel' });
        });

        const render = (locked: boolean, waiting: boolean) => {
            card.replaceChildren();

            const brand = document.createElement('div');
            brand.className = 'brand';
            const dot = document.createElement('span');
            dot.className = 'dot';
            brand.append(dot, document.createTextNode('VaultWares'));
            card.appendChild(brand);

            const title = document.createElement('h1');
            const body = document.createElement('p');
            body.className = 'body';

            if (locked) {
                title.textContent = t('passkeyLockedTitle');
                body.textContent = t('passkeyLockedBody');
            } else {
                title.textContent = request.kind === 'create'
                    ? t('passkeyCreateTitle')
                    : t('passkeyGetTitle');
                body.textContent = request.kind === 'create'
                    ? t('passkeyCreateBody', { rp: request.summary.rpName })
                    : t('passkeyGetBody', { rp: request.summary.rpName });
            }
            card.append(title, body);

            const rp = document.createElement('code');
            rp.className = 'rp';
            rp.textContent = request.summary.rpId;
            card.appendChild(rp);

            if (locked) {
                const unlockBtn = document.createElement('button');
                unlockBtn.className = 'primary';
                unlockBtn.textContent = t('passkeyOpenVault');
                unlockBtn.disabled = waiting;
                unlockBtn.addEventListener('click', () => {
                    request.onUnlockRequested();
                    render(true, true);
                    void request.waitForUnlock().then(unlocked => {
                        if (settled) return;
                        if (unlocked) render(false, false);
                    });
                });

                const cancelBtn = document.createElement('button');
                cancelBtn.className = 'secondary';
                cancelBtn.textContent = t('passkeyCancel');
                cancelBtn.addEventListener('click', () => settle({ action: 'cancel' }));

                const actions = document.createElement('div');
                actions.className = 'actions';
                actions.append(unlockBtn, cancelBtn);
                card.appendChild(actions);

                if (waiting) {
                    const waitingNote = document.createElement('div');
                    waitingNote.className = 'waiting';
                    waitingNote.textContent = t('passkeyWaitingUnlock');
                    card.appendChild(waitingNote);
                }
                unlockBtn.focus();
                return;
            }

            const hasAccounts = request.accounts.length > 0;

            if (request.kind === 'get') {
                if (!hasAccounts) {
                    const empty = document.createElement('div');
                    empty.className = 'empty';
                    empty.textContent = t('passkeyNoneForSite');
                    card.appendChild(empty);
                } else {
                    const wrap = document.createElement('div');
                    wrap.className = 'accounts';
                    const label = document.createElement('div');
                    label.className = 'account-label';
                    label.textContent = request.accounts.length > 1
                        ? t('passkeyChooseAccount')
                        : t('passkeyAccountLabel');
                    wrap.appendChild(label);

                    for (const account of request.accounts) {
                        const button = document.createElement('button');
                        button.className = 'account';
                        button.setAttribute(
                            'aria-selected',
                            String(account.credentialId === selectedCredentialId),
                        );

                        const avatar = document.createElement('span');
                        avatar.className = 'avatar';
                        avatar.textContent = initials(account.userDisplayName || account.userName);

                        const who = document.createElement('span');
                        who.className = 'who';
                        const name = document.createElement('span');
                        name.className = 'name';
                        name.textContent = account.userDisplayName || account.userName;
                        const sub = document.createElement('span');
                        sub.className = 'sub';
                        sub.textContent = account.userName;
                        who.append(name, sub);

                        button.append(avatar, who);
                        button.addEventListener('click', () => {
                            selectedCredentialId = account.credentialId;
                            settle({ action: 'approve', credentialId: account.credentialId });
                        });
                        wrap.appendChild(button);
                    }
                    card.appendChild(wrap);
                }
            } else if (request.summary.userName) {
                const wrap = document.createElement('div');
                wrap.className = 'accounts';
                const label = document.createElement('div');
                label.className = 'account-label';
                label.textContent = t('passkeyAccountLabel');
                const value = document.createElement('div');
                value.className = 'account';
                const avatar = document.createElement('span');
                avatar.className = 'avatar';
                avatar.textContent = initials(request.summary.userDisplayName || request.summary.userName);
                const who = document.createElement('span');
                who.className = 'who';
                const name = document.createElement('span');
                name.className = 'name';
                name.textContent = request.summary.userDisplayName || request.summary.userName;
                const sub = document.createElement('span');
                sub.className = 'sub';
                sub.textContent = request.summary.userName;
                who.append(name, sub);
                value.append(avatar, who);
                wrap.append(label, value);
                card.appendChild(wrap);
            }

            const actions = document.createElement('div');
            actions.className = 'actions';

            const approve = document.createElement('button');
            approve.className = 'primary';
            approve.textContent = request.kind === 'create'
                ? t('passkeyApproveCreate')
                : t('passkeyApproveGet');
            approve.disabled = request.kind === 'get' && !hasAccounts;
            approve.addEventListener('click', () =>
                settle({ action: 'approve', credentialId: selectedCredentialId }));

            const fallback = document.createElement('button');
            fallback.className = 'secondary';
            fallback.textContent = t('passkeyUseBrowser');
            fallback.addEventListener('click', () => settle({ action: 'fallback' }));

            const cancel = document.createElement('button');
            cancel.className = 'secondary';
            cancel.textContent = t('passkeyCancel');
            cancel.addEventListener('click', () => settle({ action: 'cancel' }));

            actions.append(approve, fallback, cancel);
            card.appendChild(actions);

            (approve.disabled ? fallback : approve).focus();
        };

        render(request.locked, false);
        document.documentElement.appendChild(host);
    });
}

export function dismissConsent(): void {
    document.getElementById(HOST_ID)?.remove();
}
