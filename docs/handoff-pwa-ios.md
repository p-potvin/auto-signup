# Handoff: mobile vault (PWA), iOS first

Rewritten 2026-08-07, after the session that built and deployed the PWA shell.
The original version of this file listed a blocker and a six-step plan; steps
1–4 are done and the blocker turned out to be two blockers, one of which was
not visible from anything the previous session had run.

## Where it stands

**The PWA is live at `https://warden.vaultwares.ca/`, tailnet-only.** It shows
the unlock screen and correctly reports that nothing is enrolled yet. Nothing
else is needed to open it on the phone except Tailscale being connected.

| Step | State |
|---|---|
| 1. Deploy current vault-warden | done — `f33c221` on greencloud |
| 2. Verify enrollment | done — `npm run test:warden-live`, 18/18 against the live service |
| 3. Storage seam | done — `src/platform/store.ts` |
| 4. PWA shell (unlock, list, search, copy) | done — deployed, verified in a browser |
| 5. Face-ID unlock via WebAuthn RP | not started |
| 6. Editing, then offline | not started |

## Do this before putting real data in the vault

**Rotate the keychain.** Commit `4220810` pushed
`.access/vaultwares-recovery-kit-2026-08-05.vwrecovery` to this repo while it
was public. A kit carries the ML-KEM-768 and ML-DSA-65 secret keys (encrypted
under the master key) and the master key wrapped under the device PIN, which
`onboarding/App.tsx` allows to be four characters — a few CPU-hours of Argon2id
at 64 MiB. Assume it was fetched.

Nothing was decryptable: the vault had no items and no account key enrolled. The
cost is forward-looking, and there are two halves to it:

- Items sealed under that same KEM keypair later would be readable by anyone who
  cracked the PIN, retroactively.
- The **signing** secret key is in the kit too, so its holder can forge
  envelopes that verify against the old `sigPublicKey`.

A fresh keychain retires both. The file is untracked and `.gitignore`d now, but
the blob is still reachable in this branch's history — rotation is what makes it
worthless, not its removal.

## What the previous handoff got wrong

The blocker it named was real: the deployed `/opt/vault-warden` was the legacy
377-line build with no `users`, `vaults` or `items` tables. That is fixed.

What it missed is that fixing it would not have been enough.

**vault-warden scoped accounts to the Tailscale *node*, not the user.**
`get_actor` upserted `users` on `node.StableID`. Measured on greencloud:

| device | node StableID | UserProfile.ID |
|---|---|---|
| `clopeux-desktop` | `nHWBUgRYDH11CNTRL` | `4862949105728501` |
| `clopeux-iphone` | `nSmv7Q2CZF11CNTRL` | `4862949105728501` |

Same person, two accounts, two identity vaults. Enrollment would have reported
success on the desktop and the phone would have opened an empty vault with no
account key to unwrap — a failure that only appears on the second device.

**And the local-token branch fired behind nginx.** It tested
`request.client.host == "127.0.0.1"`, which is true for *every* proxied request,
so any tailnet caller holding `VW_SECRETS_LOCAL_TOKEN` got the synthetic local
user's vaults. The extension sends that header from its settings, so it landed
on a third account, distinct from both devices.

Both fixed in vault-warden `#3`; `tests/test_identity_scope.py` pins them.

## What is deployed, and how to redeploy

Both services deploy through `vw-webhookd` on a push to main, same as everything
else on greencloud. Either script is safe to run by hand, in which case it takes
the tip of `origin/main`:

```bash
ssh -i ~/.ssh/id_ed25519 root@100.73.93.84 /var/www/deploy-scripts/deploy-vault-warden.sh
```

```bash
ssh -i ~/.ssh/id_ed25519 root@100.73.93.84 /var/www/deploy-scripts/deploy-vaultwares-pwa.sh
```

- `ops/deploy/deploy-vault-warden.sh` → `/opt/vault-warden`, keeps `venv/`,
  `compose/` and `postgres-data/`, restores the previous tree if `/health` does
  not answer in 30s. Deployed sha in `/opt/vault-warden/.deployed-sha`.
- `ops/deploy/deploy-vaultwares-pwa.sh` → `/var/www/warden.vaultwares.ca`,
  refuses to publish an incomplete bundle.
- `ops/nginx/warden.vaultwares.ca.conf` — nginx serves `/`, vault-warden keeps
  `/v1`, `/health`, `/docs`, `/openapi.json`.

**`p-potvin/vault-warden` has no GitHub webhook**, so its pushes do not
auto-deploy yet. The receiver side is done. Creating the hook returned `403
Resource not accessible by integration` — the GitHub App installation lacks
`admin:repo_hook`. This repo already has its hook (id `628183962`), so the PWA
auto-deploys once this branch merges.

## Things that will bite the next person

- **nginx includes `sites-enabled/*`, not `*.conf`.** A backup left beside the
  original loads as a second server block for the same name. nginx only warns.
  Backups belong in `/etc/nginx/backups/`.
- **The old nginx config sent `Access-Control-Allow-Origin: *`.** That was a
  real hole, not dead weight: vault-warden authenticates by source address, so
  any page a tailnet device loaded could read `/v1/vaults` — or write
  `/v1/account/key` — with the browser supplying the identity. Removed. Do not
  reinstate `snippets/cors.conf` here; the PWA is same-origin and the extension
  declares `<all_urls>` in `host_permissions`.
- **`webpack.pwa.config.js` exports an array, and webpack runs those in
  parallel.** Neither config may set `output.clean`; the app build would delete
  the service worker the much faster SW build had already written. `build:pwa`
  wipes `dist-pwa` once, up front.
- **The web session area is memory only**, by design — it holds the unwrapped
  master key, and `sessionStorage` would put that on disk. A reload therefore
  costs another Argon2id pass. That is the argument for step 5, not a bug.
- **`test/warden-live.mjs` writes to a live vault** and refuses to run when an
  account key is enrolled. It is out of `npm test` on purpose.

## Still true, and still the point

**Native iOS is off the table.** No Mac, no Xcode, no developer programme. That
rules out a native app and a Safari Web Extension both. Do not re-propose them.

The consequence: `ASCredentialProviderExtension` is what makes a password
manager feel native on iOS — QuickType, in-app autofill, system-wide passkeys.
A PWA gets **none** of it. Copy-paste is the ceiling. `mobile/clipboard.ts`
makes copying fast and takes the secret back after 30s, and says so out loud
when Safari refuses the clear (a timer-driven clipboard write is not a user
gesture, so it can be denied).

**PQC is not a problem.** `@noble/post-quantum` is pure JavaScript and the
bundle runs ML-KEM-768 in the browser today — verified, six items decrypted.
Do not "simplify" the crypto to symmetric-only on mobile's account.

`navigator.credentials.get` on iOS goes to the *system* authenticator. That is
correct and wanted for step 5, and it is unrelated to `src/webauthn/`, which is
this extension's own authenticator and cannot be reached from the phone.

**Storage eviction is the reason the install prompt exists.** Safari clears
IndexedDB after ~7 days for sites not on the Home Screen. Local state is a
cache that can always be rebuilt from the server with the master password —
keep it that way, and never let the phone be the only copy of anything.

## Where things live

- `src/mobile/session.ts` — bootstrap, unlock, search. Every interesting failure
  is here, deliberately outside the React tree.
- `src/mobile/App.tsx` — the UI. Read-only.
- `src/mobile/service-worker.ts` — offline shell. **No vault data in Cache
  Storage**; `/v1/` is network-only and uncached, which is verified.
- `src/platform/store.ts` — the seam. `chrome.storage` in the extension,
  IndexedDB on the web, memory for the session area on both.
- `scripts/serve-pwa.mjs` — serves `dist-pwa` on loopback for desktop testing.
  `http://localhost` is a secure context, so service workers and the clipboard
  behave as they will on the phone.

## Suggested order from here

1. Rotate the keychain (above), then enrol a master password from the extension.
2. Open `https://warden.vaultwares.ca/` on the phone and unlock.
3. Face-ID unlock via WebAuthn RP — the PWA as relying party, wrapping the master
   key under a credential so a reload is not another Argon2id pass.
4. Editing, then offline.

## Still open, unrelated to mobile

- Export (CSV / password-protected zip, selection screen, subdomain-flattening
  compatibility mode for re-import into Proton).
- `vaultwares-docs` PR #27 corrects stale architecture claims; if it has not
  merged, the inventory pages still misdescribe what is deployed. They now also
  predate this deployment.
