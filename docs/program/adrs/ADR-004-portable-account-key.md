# ADR-004: Portable Account Key for Multi-Device Access

## Status

Accepted — 2026-08-05. Supersedes the "shelved: multi-device key provisioning"
section of `docs/crypto-status.md`.

## Context

The extension's keys are bound to one machine. The hierarchy is sound:

```
PIN --Argon2id(salt)--> pin key --unwraps--> master key
master key --decrypts--> ML-KEM-768 + ML-DSA-65 secret keys
KEM secret --opens--> item envelopes
```

but the wrapped master key and its salt are written to `chrome.storage.local`.
Nothing else can ever derive that master key, so a second client — a phone, a
second browser — cannot read a single item. `crypto-status.md` recorded this as
blocked on "a tailnet-shared vault-warden".

That premise is out of date. `vault-warden` already ships:

- Tailscale `whois` identity binding, so a device on the tailnet authenticates
  as its node rather than by presenting a token a user has to type
- `PUT/GET /v1/account/key`, storing `{kdf, salt_b64, protected_user_key}` — a
  password-wrapped user key, which is precisely the missing piece
- per-user `personal` and `identity` vaults holding client-encrypted items the
  server cannot read, with `passkey` among the item kinds

The target client is a **PWA**, not a native iOS app: there is no Mac, no Xcode,
and no intention to pay for an Apple developer account. That decision is what
makes the rest of this ADR possible, and it is worth stating plainly, because
the obvious alternative — converging on symmetric-only crypto — was motivated
almost entirely by CryptoKit having no ML-KEM. With no Swift in the picture,
`@noble/post-quantum` runs in mobile Safari like any other browser and that
pressure disappears.

## Decision

**Keep the entire existing key hierarchy and envelope format. Move only the
wrapping of the master key from local storage to `/v1/account/key`.**

The master key is already structurally identical to vault-warden's "user key":
32 random bytes that wrap the real key material and are themselves wrapped by a
password-derived key. The change is where the wrapped form lives, not what it
is.

```
master password --Argon2id(salt)--> password key      } uploaded as
password key --wraps--> master key                    } protected_user_key
master key --decrypts--> KEM + signing secret keys    } sealed keychain blob
KEM secret --opens--> item envelopes                  } unchanged
```

Consequences of that choice:

- **Item envelopes do not change.** Every stored item stays readable; there is
  no re-encryption step and therefore no migration that can corrupt a vault.
- **ML-KEM-768 / ML-DSA-65 are retained.** Post-quantum protection of items at
  rest is unaffected, satisfying `SECURITY_POSTURE` without a hybrid scheme or a
  documented exception.
- **A password change rewrites one small blob.** Items are sealed under the
  master key and only the master key is wrapped by the password, so changing the
  password never touches item ciphertext — which is what makes it safe to do
  from a phone on a flaky connection.
- **The server still cannot decrypt anything.** It receives KDF parameters, a
  salt, and ciphertext. ADR-002 holds.

**The PIN is demoted, and a real master password is introduced.**

A 4-digit PIN behind Argon2id was defensible while the wrapped blob never left
the machine. Serving that blob to anything on the tailnet changes the threat
model completely: an attacker who can read it grinds a ten-thousand-candidate
keyspace offline, and Argon2id at t=3/m=64MiB does not save it.

So `protected_user_key` is wrapped under a master password with a **12-character
minimum** (`MIN_MASTER_PASSWORD_LENGTH`). The device PIN survives as a
local-only convenience unwrapping a device-held copy of the master key; it never
protects the server-side blob.

**KDF parameters: Argon2id, t=3, m=64 MiB, p=1.** Matched to the existing local
derivation so migrating an install does not silently change the work factor, and
capped at 64 MiB because this now has to run in mobile Safari, where more risks
the tab being reaped mid-unlock. `pbkdf2-sha256` is implemented because
vault-warden accepts it, but is not what this client enrolls with.

## Alternatives rejected

**Converge on vault-warden's symmetric-only item model.** Would have meant
re-encrypting every item, discarding the ML-KEM envelope, and a posture
regression needing its own exception. Its main advantage was avoiding ML-KEM in
Swift — irrelevant once the client is a PWA.

**Provision keys device-to-device with ML-KEM** (the dormant model in
`src/api/devices.ts`). Still the right mechanism for approving a device
*without* sharing the password, and worth keeping for that. It does not replace
this: a new device with no existing device online must still be able to get in,
and a password is the only thing a user carries in their head.

**Leave sync local-only and give the phone a read-only export.** No live vault,
no saving from the phone, and an exported plaintext copy is the thing this
product exists to avoid.

## Consequences

- Users must set a master password. Existing installs have only a PIN, so
  enrollment has to prompt for one, and that flow must be written before any
  device can be added.
- `docs/crypto-status.md` is stale and updated by this change.
- The extension defaults `syncServerUrl` to `127.0.0.1:9444`; multi-device
  requires pointing it at the tailnet vault-warden instead.
- Recovery-kit format is unaffected but should eventually carry the account-key
  blob so a lost password is recoverable.

## Verification

`npm run test:portability` builds "device B" from nothing but the master
password and the two blobs the server holds, and opens an item sealed by device
A — 17/17, including that the master key never appears in the uploaded blob,
that `deviceId` does not travel between devices, that a password change
preserves the master key, and that items still open afterwards.
