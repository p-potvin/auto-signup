/**
 * VaultWares Redesign tokens for UI injected into third-party pages.
 *
 * In-page surfaces cannot import `src/theme/revisited.css` — the page owns the
 * cascade and there is no build step for it there. This module mirrors the
 * Console-mode token values from that file so injected UI still refers to named
 * tokens instead of scattering literals through the DOM code.
 *
 * SoT: `src/theme/revisited.css` (VaultWares Redesign, vaultwares-themes).
 * Keep the values here in step with that file.
 */

export const TOKENS = {
    consoleBg: '#0b0813',
    consoleSurface: '#13101c',
    consoleRaised: '#2A2340',
    consoleElevated: '#453763',
    consoleActive: '#614d8a',
    consoleText: '#a394cc',
    consoleTextStrong: '#ffffff',
    consoleTextSecondary: 'rgba(237, 230, 255, 0.72)',
    consoleTextMuted: 'rgba(237, 230, 255, 0.5)',
    consoleBorderSubtle: 'rgba(255, 255, 255, 0.06)',
    gold: '#D6A441',
    violet: '#B07CFF',
    signalAlert: '#FF6B7A',
    signalOnline: '#6BE675',
    fontSans: "'Inter', 'Segoe UI', ui-sans-serif, system-ui, sans-serif",
    fontMono: "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace",
    radiusSm: '8px',
    radiusMd: '12px',
    radiusLg: '18px',
    shadowOverlay: '0 24px 64px rgba(0, 0, 0, 0.55)',
    shadowMenu: '0 8px 32px rgba(0, 0, 0, 0.5)',
    /** Max signed 32-bit z-index, so page overlays cannot cover our UI. */
    zIndex: '2147483647',
} as const;

/**
 * Injected UI lives in a closed shadow root. The host element still inherits
 * from the page, so it is reset explicitly — a page setting `* { all: unset }`
 * or a transform on a parent would otherwise move or flatten our surface.
 */
export const HOST_RESET = `
    all: initial;
    position: fixed;
    z-index: ${TOKENS.zIndex};
    inset: auto;
    color-scheme: dark;
`;

export const BASE_FONT_STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: ${TOKENS.fontSans}; }
    button { cursor: pointer; border: none; background: none; font: inherit; color: inherit; }
    button:focus-visible { outline: 2px solid ${TOKENS.gold}; outline-offset: 2px; }
`;
