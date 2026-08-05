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

## Shelved: multi-device key provisioning

Vault sync is **local-only**: the extension syncs to a `vault-warden` running on
the same machine (`127.0.0.1:9444`), and each person runs their own. There is no
shared server between devices, so a second device cannot reach another device's
items at all — provisioning it a key would unlock nothing.

This blocks the ROADMAP goal of "the same encrypted vault across browser,
desktop, iOS, and Android".

**Intended path:** put users on their own tailnet and point their devices at one
shared `vault-warden` over it, rather than loopback. Once devices share a sync
target, multi-device provisioning becomes real work:

- an account-level vault key, KEM-encrypted to each approved device's device key
  at approval time, so a new device can decapsulate and read existing items
- the existing device model (`src/api/devices.ts`, register/approve/promote) is
  **dormant, not dead** — it was built for the cloud API and would be reused here.
  Do not delete it.

Note the recovery kit restores *keys*, not *items*: a new machine's vault-warden
database starts empty, so moving machines also needs an item export/restore.

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
