#!/usr/bin/env node
/**
 * Generates the PWA / Home Screen icons. Run with:
 *
 *   node public/icons/create-pwa-icons.mjs
 *
 * Deliberately dependency-free, unlike `create-icons.js` next to it: that one
 * needs `node-canvas`, which is a native build, and adding a compiler
 * dependency to produce three PNGs that change roughly never is a bad trade. A
 * PNG is a zlib stream in four chunks, and Node already has zlib.
 *
 * Matches the extension icon — gold-to-cyan gradient, rounded square, chevron —
 * so the Home Screen icon and the toolbar icon read as the same product.
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = dirname(fileURLToPath(import.meta.url));
// 180 is what iOS wants for apple-touch-icon; 192 and 512 are the manifest's.
const SIZES = [180, 192, 512];

const FROM = [0xcc, 0x9b, 0x21];
const TO = [0x21, 0xb8, 0xcc];
const INK = [0x1a, 0x1f, 0x23];

/* ------------------------------------------------------------------ shapes */

/** Signed distance to a rounded rectangle, negative inside. */
function roundedRectDistance(x, y, size, radius) {
    const half = size / 2;
    const dx = Math.abs(x - half) - (half - radius);
    const dy = Math.abs(y - half) - (half - radius);
    const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
    return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

/** Distance from a point to a line segment. */
function segmentDistance(px, py, ax, ay, bx, by) {
    const vx = bx - ax;
    const vy = by - ay;
    const wx = px - ax;
    const wy = py - ay;
    const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / (vx * vx + vy * vy)));
    return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

function chevronDistance(x, y, size) {
    // Two strokes meeting at the bottom centre.
    const left = [size * 0.30, size * 0.30];
    const apex = [size * 0.50, size * 0.72];
    const right = [size * 0.70, size * 0.30];
    return Math.min(
        segmentDistance(x, y, left[0], left[1], apex[0], apex[1]),
        segmentDistance(x, y, apex[0], apex[1], right[0], right[1]),
    ) - size * 0.075;
}

/** 0 outside, 1 inside, ramped across one pixel so edges are not jagged. */
function coverage(distance) {
    return Math.max(0, Math.min(1, 0.5 - distance));
}

function mix(a, b, t) {
    return [
        Math.round(a[0] + (b[0] - a[0]) * t),
        Math.round(a[1] + (b[1] - a[1]) * t),
        Math.round(a[2] + (b[2] - a[2]) * t),
    ];
}

/* --------------------------------------------------------------------- png */

const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c;
    }
    return table;
})();

function crc32(buf) {
    let c = 0xffffffff;
    for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
}

function encodePng(size, rgba) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8;   // bit depth
    ihdr[9] = 6;   // colour type: RGBA
    // 10..12 stay zero: deflate, adaptive filtering, no interlace.

    // One filter byte per scanline; filter 0 (None) keeps this readable and the
    // images are small enough that the extra compression is not worth the code.
    const raw = Buffer.alloc(size * (size * 4 + 1));
    for (let y = 0; y < size; y++) {
        const rowStart = y * (size * 4 + 1);
        raw[rowStart] = 0;
        rgba.copy(raw, rowStart + 1, y * size * 4, (y + 1) * size * 4);
    }

    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

/* -------------------------------------------------------------------- draw */

function render(size) {
    const rgba = Buffer.alloc(size * size * 4);
    const radius = size * 0.2;

    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const px = x + 0.5;
            const py = y + 0.5;

            const background = coverage(roundedRectDistance(px, py, size, radius));
            if (background <= 0) continue;

            const gradient = mix(FROM, TO, (px + py) / (2 * size));
            const ink = coverage(chevronDistance(px, py, size));
            const [r, g, b] = mix(gradient, INK, ink);

            const offset = (y * size + x) * 4;
            rgba[offset] = r;
            rgba[offset + 1] = g;
            rgba[offset + 2] = b;
            rgba[offset + 3] = Math.round(background * 255);
        }
    }
    return rgba;
}

for (const size of SIZES) {
    const path = join(OUT_DIR, `icon-${size}.png`);
    writeFileSync(path, encodePng(size, render(size)));
    console.log(`wrote ${path}`);
}
