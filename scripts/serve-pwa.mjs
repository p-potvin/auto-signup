#!/usr/bin/env node
/**
 * Static server for `dist-pwa/`, for looking at the mobile vault on a desktop.
 *
 *   node scripts/serve-pwa.mjs [port]
 *
 * Dependency-free and loopback-only. http://localhost counts as a secure
 * context, so service workers and the clipboard API both work here the same way
 * they will on the phone. The API still comes from warden.vaultwares.ca over the
 * tailnet — this serves the shell, not the vault.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'dist-pwa');
const PORT = Number(process.argv[2] ?? 5199);

const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
    '.webmanifest': 'application/manifest+json',
    '.map': 'application/json',
};

createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // normalize() collapses any ../ before it can escape dist-pwa.
    let rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';

    try {
        const body = await readFile(join(ROOT, rel));
        res.writeHead(200, {
            'Content-Type': TYPES[extname(rel)] ?? 'application/octet-stream',
            // No caching in dev, or a rebuilt bundle hides behind the old one.
            'Cache-Control': 'no-store',
        });
        res.end(body);
    } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
    }
}).listen(PORT, '127.0.0.1', () => {
    console.log(`serving dist-pwa on http://localhost:${PORT}`);
});
