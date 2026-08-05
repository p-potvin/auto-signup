# VaultWares Identity Manager — Roadmap

## Product Definition

A privacy-first identity vault that lets users:

- Store encrypted logins, addresses, cards, TOTP seeds, notes, files, and related metadata
- Generate fully fictional but realistic personas for online sign-ups
- Detect sign-up and login pages in the browser and suggest either a new fictional identity or an existing domain-linked one
- Manage the same encrypted vault across browser, desktop, iOS, and Android clients
  - **Blocked today.** Vault sync is local-only (the extension syncs to a
    `vault-warden` on the same machine), so devices share nothing. Reaching this
    goal means putting users on their own tailnet and pointing their devices at
    one shared `vault-warden` over it, then provisioning the account key to each
    approved device. See `docs/crypto-status.md`.

**Not intended for:** impersonation, KYC bypass, forged identity documents, reference-image cloning, or evasive abuse automation.

## Current State (v2.1)

- Browser extension (Chrome + Firefox 128+ MV3) with PQC crypto, vault UI, popup, content script, onboarding
- **Passkeys:** the extension is a real WebAuthn authenticator — it creates ES256
  credentials, stores the private keys in the encrypted vault, and signs
  assertions. See `docs/passkeys.md`
- **Identities without AI:** personas can be created and edited by hand;
  generation is an optional convenience over the same editor
- 14 API endpoints under `/v1/` in `vaultwares-api` (auth, vault CRUD, sync, devices)
- Zero-knowledge encryption: ML-KEM-768, ML-DSA-65, AES-256-GCM, Argon2id KDF
- Encrypted local cache with sync-ready records

## Release Phases

### Phase 1 — Foundation (current)

- [x] Branding direction and UX skeleton
- [x] Extension architecture rewrite (encrypted storage, sync-ready)
- [x] Zero-knowledge encryption model (PQC + symmetric + KDF)
- [x] API surface `/v1/` with auth, vault, sync, device routes
- [x] Database schema v1 (Tortoise ORM + Prisma)
- [x] Chrome + Firefox MV3 compatibility
- [x] Password generator presets (Classic, Correct-Horse, The Token)
- [x] Configurable generator rules GUI
- [x] Auto-lock fix (session storage for master key persistence)
- [x] Item type selector on creation
- [x] Popup: quick gen behind button, autofill from popup, new item from current tab
- [x] Content script: AUTOFILL message listener for popup-triggered fill
- [x] Identity management: Identity type, encrypted storage, AI generation (Ollama JSON), identity-first vault UI, popup grouping by identity, content script identity grouping, item-to-identity assignment, lastUsedAt tracking
- [x] Manual identity creation and editing (no generation endpoint required)
- [x] WebAuthn authenticator: `navigator.credentials` interception, ES256 keygen, CBOR attestation, DER assertion signing, in-page consent, browser fallback
- [x] Field detection rewrite: shadow-DOM traversal, MutationObserver rescan for SPA forms, per-form scoping, keyboard navigation, save-login prompt

### Phase 2 — Integration

- [ ] Connect extension, API, and pipelines end-to-end
- [x] Domain suggestion behavior (subdomain matching, URL matching, proactive inline suggestions, create-from-page fallback)
- [x] Offline queue and retry behavior
- [x] Auto-sync on startup + periodic sync (60s interval)
- [x] Sync conflict resolution (last-write-wins by updatedAt)
- [ ] Domain profile and identity suggestion APIs
- [ ] Generation job orchestration (pipelines)
- [ ] Stabilize testing and rollout gates

### Phase 3 — Companion Clients

- [ ] Desktop app (full vault-management client)
- [ ] iOS app + Password AutoFill extension
- [ ] Android app + AutofillService
- [ ] Mock subscription and entitlement surfaces
- [ ] Cross-platform QA matrix
- [ ] Keep paid/telecom/network features mocked

### Phase 4 — Commercial & Growth

- [ ] Billing best-practices research
- [ ] Phone-number provider landscape research
- [ ] IP/network product feasibility research
- [ ] Pricing and packaging framework
- [ ] Marketing and publicity strategy
- [ ] SEO/content plan
- [ ] `vaultwares-website` revamp

## Epics

### EPIC-01: Branding, UI/UX Skeleton, Encryption Flow

**Goal:** Define visual identity, trust language, interaction model, and encryption-facing UX.

**Workstreams:**
1. Theme audit and candidate skins (from `vault-themes`)
2. Brand foundation (name, tone, value prop, trust language, icon direction)
3. UX skeleton (extension popup, full vault, desktop, iOS, Android IA)
4. Encryption and recovery UX (onboarding, PIN, device registration, recovery kit, lost-device)
5. Canva program (moodboard, sitemap, screens, diagrams)

**Done when:** Approved brand foundation, semantic tokens, screen skeletons, encryption/recovery UX diagrams.

### EPIC-02: Web Extension, Database, API

**Goal:** Turn the local-only prototype into the first client of a global encrypted identity platform.

**Workstreams:**
1. Extension architecture rewrite (encrypted storage, sync-ready, module boundaries)
2. Cross-browser support (Chrome/Firefox packaging, QA matrix)
3. API surface spec (`/v1` routes for auth, devices, vault, sync, domains, generation, artifacts)
4. Database schema v1 (users, devices, vault items, item versions, domain profiles, audit events)
5. `vaultwares-api` expansion (persona generation, async jobs, callback signing)
6. Mock commerce and entitlements (plan catalog, invoices, subscriptions — simulated)

**Done when:** Approved extension PRD, API/schema package, api plan, sync/offline strategy.

### EPIC-03: Encryption Implementation and Module Integration

**Goal:** Specify the full cryptographic architecture connecting extension, API, and pipelines.

**Workstreams:**

1. Key hierarchy (account root, device keys, item keys, recovery material, wrapping/rotation)
2. PIN and session unlock (Argon2id derivation, session lifetime, re-lock triggers, biometric)
3. Vault envelope format (version, ciphertext, nonce, wrapped key, metadata, integrity)
4. Recovery and rekey (recovery kit contents, export/import, rekey triggers, lost-device)
5. Pipelines artifact sealing (encrypted generation results, signed callbacks, searchable metadata)
6. Sync and conflict handling (optimistic writes, pending queue, version merge, conflict UX)
7. Security observability (correlation IDs, audit/risk events, logging rules, dashboards)

**Done when:** Server cannot decrypt vault by design, generated bundles arrive encrypted, recovery/revocation flows are concrete.

### EPIC-04: Desktop, Mobile, Mock Data, Tests

**Goal:** Deliver companion clients and release-grade QA.

**Workstreams:**
1. Desktop client (vault browsing, CRUD, artifact review, device approval, recovery, mock plans)
2. iOS client (SwiftUI shell, Password AutoFill extension, Secure Enclave/keychain)
3. Android client (native shell, AutofillService, encrypted cache, unlock)
4. Mock data services (simulated plans, entitlements, phone/IP products)
5. QA matrix (cross-client sync, onboarding/recovery, autofill, accessibility, performance, offline)
6. Finishing touches (empty states, edge copy, store icons, packaging checklists)

**Done when:** Approved PRDs for desktop/iOS/Android, mock service catalog, QA matrix, release checklist.

### EPIC-05: Research, Deferred Commercial, Marketing

**Goal:** Research future commercial/infrastructure layers without implementation.

**Constraint:** Research-only — no implementation until legal entity, budget, and provider strategy are ready.

**Workstreams:**
1. Billing research (self-managed vs provider, legal/compliance, mock-to-real migration)
2. Phone number product research (providers, portability, compliance, fraud)
3. IP/network product research (static vs dynamic, abuse monitoring, provisioning)
4. Pricing and packaging (plan ladder, low-cost vs high-cost features, mock-only gates)
5. Marketing and publicity (positioning, audience segments, messaging, launch narrative)
6. SEO and content (content clusters, keywords, landing pages, education strategy)
7. Website revamp (IA, conversion funnels, feature pages, asset requirements)

**Done when:** All research briefs authored with decision criteria and deferred implementation gates.

## Architecture Decisions

- **ADR-001:** Product boundary — fictional personas for privacy, not impersonation or KYC bypass
- **ADR-002:** Zero-knowledge model — server stores ciphertext only, clients own decryption
- **ADR-003:** Repo boundaries — extension, API, desktop, iOS, Android as separate repos

## Future Repo Map

| Repo | Purpose |
|------|---------|
| `vaultwares-identity-manager` | Browser extension + shared planning anchor |
| `vaultwares-identity-api` | Account, sync, device, entitlement, orchestration APIs |
| `vaultwares-identity-desktop` | Desktop companion app |
| `vaultwares-identity-ios` | iOS app + Password AutoFill extension |
| `vaultwares-identity-android` | Android app + AutofillService |
| `vaultwares-pipelines` | AI generation and artifact orchestration backend |
| `vaultwares-website` | Public marketing site |

## Backlog Issue Seeds

### EPIC-01
- Audit `vault-themes` and shortlist candidate skins
- Define semantic token map for Identity Manager surfaces
- Create brand strategy brief and trust-language guide
- Design extension popup and signup/login suggestion shells
- Design desktop, iOS, and Android shell concepts
- Design encryption, recovery, and device approval journeys

### EPIC-02
- Split extension responsibilities into detection, autofill, vault UI, sync, unlock modules
- Define Chrome/Firefox packaging compatibility matrix
- Define `/v1` API route groups and ownership
- Design database schema v1 for encrypted sync and domain suggestions
- Define `vaultwares-pipelines` identity-generation orchestration contract
- Define sync/offline queue and reconciliation model
- Define mock subscription and entitlement contracts

### EPIC-03
- Define client key hierarchy and wrapping model
- Define PIN/session unlock rules across clients
- Define vault envelope v1 format
- Define recovery kit export/import and rekey policy
- Define sealed artifact delivery contract from pipelines to API
- Define audit/risk event taxonomy and safe logging rules

### EPIC-04
- Draft desktop product requirements and shell responsibilities
- Draft iOS app and Password AutoFill extension requirements
- Draft Android app and AutofillService requirements
- Define mock premium-product catalog for UI/testing
- Define cross-platform QA matrix and release checklist

### EPIC-05
- Research billing best practices and mock-to-real migration strategy
- Research phone-number provider landscape and feasibility
- Research IP/network product feasibility
- Define pricing and packaging framework
- Define marketing and publicity strategy
- Define SEO/content plan
- Create `vaultwares-website` revamp brief and IA proposal

## Glossary

- **Artifact Manifest:** Metadata object describing generated encrypted outputs for a persona bundle
- **Domain Profile:** Normalized metadata about a site or domain cluster for login/sign-up suggestions
- **Fictional Persona:** Realistic, synthetic, non-user-supplied identity for privacy-preserving use
- **Recovery Kit:** Exported user-controlled bundle required to regain access when devices are lost
- **Vault Item:** Any encrypted record stored in the identity vault (login, card, note, file, TOTP seed, persona)
- **Zero-Knowledge Client-First:** Trust model where the API stores ciphertext and wrapped keys, clients own decryption
