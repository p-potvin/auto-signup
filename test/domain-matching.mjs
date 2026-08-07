/**
 * URL normalisation and subdomain matching tests. Run with:
 *
 *   npm run test:domain
 *
 * Guards the two rules the vault depends on: stored URLs carry no protocol,
 * and an exact host outranks a parent domain outranks a sibling subdomain.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const ROOT = process.cwd();
const out = mkdtempSync(join(tmpdir(), 'vw-dom-'));
execFileSync(process.execPath, [join(ROOT,'node_modules/typescript/bin/tsc'), join(ROOT,'src/utils/domain.ts'),
  '--outDir', out, '--module','ES2020','--target','ES2020','--lib','ES2020,DOM','--strict','--skipLibCheck'], {stdio:'inherit'});
const d = await import(pathToFileURL(join(out,'domain.js')).href);
const r=[]; const ck=(n,ok,det='')=>{r.push(ok);console.log(`${ok?'PASS':'FAIL'}  ${n}${det?`  — ${det}`:''}`)};

ck('protocol dropped from stored url', d.normalizeStoredUrl('https://www.Example.com/login/') === 'example.com/login', d.normalizeStoredUrl('https://www.Example.com/login/'));
ck('protocol-less input accepted', d.normalizeStoredUrl('app.example.com/x') === 'app.example.com/x');
ck('bare host keeps no trailing slash', d.normalizeStoredUrl('https://example.com/') === 'example.com', d.normalizeStoredUrl('https://example.com/'));
ck('query string preserved', d.normalizeStoredUrl('https://x.com/a?b=1') === 'x.com/a?b=1');
ck('subdomain preserved by getHost', d.getHost('https://mail.example.com') === 'mail.example.com');
ck('registrable domain for .co.uk', d.getRegistrableDomain('https://mail.example.co.uk') === 'example.co.uk', d.getRegistrableDomain('https://mail.example.co.uk'));
ck('registrable domain for qc.ca', d.getRegistrableDomain('https://a.vaultwares.qc.ca') === 'vaultwares.qc.ca', d.getRegistrableDomain('https://a.vaultwares.qc.ca'));

ck('exact host beats parent', d.matchStrength('mail.example.com','https://mail.example.com/x') === d.MATCH_EXACT);
ck('parent domain matches subdomain page', d.matchStrength('example.com','https://mail.example.com') === d.MATCH_PARENT);
ck('sibling subdomain is only RELATED', d.matchStrength('mail.example.com','https://dev.example.com') === d.MATCH_RELATED);
ck('exact ranks above related', d.MATCH_EXACT > d.MATCH_RELATED);
ck('different site does not match', d.matchStrength('example.com','https://evil.com') === d.MATCH_NONE);
ck('suffix trick rejected', d.matchStrength('example.com','https://notexample.com') === d.MATCH_NONE, String(d.matchStrength('example.com','https://notexample.com')));
ck('www ignored on both sides', d.matchStrength('www.example.com','https://example.com') === d.MATCH_EXACT);
ck('vaultwarden.pw exact', d.matchStrength('vaultwarden.pw','https://vaultwarden.pw/login') === d.MATCH_EXACT);
ck('vaultwarden.pw subdomain', d.matchStrength('vaultwarden.pw','https://app.vaultwarden.pw') === d.MATCH_PARENT);

const f=r.filter(x=>!x).length;
console.log(`\n${r.length-f}/${r.length} checks passed`);
rmSync(out,{recursive:true,force:true});
if(f) process.exit(1);
