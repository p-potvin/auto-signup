# vaultwares-identity-manager

> A **VaultWares** project.

Identity vault, passkey authenticator, and auto-signup extension for Firefox 128+
and Chrome. Detects login and sign-up forms, suggests vault entries, and acts as
a full WebAuthn authenticator so passkeys live in the encrypted vault instead of
a single device.

## Capabilities

- **Passkeys.** Replaces `navigator.credentials` to create and assert real
  WebAuthn credentials (ES256), with the private keys sealed in the vault. Every
  ceremony needs explicit consent, and the browser or a security key is always
  one click away. Design and open gaps: `docs/passkeys.md`.
- **Identities.** Personas are created and edited by hand; AI generation is an
  optional convenience over the same editor and is never required.
- **Autofill.** Detects credential forms across shadow roots and late-rendered
  SPA views, scopes fills to one form, and offers to save what you submit.

## Verification

```bash
npm run typecheck && npm run test:webauthn && npm run build
```

`test:webauthn` runs a relying party against the authenticator — it parses the
attestation with an independent CBOR decoder and verifies 300 assertion
signatures with WebCrypto.

## Program Documentation

This repository now acts as the planning anchor for the broader VaultWares Identity Manager program while the API, desktop, iOS, and Android repos are still future work.

Start here:

- `docs/program/README.md` for the full program index
- `docs/program/epics/` for delivery lanes
- `docs/program/adrs/` for core architectural decisions
- `docs/program/backlog/github-issue-seeds.md` for issue-ready backlog seeds

## VaultWares Branding

This project uses [vaultwares-themes](https://github.com/p-potvin/vaultwares-themes) — the centralized VaultWares theme library — included here as a git submodule under `vaultwares-themes/`.

## Getting Started

After cloning, initialize the submodule:

```bash
git submodule update --init --recursive
```
