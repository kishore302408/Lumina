/**
 * Generates electron/icon.ico — a 256×256 brand icon, zero dependencies.
 *
 * Draws a rounded square with the Lumino gradient plus a geometric "L",
 * encodes it as a PNG (node:zlib), then wraps that PNG in an ICO container
 * (Windows supports PNG-compressed ICO entries since Vista).
 *
 * Run:  node scripts/make-icon.mjs
 */
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SIZE = 256;
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "electron", "icon.ico");

/* ------------------------------------------------------------ drawing */

const px = new Uint8Array(SIZE * SIZE * 4); // RGBA

function blend(i, r, g, b, a) {
  const na = a + px[i + 3] / 255 * (1 - a);
  if (na <= 0) return;
  px[i] = Math.round((r * a + px[i] * (px[i + 3] / 255) * (1 - a)) / na);
  px[i + 1] = Math.round((g * a + px[i + 1] * (px[i + 3] / 255) * (1 - a)) / na);
  px[i + 2] = Math.round((b * a + px[i + 2] * (px[i + 3] / 255) * (1 - a)) / na);
  px[i + 3] = Math.round(na * 255);
}

/** Signed distance to a rounded rectangle (negative inside). */
function roundedSDF(x, y, cx, cy, w, h, r) {
  const qx = Math.abs(x - cx) - (w / 2 - r);
  const qy = Math.abs(y - cy) - (h / 2 - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

function fillRounded(cx, cy, w, h, r, colorAt) {
  const pad = r + 2;
  const x0 = Math.max(0, Math.floor(cx - w / 2 - pad));
  const x1 = Math.min(SIZE - 1, Math.ceil(cx + w / 2 + pad));
  const y0 = Math.max(0, Math.floor(cy - h / 2 - pad));
  const y1 = Math.min(SIZE - 1, Math.ceil(cy + h / 2 + pad));

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = roundedSDF(x + 0.5, y + 0.5, cx, cy, w, h, r);
      if (d > 0.5) continue;
      const alpha = d <= -0.5 ? 1 : 0.5 - d;
      const [r8, g8, b8, a8] = colorAt(x, y);
      blend((y * SIZE + x) * 4, r8, g8, b8, alpha * a8);
    }
  }
}

const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => [
  Math.round(lerp(c1[0], c2[0], t)),
  Math.round(lerp(c1[1], c2[1], t)),
  Math.round(lerp(c1[2], c2[2], t)),
];

const PURPLE = [109, 94, 252];
const CYAN = [18, 214, 223];

// 1 — brand gradient rounded square
fillRounded(128, 128, 256, 256, 58, (x, y) => {
  const t = Math.min(1, Math.max(0, (x + y) / (SIZE * 2)));
  const [r, g, b] = mix(PURPLE, CYAN, t);
  // soft top-left highlight
  const hl = Math.max(0, 1 - Math.hypot(x - 40, y - 10) / 300) * 0.22;
  return [Math.min(255, Math.round(r + 255 * hl)), Math.min(255, Math.round(g + 255 * hl)), Math.min(255, Math.round(b + 255 * hl)), 1];
});

// 2 — the "L": a vertical stem and a foot, drawn as rounded bars
const WHITE = [255, 255, 255];
const stem = { cx: 73 + 19, cy: 56 + 72, w: 38, h: 144, r: 12 };
const foot = { cx: 73 + 55, cy: 162 + 19, w: 110, h: 38, r: 12 };

for (const bar of [stem, foot]) {
  fillRounded(bar.cx, bar.cy, bar.w, bar.h, bar.r, (x, y) => {
    // gentle vertical shading so the letter reads with depth
    const shade = 1 - Math.max(0, (y - bar.cy + bar.h / 2) / bar.h) * 0.12;
    return [Math.round(WHITE[0] * shade), Math.round(WHITE[1] * shade), Math.round(WHITE[2] * shade), 1];
  });
}

/* --------------------------------------------------------- PNG encode */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng() {
  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
  for (let y = 0; y < SIZE; y++) {
    const rowStart = y * (SIZE * 4 + 1);
    raw[rowStart] = 0; // filter: none
    Buffer.from(px.buffer, px.byteOffset + y * SIZE * 4, SIZE * 4).copy(raw, rowStart + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------ ICO wrap */

function wrapIco(png) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // one image

  const entry = Buffer.alloc(16);
  entry[0] = 0; // width 256 → stored as 0
  entry[1] = 0; // height 256 → stored as 0
  entry[2] = 0; // palette colors
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4); // color planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(png.length, 8); // image size
  entry.writeUInt32LE(header.length + entry.length, 12); // offset

  return Buffer.concat([header, entry, png]);
}

mkdirSync(dirname(OUT), { recursive: true });
const png = encodePng();
writeFileSync(OUT, wrapIco(png));
console.log(`[icon] wrote ${OUT} (png ${png.length} bytes)`);
