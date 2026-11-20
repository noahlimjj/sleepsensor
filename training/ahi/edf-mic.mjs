// Streams one channel (default "Mic") of an EDF file to stdout as s16le PCM.
// Usage: node edf-mic.mjs file.edf [label] | ffmpeg -f s16le -ar 48000 -ac 1 -i - out.flac
import { openSync, readSync, closeSync } from 'fs';

const [file, label = 'Mic'] = process.argv.slice(2);
const fd = openSync(file, 'r');
const head = Buffer.alloc(256);
readSync(fd, head, 0, 256, 0);
const ns = parseInt(head.toString('latin1', 252, 256));
const sh = Buffer.alloc(ns * 256);
readSync(fd, sh, 0, sh.length, 256);
const labels = [];
for (let i = 0; i < ns; i++) labels.push(sh.toString('latin1', i * 16, (i + 1) * 16).trim());
const sprOff = ns * 216;
const spr = [];
for (let i = 0; i < ns; i++) spr.push(parseInt(sh.toString('latin1', sprOff + i * 8, sprOff + (i + 1) * 8)));
const ch = labels.indexOf(label);
if (ch < 0) throw new Error(`no channel ${label} in ${labels.join(',')}`);
const recBytes = spr.reduce((a, b) => a + b, 0) * 2;
const chOff = spr.slice(0, ch).reduce((a, b) => a + b, 0) * 2;
const chBytes = spr[ch] * 2;
process.stderr.write(`${file}: ${label} @ ${spr[ch]} Hz\n`);

const BATCH = 16;
const buf = Buffer.alloc(recBytes * BATCH);
let pos = 256 + ns * 256;
for (;;) {
  const n = readSync(fd, buf, 0, buf.length, pos);
  const recs = Math.floor(n / recBytes);
  if (!recs) break;
  const out = Buffer.alloc(recs * chBytes);
  for (let r = 0; r < recs; r++) buf.copy(out, r * chBytes, r * recBytes + chOff, r * recBytes + chOff + chBytes);
  if (!process.stdout.write(out)) await new Promise((res) => process.stdout.once('drain', res));
  pos += recs * recBytes;
  if (n < buf.length) break;
}
closeSync(fd);
