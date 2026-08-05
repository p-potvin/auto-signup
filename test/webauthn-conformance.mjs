/**
 * Conformance test for the software authenticator. Run with:
 *
 *   npm run test:webauthn
 *
 * Acts as a relying party: runs a registration ceremony, parses the
 * attestationObject the way a server library does, pulls the COSE public key
 * out of the attested credential data, then runs assertion ceremonies and
 * verifies the signatures with WebCrypto.
 *
 * The CBOR decoder here is written independently of the encoder on purpose —
 * running the encoder backwards would agree with itself no matter how wrong it
 * was. A bad DER signature, a mislaid authData field, or a broken COSE map all
 * surface as a verification failure.
 *
 * No test framework and no dependencies: it compiles the two modules under test
 * with the repo's own TypeScript and runs them on Node's WebCrypto.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SIGNATURE_ROUNDS = 300;

/* ------------------------------------------------------------------ build */

const outDir = mkdtempSync(join(tmpdir(), 'vw-webauthn-'));

function buildModulesUnderTest() {
    const tsc = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
    execFileSync(process.execPath, [
        tsc,
        join(ROOT, 'src/webauthn/encoding.ts'),
        join(ROOT, 'src/webauthn/authenticator.ts'),
        join(ROOT, 'src/webauthn/types.ts'),
        '--outDir', outDir,
        '--module', 'ES2020',
        '--target', 'ES2020',
        '--moduleResolution', 'bundler',
        '--lib', 'ES2020,DOM',
        '--strict',
        '--skipLibCheck',
    ], { stdio: 'inherit' });

    // tsc emits the repo's extensionless imports; Node's ESM loader needs them.
    const authPath = join(outDir, 'authenticator.js');
    writeFileSync(
        authPath,
        readFileSync(authPath, 'utf8').replace(/from '\.\/(\w+)'/g, "from './$1.js'"),
    );
}

/* -------------------------------------------------------------- utilities */

function b64uToBytes(value) {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
    return new Uint8Array(Buffer.from(base64 + '='.repeat((4 - (base64.length % 4)) % 4), 'base64'));
}

/** Independent CBOR decoder — deliberately not the encoder run backwards. */
function cborDecode(bytes, cursor = { at: 0 }) {
    const first = bytes[cursor.at++];
    const major = first >> 5;
    const minor = first & 0x1f;

    let arg = minor;
    if (minor === 24) {
        arg = bytes[cursor.at++];
    } else if (minor === 25) {
        arg = (bytes[cursor.at] << 8) | bytes[cursor.at + 1];
        cursor.at += 2;
    } else if (minor === 26) {
        arg = ((bytes[cursor.at] << 24) >>> 0) + (bytes[cursor.at + 1] << 16)
            + (bytes[cursor.at + 2] << 8) + bytes[cursor.at + 3];
        cursor.at += 4;
    } else if (minor >= 27) {
        throw new Error('unsupported CBOR length');
    }

    switch (major) {
        case 0: return arg;
        case 1: return -arg - 1;
        case 2: { const v = bytes.slice(cursor.at, cursor.at + arg); cursor.at += arg; return v; }
        case 3: {
            const v = Buffer.from(bytes.slice(cursor.at, cursor.at + arg)).toString('utf8');
            cursor.at += arg;
            return v;
        }
        case 4: {
            const items = [];
            for (let i = 0; i < arg; i++) items.push(cborDecode(bytes, cursor));
            return items;
        }
        case 5: {
            const map = new Map();
            for (let i = 0; i < arg; i++) {
                const key = cborDecode(bytes, cursor);
                map.set(key, cborDecode(bytes, cursor));
            }
            return map;
        }
        default: throw new Error(`unsupported CBOR major type ${major}`);
    }
}

function parseAuthData(authData) {
    const view = new DataView(authData.buffer, authData.byteOffset, authData.byteLength);
    const parsed = {
        rpIdHash: authData.slice(0, 32),
        flags: authData[32],
        signCount: view.getUint32(33, false),
        aaguid: null,
        credentialId: null,
        coseKey: null,
    };
    if (parsed.flags & 0x40) {
        parsed.aaguid = authData.slice(37, 53);
        const idLength = view.getUint16(53, false);
        parsed.credentialId = authData.slice(55, 55 + idLength);
        parsed.coseKey = cborDecode(authData.slice(55 + idLength));
    }
    return parsed;
}

function coseToJwk(cose) {
    if (cose.get(1) !== 2) throw new Error(`kty is not EC2 (got ${cose.get(1)})`);
    if (cose.get(3) !== -7) throw new Error(`alg is not ES256 (got ${cose.get(3)})`);
    if (cose.get(-1) !== 1) throw new Error(`crv is not P-256 (got ${cose.get(-1)})`);
    const b64u = b => Buffer.from(b).toString('base64url');
    return { kty: 'EC', crv: 'P-256', x: b64u(cose.get(-2)), y: b64u(cose.get(-3)), ext: true };
}

/** DER SEQUENCE -> the raw r||s pair WebCrypto verifies against. */
function derToRaw(der) {
    let at = 2;
    if (der[at++] !== 0x02) throw new Error('expected INTEGER for r');
    const rLength = der[at++];
    const r = der.slice(at, at + rLength);
    at += rLength;
    if (der[at++] !== 0x02) throw new Error('expected INTEGER for s');
    const sLength = der[at++];
    const s = der.slice(at, at + sLength);
    if (at + sLength !== der.length) throw new Error('trailing bytes after DER SEQUENCE');

    const pad = value => {
        const trimmed = value[0] === 0 ? value.slice(1) : value;
        const out = new Uint8Array(32);
        out.set(trimmed, 32 - trimmed.length);
        return out;
    };
    return Buffer.concat([Buffer.from(pad(r)), Buffer.from(pad(s))]);
}

const results = [];
function check(name, ok, detail = '') {
    results.push({ name, ok: !!ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

/* ------------------------------------------------------------------- main */

const ORIGIN = 'https://example.com';
const RP_ID = 'example.com';

async function main() {
    buildModulesUnderTest();
    const { makeCredential, getAssertion, isRpIdAllowed } =
        await import(pathToFileURL(join(outDir, 'authenticator.js')).href);

    const createChallenge = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');

    const created = await makeCredential({
        challenge: createChallenge,
        rp: { id: RP_ID, name: 'Example Corp' },
        user: {
            id: Buffer.from('user-1234').toString('base64url'),
            name: 'ada@example.com',
            displayName: 'Ada Lovelace',
        },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    }, ORIGIN, true);

    /* --- registration, parsed as a server library would ------------------ */
    const attestation = cborDecode(b64uToBytes(created.attestationObject));
    check('attestationObject is a CBOR map', attestation instanceof Map);
    check('fmt is "none"', attestation.get('fmt') === 'none');
    check('attStmt is an empty map',
        attestation.get('attStmt') instanceof Map && attestation.get('attStmt').size === 0);

    const authData = attestation.get('authData');
    check('authData present as a byte string', authData instanceof Uint8Array, `${authData?.length} bytes`);

    const parsed = parseAuthData(authData);
    const expectedRpHash = new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(RP_ID)),
    );
    check('rpIdHash equals SHA-256(rpId)',
        Buffer.compare(Buffer.from(parsed.rpIdHash), Buffer.from(expectedRpHash)) === 0);
    check('UP flag set', (parsed.flags & 0x01) !== 0);
    check('UV flag set when the user was verified', (parsed.flags & 0x04) !== 0);
    check('AT flag set on registration', (parsed.flags & 0x40) !== 0);
    check('BE and BS flags set (vault-backed credential)',
        (parsed.flags & 0x08) !== 0 && (parsed.flags & 0x10) !== 0);
    check('signCount is 0 (no counter, by design)', parsed.signCount === 0);
    check('AAGUID zeroed, as fmt=none requires', parsed.aaguid.every(b => b === 0));
    check('credentialId in authData matches the returned id',
        Buffer.compare(Buffer.from(parsed.credentialId), Buffer.from(b64uToBytes(created.credentialId))) === 0);

    const clientData = JSON.parse(Buffer.from(b64uToBytes(created.clientDataJSON)).toString('utf8'));
    check('clientData.type is webauthn.create', clientData.type === 'webauthn.create');
    check('clientData.challenge round-trips', clientData.challenge === createChallenge);
    check('clientData.origin is the calling origin', clientData.origin === ORIGIN);

    const jwk = coseToJwk(parsed.coseKey);
    const rpKey = await crypto.subtle.importKey(
        'jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'],
    );
    check('COSE key imports as a P-256 verify key', !!rpKey);

    const spkiKey = await crypto.subtle.importKey(
        'spki', b64uToBytes(created.publicKeySpki), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify'],
    );
    const spkiJwk = await crypto.subtle.exportKey('jwk', spkiKey);
    check('COSE key and stored SPKI describe the same point',
        spkiJwk.x === jwk.x && spkiJwk.y === jwk.y);

    /* --- assertion -------------------------------------------------------- */
    const storedCredential = {
        credentialId: created.credentialId,
        rpId: created.rpId,
        userHandle: created.userHandle,
        userName: created.userName,
        privateKeyPkcs8: created.privateKeyPkcs8,
        publicKeySpki: created.publicKeySpki,
    };

    const getChallenge = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
    const assertion = await getAssertion(
        { challenge: getChallenge, rpId: RP_ID, allowCredentials: [{ id: created.credentialId, type: 'public-key' }] },
        ORIGIN, storedCredential, true,
    );

    const assertionAuthData = b64uToBytes(assertion.authenticatorData);
    check('assertion authData is 37 bytes (no attested data)', assertionAuthData.length === 37);
    check('assertion AT flag is clear', (parseAuthData(assertionAuthData).flags & 0x40) === 0);

    const assertionClientData = JSON.parse(Buffer.from(b64uToBytes(assertion.clientDataJSON)).toString('utf8'));
    check('assertion clientData.type is webauthn.get', assertionClientData.type === 'webauthn.get');
    check('assertion challenge round-trips', assertionClientData.challenge === getChallenge);

    const clientDataHash = new Uint8Array(
        await crypto.subtle.digest('SHA-256', b64uToBytes(assertion.clientDataJSON)),
    );
    const signedPayload = Buffer.concat([Buffer.from(assertionAuthData), Buffer.from(clientDataHash)]);
    const signature = b64uToBytes(assertion.signature);

    check('signature is an ASN.1 DER SEQUENCE',
        signature[0] === 0x30 && signature[1] === signature.length - 2);
    check('*** relying party verifies the assertion signature ***',
        await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, rpKey, derToRaw(signature), signedPayload));

    const tamperedHash = new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode('{"challenge":"wrong"}')),
    );
    check('a tampered challenge fails verification',
        await crypto.subtle.verify(
            { name: 'ECDSA', hash: 'SHA-256' }, rpKey, derToRaw(signature),
            Buffer.concat([Buffer.from(assertionAuthData), Buffer.from(tamperedHash)]),
        ) === false);

    /* --- DER edge cases --------------------------------------------------- */
    // r and s vary in length run to run; only a batch reliably exercises the
    // leading-zero-trim and high-bit-pad branches.
    const lengths = new Map();
    let verified = 0;
    for (let i = 0; i < SIGNATURE_ROUNDS; i++) {
        const round = await getAssertion(
            { challenge: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'), rpId: RP_ID },
            ORIGIN, storedCredential, true,
        );
        const der = b64uToBytes(round.signature);
        lengths.set(der.length, (lengths.get(der.length) ?? 0) + 1);

        const roundAuthData = b64uToBytes(round.authenticatorData);
        const roundHash = new Uint8Array(
            await crypto.subtle.digest('SHA-256', b64uToBytes(round.clientDataJSON)),
        );
        const ok = await crypto.subtle.verify(
            { name: 'ECDSA', hash: 'SHA-256' }, rpKey, derToRaw(der),
            Buffer.concat([Buffer.from(roundAuthData), Buffer.from(roundHash)]),
        );
        if (ok) verified++;
    }
    check(`all ${SIGNATURE_ROUNDS} signatures verify`, verified === SIGNATURE_ROUNDS, `${verified}/${SIGNATURE_ROUNDS}`);
    check('DER encoder exercised across multiple lengths', lengths.size >= 2,
        [...lengths.entries()].sort((a, b) => a[0] - b[0]).map(([l, n]) => `${l}B x${n}`).join(', '));

    /* --- rpId policy ------------------------------------------------------ */
    check('rpId policy: same host allowed', isRpIdAllowed('example.com', 'https://example.com'));
    check('rpId policy: subdomain may claim its parent', isRpIdAllowed('example.com', 'https://app.example.com'));
    check('rpId policy: cross-site rejected', !isRpIdAllowed('google.com', 'https://evil.com'));
    check('rpId policy: suffix trick rejected', !isRpIdAllowed('example.com', 'https://notexample.com'));
    check('rpId policy: parent may not claim a child', !isRpIdAllowed('app.example.com', 'https://example.com'));
    check('rpId policy: plain http rejected', !isRpIdAllowed('example.com', 'http://example.com'));
    check('rpId policy: http://localhost allowed for development', isRpIdAllowed('localhost', 'http://localhost:3000'));

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
