# Handoff: mobile vault (PWA), iOS first

Written 2026-08-07, at the end of the session that built master-password
enrollment. Read this before starting mobile work — several things that look
decided are not, and one thing that looks working is not deployed.

## The decision already made, and why

**Native iOS is off the table.** No Mac, no Xcode, and no intent to pay for the
Apple developer programme. That rules out both a native app and a Safari Web
Extension, since Xcode is mandatory to build and sign either. Do not re-propose
them.

The consequence to internalise: **`ASCredentialProviderExtension` is what makes
a password manager feel native on iOS** — QuickType bar, in-app autofill, and
since iOS 17 passkeys system-wide. A PWA gets **none** of that. Copy-paste is
the ceiling. Say so plainly rather than implying parity.

What a PWA *can* do that is worth having:

- Read and search the vault on the phone.
- Unlock with Face ID via WebAuthn — the PWA acts as a *relying party* here,
  which is unrelated to the authenticator work in `src/webauthn/` and is the one
  place iOS biometrics are available to us.
- Work offline once installed, with a service worker.

## The blocker nobody has hit yet

`src/api/warden.ts` calls `/v1/account/key` and `/v1/vaults/{id}/items`.
**Those endpoints do not exist in production.** Measured 2026-08-07 over SSH:
`/opt/vault-warden` on greencloud is the legacy 377-line build, not a git
checkout, with only `secrets` and `audit_log` tables — no `users`, `vaults` or
`items`. Enrollment will 404 against the live service.

So the first mobile task is not mobile at all:

1. Deploy the current `vault-warden` repo to greencloud, replacing the legacy
   build. Check `vault-warden` PR #2 first — it adds a fail-fast database probe,
   without which a misconfigured DSN is a 30-second hang and an opaque
   `PoolTimeout`.
2. Prove enrollment browser-to-browser before involving a phone. If two Firefox
   profiles cannot share a vault, a PWA will not either, and debugging it on a
   phone is far worse.

Only then does mobile become a real task.

## What is already built and portable

Enrollment is done and tested (`npm run test:portability`, 28/28), including a
device bootstrapped purely from the enrollment bundle opening an item sealed by
the original. The model:

```
master password --Argon2id--> password key --unwraps--> master key   (server: /v1/account/key)
master key --opens--> sealed portable keychain                        (server: identity vault item)
keychain --> ML-KEM secret --opens--> item envelopes
```

The PIN is unchanged and stays device-local; it wraps a local copy of the master
key for quick unlock. The phone has no PIN and starts from the master password.

**PQC is not a problem here.** `@noble/post-quantum` is pure JavaScript and runs
in iOS Safari. The reason ML-KEM looked like a blocker earlier was the *native*
path, where CryptoKit has no ML-KEM and you would be binding liboqs into Swift.
Going PWA removes that entirely — do not "simplify" the crypto to symmetric-only
on mobile's account. That would be a real posture regression for no gain.

## Where the PWA should be served from

vault-warden already serves over the tailnet behind `warden.vaultwares.ca`
(nginx on greencloud to `127.0.0.1:9444`). `clopeux-iphone` (`100.75.112.67`) is
already on the tailnet, so the transport exists today.

Serving the PWA from vault-warden itself is the least-moving-parts option: same
origin as the API, no CORS, no second deployment. Tailnet-only, which is the
right default for a vault.

Note the earlier deployment discussion concluded vault-warden would run on
`clopeux-desktop`. **It is already on greencloud and running there** — the
desktop plan predated checking. Greencloud is the better host anyway: always on,
so the phone does not lose the vault when the desktop sleeps.

## Reusable as-is

`src/crypto/`, `src/utils/domain.ts`, `src/utils/import.ts`, `src/types/` have no
`chrome.*` dependency. `src/utils/storage.ts` does, and is the seam — a PWA needs
an IndexedDB implementation behind the same interface.

The vault UI is React and already responsive-ish, but it was built for a 1280px
tab. Expect real layout work, not a media query.

## iOS-specific traps

- **Storage eviction.** Safari clears IndexedDB/localStorage after ~7 days of
  non-use for sites that are not installed to the Home Screen. For a cached
  vault that means silent data loss. Two mitigations: prompt to install, and
  treat local state as a cache that can always be rebuilt from the server with
  the master password. Never let the phone be the only copy of anything.
- **No autofill.** Nothing can be done about this. Design the copy flow to be
  genuinely fast — one tap to copy, clipboard cleared on a timer.
- **`navigator.credentials.get` on iOS** goes to the system authenticator. That
  is correct and wanted for Face-ID unlock; it is *not* the extension's
  authenticator and cannot be made to be.
- **Service worker + crypto.** Do not cache decrypted material in the service
  worker's cache storage. It outlives the tab.

## Suggested order

1. Deploy current vault-warden (see blocker above).
2. Verify enrollment browser-to-browser.
3. Extract the storage seam so `src/crypto` and `src/utils` build outside the
   extension.
4. PWA shell: unlock, list, search, copy. No editing at first.
5. Face-ID unlock via WebAuthn RP.
6. Editing, then offline.

## Still open, unrelated to mobile

- Export (CSV / password-protected zip, selection screen, subdomain-flattening
  compatibility mode for re-import into Proton).
- Item sync still targets `api/sync.ts` rather than vault-warden's item API.
- `vaultwares-docs` PR #27 corrects several stale architecture claims; if it has
  not merged, the inventory pages still misdescribe what is deployed.
