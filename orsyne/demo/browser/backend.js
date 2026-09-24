/**
 * Le serveur ORSYNE, tel quel, execute dans la page.
 *
 * Aucune logique n'est reecrite ici : ce fichier demarre PostgreSQL
 * (PGlite), applique les vraies migrations, charge le vrai jeu de
 * demonstration, puis fait passer chaque appel `/api/...` des interfaces
 * par le vrai `createApp()` — memes routes, memes droits, meme moteur de
 * reservation, meme contrainte anti-double reservation.
 */
import { Buffer } from 'buffer';
import { PGlite } from '@electric-sql/pglite';

import { attachDatabase } from '../shims/pg.js';
import { MIGRATIONS } from './migrations.generated.js';
import { EXTENSIONS } from './extensions.generated.js';

import { createApp } from '../../src/api/server.js';
import { seed, seedReservations } from '../../src/db/seed.js';
import { outboxWorker } from '../../src/services/outbox-worker.js';
import { scheduler } from '../../src/services/scheduler.js';

// Chaque remise a zero ouvre une nouvelle base : attendre l'effacement de
// l'ancienne peut bloquer tant que le navigateur n'a pas relache le fichier.
const GENERATION_KEY = 'orsyne-demo:generation';

function generation() {
  try { return Number(localStorage.getItem(GENERATION_KEY)) || 1; } catch { return 1; }
}

const dataDir = () => `idb://orsyne-demo-${generation()}`;

let handle = null;
let database = null;

// Les extensions voyagent dans ce module ; PGlite les demande par fetch,
// on lui repond sans reseau pendant l'ouverture de la base.
const EXTENSION_ORIGIN = 'https://extensions.orsyne.local/';

function extension(name) {
  return { name, setup: async () => ({ bundlePath: new URL(`${EXTENSION_ORIGIN}${name}.tar.gz`) }) };
}

async function withEmbeddedExtensions(open) {
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = String(input?.url ?? input);
    if (!url.startsWith(EXTENSION_ORIGIN)) return nativeFetch(input, init);
    const name = url.slice(EXTENSION_ORIGIN.length).replace('.tar.gz', '');
    const bytes = Uint8Array.from(atob(EXTENSIONS[name]), (c) => c.charCodeAt(0));
    return Promise.resolve(new Response(bytes, { headers: { 'content-type': 'application/gzip' } }));
  };
  try {
    return await open();
  } finally {
    globalThis.fetch = nativeFetch;
  }
}

async function fetchOk(file) {
  const response = await fetch(new URL(file, document.baseURI));
  if (!response.ok) throw new Error(`${file} : HTTP ${response.status}`);
  return response;
}

async function openDatabase({ persistent }) {
  const [wasm, data] = await Promise.all([
    fetchOk('pglite.wasm').then((r) => r.arrayBuffer()).then((b) => WebAssembly.compile(b)),
    fetchOk('pglite-data.wasm').then((r) => r.arrayBuffer()).then((b) => new Blob([b])),
  ]);
  const options = {
    wasmModule: wasm,
    // Ecriture differee vers IndexedDB : la page reste fluide pendant le service.
    relaxedDurability: true,
    fsBundle: data,
    extensions: {
      btree_gist: extension('btree_gist'),
      citext: extension('citext'),
    },
  };
  if (persistent) {
    try {
      return await withEmbeddedExtensions(() => PGlite.create(dataDir(), options));
    } catch (error) {
      console.warn('[orsyne] stockage local indisponible, base en memoire :', error);
    }
  }
  return withEmbeddedExtensions(() => PGlite.create(options));
}

async function isInstalled(db) {
  const { rows } = await db.query(`SELECT to_regclass('public.reservations') IS NOT NULL AS ok`);
  return rows[0].ok;
}

async function install(db, progress) {
  for (const [index, migration] of MIGRATIONS.entries()) {
    progress(`Migration ${index + 1}/${MIGRATIONS.length} : ${migration.name}`);
    // pgcrypto n'existe pas dans PGlite ; gen_random_uuid() est natif
    // depuis PostgreSQL 13, c'est la seule fonction utilisee.
    await db.exec(migration.sql.replace(/CREATE EXTENSION IF NOT EXISTS pgcrypto;/g, ''));
  }
}

/**
 * @param {{onProgress?: (label: string) => void, persistent?: boolean}} options
 */
export async function boot({ onProgress = () => {}, persistent = true } = {}) {
  onProgress('Démarrage de PostgreSQL dans le navigateur…');
  database = await openDatabase({ persistent });
  attachDatabase(database);

  let freshInstall = false;
  if (!(await isInstalled(database))) {
    await install(database, onProgress);
    freshInstall = true;
  }

  onProgress('Chargement du restaurant de démonstration…');
  const seeded = await seed({ log: () => {} });
  if (freshInstall && typeof seeded === 'object') {
    onProgress('Réservations du prochain service…');
    await seedReservations({ ...seeded, log: () => {} });
  }

  handle = createApp();
  outboxWorker.start();
  scheduler.start();

  const { rows: [role] } = await database.query(
    `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'orsyne_app'`);
  return {
    freshInstall,
    appRoleIsolated: !role.rolsuper && !role.rolbypassrls,
  };
}

/** Efface la base locale : le prochain demarrage repart du jeu de demonstration. */
export async function wipe() {
  outboxWorker.stop();
  scheduler.stop();
  try { await database?.close(); } catch { /* deja fermee */ }
  const previous = dataDir().replace('idb://', '/pglite/');
  try { localStorage.setItem(GENERATION_KEY, String(generation() + 1)); } catch { /* prive */ }
  // Effacement en arriere-plan : la nouvelle base n'en depend pas.
  try { indexedDB.deleteDatabase(previous); } catch { /* deja absente */ }
}

/* ------------------------------------------------------------------ */
/* Requetes HTTP simulees : un objet req/res compatible node:http.     */
/* ------------------------------------------------------------------ */

class FakeResponse {
  constructor() {
    this.statusCode = 200;
    this.headers = {};
    this.headersSent = false;
    this.chunks = [];
    this.listeners = {};
    this.finished = new Promise((resolve) => { this.finish = resolve; });
    this.onHead = null;
    this.onData = null;
  }
  setHeader(name, value) { this.headers[name.toLowerCase()] = value; }
  getHeader(name) { return this.headers[name.toLowerCase()]; }
  removeHeader(name) { delete this.headers[name.toLowerCase()]; }
  writeHead(status, headers = {}) {
    this.statusCode = status;
    for (const [k, v] of Object.entries(headers)) this.setHeader(k, v);
    this.headersSent = true;
    this.onHead?.(this);
    return this;
  }
  write(chunk) {
    if (!this.headersSent) this.writeHead(this.statusCode);
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    if (this.onData) this.onData(text); else this.chunks.push(text);
    return true;
  }
  end(chunk) {
    if (chunk !== undefined && chunk !== null) this.write(chunk);
    if (!this.headersSent) this.writeHead(this.statusCode);
    this.finish();
    this.emit('finish');
  }
  on(event, fn) { (this.listeners[event] ??= []).push(fn); return this; }
  once(event, fn) { return this.on(event, fn); }
  emit(event) { for (const fn of this.listeners[event] ?? []) fn(); }
}

function fakeRequest({ method, url, headers, body }) {
  const payload = body == null ? null : Buffer.from(body);
  return {
    method,
    url,
    headers,
    socket: { remoteAddress: '127.0.0.1' },
    connection: { remoteAddress: '127.0.0.1' },
    on() { return this; },
    async *[Symbol.asyncIterator]() { if (payload?.length) yield payload; },
  };
}

/** Un « navigateur » par interface : chacune garde sa propre session. */
const jars = new Map();

function loadJar(id) {
  if (!jars.has(id)) {
    let stored = {};
    try { stored = JSON.parse(localStorage.getItem(`orsyne-jar:${id}`) ?? '{}'); } catch { /* prive */ }
    jars.set(id, stored);
  }
  return jars.get(id);
}

function saveJar(id) {
  try { localStorage.setItem(`orsyne-jar:${id}`, JSON.stringify(jars.get(id))); } catch { /* prive */ }
}

export function clearSessions() {
  jars.clear();
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith('orsyne-jar:')) localStorage.removeItem(key);
  } catch { /* prive */ }
}

function applySetCookie(jarId, header) {
  if (!header) return;
  const jar = loadJar(jarId);
  for (const line of [].concat(header)) {
    const [pair, ...attributes] = line.split(';');
    const index = pair.indexOf('=');
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    const expires = attributes.map((a) => a.trim()).find((a) => /^expires=/i.test(a));
    const expired = expires && new Date(expires.slice(8)) < new Date();
    if (!value || expired) delete jar[name]; else jar[name] = value;
  }
  saveJar(jarId);
}

function cookieHeader(jarId) {
  return Object.entries(loadJar(jarId)).map(([k, v]) => `${k}=${v}`).join('; ');
}

function prepare(jarId, { method = 'GET', url, headers = {}, body = null }) {
  const target = new URL(url, 'https://orsyne.demo');
  const req = fakeRequest({
    method: method.toUpperCase(),
    url: target.pathname + target.search,
    headers: {
      host: 'orsyne.demo',
      'user-agent': navigator.userAgent,
      cookie: cookieHeader(jarId),
      ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
    },
    body,
  });
  return { req, res: new FakeResponse() };
}

/**
 * Traite une requete comme le ferait le serveur Node.
 * @returns {Promise<{status: number, headers: object, body: string}>}
 */
export async function request(jarId, init) {
  if (!handle) throw new Error('Serveur local non demarre.');
  const { req, res } = prepare(jarId, init);
  await handle(req, res);
  await res.finished;
  applySetCookie(jarId, res.headers['set-cookie']);
  return { status: res.statusCode, headers: res.headers, body: res.chunks.join('') };
}

/**
 * Ouvre un flux temps reel (SSE) et decoupe les trames.
 * @returns {Promise<{status: number, close: () => void}>}
 */
export async function stream(jarId, url, onEvent) {
  const { req, res } = prepare(jarId, { method: 'GET', url });
  let buffer = '';
  res.onData = (text) => {
    buffer += text;
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let type = 'message';
      const data = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) type = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (data.length) onEvent(type, data.join('\n'));
    }
  };
  const head = new Promise((resolve) => { res.onHead = resolve; });
  await Promise.race([handle(req, res), head]);
  await head;
  return {
    status: res.statusCode,
    close() { res.emit('close'); },
  };
}
