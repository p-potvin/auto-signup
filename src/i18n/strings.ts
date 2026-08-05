/**
 * Bilingual strings (EN + Quebec French) for surfaces added alongside passkeys,
 * manual identities, and the in-page suggestion menu.
 *
 * The rest of the extension predates this module and is still English-only;
 * retrofitting it is tracked separately. Anything new goes through `t()`.
 *
 * QC copy runs 15-20% longer than EN, so every consumer must size from content
 * rather than assume the English width.
 */

export type Locale = 'en' | 'qc';

type StringTable = Record<string, { en: string; qc: string }>;

const STRINGS = {
    /* ------------------------------------------------ passkey consent flow */
    passkeyCreateTitle: {
        en: 'Create a passkey',
        qc: "Créer une clé d'accès",
    },
    passkeyGetTitle: {
        en: 'Sign in with a passkey',
        qc: "Se connecter avec une clé d'accès",
    },
    passkeyCreateBody: {
        en: 'VaultWares will generate a passkey for {rp} and store the private key in your encrypted vault.',
        qc: "VaultWares va générer une clé d'accès pour {rp} et conserver la clé privée dans votre coffre chiffré.",
    },
    passkeyGetBody: {
        en: 'Sign in to {rp} using a passkey stored in your vault.',
        qc: "Connectez-vous à {rp} avec une clé d'accès conservée dans votre coffre.",
    },
    passkeyApproveCreate: {
        en: 'Create passkey',
        qc: "Créer la clé d'accès",
    },
    passkeyApproveGet: {
        en: 'Sign in',
        qc: 'Se connecter',
    },
    passkeyUseBrowser: {
        en: 'Use browser or security key',
        qc: 'Utiliser le navigateur ou une clé de sécurité',
    },
    passkeyCancel: {
        en: 'Cancel',
        qc: 'Annuler',
    },
    passkeyLockedTitle: {
        en: 'Vault is locked',
        qc: 'Le coffre est verrouillé',
    },
    passkeyLockedBody: {
        en: 'Unlock VaultWares to use your passkeys. Your PIN is never entered on a web page.',
        qc: "Déverrouillez VaultWares pour utiliser vos clés d'accès. Votre NIP n'est jamais saisi dans une page web.",
    },
    passkeyOpenVault: {
        en: 'Open VaultWares',
        qc: 'Ouvrir VaultWares',
    },
    passkeyWaitingUnlock: {
        en: 'Waiting for unlock…',
        qc: 'En attente du déverrouillage…',
    },
    passkeyNoneForSite: {
        en: 'No passkey saved for this site',
        qc: "Aucune clé d'accès enregistrée pour ce site",
    },
    passkeyAccountLabel: {
        en: 'Account',
        qc: 'Compte',
    },
    passkeyChooseAccount: {
        en: 'Choose an account',
        qc: 'Choisissez un compte',
    },

    /* ------------------------------------------------ suggestion menu copy */
    menuLoginsHeader: {
        en: 'VaultWares — Logins',
        qc: 'VaultWares — Identifiants',
    },
    menuSignupHeader: {
        en: 'VaultWares — Sign up',
        qc: 'VaultWares — Inscription',
    },
    menuNoMatches: {
        en: 'No matching logins found',
        qc: 'Aucun identifiant correspondant',
    },
    menuCreateForSite: {
        en: 'Create new login for this site',
        qc: 'Créer un identifiant pour ce site',
    },
    menuLocked: {
        en: 'Vault is locked — open VaultWares to unlock',
        qc: 'Coffre verrouillé — ouvrez VaultWares pour déverrouiller',
    },
    menuPasskeyBadge: {
        en: 'Passkey',
        qc: "Clé d'accès",
    },
    menuIdentityFallback: {
        en: 'Identity',
        qc: 'Identité',
    },
    menuIdentitiesGroup: {
        en: 'Identities',
        qc: 'Identités',
    },
    menuLinkedBadge: {
        en: 'This site',
        qc: 'Ce site',
    },
    menuGeneratePassword: {
        en: 'Use a generated password',
        qc: 'Utiliser un mot de passe généré',
    },
    menuGeneratePasswordHint: {
        en: 'Fills every password field and copies it',
        qc: 'Remplit tous les champs et le copie',
    },
    menuGenerateBadge: {
        en: 'New',
        qc: 'Nouveau',
    },

    /* --------------------------------------------------- save-login prompt */
    savePromptTitle: {
        en: 'Save this login to VaultWares?',
        qc: 'Enregistrer cet identifiant dans VaultWares?',
    },
    savePromptSave: {
        en: 'Save',
        qc: 'Enregistrer',
    },
    savePromptUpdate: {
        en: 'Update',
        qc: 'Mettre à jour',
    },
    savePromptDismiss: {
        en: 'Not now',
        qc: 'Pas maintenant',
    },
    savePromptUpdateTitle: {
        en: 'Update the saved password?',
        qc: 'Mettre à jour le mot de passe enregistré?',
    },

    /* ------------------------------------------------- manual identity form */
    identityCreateManual: {
        en: 'Create manually',
        qc: 'Créer manuellement',
    },
    identityNewTitle: {
        en: 'New identity',
        qc: 'Nouvelle identité',
    },
    identityEditTitle: {
        en: 'Edit identity',
        qc: "Modifier l'identité",
    },
    identityReviewTitle: {
        en: 'Review generated identity',
        qc: "Réviser l'identité générée",
    },
    identityNameRequired: {
        en: 'A full name is required',
        qc: 'Un nom complet est requis',
    },
    identitySave: {
        en: 'Save identity',
        qc: "Enregistrer l'identité",
    },
    identityFillSample: {
        en: 'Fill sample values',
        qc: 'Remplir avec des exemples',
    },
} satisfies StringTable;

export type StringKey = keyof typeof STRINGS;

function detectLocale(): Locale {
    const language = (
        typeof navigator !== 'undefined' ? navigator.language : 'en'
    ).toLowerCase();
    return language.startsWith('fr') ? 'qc' : 'en';
}

let activeLocale: Locale = detectLocale();

export function getLocale(): Locale {
    return activeLocale;
}

export function setLocale(locale: Locale): void {
    activeLocale = locale;
}

/**
 * Looks up a string and substitutes `{name}` placeholders.
 */
export function t(key: StringKey, vars?: Record<string, string>): string {
    const entry = STRINGS[key];
    let value = entry[activeLocale] ?? entry.en;
    if (vars) {
        for (const [name, replacement] of Object.entries(vars)) {
            value = value.split(`{${name}}`).join(replacement);
        }
    }
    return value;
}
