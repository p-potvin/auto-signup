/**
 * End-to-end enrollment against the real vault-warden. Run with:
 *
 *   npm run test:warden-live
 *
 * `test:portability` already proves the crypto: a device holding only the
 * password and the two blobs can open an item. What it cannot prove is that
 * those blobs survive the round trip through the actual server — that the JSON
 * shapes match what `PUT /v1/account/key` validates, that the identity vault is
 * reachable, and that the account a request lands on is the *user's* and not the
 * device's. That is what this checks, which is why it is not in `npm test`: it
 * needs the tailnet and it writes to a live vault.
 *
 * Safety: it refuses to run if an account key is already enrolled, because
 * `PUT /v1/account/key` overwrites in place and there is no undo. Set
 * VW_LIVE_OVERWRITE=1 only if you know the vault is disposable.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = (process.env.VW_WARDEN_BASE || 'https://warden.vaultwares.ca/v1').replace(/\/$/, '');
const KEYCHAIN_ITEM_NAME = 'vw:keychain:v1';
const PASSWORD = 'live-roundtrip-master-password';

const outDir = join(ROOT, '.vw-test-build-live');

function build() {
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

const results = [];
function check(name, ok, detail = '') {
    results.push({ name, ok: !!ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function api(path, options = {}) {
    const resp = await fetch(`${BASE}${path}`, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
    const text = await resp.text();
    let body;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: resp.status, body };
}

async function main() {
    console.log(`vault-warden at ${BASE}\n`);

    const vaults = await api('/vaults');
    if (vaults.status !== 200) {
        console.error(`Cannot reach vault-warden (HTTP ${vaults.status}). On the tailnet?`);
        console.error(JSON.stringify(vaults.body));
        process.exit(1);
    }
    check('GET /vaults answers', true);

    const identity = (vaults.body.vaults || []).find(v => v.kind === 'identity');
    check('the account has an identity vault', !!identity, identity ? `id ${identity.id}` : 'none returned');
    if (!identity) process.exit(1);

    const existing = await api('/account/key');
    if (existing.status === 200 && process.env.VW_LIVE_OVERWRITE !== '1') {
        console.error('\nAn account key is already enrolled. This test overwrites it and there is no undo.');
        console.error('Re-run with VW_LIVE_OVERWRITE=1 only if this vault is disposable.');
        process.exit(2);
    }
    check('no key enrolled yet, safe to write', existing.status === 404, `HTTP ${existing.status}`);

    build();
    const cryptoBase = pathToFileURL(join(outDir, 'crypto')).href;
    const account = await import(`${cryptoBase}/account-key.js`);
    const enrollment = await import(`${cryptoBase}/enrollment.js`);
    const envelope = await import(`${cryptoBase}/envelope.js`);
    const pqc = await import(`${cryptoBase}/pqc.js`);
    const symmetric = await import(`${cryptoBase}/symmetric.js`);

    /* ---------------------------------------------- device A: enrol */

    const kemKp = pqc.generateKemKeyPair();
    const sigKp = pqc.generateSigKeyPair();
    const masterKey = symmetric.generateSymmetricKey();
    const toEnc = r => ({ ciphertext: pqc.toBase64(r.ciphertext), nonce: pqc.toBase64(r.nonce) });
    const keychain = {
        kemPublicKey: pqc.toBase64(kemKp.publicKey),
        sigPublicKey: pqc.toBase64(sigKp.publicKey),
        kemSecretKeyEnc: toEnc(symmetric.encrypt(kemKp.secretKey, masterKey)),
        sigSecretKeyEnc: toEnc(symmetric.encrypt(sigKp.secretKey, masterKey)),
        deviceId: 'device-a-uuid',
    };

    const bundle = enrollment.buildEnrollment(masterKey, keychain, PASSWORD);
    check('enrollment bundle builds and self-checks', true);

    const put = await api('/account/key', { method: 'PUT', body: JSON.stringify(bundle.accountKey) });
    check('PUT /account/key accepted', put.status === 200, `HTTP ${put.status} ${JSON.stringify(put.body)}`);

    const post = await api(`/vaults/${identity.id}/items`, {
        method: 'POST',
        body: JSON.stringify({ kind: 'note', name: KEYCHAIN_ITEM_NAME, cipher: bundle.sealedKeychain }),
    });
    check('POST sealed keychain accepted', post.status === 200 || post.status === 201, `HTTP ${post.status} ${JSON.stringify(post.body)}`);

    // An item sealed by device A, which device B must be able to open.
    const secret = 'the-password-only-device-A-knows';
    const item = envelope.createVaultItem(
        'login',
        { url: 'example.com', username: '', email: 'ada@example.com', password: secret },
        { label: 'example.com', domain: 'example.com', tags: [], favorite: false },
        'device-a-uuid',
    );
    const sealedItem = envelope.createEnvelope(item, kemKp.publicKey, sigKp.secretKey, 'device-a-uuid');

    /* ------------------------------- device B: only password + server */

    const fetchedKey = await api('/account/key');
    check('GET /account/key returns the blob', fetchedKey.status === 200, `HTTP ${fetchedKey.status}`);
    check(
        'the blob survived the round trip byte-for-byte',
        fetchedKey.body?.protected_user_key === bundle.accountKey.protected_user_key
        && fetchedKey.body?.salt_b64 === bundle.accountKey.salt_b64,
    );
    check(
        'KDF parameters survived',
        fetchedKey.body?.kdf?.type === bundle.accountKey.kdf.type
        && fetchedKey.body?.kdf?.iterations === bundle.accountKey.kdf.iterations
        && fetchedKey.body?.kdf?.memory_kib === bundle.accountKey.kdf.memory_kib,
        JSON.stringify(fetchedKey.body?.kdf),
    );

    const list = await api(`/vaults/${identity.id}/items`);
    const matches = (list.body?.items || []).filter(i => i.name === KEYCHAIN_ITEM_NAME);
    check('the keychain item is listed', matches.length > 0, `${matches.length} match(es)`);
    const newest = matches.reduce((a, b) => (b.id > a.id ? b : a));
    check('it is stored as an opaque user blob', newest.mode === 'user', `mode=${newest.mode}`);

    const fetchedItem = await api(`/vaults/${identity.id}/items/${newest.id}`);
    check('the sealed keychain reads back', fetchedItem.body?.cipher === bundle.sealedKeychain);

    // Everything below uses only PASSWORD and what the server just returned.
    const recoveredMaster = account.openAccountKeyBlob(fetchedKey.body, PASSWORD);
    check('master key unwraps from the fetched blob', !!recoveredMaster);
    check(
        'it is the same master key',
        recoveredMaster && Buffer.from(recoveredMaster).equals(Buffer.from(masterKey)),
    );

    const portable = account.openPortableKeychain(fetchedItem.body.cipher, recoveredMaster);
    const deviceB = account.fromPortableKeychain(portable, 'device-b-uuid');
    const kemSecretOnB = symmetric.decrypt(
        pqc.fromBase64(deviceB.kemSecretKeyEnc.ciphertext),
        pqc.fromBase64(deviceB.kemSecretKeyEnc.nonce),
        recoveredMaster,
    );
    const opened = envelope.openEnvelope(sealedItem, kemSecretOnB, pqc.fromBase64(deviceB.sigPublicKey));
    check(
        '*** device B opens an item sealed by device A ***',
        opened.data.password === secret && opened.data.email === 'ada@example.com',
        `${opened.metadata.label} / ${opened.data.email}`,
    );
    check('device B kept its own device id', deviceB.deviceId === 'device-b-uuid');

    const wrongPassword = account.openAccountKeyBlob(fetchedKey.body, 'not-the-master-password');
    check('a wrong password yields null, not a throw', wrongPassword === null);

    /* ------------------------------------------------------- cleanup */

    const del = await api(`/vaults/${identity.id}/items/${newest.id}`, { method: 'DELETE' });
    check('test item removed', del.status === 200 || del.status === 204, `HTTP ${del.status}`);
    console.log('\nNote: the enrolled account key is left in place — vault-warden has no delete');
    console.log('endpoint for it. Re-enrolling from the extension overwrites it.');

    rmSync(outDir, { recursive: true, force: true });

    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    if (failed.length) {
        for (const f of failed) console.log(`  FAILED: ${f.name}`);
        process.exit(1);
    }
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
