/**
 * The inline suggestion menu.
 *
 * Rendered into a closed shadow root: the previous version appended a plain
 * div, which inherited the page's CSS (any `div { font-size: 0 }` broke it) and
 * left vault labels readable by page scripts. A shadow root fixes both.
 */

import { TOKENS, HOST_RESET, BASE_FONT_STYLE } from './tokens';
import { t } from '../i18n/strings';

export interface MenuEntry {
    id: string;
    label: string;
    sublabel: string;
    /** Shown as a chip; used for passkey entries. */
    badge?: string;
    group?: string;
    onChoose: () => void;
}

export interface MenuOptions {
    header: string;
    entries: MenuEntry[];
    emptyMessage?: string;
    /** Non-actionable line under the header, e.g. a passkey availability hint. */
    notice?: string;
    footerLabel?: string;
    onFooter?: () => void;
    anchor: HTMLElement;
}

const HOST_ID = 'vw-inline-menu';

function styleSheet(): string {
    return `
        ${BASE_FONT_STYLE}
        .menu {
            position: absolute;
            min-width: 280px;
            max-width: 380px;
            max-height: 320px;
            overflow-y: auto;
            background: ${TOKENS.consoleSurface};
            border: 1px solid ${TOKENS.consoleBorderSubtle};
            border-radius: ${TOKENS.radiusMd};
            box-shadow: ${TOKENS.shadowMenu};
            padding: 6px;
            color: ${TOKENS.consoleText};
        }
        .header {
            padding: 6px 10px 8px;
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: ${TOKENS.gold};
        }
        .group {
            padding: 6px 10px 2px;
            font-size: 10px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: rgba(214, 164, 65, 0.7);
        }
        .entry {
            display: flex;
            align-items: center;
            gap: 10px;
            width: 100%;
            text-align: left;
            padding: 9px 10px;
            border-radius: ${TOKENS.radiusSm};
        }
        .entry:hover, .entry[data-active="true"] { background: ${TOKENS.consoleRaised}; }
        .icon {
            width: 28px; height: 28px; flex-shrink: 0;
            border-radius: 6px;
            background: ${TOKENS.consoleRaised};
            display: flex; align-items: center; justify-content: center;
            font-size: 12px; font-weight: 700; color: ${TOKENS.gold};
        }
        .entry[data-active="true"] .icon { background: ${TOKENS.consoleElevated}; }
        .text { flex: 1; min-width: 0; }
        .label {
            font-size: 13px; font-weight: 500; color: ${TOKENS.consoleTextStrong};
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .sublabel {
            font-size: 11px; color: ${TOKENS.consoleTextSecondary};
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .badge {
            flex-shrink: 0;
            font-size: 9px;
            font-weight: 600;
            letter-spacing: 0.4px;
            text-transform: uppercase;
            color: ${TOKENS.violet};
            border: 1px solid ${TOKENS.violet}55;
            border-radius: 999px;
            padding: 2px 7px;
        }
        .empty {
            padding: 10px 12px;
            font-size: 12px;
            text-align: center;
            color: ${TOKENS.consoleTextMuted};
        }
        .notice {
            display: flex; align-items: center; gap: 7px;
            margin: 0 4px 4px;
            padding: 7px 8px;
            border-radius: ${TOKENS.radiusSm};
            background: ${TOKENS.consoleBg};
            border: 1px solid ${TOKENS.consoleBorderSubtle};
            font-size: 11px;
            color: ${TOKENS.consoleTextSecondary};
        }
        .notice .mark {
            width: 6px; height: 6px; border-radius: 50%;
            background: ${TOKENS.violet}; flex-shrink: 0;
        }
        .footer {
            display: flex; align-items: center; gap: 10px;
            width: 100%;
            padding: 9px 10px;
            margin-top: 4px;
            border-top: 1px solid ${TOKENS.consoleBorderSubtle};
            border-radius: ${TOKENS.radiusSm};
            font-size: 13px; font-weight: 500;
            color: ${TOKENS.gold};
        }
        .footer:hover, .footer[data-active="true"] { background: ${TOKENS.consoleRaised}; }
        .footer .icon { color: ${TOKENS.gold}; font-size: 16px; }
    `;
}

let activeMenu: { host: HTMLElement; dispose: () => void } | null = null;

export function closeMenu(): void {
    activeMenu?.dispose();
    activeMenu = null;
}

export function isMenuOpen(): boolean {
    return activeMenu !== null;
}

/**
 * Positions the menu under the anchor, flipping above it when the field sits
 * near the bottom of the viewport.
 */
function position(menu: HTMLElement, anchor: HTMLElement): void {
    const rect = anchor.getBoundingClientRect();
    const menuHeight = menu.offsetHeight || 200;
    const spaceBelow = window.innerHeight - rect.bottom;

    const top = spaceBelow < menuHeight && rect.top > menuHeight
        ? rect.top + window.scrollY - menuHeight - 4
        : rect.bottom + window.scrollY + 4;

    menu.style.top = `${top}px`;
    menu.style.left = `${rect.left + window.scrollX}px`;
    menu.style.minWidth = `${Math.max(rect.width, 280)}px`;
}

export function showMenu(options: MenuOptions): void {
    closeMenu();

    const host = document.createElement('div');
    host.id = HOST_ID;
    host.setAttribute('style', `${HOST_RESET} position: absolute; top: 0; left: 0;`);
    const root = host.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = styleSheet();
    root.appendChild(style);

    const menu = document.createElement('div');
    menu.className = 'menu';
    menu.setAttribute('role', 'listbox');
    root.appendChild(menu);

    const header = document.createElement('div');
    header.className = 'header';
    header.textContent = options.header;
    menu.appendChild(header);

    if (options.notice) {
        const notice = document.createElement('div');
        notice.className = 'notice';
        const mark = document.createElement('span');
        mark.className = 'mark';
        notice.append(mark, document.createTextNode(options.notice));
        menu.appendChild(notice);
    }

    const actionable: HTMLElement[] = [];

    if (options.entries.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = options.emptyMessage ?? t('menuNoMatches');
        menu.appendChild(empty);
    } else {
        let lastGroup: string | undefined;
        for (const entry of options.entries) {
            if (entry.group && entry.group !== lastGroup) {
                const group = document.createElement('div');
                group.className = 'group';
                group.textContent = entry.group;
                menu.appendChild(group);
                lastGroup = entry.group;
            }

            const button = document.createElement('button');
            button.className = 'entry';
            button.setAttribute('role', 'option');

            const icon = document.createElement('span');
            icon.className = 'icon';
            icon.textContent = (entry.label || 'V').trim()[0]?.toUpperCase() ?? 'V';

            const text = document.createElement('span');
            text.className = 'text';
            const label = document.createElement('span');
            label.className = 'label';
            label.textContent = entry.label;
            const sublabel = document.createElement('span');
            sublabel.className = 'sublabel';
            sublabel.textContent = entry.sublabel;
            text.append(label, sublabel);

            button.append(icon, text);

            if (entry.badge) {
                const badge = document.createElement('span');
                badge.className = 'badge';
                badge.textContent = entry.badge;
                button.appendChild(badge);
            }

            button.addEventListener('click', () => {
                closeMenu();
                entry.onChoose();
            });
            menu.appendChild(button);
            actionable.push(button);
        }
    }

    if (options.footerLabel && options.onFooter) {
        const footer = document.createElement('button');
        footer.className = 'footer';
        const icon = document.createElement('span');
        icon.className = 'icon';
        icon.textContent = '+';
        const label = document.createElement('span');
        label.textContent = options.footerLabel;
        footer.append(icon, label);
        footer.addEventListener('click', () => {
            closeMenu();
            options.onFooter?.();
        });
        menu.appendChild(footer);
        actionable.push(footer);
    }

    document.documentElement.appendChild(host);
    position(menu, options.anchor);

    /* ------------------------------------------------------- interaction */

    let activeIndex = -1;
    const setActive = (index: number) => {
        actionable.forEach(el => el.removeAttribute('data-active'));
        activeIndex = index;
        if (index >= 0 && index < actionable.length) {
            actionable[index].setAttribute('data-active', 'true');
            actionable[index].scrollIntoView({ block: 'nearest' });
        }
    };

    // Keys are handled on the anchor so the user never leaves the field:
    // arrows move the highlight, Enter picks, Escape dismisses. Everything
    // else falls through to the page so normal typing still works.
    const onKeyDown = (event: KeyboardEvent) => {
        if (actionable.length === 0 && event.key !== 'Escape') return;
        switch (event.key) {
            case 'ArrowDown':
                event.preventDefault();
                setActive((activeIndex + 1) % actionable.length);
                break;
            case 'ArrowUp':
                event.preventDefault();
                setActive(activeIndex <= 0 ? actionable.length - 1 : activeIndex - 1);
                break;
            case 'Enter':
                if (activeIndex >= 0) {
                    event.preventDefault();
                    actionable[activeIndex].click();
                }
                break;
            case 'Escape':
                event.preventDefault();
                closeMenu();
                break;
            case 'Tab':
                closeMenu();
                break;
        }
    };

    const onDocumentPointerDown = (event: Event) => {
        const target = event.target as Node;
        if (target === host || host.contains(target) || target === options.anchor) return;
        closeMenu();
    };

    const reposition = () => position(menu, options.anchor);

    options.anchor.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onDocumentPointerDown, true);
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);

    activeMenu = {
        host,
        dispose: () => {
            options.anchor.removeEventListener('keydown', onKeyDown, true);
            document.removeEventListener('pointerdown', onDocumentPointerDown, true);
            window.removeEventListener('scroll', reposition, true);
            window.removeEventListener('resize', reposition);
            host.remove();
        },
    };
}
