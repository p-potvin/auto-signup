#!/usr/bin/env node
/**
 * A throwaway vault-warden with a fixture vault in it, for working on the
 * mobile UI.
 *
 * The unlocked screens — the item list, the detail rows, the TOTP ticker — can
 * only be looked at with a vault open, and the real one is somebody's actual
 * passwords behind a master password nobody else has. Pointing at production to
 * check a font size means either enrolling a throwaway password over the top of
 * a real account key (destructive, no undo) or not checking at all.
 *
 *   node scripts/mock-warden.mjs [port]
 *
 * Master password: mock-master-password-1234
 *
 * Loopback-only, and it holds nothing but generated fixtures. Every blob is
 * built with the real crypto, so what the UI renders has gone through the same
 * Argon2id, ML-KEM-768 and ML-DSA-65 path as production — a mock that skipped
 * that would not exercise the slow unlock this UI is shaped around.
 */

import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2] ?? 5200);
const PASSWORD = 'mock-master-password-1234';
const KEYCHAIN_ITEM_NAME = 'vw:keychain:v1';
const IDENTITY_VAULT_ID = 5;

const outDir = join(ROOT, '.vw-mock-build');

function buildCrypto() {
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    const tsc = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
    execFileSync(process.execPath, [
        tsc,
        join(ROOT, 'src/crypto/account-key.ts'),
        join(ROOT, 'src/crypto/enrollment.ts'),
        join(ROOT, 'src/crypto/envelope.ts'),
        join(ROOT, 'src/crypto/pqc.ts'),
        join(ROOT, 'src/crypto/symmetric.ts'),
        '--outDir', outDir,
        '--module', 'ES2020', '--target', 'ES2020',
        '--moduleResolution', 'bundler', '--lib', 'ES2020,DOM',
        '--strict', '--skipLibCheck', '--esModuleInterop',
    ], { stdio: 'inherit' });

    for (const rel of ['crypto/account-key.js', 'crypto/enrollment.js', 'crypto/envelope.js', 'crypto/pqc.js', 'crypto/symmetric.js', 'types/index.js']) {
        const file = join(outDir, rel);
        try {
            writeFileSync(
                file,
                readFileSync(file, 'utf8')
                    .replace(/from '\.\/([\w-]+)'/g, "from './$1.js'")
                    .replace(/from '\.\.\/([\w/-]+)'/g, "from '../$1.js'"),
            );
        } catch { /* not every file is emitted */ }
    }
}

const FIXTURES = [
    ['login', { url: 'github.com', username: '', email: 'ada@example.com', password: 'S3cret-github-pw!', notes: 'work account', totpSecret: 'JBSWY3DPEHPK3PXP' }, { label: 'GitHub', domain: 'github.com', tags: ['work'], favorite: true }],
    ['login', { url: 'banquenationale.ca', username: 'ada.l', email: '', password: 'correct horse battery staple', notes: '' }, { label: 'Banque Nationale', domain: 'banquenationale.ca', tags: ['finance'], favorite: false }],
    ['login', { url: 'netflix.com', username: '', email: 'ada@example.com', password: 'watch-me-42', notes: '' }, { label: 'Netflix', domain: 'netflix.com', tags: [], favorite: false }],
    ['login', { url: 'hydroquebec.com', username: '', email: 'ada@example.com', password: 'kilowatt-heure-99', notes: '' }, { label: 'Hydro-Québec', domain: 'hydroquebec.com', tags: [], favorite: false }],
    ['card', { holderName: 'Ada Lovelace', cardNumber: '4111111111111111', expiryMonth: '09', expiryYear: '2029', cvv: '123', notes: '' }, { label: 'Visa personnelle', tags: ['finance'], favorite: false }],
    ['totp', { label: 'AWS root', secret: 'JBSWY3DPEHPK3PXP', issuer: 'Amazon', digits: 6, period: 30, algorithm: 'SHA1' }, { label: 'AWS root', tags: ['work'], favorite: false }],
    ['address', { fullName: 'Ada Lovelace', street: '1 rue Principale', city: 'Montréal', state: 'QC', zipCode: 'H2X 1Y4', country: 'Canada', phone: '+1 514 555 0100' }, { label: 'Domicile', tags: [], favorite: false }],
    ['passkey', { rpId: 'webauthn.io', credentialId: 'abc', privateKey: 'x', userHandle: 'y', userName: 'ada@example.com' }, { label: 'webauthn.io', tags: [], favorite: false }],
];

buildCrypto();
const base = pathToFileURL(join(outDir, 'crypto')).href;
const account = await import(`${base}/account-key.js`);
const enrollment = await import(`${base}/enrollment.js`);
const envelope = await import(`${base}/envelope.js`);
const pqc = await import(`${base}/pqc.js`);
const symmetric = await import(`${base}/symmetric.js`);

const kemKp = pqc.generateKemKeyPair();
const sigKp = pqc.generateSigKeyPair();
const masterKey = symmetric.generateSymmetricKey();
const toEnc = r => ({ ciphertext: pqc.toBase64(r.ciphertext), nonce: pqc.toBase64(r.nonce) });
const keychain = {
    kemPublicKey: pqc.toBase64(kemKp.publicKey),
    sigPublicKey: pqc.toBase64(sigKp.publicKey),
    kemSecretKeyEnc: toEnc(symmetric.encrypt(kemKp.secretKey, masterKey)),
    sigSecretKeyEnc: toEnc(symmetric.encrypt(sigKp.secretKey, masterKey)),
    deviceId: 'mock-device',
};

const bundle = enrollment.buildEnrollment(masterKey, keychain, PASSWORD);
const items = FIXTURES.map(([type, data, meta]) => envelope.createEnvelope(
    envelope.createVaultItem(type, data, meta, 'mock-device'),
    kemKp.publicKey, sigKp.secretKey, 'mock-device',
));
rmSync(outDir, { recursive: true, force: true });

// Wide open, because in production the PWA is same-origin with the API and this
// mock is on a second loopback port purely so it does not collide with the
// static server. Production must NOT carry these headers — vault-warden
// authenticates by source address, so a permissive origin there lets any page a
// tailnet device loads read the vault. See ops/nginx/warden.vaultwares.ca.conf.
const DEV_CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-VW-Local-Token',
};

function send(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...DEV_CORS });
    res.end(payload);
}

createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/\/$/, '');

    if (req.method === 'OPTIONS') {
        res.writeHead(204, DEV_CORS);
        res.end();
        return;
    }

    if (path === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain', ...DEV_CORS });
        res.end('ok');
        return;
    }
    if (path === '/v1/whoami') {
        return send(res, 200, {
            login: 'mock@github', display_name: 'Mock User',
            node: 'mock-node', is_local: false, enrolled: true,
        });
    }
    if (path === '/v1/vaults') {
        return send(res, 200, { vaults: [{ id: 4, kind: 'personal' }, { id: IDENTITY_VAULT_ID, kind: 'identity' }] });
    }
    if (path === '/v1/account/key') {
        return send(res, 200, bundle.accountKey);
    }
    if (path === `/v1/vaults/${IDENTITY_VAULT_ID}/items`) {
        return send(res, 200, { items: [{ id: 1, kind: 'note', name: KEYCHAIN_ITEM_NAME, mode: 'user', updated_at: new Date(0).toISOString() }] });
    }
    if (path === `/v1/vaults/${IDENTITY_VAULT_ID}/items/1`) {
        return send(res, 200, { cipher: bundle.sealedKeychain });
    }
    if (path === '/v1/identity/sync/changes') {
        return send(res, 200, { items, cursor: new Date(0).toISOString(), hasMore: false });
    }

    send(res, 404, { detail: `mock-warden has no route for ${path}` });
}).listen(PORT, '127.0.0.1', () => {
    console.log(`mock vault-warden on http://127.0.0.1:${PORT}/v1`);
    console.log(`master password: ${PASSWORD}`);
    console.log(`${items.length} fixture items`);
});
