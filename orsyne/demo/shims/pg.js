/**
 * Remplace le module `pg` par une base PostgreSQL embarquee (PGlite).
 *
 * Le code d'ORSYNE reste identique : il demande un pool, ouvre des
 * transactions, pose le contexte tenant. Ici, une seule session Postgres
 * sert tout le monde ; un verrou garantit qu'une seule transaction a la
 * fois la tient.
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

const BEGIN = /^\s*(BEGIN|START\s+TRANSACTION)\b/i;
const END = /^\s*(COMMIT|END|ROLLBACK)\s*;?\s*$/i;

/**
 * Une « connexion » du pool.
 *
 * Toutes partagent la meme session Postgres : on ne peut donc pas laisser
 * deux transactions s'entrelacer. Le verrou est tenu de BEGIN a COMMIT ou
 * ROLLBACK, et le temps d'une seule requete hors transaction.
 *
 * Tenir le verrou pendant toute la duree d'emprunt (premiere version)
 * bloquait la base des qu'un code gardait une connexion ouverte en en
 * empruntant une autre — exactement ce que fait le planificateur, qui
 * garde son verrou consultatif sur une connexion pendant tout son tour.
 */
class PooledClient {
  constructor(role) {
    this.role = role;
    this.releaseLock = null;
    this.released = false;
  }

  async query(text, params) {
    if (this.released) throw new Error('Connexion deja rendue au pool.');
    const sql = typeof text === 'object' ? text.text : text;

    if (this.releaseLock) {
      // En transaction : la session est deja a nous.
      try {
        return await run(text, params);
      } finally {
        if (END.test(sql)) this.unlock();
      }
    }

    const release = await session.acquire();
    try {
      await useRole(this.role);
      const result = await run(text, params);
      if (BEGIN.test(sql)) {
        this.releaseLock = release;
        return result;
      }
      release();
      return result;
    } catch (error) {
      release();
      throw error;
    }
  }

  unlock() {
    const release = this.releaseLock;
    this.releaseLock = null;
    release?.();
  }

  release() {
    if (this.released) return;
    this.released = true;
    if (this.releaseLock) {
      // Transaction abandonnee sans COMMIT ni ROLLBACK : on l'annule.
      run('ROLLBACK').catch(() => {}).finally(() => this.unlock());
    }
  }

  on() { return this; }
}

class Pool {
  constructor() { this.ended = false; }
  async connect() { return new PooledClient('app'); }
  async query(text, params) {
    const client = await this.connect();
    try { return await client.query(text, params); } finally { client.release(); }
  }
  async end() { this.ended = true; }
  on() { return this; }
}

class Client {
  constructor() { this.inner = new PooledClient('admin'); }
  async connect() {}
  query(text, params) { return this.inner.query(text, params); }
  async end() { this.inner.release(); }
  on() { return this; }
}

const types = {
  builtins: { INT8: 20, NUMERIC: 1700, DATE: 1082 },
  // PGlite renvoie deja les bigint en Number et les numeric en texte.
  setTypeParser() {},
};

export default { Pool, Client, types };
export { Pool, Client, types };
