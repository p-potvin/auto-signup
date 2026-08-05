/**
 * Form and field detection.
 *
 * Rewritten in v2.1: the previous version scanned the document once at
 * document_idle and treated the page as a single flat form. That missed
 * anything rendered later (most SPA login pages), anything inside a shadow
 * root (design-system inputs), and it merged unrelated forms — a search box on
 * a checkout page could end up in the same "form" as the card fields.
 *
 * Detection now runs per form, is re-runnable, and prefers the `autocomplete`
 * attribute, which is the signal sites are actually asked to provide.
 */

export type FieldRole =
    | 'username'
    | 'email'
    | 'password'
    | 'newPassword'
    | 'passwordConfirm'
    | 'totp'
    | 'firstName'
    | 'lastName'
    | 'fullName'
    | 'phone'
    | 'birthDate'
    | 'street'
    | 'city'
    | 'state'
    | 'zipCode'
    | 'country'
    | 'cardNumber'
    | 'cardHolder'
    | 'cvv'
    | 'expiry'
    | 'unknown';

export type FormKind = 'login' | 'signup' | 'changePassword' | 'payment' | 'none';

export interface DetectedField {
    element: HTMLInputElement;
    role: FieldRole;
    /** 0-100. `autocomplete` scores highest, then type, then name/label text. */
    confidence: number;
}

export interface DetectedForm {
    /** The <form>, or the nearest container when the page uses bare inputs. */
    scope: Element;
    kind: FormKind;
    fields: DetectedField[];
    score: number;
}

const FILLABLE_SELECTOR =
    'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=checkbox]):not([type=radio]):not([type=file]):not([type=image]):not([type=range]):not([type=color])';

/* ------------------------------------------------------------- traversal */

/**
 * Collects inputs across open shadow roots. Closed roots are unreachable by
 * design and are simply not supported.
 */
export function collectInputs(root: ParentNode = document): HTMLInputElement[] {
    const found: HTMLInputElement[] = [];
    const seen = new Set<Element>();

    const walk = (node: ParentNode) => {
        for (const element of Array.from(node.querySelectorAll<HTMLElement>('*'))) {
            if (element instanceof HTMLInputElement) {
                if (!seen.has(element) && element.matches(FILLABLE_SELECTOR)) {
                    seen.add(element);
                    found.push(element);
                }
            }
            if (element.shadowRoot) walk(element.shadowRoot);
        }
    };

    walk(root);
    return found;
}

export function isVisible(element: HTMLElement): boolean {
    if (element.hidden) return false;
    if ((element as HTMLInputElement).disabled) return false;
    if (element.getClientRects().length === 0) return false;
    const style = element.ownerDocument.defaultView?.getComputedStyle(element);
    if (!style) return true;
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
}

/* ---------------------------------------------------------------- hinting */

function labelTextFor(input: HTMLInputElement): string {
    const parts: string[] = [];

    if (input.labels) {
        for (const label of Array.from(input.labels)) {
            parts.push(label.textContent ?? '');
        }
    }
    const describedBy = input.getAttribute('aria-labelledby');
    if (describedBy) {
        for (const id of describedBy.split(/\s+/)) {
            parts.push(input.ownerDocument.getElementById(id)?.textContent ?? '');
        }
    }
    parts.push(input.getAttribute('aria-label') ?? '');
    parts.push(input.getAttribute('title') ?? '');
    return parts.join(' ');
}

function textHints(input: HTMLInputElement): string {
    return [
        input.name,
        input.id,
        input.getAttribute('placeholder') ?? '',
        input.getAttribute('data-testid') ?? '',
        labelTextFor(input),
    ].join(' ').toLowerCase();
}

/**
 * The `autocomplete` token is the one signal the HTML spec defines for this,
 * so a site that sets it is believed over any name/placeholder guess.
 */
const AUTOCOMPLETE_ROLES: Record<string, FieldRole> = {
    username: 'username',
    email: 'email',
    'current-password': 'password',
    'new-password': 'newPassword',
    'one-time-code': 'totp',
    'given-name': 'firstName',
    'family-name': 'lastName',
    name: 'fullName',
    tel: 'phone',
    'tel-national': 'phone',
    bday: 'birthDate',
    'street-address': 'street',
    'address-line1': 'street',
    'address-level2': 'city',
    'address-level1': 'state',
    'postal-code': 'zipCode',
    'country-name': 'country',
    country: 'country',
    'cc-number': 'cardNumber',
    'cc-name': 'cardHolder',
    'cc-csc': 'cvv',
    'cc-exp': 'expiry',
    'cc-exp-month': 'expiry',
    'cc-exp-year': 'expiry',
};

export function detectFieldRole(input: HTMLInputElement): DetectedField {
    const autocomplete = (input.getAttribute('autocomplete') ?? '')
        .toLowerCase()
        .split(/\s+/)
        // "section-foo billing cc-number" — the token we want is the last one.
        .filter(token => token && token !== 'on' && token !== 'off')
        .pop();

    if (autocomplete && AUTOCOMPLETE_ROLES[autocomplete]) {
        return { element: input, role: AUTOCOMPLETE_ROLES[autocomplete], confidence: 100 };
    }

    const hints = textHints(input);
    const type = input.type.toLowerCase();

    if (type === 'password') {
        if (/confirm|repeat|retype|again|verif/.test(hints)) {
            return { element: input, role: 'passwordConfirm', confidence: 90 };
        }
        if (/new|create|choose|set/.test(hints)) {
            return { element: input, role: 'newPassword', confidence: 85 };
        }
        return { element: input, role: 'password', confidence: 80 };
    }

    if (type === 'email') return { element: input, role: 'email', confidence: 90 };
    if (type === 'tel') return { element: input, role: 'phone', confidence: 85 };

    const rules: [RegExp, FieldRole][] = [
        [/one.?time|otp|totp|2fa|mfa|auth.?code|verification.?code|security.?code/, 'totp'],
        [/first.?name|given.?name|prenom|prénom/, 'firstName'],
        [/last.?name|surname|family.?name|\bnom\b/, 'lastName'],
        [/full.?name|^name$|your.?name/, 'fullName'],
        [/e.?mail|courriel/, 'email'],
        [/user.?name|user.?id|\buser\b|login|handle|account.?name|identifiant/, 'username'],
        [/phone|mobile|telephone|téléphone/, 'phone'],
        [/birth|dob|date.?of.?birth|naissance/, 'birthDate'],
        [/street|address.?1|addr1|adresse/, 'street'],
        [/city|town|ville/, 'city'],
        [/state|province|region/, 'state'],
        [/zip|postal|code.?postal/, 'zipCode'],
        [/country|pays/, 'country'],
        [/card.?number|cc.?num|credit.?card/, 'cardNumber'],
        [/card.?holder|name.?on.?card/, 'cardHolder'],
        [/cvc|cvv|card.?code/, 'cvv'],
        [/expir|exp.?date|valid.?thru/, 'expiry'],
    ];

    for (const [pattern, role] of rules) {
        if (pattern.test(hints)) {
            return { element: input, role, confidence: 60 };
        }
    }

    // A lone text input next to a password field is almost always the username.
    return { element: input, role: 'unknown', confidence: 0 };
}

/* -------------------------------------------------------------- grouping */

/**
 * The container to treat as "the form". A real `<form>` wins; otherwise walk up
 * until a container holds more than one fillable input, which is what a
 * div-based login box looks like.
 */
function scopeFor(input: HTMLInputElement): Element {
    const form = input.form;
    if (form) return form;

    let node: Element | null = input.parentElement;
    let fallback: Element = input.parentElement ?? input;
    let depth = 0;

    while (node && depth < 8) {
        const count = node.querySelectorAll(FILLABLE_SELECTOR).length;
        if (count > 1) return node;
        fallback = node;
        node = node.parentElement;
        depth++;
    }
    return fallback;
}

function classify(fields: DetectedField[]): { kind: FormKind; score: number } {
    const roles = new Set(fields.map(f => f.role));

    const hasPassword = roles.has('password');
    const hasNewPassword = roles.has('newPassword');
    const hasConfirm = roles.has('passwordConfirm');
    const hasIdentifier = roles.has('username') || roles.has('email');
    const hasPersonalName = roles.has('firstName') || roles.has('lastName') || roles.has('fullName');
    const hasCard = roles.has('cardNumber') || roles.has('cvv');

    // Change-password forms have a current + new pair and must not be offered
    // a plain "fill my saved password" into the new-password box.
    if (hasPassword && (hasNewPassword || hasConfirm) && !hasPersonalName) {
        return { kind: 'changePassword', score: 85 };
    }
    if ((hasNewPassword || hasConfirm) && (hasIdentifier || hasPersonalName)) {
        return { kind: 'signup', score: 90 };
    }
    if (hasPassword && hasPersonalName) {
        return { kind: 'signup', score: 75 };
    }
    if (hasPassword && hasIdentifier) {
        return { kind: 'login', score: 90 };
    }
    if (hasPassword) {
        return { kind: 'login', score: 65 };
    }
    // Identifier-only step: the "enter your email, then password" pattern.
    if (hasIdentifier && fields.length <= 3) {
        return { kind: 'login', score: 55 };
    }
    if (hasCard) {
        return { kind: 'payment', score: 70 };
    }
    return { kind: 'none', score: 0 };
}

export function detectForms(root: ParentNode = document): DetectedForm[] {
    const inputs = collectInputs(root).filter(isVisible);
    if (inputs.length === 0) return [];

    const groups = new Map<Element, DetectedField[]>();
    for (const input of inputs) {
        const scope = scopeFor(input);
        const field = detectFieldRole(input);
        const existing = groups.get(scope);
        if (existing) existing.push(field);
        else groups.set(scope, [field]);
    }

    const forms: DetectedForm[] = [];
    for (const [scope, fields] of groups) {
        // A text input immediately before a password field is the identifier,
        // even when the site labels it nothing useful.
        for (let i = 0; i < fields.length; i++) {
            if (fields[i].role !== 'unknown') continue;
            const next = fields[i + 1];
            if (next && (next.role === 'password' || next.role === 'newPassword')) {
                fields[i] = { ...fields[i], role: 'username', confidence: 50 };
            }
        }

        const { kind, score } = classify(fields);
        if (kind === 'none') continue;
        forms.push({ scope, kind, fields, score });
    }

    return forms.sort((a, b) => b.score - a.score);
}

/** The form containing a given input, so fills stay inside one form. */
export function formForElement(forms: DetectedForm[], element: Element): DetectedForm | null {
    return forms.find(form => form.fields.some(f => f.element === element)) ?? null;
}

/* ----------------------------------------------------------------- filling */

/**
 * Sets a value the way a user would.
 *
 * React (and every framework with a controlled input) tracks the last value it
 * wrote on the DOM node. Assigning `.value` directly leaves that tracker stale,
 * React concludes nothing changed, and the state silently reverts on the next
 * render. Going through the native setter and firing the events is what makes
 * the fill stick.
 */
export function fillField(input: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
    )?.set;

    input.focus();
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
}

export function fillForm(form: DetectedForm, data: Partial<Record<FieldRole, string>>): number {
    let filled = 0;
    for (const field of form.fields) {
        const value = data[field.role];
        if (!value) continue;
        fillField(field.element, value);
        filled++;
    }
    return filled;
}
