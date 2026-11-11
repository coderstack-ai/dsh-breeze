// dsh-breeze — where generated audio lands, and how a local server gets started.

import fs from 'node:fs';
import path from 'node:path';

import { audioDir } from './config.mjs';

const EXTENSIONS = { wav: 'wav', mp3: 'mp3', pcm: 'pcm' };

function pad(value, size = 2) {
  return String(value).padStart(size, '0');
}

/** A filesystem-safe, human-readable slug from the spoken text. */
function slugFrom(text) {
  const cleaned = String(text || '')
    .replace(/[（）()\[\]{}<>"'`~!@#$%^&*+=|\\/:;,.?！？。，、；：“”‘’（）《》【】…—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return 'speech';
  const latin = cleaned.replace(/[^\w\s-]/g, '').trim();
  const source = latin || cleaned;
  return source.split(' ').slice(0, 6).join('-').slice(0, 48) || 'speech';
}

/** Write one audio artifact and return its absolute path plus byte size. */
export function writeAudio(config, buffer, { ext = 'wav', text = '' } = {}) {
  const dir = audioDir(config);
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date();
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const suffix = Math.random().toString(36).slice(2, 6);
  const name = `breeze-${stamp}-${slugFrom(text)}-${suffix}.${EXTENSIONS[ext] || ext}`;
  const file = path.join(dir, name);
  fs.writeFileSync(file, buffer);
  return { path: file, bytes: buffer.length, dir };
}

/** Guard for every path an agent hands us: it must be a readable regular file. */
export function assertReadableFile(file, label = 'file') {
  const resolved = path.resolve(String(file || ''));
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new Error(`${label} not found: ${resolved}`);
  }
  if (!stat.isFile()) throw new Error(`${label} is not a regular file: ${resolved}`);
  if (stat.size === 0) throw new Error(`${label} is empty: ${resolved}`);
  return { path: resolved, size: stat.size };
}

/** Remove a file we wrote this turn, used when a later step fails. */
export function safeUnlink(file) {
  try {
    fs.unlinkSync(file);
  } catch {
    // best effort
  }
}
