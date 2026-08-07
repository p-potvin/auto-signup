# Crypto status

Current state of the vault's cryptography, what a security review found, and what
is deliberately still open. Written 2026-07-15, updated 2026-08-05.

## Passkey key material (added v2.1.0)

WebAuthn credentials use ECDSA P-256 (COSE ES256) because that is what relying
parties verify — it is fixed by the protocol and is not a choice the vault gets
to make post-quantum. The classical P-256 key is only ever the *contents* of a
vault item: it is sealed inside the same ML-KEM-768 envelope as everything else,
so at rest it carries the vault's PQC protection. See `docs/passkeys.md`.

Private keys are generated in the background service worker, exported once as
PKCS#8, and immediately encrypted. They are never sent to a page — the injected
page script only ever receives a finished signature.

## Key hierarchy (as implemented)

```
PIN --Argon2id(salt)--> pin key --unwraps--> master key
master key --decrypts--> account KEM + signing secret keys
account KEM secret --opens--> item envelopes (KEM-DEM)
```

`chrome.storage.local` holds only public keys and ciphertext. Secret keys exist
in cleartext only in memory (and `chrome.storage.session`) while unlocked.

**Envelope v2** (`src/crypto/envelope.ts`, `src/utils/identity-storage.ts`):
data is encrypted under the ML-KEM-768 shared secret; the envelope carries the
encapsulated key, and an ML-DSA-65 signature covers `version | itemType |
encapsulatedKey | ciphertext | nonce | canonicalJSON(metadata)`.

## Fixed

Each of these was individually fatal or security-defeating:

- **Nothing could ever decrypt.** Items were encrypted under a random key that
  was then discarded; decryption derived the KEM shared secret instead, which was
  never that key. Now proper KEM-DEM (the shared secret *is* the data key).
- **`decapsulate()` arguments were reversed** for `@noble/post-quantum` 0.2.x
  (`(cipherText, secretKey)`), so it threw at runtime regardless.
- **Every install shared one signing key** — ML-DSA keygen used an all-zero seed,
  making signatures forgeable by anyone. Now seeded with fresh randomness.
- **Signature didn't cover `encapsulatedKey`** and used non-canonical
  `JSON.stringify` for metadata (order-dependent verification).
- **Setup registered a different keypair than it stored**, so the server held
  public keys whose secrets this device never had.
- **Secret keys were stored in plaintext at rest**, and the master key/PIN was
  inert — it gated the UI but encrypted nothing. Storage access alone opened the
  whole vault without the PIN. See the key hierarchy above.
- **Recovery kit could not recover anything** — it wrapped a freshly generated,
  unrelated KEM keypair. v2 carries the real account secret keys.

Envelope v2 and the new keychain layout both changed formats. Existing installs
must re-run setup; nothing of value is lost because old items were undecryptable.

## Multi-device: unblocked (2026-08-05)

This section previously said multi-device was shelved pending "a tailnet-shared
vault-warden". That premise was wrong: `vault-warden` already provides Tailscale
`whois` identity binding, per-user client-encrypted vaults, and
`PUT/GET /v1/account/key` — a password-wrapped portable user key.

The extension's `masterKey` is structurally the same thing as that user key: 32
random bytes wrapping the real key material. The only reason it was not portable
is that its wrapped form lived in `chrome.storage.local`. Moving that one blob
to `/v1/account/key` makes any device with the master password able to open the
vault, with **no change to the item envelopes and no loss of ML-KEM**.

See `docs/program/adrs/ADR-004-portable-account-key.md` for the decision and
`src/crypto/account-key.ts` for the implementation. `npm run test:portability`
proves a device built only from the password and the server's blobs opens an
item sealed by another device.

Still true, and still open:

- The default `syncServerUrl` is `127.0.0.1:9444`. Multi-device requires
  pointing it at the tailnet vault-warden.
- **Existing installs have a PIN, not a master password.** Enrollment and
  migration are not written yet; until they are, nothing actually moves.
- The device model (`src/api/devices.ts`, register/approve/promote) is
  **dormant, not dead**. It remains the right mechanism for approving a device
  *without* sharing the password. Do not delete it.
- The recovery kit restores *keys*, not *items*, and does not yet carry the
  account-key blob.

## Superseded: the PIN as the only secret

A numeric PIN behind Argon2id was acceptable while the wrapped master key never
left the machine. Once that blob is served to anything on the tailnet, a
ten-thousand-candidate keyspace falls to offline grinding regardless of the work
factor.

ADR-004 therefore introduces a master password with a 12-character minimum for
the server-side blob, and demotes the PIN to a local-only convenience unwrapping
a device-held copy. The PIN must never again be the only thing protecting
material that leaves the device.

## Still open (lower severity)

- A numeric PIN behind Argon2id is still brute-forceable offline once the wrapped
  blob + salt are readable. Prefer a passphrase, or rate-limited unlock.
- Access/refresh tokens sit in `chrome.storage.local` in the clear (`src/api/auth.ts`).
- `uuid()` in `src/crypto/envelope.ts` falls back to `Math.random()` when
  `crypto.randomUUID` is absent.
- `String.fromCharCode(...spread)` base64 helpers (`src/crypto/kdf.ts`,
  `src/crypto/symmetric.ts`) throw `RangeError` on large inputs; `pqc.ts` has a
  safe loop version to standardize on.
- AI persona generation via `/generate/identity` happens **server-side in
  plaintext**, so the generation service sees every persona before it is
  encrypted. The local Ollama path (`generationEndpointUrl`) avoids this.
- `facePhoto` is plumbed through types, encryption and UI but `createIdentityObject`
  hardcodes it to `null` and generation returns no image — there is currently no
  AI visual asset. If added, store it as a separate encrypted attachment rather
  than inline in the identity blob, so editing metadata doesn't re-sync megabytes.
