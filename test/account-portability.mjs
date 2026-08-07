/**
 * Multi-device portability tests. Run with:
 *
 *   npm run test:portability
 *
 * The question this answers is the one blocking a phone: can a device that has
 * never seen this vault open an item, given only the master password and what
 * vault-warden stores?
 *
 * "Device B" below is built from nothing but the password and the two blobs the
 * server holds. If it can read an envelope sealed by device A, a PWA can too.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Inside the repo, not the system temp dir: these modules import @noble/*, and
// Node resolves bare specifiers by walking up for node_modules, which only
// finds the repo's packages if the emitted code sits under it.
const outDir = join(ROOT, '.vw-test-build');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

function build() {
    const tsc = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
    execFileSync(process.execPath, [
        tsc,
        join(ROOT, 'src/crypto/account-key.ts'),
        join(ROOT, 'src/crypto/envelope.ts'),
        join(ROOT, 'src/crypto/pqc.ts'),
        join(ROOT, 'src/crypto/symmetric.ts'),
        '--outDir', outDir,
        '--module', 'ES2020', '--target', 'ES2020',
        '--moduleResolution', 'bundler', '--lib', 'ES2020,DOM',
        '--strict', '--skipLibCheck', '--esModuleInterop',
    ], { stdio: 'inherit' });

    // tsc roots at src/ because these files import ../types.
    for (const rel of ['crypto/account-key.js', 'crypto/envelope.js', 'crypto/pqc.js', 'crypto/symmetric.js', 'types/index.js']) {
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

const PASSWORD = 'correct-horse-battery-staple';
const NEW_PASSWORD = 'a-different-long-master-password';

async function main() {
    build();
    const base = pathToFileURL(join(outDir, 'crypto')).href;
    const account = await import(`${base}/account-key.js`);
    const envelope = await import(`${base}/envelope.js`);
    const pqc = await import(`${base}/pqc.js`);
    const symmetric = await import(`${base}/symmetric.js`);

    /* ---- device A: a normal install ---------------------------------- */
    const kemKp = pqc.generateKemKeyPair();
    const sigKp = pqc.generateSigKeyPair();
    const masterKey = symmetric.generateSymmetricKey();

    const toEnc = (r) => ({ ciphertext: pqc.toBase64(r.ciphertext), nonce: pqc.toBase64(r.nonce) });
    const deviceAState = {
        kemPublicKey: pqc.toBase64(kemKp.publicKey),
        sigPublicKey: pqc.toBase64(sigKp.publicKey),
        kemSecretKeyEnc: toEnc(symmetric.encrypt(kemKp.secretKey, masterKey)),
        sigSecretKeyEnc: toEnc(symmetric.encrypt(sigKp.secretKey, masterKey)),
        deviceId: 'device-a-uuid',
    };

    const item = envelope.createVaultItem(
        'login',
        { url: 'vaultwarden.pw', username: '', email: 'ada@example.com', password: 'hunter2' },
        { label: 'vaultwarden.pw', domain: 'vaultwarden.pw', tags: [], favorite: false },
        'device-a-uuid',
    );
    const sealedItem = envelope.createEnvelope(item, kemKp.publicKey, sigKp.secretKey, 'device-a-uuid');

    /* ---- what the server ends up holding ------------------------------ */
    const accountBlob = account.buildAccountKeyBlob(masterKey, PASSWORD);
    const sealedKeychain = account.sealPortableKeychain(
        account.toPortableKeychain(deviceAState),
        masterKey,
    );

    check('account blob carries KDF params vault-warden accepts',
        accountBlob.kdf.type === 'argon2id'
        && Number.isInteger(accountBlob.kdf.iterations)
        && Number.isInteger(accountBlob.kdf.memory_kib)
        && Number.isInteger(accountBlob.kdf.parallelism),
        JSON.stringify(accountBlob.kdf));
    check('server never receives the master key',
        !accountBlob.protected_user_key.includes(pqc.toBase64(masterKey)));
    check('sealed keychain does not leak the KEM public key in clear',
        !sealedKeychain.includes(deviceAState.kemPublicKey));
    check('portable keychain omits deviceId',
        account.toPortableKeychain(deviceAState).deviceId === undefined);

    /* ---- device B: knows only the password and the two blobs ---------- */
    const recoveredMasterKey = account.openAccountKeyBlob(accountBlob, PASSWORD);
    check('device B derives the master key from the password',
        !!recoveredMasterKey && Buffer.compare(Buffer.from(recoveredMasterKey), Buffer.from(masterKey)) === 0);

    const portable = account.openPortableKeychain(sealedKeychain, recoveredMasterKey);
    const deviceBState = account.fromPortableKeychain(portable, 'device-b-uuid');
    check('device B keeps its own deviceId', deviceBState.deviceId === 'device-b-uuid');
    check('device B recovers the same public keys',
        deviceBState.kemPublicKey === deviceAState.kemPublicKey
        && deviceBState.sigPublicKey === deviceAState.sigPublicKey);

    const kemSecretOnB = symmetric.decrypt(
        pqc.fromBase64(deviceBState.kemSecretKeyEnc.ciphertext),
        pqc.fromBase64(deviceBState.kemSecretKeyEnc.nonce),
        recoveredMasterKey,
    );
    const opened = envelope.openEnvelope(sealedItem, kemSecretOnB, pqc.fromBase64(deviceBState.sigPublicKey));

    check('*** device B opens an item sealed by device A ***',
        opened.data.password === 'hunter2' && opened.data.email === 'ada@example.com',
        `${opened.metadata.label} / ${opened.data.email}`);
    check('ML-KEM envelope format unchanged (still PQC)',
        !!sealedItem.envelope.encapsulatedKey && sealedItem.envelope.version >= 2,
        `v${sealedItem.envelope.version}`);

    /* ---- wrong password ------------------------------------------------ */
    check('wrong password yields null, not a crash',
        account.openAccountKeyBlob(accountBlob, 'not-the-password') === null);

    /* ---- password change ------------------------------------------------ */
    const rewrapped = account.rewrapForNewPassword(recoveredMasterKey, NEW_PASSWORD);
    const afterChange = account.openAccountKeyBlob(rewrapped, NEW_PASSWORD);

    check('password change keeps the same master key',
        !!afterChange && Buffer.compare(Buffer.from(afterChange), Buffer.from(masterKey)) === 0);
    check('old password stops working after the change',
        account.openAccountKeyBlob(rewrapped, PASSWORD) === null);
    check('salt is fresh on re-wrap', rewrapped.salt_b64 !== accountBlob.salt_b64);

    const kemSecretAfter = symmetric.decrypt(
        pqc.fromBase64(portable.kemSecretKeyEnc.ciphertext),
        pqc.fromBase64(portable.kemSecretKeyEnc.nonce),
        afterChange,
    );
    const openedAfter = envelope.openEnvelope(sealedItem, kemSecretAfter, pqc.fromBase64(portable.sigPublicKey));
    check('items still open after a password change (no re-encryption needed)',
        openedAfter.data.password === 'hunter2');

    /* ---- KDF contract --------------------------------------------------- */
    const roundTripped = JSON.parse(JSON.stringify(accountBlob));
    check('blob survives JSON transport intact',
        !!account.openAccountKeyBlob(roundTripped, PASSWORD));

    const pbkdf2Blob = account.buildAccountKeyBlob(masterKey, PASSWORD, {
        type: 'pbkdf2-sha256', iterations: 600000,
    });
    check('pbkdf2-sha256 path also round-trips (vault-warden allows it)',
        !!account.openAccountKeyBlob(pbkdf2Blob, PASSWORD));

    check('a 4-digit PIN is below the master-password floor',
        account.MIN_MASTER_PASSWORD_LENGTH > 4, `min=${account.MIN_MASTER_PASSWORD_LENGTH}`);

    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length) {
        console.log(`FAILED: ${failed.map(f => f.name).join(', ')}`);
        process.exitCode = 1;
    }
}

try {
    await main();
} finally {
    rmSync(outDir, { recursive: true, force: true });
}
