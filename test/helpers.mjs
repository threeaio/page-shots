// Test helpers: a tiny static server for the fixture pages, a minimal PNG encoder/decoder (8-bit RGB/RGBA,
// no interlace – enough for solid test images and Chromium screenshots) and a wrapper around shoot.mjs.

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const FIXTURES = path.join(ROOT, "test", "fixtures");
export const SHOOT = path.join(ROOT, "scripts", "shoot.mjs");

// ---------- PNG ----------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

/** A solid-color RGB PNG. */
export function solidPng(width, height, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set([r, g, b], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** Decodes a PNG into { width, height, pixel(x, y) -> [r, g, b] }. */
export function decodePng(buf) {
  let pos = 8;
  let width, height, channels;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0) throw new Error("only 8-bit, non-interlaced PNGs");
      channels = { 2: 3, 6: 4 }[data[9]];
      if (!channels) throw new Error(`unsupported color type ${data[9]}`);
    } else if (type === "IDAT") idat.push(data);
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? out[y * stride + i - channels] : 0;
      const b = y > 0 ? out[(y - 1) * stride + i] : 0;
      const c = i >= channels && y > 0 ? out[(y - 1) * stride + i - channels] : 0;
      let pred = 0;
      if (filter === 1) pred = a;
      else if (filter === 2) pred = b;
      else if (filter === 3) pred = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + i] = (line[i] + pred) & 0xff;
    }
  }
  return {
    width,
    height,
    pixel: (x, y) => {
      const i = y * stride + x * channels;
      return [out[i], out[i + 1], out[i + 2]];
    },
  };
}

/** True when the color is within `tol` of the expected one on every channel. */
export const near = (actual, expected, tol = 12) => actual.every((v, i) => Math.abs(v - expected[i]) <= tol);

// ---------- server ----------

/** Serves test/fixtures and solid images at /img/<rrggbb>.png. Optional delay for images (?delay=ms). */
export async function startServer() {
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://localhost");
    const img = u.pathname.match(/^\/img\/([0-9a-f]{6})\.png$/);
    if (img) {
      const delay = Number(u.searchParams.get("delay") || 0);
      if (delay) await new Promise((r) => setTimeout(r, delay));
      const hex = img[1];
      const color = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
      res.writeHead(200, { "content-type": "image/png" });
      return res.end(solidPng(200, 200, color));
    }
    const file = path.join(FIXTURES, path.normalize(u.pathname).replace(/^\/+/, ""));
    if (!file.startsWith(FIXTURES) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      return res.end("not found");
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((r) => server.close(r)) };
}

// ---------- shoot ----------

const created = [];
process.on("exit", () => {
  if (!process.env.KEEP_TEST_OUTPUT) for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});
/** A fresh temp folder, removed when the test process exits (set KEEP_TEST_OUTPUT=1 to keep it). */
export const tempDir = (prefix = "page-shots-test-") => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
};

/** Runs shoot.mjs and returns the parsed stdout line plus the regions.json and the decoded images. */
export async function shoot(url, extraArgs = [], { script = SHOOT, env = process.env } = {}) {
  const out = tempDir();
  const { stdout, stderr } = await run(process.execPath, [script, url, out, ...extraArgs], { env, timeout: 120_000 });
  const summary = JSON.parse(stdout.trim().split("\n").pop());
  const regions = JSON.parse(fs.readFileSync(path.join(out, "regions.json"), "utf8"));
  const images = Object.fromEntries(summary.images.map((i) => [i.view, decodePng(fs.readFileSync(i.path))]));
  return { out, summary, regions, images, stderr };
}
