# Passkeys

The extension is a software WebAuthn authenticator. It creates real passkeys,
keeps the private keys in the encrypted vault, and signs assertions — the same
role a security key or the platform TPM normally plays.

Written 2026-08-05, shipped in v2.1.0.

## How a ceremony flows

```
page: navigator.credentials.create/get
  -> webauthn-inject.js   (MAIN world, document_start) serializes and posts
  -> webauthn-bridge.js   (ISOLATED world) re-derives origin, asks for consent
  -> background           unlocks nothing the user did not approve, signs
  -> bridge -> inject     rebuilds a PublicKeyCredential for the page
```

Four separate pieces because each boundary matters:

- **`inject.ts` runs in the page's own world.** `navigator.credentials` has to
  be replaced before page scripts capture a reference to it, which means
  `document_start` and `world: "MAIN"`. It holds no key material — it is a
  serializer and nothing more.
- **`bridge.ts` runs isolated.** The page cannot reach it, so this is where the
  origin is re-derived from `window.location` rather than trusted from the
  message, and where consent is gathered.
- **`service.ts` + `authenticator.ts` run in the background.** Private keys are
  unwrapped, used, and discarded here. They never enter a page.

## What is signed

Registration emits `fmt: "none"` attestation:

```
authData = SHA-256(rpId) | flags | signCount | AAGUID | credIdLen | credId | COSE_Key
attestationObject = CBOR{ fmt: "none", attStmt: {}, authData }
```

Assertion signs `authData || SHA-256(clientDataJSON)` with ECDSA P-256/SHA-256,
re-encoded from WebCrypto's raw `r||s` into the ASN.1 DER that relying parties
parse.

Credentials are ES256 (COSE `-7`) only. A site demanding RS256 or Ed25519 gets
`NotSupportedError` and falls through to the browser.

## Decisions worth knowing

**The signature counter is always 0.** A counter exists so a relying party can
spot a cloned authenticator. Vault credentials are deliberately cloned — that is
what syncing a vault means — so a per-device counter would drift and the
relying party would read the decrease as a compromise and lock the account.
WebAuthn L2 §6.1.1 permits a constant 0 to mean "no counter implemented", which
is the honest answer. `lastUsedAt` on the vault item carries the usage history a
counter would otherwise hint at.

**The AAGUID is zeroed.** `fmt: "none"` and a self-identifying AAGUID are
inconsistent; an identifiable AAGUID only means something behind a real
attestation statement.

**Backup flags are set (BE|BS).** These credentials genuinely are backed up and
multi-device, and sites increasingly use the flags to decide whether to nag the
user to enrol a second factor.

**The PIN is never entered in a page.** A PIN field rendered into a site's DOM
is both phishable and readable by that site. A locked vault instead sends the
user to the extension's own UI, and the consent prompt polls for the unlock
until the ceremony deadline.

**Consent lives in a closed shadow root.** The page cannot read the prompt,
restyle it, or find it with `querySelector` to fake a click. Verified: with the
prompt open, `document.getElementById('vw-passkey-consent').shadowRoot` is
`null` and its `textContent` is empty.

**The prompt is anchored to the side, and on sign-in the account row is the
button.** A centred modal covers the part of the page the user is reading —
often the sign-in form the ceremony belongs to — so it sits top-right (centred
below 520px, where there is no room at the side). The backdrop stays, because
that is what makes the prompt modal and blocks click-jacking. On a sign-in,
picking the passkey and confirming are the same decision, so the account rows
are styled as the primary control and there is no separate confirm button;
registration keeps one, since there is nothing to pick.

**rpId is checked against the origin** (`isRpIdAllowed`). Without it any page
could ask us to mint or assert a credential for another site — the exact attack
WebAuthn's origin binding exists to stop. `notexample.com` cannot claim
`example.com`, and a parent cannot claim a child's rpId.

**The user can always escape to the browser.** Every prompt offers "use browser
or security key", which returns the ceremony to the native implementation, and
`passkeysEnabled: false` in settings hands over every ceremony without a prompt.
Conditional mediation (passkey-in-autofill) is not implemented, so those
requests are passed straight through rather than swallowed.

## Firefox 128 minimum

`content_scripts` with `world: "MAIN"` landed in Firefox 128. Injecting a
`<script>` tag instead would be subject to page CSP and would lose the race
against page scripts on strict sites, so the manifest requires 128+.

## Imported vs created credentials

`PasskeyItem` predates this work and allowed hand-entered records. Those fields
are still read so old items load, but only credentials with
`createdByAuthenticator: true` are offered during a ceremony — an imported
record has no usable PKCS#8 key and would produce a signature the relying party
rejects, with nothing to tell the user why. The vault editor shows imported
records with a warning and authenticator-created ones read-only.

## Verification

`npm run test:webauthn` runs a relying party against the authenticator: it
parses the attestation with an independently written CBOR decoder, imports the
COSE key, and verifies 300 assertion signatures with WebCrypto, plus the rpId
policy cases. 33/33 passing as of this commit, with DER lengths 69-72B all
exercised.

Browser-side, `inject.ts` was driven through a full register-then-authenticate
cycle in a real engine with a stub bridge; 20/20 checks including an end-to-end
RP verification of the returned credential.

## Not done yet

- **Conditional mediation** (passkeys offered in the autofill dropdown).
  Requires the browser to route the request to us without a modal, and a
  different UI.
- **Cross-device / hybrid transport** (scanning a QR to use a phone). We
  advertise `hybrid` in `getTransports()` because a synced vault credential is
  reachable from other devices *in principle*, but the transport itself is not
  implemented — see the multi-device blocker in `crypto-status.md`.
- **Largeblob, PRF, and other extensions.** `getClientExtensionResults()`
  returns `{}`.
- **Credential deletion signalling.** Removing a passkey from the vault does not
  tell the relying party.
