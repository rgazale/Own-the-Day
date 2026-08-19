'use strict';
/**
 * pngutil.js — tiny dependency-free PNG encoder + a taskbar badge image,
 * used at runtime to draw the overlay dot for the overdue/due-today count.
 */
const zlib = require('node:zlib');

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
  ihdr[8] = 8; ihdr[9] = 6;
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/** A solid red circle badge (32x32) to overlay on the taskbar icon. */
function badgePng() {
  const size = 32;
  const buf = Buffer.alloc(size * size * 4);
  const cx = 16; const cy = 16; const r = 15;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      const inside = (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
      if (inside) { buf[i] = 0xb0; buf[i + 1] = 0x3a; buf[i + 2] = 0x2e; buf[i + 3] = 0xff; }
    }
  }
  return encodePng(buf, size);
}

module.exports = { encodePng, badgePng };
