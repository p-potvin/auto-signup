export type ItemType = 'login' | 'address' | 'card' | 'totp' | 'passkey';

/**
 * `url` is stored without a scheme (see `utils/domain.normalizeStoredUrl`).
 *
 * Email and username are separate because many sites accept one and not the
 * other, and cramming both into one field means autofill has to guess. Either
 * may be empty; `email` is the common case and the one the editor shows first.
 * Records written before v2.1 have only `username`, which still loads.
 */
export interface LoginItem {
    url: string;
    username: string;
    email?: string;
    password: string;
    notes?: string;
    totpSecret?: string;
}

/** The identifier to show for a login, preferring whichever is filled. */
export function loginIdentifier(login: LoginItem): string {
    return login.email || login.username || '';
}

export interface AddressItem {
    fullName: string;
    street: string;
    city: string;
    state: string;
    zipCode: string;
    country: string;
    phone?: string;
}

export interface CardItem {
    holderName: string;
    cardNumber: string;
    expiryMonth: string;
    expiryYear: string;
    cvv: string;
    notes?: string;
}

export interface TotpItem {
    label: string;
    secret: string;
    issuer?: string;
    digits: number;
    period: number;
    algorithm: 'SHA1' | 'SHA256' | 'SHA512';
}

/**
 * A WebAuthn credential the extension can actually assert with.
 *
 * The original five fields are kept under their old names so records created
 * by the manual passkey editor before v2.1 still load. Everything the
 * authenticator added is optional and defaulted on read.
 *
 * `privateKey` is base64url PKCS#8 (P-256) and `publicKey` base64url SPKI.
 * Both live inside the encrypted envelope like any other item field.
 */
export interface PasskeyItem {
    rpId: string;
    credentialId: string;
    privateKey: string;
    userHandle: string;
    notes?: string;
    rpName?: string;
    publicKey?: string;
    userName?: string;
    userDisplayName?: string;
    /** COSE algorithm identifier; -7 (ES256) is all this authenticator issues. */
    algorithm?: number;
    /** True for credentials created by this extension's authenticator. */
    createdByAuthenticator?: boolean;
    createdAt?: string;
}

export type VaultItemData = LoginItem | AddressItem | CardItem | TotpItem | PasskeyItem;

export interface VaultItemMetadata {
    label: string;
    domain?: string;
    iconRef?: string;
    tags: string[];
    favorite: boolean;
}

export interface VaultItem {
    id: string;
    itemType: ItemType;
    data: VaultItemData;
    metadata: VaultItemMetadata;
    identityId: string | null;
    createdAt: string;
    updatedAt: string;
    authorDeviceId: string;
    deletedAt: string | null;
    lastUsedAt: string | null;
}

export interface VaultSettings {
    autoLockMinutes: number;
    autoFillEnabled: boolean;
    autoDetectEnabled: boolean;
    defaultPasswordLength: number;
    defaultPasswordComplexity: 'medium' | 'high' | 'maximum';
    defaultGeneratorPreset: string;
    vaultSectionName: string;
    generationEndpointUrl: string;
    autoAssignItemsToIdentity: boolean;
    /**
     * When false, WebAuthn ceremonies are handed straight back to the browser
     * so the user's platform authenticator or security key still works.
     */
    passkeysEnabled: boolean;
    /** Offer to save a login after a form is submitted. */
    savePromptEnabled: boolean;
    // The vault-warden this account syncs to, tailnet-only. Encrypted envelopes
    // are pushed here instead of to a cloud API.
    syncServerUrl: string;
    /**
     * Machine-automation token for a vault-warden running on this machine.
     *
     * Blank for a normal install: the tailnet is the authentication. Only sent
     * to a loopback `syncServerUrl` (see `api/local-client.ts`).
     */
    syncLocalToken: string;
}

export const DEFAULT_SETTINGS: VaultSettings = {
    autoLockMinutes: 5,
    autoFillEnabled: true,
    autoDetectEnabled: true,
    defaultPasswordLength: 20,
    defaultPasswordComplexity: 'maximum',
    defaultGeneratorPreset: 'classic',
    vaultSectionName: 'Vault',
    generationEndpointUrl: '',
    autoAssignItemsToIdentity: true,
    passkeysEnabled: true,
    savePromptEnabled: true,
    // greencloud over the tailnet. Nothing runs on 127.0.0.1 on a workstation,
    // and an always-on host is what lets the phone reach the vault when this
    // machine is asleep.
    syncServerUrl: 'https://warden.vaultwares.ca/v1',
    syncLocalToken: '',
};
