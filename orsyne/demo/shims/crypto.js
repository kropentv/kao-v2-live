/** `node:crypto` pour le navigateur : WebCrypto + @noble/hashes (JS pur). */
import { Buffer } from 'buffer';
import { scryptAsync } from '@noble/hashes/scrypt';
import { sha256 } from '@noble/hashes/sha256';
import { hmac } from '@noble/hashes/hmac';

const bytes = (value) => (typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value));

export function randomBytes(size) {
  return Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(size)));
}

export function randomUUID() {
  return globalThis.crypto.randomUUID();
}

export function scrypt(password, salt, keylen, options, callback) {
  const done = typeof options === 'function' ? options : callback;
  const { N = 16384, r = 8, p = 1 } = typeof options === 'object' ? options : {};
  scryptAsync(bytes(password), bytes(salt), { N, r, p, dkLen: keylen })
    .then((key) => done(null, Buffer.from(key)), (error) => done(error));
}

function digestOf(compute) {
  const chunks = [];
  const api = {
    update(data) { chunks.push(bytes(data)); return api; },
    digest(encoding) {
      const total = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
      let offset = 0;
      for (const c of chunks) { total.set(c, offset); offset += c.length; }
      const out = Buffer.from(compute(total));
      return encoding ? out.toString(encoding) : out;
    },
  };
  return api;
}

export function createHash(algorithm) {
  if (algorithm !== 'sha256') throw new Error(`Hash non disponible : ${algorithm}`);
  return digestOf((data) => sha256(data));
}

export function createHmac(algorithm, key) {
  if (algorithm !== 'sha256') throw new Error(`HMAC non disponible : ${algorithm}`);
  return digestOf((data) => hmac(sha256, bytes(key), data));
}

export function timingSafeEqual(a, b) {
  if (a.length !== b.length) throw new RangeError('Longueurs differentes');
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

export default { randomBytes, randomUUID, scrypt, createHash, createHmac, timingSafeEqual };
