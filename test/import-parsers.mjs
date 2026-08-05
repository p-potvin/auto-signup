/**
 * Import parser tests. Run with:
 *
 *   npm run test:import
 *
 * Covers the parts of a real export that break naive parsers: quoted commas,
 * embedded newlines in notes, escaped quotes, a UTF-8 BOM, otpauth:// TOTP
 * URIs, Proton's split email/username fields, multi-URL login items, and trash.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = mkdtempSync(join(tmpdir(), 'vw-import-'));

function build() {
    const tsc = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
    execFileSync(process.execPath, [
        tsc,
        join(ROOT, 'src/utils/import.ts'),
        join(ROOT, 'src/utils/domain.ts'),
        '--outDir', outDir,
        '--module', 'ES2020', '--target', 'ES2020',
        '--moduleResolution', 'bundler', '--lib', 'ES2020,DOM',
        '--strict', '--skipLibCheck',
    ], { stdio: 'inherit' });

    // import.ts pulls in ../types, so tsc roots the output at src/ and the
    // emitted file lands under utils/.
    const file = join(outDir, 'utils', 'import.js');
    writeFileSync(
        file,
        readFileSync(file, 'utf8')
            .replace(/from '\.\/(\w+)'/g, "from './$1.js'")
            .replace(/from '\.\.\/([\w/]+)'/g, "from '../$1.js'"),
    );
    const typesIndex = join(outDir, 'types', 'index.js');
    writeFileSync(
        typesIndex,
        readFileSync(typesIndex, 'utf8').replace(/from '\.\/(\w+)'/g, "from './$1.js'"),
    );
}

const results = [];
function check(name, ok, detail = '') {
    results.push({ name, ok: !!ok });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

/* ------------------------------------------------------------- fixtures */

const PROTON_JSON = JSON.stringify({
    version: '1.31.5',
    vaults: {
        'vault-1': {
            name: 'Personal',
            items: [
                {
                    itemId: 'a',
                    state: 1,
                    data: {
                        metadata: { name: 'GitHub', note: 'work account' },
                        type: 'login',
                        content: {
                            itemEmail: 'ada@example.com',
                            itemUsername: 'ada-dev',
                            password: 'hunter2',
                            urls: ['https://github.com/login', 'https://gist.github.com'],
                            totpUri: 'otpauth://totp/GitHub:ada?secret=JBSWY3DPEHPK3PXP&issuer=GitHub',
                        },
                    },
                },
                {
                    itemId: 'b',
                    state: 2,
                    data: { metadata: { name: 'Deleted thing' }, type: 'login', content: {} },
                },
                {
                    itemId: 'c',
                    state: 1,
                    data: {
                        metadata: { name: 'Visa', note: '' },
                        type: 'creditCard',
                        content: {
                            cardholderName: 'Ada Lovelace',
                            number: '4111 1111 1111 1111',
                            verificationNumber: '123',
                            expirationDate: '09-2030',
                        },
                    },
                },
                {
                    itemId: 'd',
                    state: 1,
                    data: { metadata: { name: 'Recovery codes', note: 'abc\ndef' }, type: 'note', content: {} },
                },
                {
                    itemId: 'e',
                    state: 1,
                    data: { metadata: { name: 'An alias' }, type: 'alias', content: {} },
                },
            ],
        },
    },
});

// Deliberately nasty: BOM, quoted comma, embedded newline, escaped quote.
const BITWARDEN_CSV = '﻿'
    + 'folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n'
    + ',,login,"Bank, Inc.","line one\nline two",,0,https://www.bank.example.com/signin,ada@example.com,"pa""ss,word",JBSWY3DPEHPK3PXP\n'
    + ',,login,Forum,,,0,https://forum.example.org,ada_l,secret2,\n'
    + ',,note,Just a note,some text,,0,,,,\n';

const CHROME_CSV = 'name,url,username,password,note\n'
    + 'example.com,https://example.com/,ada@example.com,pw1,\n'
    + 'sub,https://mail.example.com/,ada,pw2,a note\n';

/* ----------------------------------------------------------------- main */

async function main() {
    build();
    const { parseProtonJson, parseCsvExport, parseImportFile, parseCsv, markDuplicates } =
        await import(pathToFileURL(join(outDir, 'utils', 'import.js')).href);

    /* --- Proton -------------------------------------------------------- */
    const proton = parseProtonJson(PROTON_JSON);
    const logins = proton.candidates.filter(c => c.itemType === 'login');
    const github = logins.find(c => c.metadata.label === 'GitHub');

    check('proton: parsed', proton.sourceLabel === 'Proton Pass');
    check('proton: login imported', !!github);
    check('proton: email kept separate from username',
        github.data.email === 'ada@example.com' && github.data.username === 'ada-dev',
        `email=${github.data.email} username=${github.data.username}`);
    check('proton: url stored without protocol', github.data.url === 'github.com/login', github.data.url);
    check('proton: otpauth:// reduced to the secret',
        github.data.totpSecret === 'JBSWY3DPEHPK3PXP', github.data.totpSecret);
    check('proton: second URL became its own entry',
        logins.some(c => c.data.url === 'gist.github.com'),
        logins.map(c => c.data.url).join(' | '));
    check('proton: trashed item skipped',
        !proton.candidates.some(c => c.metadata.label === 'Deleted thing')
        && proton.skipped.some(s => /trash/i.test(s.reason)));
    check('proton: card imported with split expiry', (() => {
        const card = proton.candidates.find(c => c.itemType === 'card');
        return card && card.data.cardNumber === '4111111111111111'
            && card.data.expiryMonth === '09' && card.data.expiryYear === '2030';
    })());
    check('proton: note imported', proton.candidates.some(c => c.metadata.tags.includes('note')));
    check('proton: unsupported type reported, not dropped silently',
        proton.skipped.some(s => /alias/i.test(s.reason)),
        proton.skipped.map(s => s.reason).join(' | '));

    /* --- CSV edge cases ------------------------------------------------ */
    const rows = parseCsv(BITWARDEN_CSV);
    check('csv: BOM stripped from first header', rows[0][0] === 'folder', JSON.stringify(rows[0][0]));
    check('csv: quoted comma kept in one field', rows[1][3] === 'Bank, Inc.', rows[1][3]);
    check('csv: embedded newline preserved', rows[1][4] === 'line one\nline two', JSON.stringify(rows[1][4]));
    check('csv: escaped quote unescaped', rows[1][9] === 'pa"ss,word', rows[1][9]);
    check('csv: row count correct (no split on inner newline)', rows.length === 4, `${rows.length} rows`);

    const bitwarden = parseCsvExport(BITWARDEN_CSV);
    check('bitwarden: detected', bitwarden.sourceLabel === 'Bitwarden', bitwarden.sourceLabel);
    check('bitwarden: two logins, note skipped',
        bitwarden.candidates.length === 2 && bitwarden.skipped.length === 1,
        `${bitwarden.candidates.length} candidates, ${bitwarden.skipped.length} skipped`);

    const bank = bitwarden.candidates[0];
    check('bitwarden: www stripped from stored url',
        bank.data.url === 'bank.example.com/signin', bank.data.url);
    check('bitwarden: email-shaped identifier routed to email',
        bank.data.email === 'ada@example.com' && bank.data.username === '');
    check('bitwarden: non-email identifier routed to username', (() => {
        const forum = bitwarden.candidates[1];
        return forum.data.username === 'ada_l' && forum.data.email === '';
    })());
    check('bitwarden: raw base32 totp kept', bank.data.totpSecret === 'JBSWY3DPEHPK3PXP');

    /* --- Chrome + subdomains ------------------------------------------- */
    const chrome = parseCsvExport(CHROME_CSV);
    check('chrome: detected', chrome.sourceLabel === 'Chrome / Edge', chrome.sourceLabel);
    check('chrome: subdomain preserved, not flattened',
        chrome.candidates[1].data.url === 'mail.example.com'
        && chrome.candidates[1].metadata.domain === 'mail.example.com',
        chrome.candidates[1].data.url);

    /* --- dispatch ------------------------------------------------------- */
    check('dispatch: .json routed to Proton', parseImportFile('x.json', PROTON_JSON).source === 'proton');
    check('dispatch: .csv routed to CSV', parseImportFile('x.csv', CHROME_CSV).source === 'chrome');
    check('dispatch: content sniffed when extension is wrong',
        parseImportFile('export.dat', PROTON_JSON).source === 'proton');

    /* --- dedupe ---------------------------------------------------------- */
    const existing = [{
        id: 'existing-1',
        itemType: 'login',
        data: { url: 'bank.example.com/signin', username: '', email: 'ada@example.com', password: 'old' },
        metadata: { label: 'Bank', domain: 'bank.example.com', tags: [], favorite: false },
    }];
    const marked = markDuplicates(bitwarden.candidates, existing);
    check('dedupe: existing record flagged', marked[0].duplicateOfId === 'existing-1', marked[0].duplicateOfId);
    check('dedupe: new record not flagged', marked[1].duplicateOfId === undefined);

    /* --- failure modes ---------------------------------------------------- */
    let threw = '';
    try { parseCsvExport('just,some,columns\n1,2,3\n'); } catch (e) { threw = e.message; }
    check('unrecognised CSV fails loudly', /no password column/i.test(threw), threw);

    threw = '';
    try { parseProtonJson('{"nope":true}'); } catch (e) { threw = e.message; }
    check('non-Proton JSON fails loudly', /vaults/i.test(threw), threw);

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
