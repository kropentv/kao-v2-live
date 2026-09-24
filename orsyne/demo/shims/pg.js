/**
 * Remplace le module `pg` par une base PostgreSQL embarquee (PGlite).
 *
 * Le code d'ORSYNE reste identique : il demande un pool, ouvre des
 * transactions, pose le contexte tenant. Ici, une seule session Postgres
 * sert tout le monde ; un verrou garantit qu'une transaction a la fois
 * la tient, exactement comme une connexion empruntee au pool.
 *
 * Deux identites, comme en production :
 *   - `new pg.Client()` (migrations, jeu de demonstration) = proprietaire ;
 *   - `new pg.Pool()` (toute l'application) = role orsyne_app, NOBYPASSRLS.
 * La securite ligne a ligne s'applique donc vraiment a l'application.
 */

let database = null;
let currentRole = null;

export function attachDatabase(db) {
  database = db;
  currentRole = null;
}

/** File d'attente FIFO : une seule transaction tient la session. */
class Mutex {
  constructor() { this.tail = Promise.resolve(); }
  acquire() {
    let release;
    const next = new Promise((resolve) => { release = resolve; });
    const ready = this.tail.then(() => release);
    this.tail = this.tail.then(() => next);
    return ready;
  }
}
const session = new Mutex();

async function useRole(role) {
  if (currentRole === role) return;
  await database.query(role === 'admin' ? 'RESET ROLE' : 'SET ROLE orsyne_app');
  await database.query('SET search_path = public, orsyne_core');
  currentRole = role;
}

function normalize(result) {
  const rows = result.rows ?? [];
  return {
    rows,
    // `rowCount` de pg : lignes renvoyees, ou lignes touchees sans RETURNING.
    rowCount: rows.length > 0 ? rows.length : (result.affectedRows ?? 0),
    fields: result.fields ?? [],
  };
}

async function run(text, params) {
  if (!database) throw new Error('Base locale non initialisee.');
  const sql = typeof text === 'object' ? text.text : text;
  const values = typeof text === 'object' ? text.values : params;
  try {
    if ((!values || values.length === 0) && /;\s*\S/.test(sql.replace(/--[^\n]*/g, ''))) {
      // Plusieurs instructions sans parametre : pg les accepte, comme exec.
      const results = await database.exec(sql);
      return normalize(results[results.length - 1] ?? {});
    }
    return normalize(await database.query(sql, values ?? []));
  } catch (error) {
    // PGlite remonte le code SQLSTATE comme pg : 23P01, 40P01, 42501…
    if (error && !error.code && error.fields?.C) error.code = error.fields.C;
    throw error;
  }
}

class PooledClient {
  constructor(role, release) {
    this.role = role;
    this.releaseLock = release;
    this.released = false;
  }
  async query(text, params) {
    if (this.released) throw new Error('Connexion deja rendue au pool.');
    await useRole(this.role);
    return run(text, params);
  }
  release() {
    if (this.released) return;
    this.released = true;
    this.releaseLock();
  }
  on() { return this; }
}

class Pool {
  constructor() { this.ended = false; }
  async connect() {
    const release = await session.acquire();
    return new PooledClient('app', release);
  }
  async query(text, params) {
    const client = await this.connect();
    try { return await client.query(text, params); } finally { client.release(); }
  }
  async end() { this.ended = true; }
  on() { return this; }
}

class Client {
  constructor() { this.inner = null; }
  async connect() {
    const release = await session.acquire();
    this.inner = new PooledClient('admin', release);
  }
  query(text, params) { return this.inner.query(text, params); }
  async end() { this.inner?.release(); }
  on() { return this; }
}

const types = {
  builtins: { INT8: 20, NUMERIC: 1700, DATE: 1082 },
  // PGlite renvoie deja les bigint en Number et les numeric en texte.
  setTypeParser() {},
};

export default { Pool, Client, types };
export { Pool, Client, types };
