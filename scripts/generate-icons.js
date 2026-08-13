#!/usr/bin/env node
'use strict';
/**
 * generate-icons.js — produce the app + tray icons with no image deps.
 * Draws a titleblock-style mark (paper field, teal frame + strip, red corner)
 * and writes assets/icon.png (256), assets/tray.png (32), assets/icon.ico.
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ASSETS = path.join(__dirname, '..', 'assets');
fs.mkdirSync(ASSETS, { recursive: true });

const COL = {
  paper: [0xf7, 0xf6, 0xf2, 0xff],
  ink: [0x20, 0x24, 0x2a, 0xff],
  teal: [0x1f, 0x4e, 0x5f, 0xff],
  red: [0xb0, 0x3a, 0x2e, 0xff],
  clear: [0, 0, 0, 0],
};

function draw(size) {
  const buf = Buffer.alloc(size * size * 4);
  const set = (x, y, c) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]; buf[i + 3] = c[3];
  };
  const rect = (x0, y0, x1, y1, c) => {
    for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) set(x, y, c);
  };
  const frame = (x0, y0, x1, y1, t, c) => {
    rect(x0, y0, x1, y0 + t, c); rect(x0, y1 - t, x1, y1, c);
    rect(x0, y0, x0 + t, y1, c); rect(x1 - t, y0, x1, y1, c);
  };
  const s = size / 256; // scale factor
  const p = Math.round(18 * s);
  const t = Math.max(2, Math.round(10 * s));
  rect(0, 0, size, size, COL.paper);
  frame(p, p, size - p, size - p, t, COL.teal);
  // titleblock strip near the bottom
  rect(p, size - p - Math.round(60 * s), size - p, size - p, COL.teal);
  // a couple of ruled lines in the field
  rect(p + Math.round(20 * s), p + Math.round(70 * s), size - p - Math.round(20 * s), p + Math.round(70 * s) + Math.max(1, Math.round(4 * s)), COL.ink);
  rect(p + Math.round(20 * s), p + Math.round(110 * s), size - p - Math.round(60 * s), p + Math.round(110 * s) + Math.max(1, Math.round(4 * s)), COL.ink);
  // red "overdue" corner marker
  rect(size - p - Math.round(46 * s), p + Math.round(6 * s), size - p - Math.round(6 * s), p + Math.round(46 * s), COL.red);
  return buf;
}

// --- minimal PNG encoder (RGBA, 8-bit, color type 6) ---
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePng(rgba, size) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}
function encodeIco(png, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry[0] = size >= 256 ? 0 : size; // 0 => 256
  entry[1] = size >= 256 ? 0 : size;
  entry[2] = 0; entry[3] = 0;
  entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(png.length, 8); entry.writeUInt32LE(22, 12);
  return Buffer.concat([header, entry, png]);
}

const png256 = encodePng(draw(256), 256);
const png32 = encodePng(draw(32), 32);
fs.writeFileSync(path.join(ASSETS, 'icon.png'), png256);
fs.writeFileSync(path.join(ASSETS, 'tray.png'), png32);
fs.writeFileSync(path.join(ASSETS, 'icon.ico'), encodeIco(png256, 256));
console.log('Wrote assets/icon.png (256), assets/tray.png (32), assets/icon.ico');
