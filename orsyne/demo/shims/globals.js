/** Globales Node attendues par src/ (process.env, Buffer), injectees par esbuild. */
import { Buffer } from 'buffer';
import processShim from './process.js';

// Le polyfill `buffer` ignore l'encodage base64url (jetons de session).
function supportsBase64url() {
  try { return Buffer.from([0xfb]).toString('base64url') === '-w'; } catch { return false; }
}
if (!supportsBase64url()) {
  const toString = Buffer.prototype.toString;
  Buffer.prototype.toString = function patched(encoding, ...rest) {
    if (encoding !== 'base64url') return toString.call(this, encoding, ...rest);
    return toString.call(this, 'base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
}

export { Buffer, processShim as process };
