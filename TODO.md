# TODO

Crypto state, fixed security-review findings, and what is deliberately still
open: `docs/crypto-status.md`. It covers why multi-device key provisioning is
shelved (local-only sync has no shared server between devices — it needs a
tailnet-shared vault-warden) and why the device model must not be deleted.

Passkey design, decisions, and the list of WebAuthn features deliberately not
implemented yet (conditional mediation, hybrid transport, extensions):
`docs/passkeys.md`.

Known gaps from the v2.1.0 work:

- New user-facing strings go through `src/i18n/strings.ts` (EN + QC). The UI
  that predates it — vault, popup, onboarding — is still English-only and needs
  a retrofit pass.
- The suggestion menu lists passkeys for awareness but cannot start a sign-in;
  only the site can begin a ceremony. Conditional mediation would fix this.

Backlog seeds and planning work now live in:

- `docs/program/backlog/github-issue-seeds.md`
- `docs/program/epics/`

Use the issue seed file to mirror planning work into GitHub once write tooling is available.
