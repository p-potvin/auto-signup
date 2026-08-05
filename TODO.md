# TODO

Crypto state, fixed security-review findings, and what is deliberately still
open: `docs/crypto-status.md`. It covers why multi-device key provisioning is
shelved (local-only sync has no shared server between devices — it needs a
tailnet-shared vault-warden) and why the device model must not be deleted.

Passkey design, decisions, and the list of WebAuthn features deliberately not
implemented yet (conditional mediation, hybrid transport, extensions):
`docs/passkeys.md`.

Form detection, what gets offered for autofill, and how the save prompt survives
a navigation: `docs/autofill.md`.

Known gaps from the v2.1.0 work:

- New user-facing strings go through `src/i18n/strings.ts` (EN + QC). The UI
  that predates it — vault, popup, onboarding — is still English-only and needs
  a retrofit pass.
- The suggestion menu lists passkeys for awareness but cannot start a sign-in;
  only the site can begin a ceremony. Conditional mediation would fix this.
- **Sync covers vault items only.** Identities are stored under a separate key
  (`src/utils/identity-storage.ts`) that `fullSync` never touches, so a persona
  exists on one machine only. The vault sidebar says so rather than implying
  otherwise. Extending sync to identities is straightforward; the multi-device
  blocker in `docs/crypto-status.md` is the reason it has not been worth doing.
- Closing a tab before answering the save prompt discards the pending save.

Backlog seeds and planning work now live in:

- `docs/program/backlog/github-issue-seeds.md`
- `docs/program/epics/`

Use the issue seed file to mirror planning work into GitHub once write tooling is available.
