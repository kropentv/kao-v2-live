/**
 * Sert demo/dist comme le lecteur d'artefacts : la page est enveloppee
 * dans un squelette HTML, les autres fichiers sont servis tels quels.
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), 'dist');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
};

// Politique proche de celle du lecteur d'artefacts : pas de reseau hors de
// l'origine, scripts locaux ou en ligne, WebAssembly autorise.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://cdnjs.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "connect-src 'self'",
  "img-src 'self' data: blob:",
  "frame-src 'self' blob:",
].join('; ');

export function serveDemo(port = 0) {
  const server = http.createServer(async (req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    const file = path === '/' ? 'index.html' : path.slice(1);
    try {
      let body = await readFile(join(dist, file));
      if (file === 'index.html') {
        body = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"></head><body>${body}</body></html>`;
      }
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'content-security-policy': CSP });
      res.end(body);
    } catch {
      res.writeHead(404); res.end('introuvable');
    }
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = await serveDemo(Number(process.env.PORT ?? 4173));
  console.log(`Demo ORSYNE : http://localhost:${server.address().port}`);
}
