#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from '../config.js';

// Identifiant arbitraire mais stable du verrou de migration ORSYNE.
const MIGRATION_LOCK_KEY = 8_276_105;

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'migrations');

/**
 * Applique les migrations manquantes, chacune dans sa propre transaction.
 * Une migration qui echoue n'en laisse jamais une moitie appliquee.
 */
export async function migrate({ connectionString = config.adminDatabaseUrl, log = console.log } = {}) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    // search_path explicite : la valeur par defaut commence par "$user",
    // ce qui ferait atterrir les tables dans un schema homonyme du role
    // si celui-ci existait. On ne laisse pas ce hasard decider.
    await client.query('SET search_path = public, orsyne_core');
    // Verrou consultatif : plusieurs instances qui demarrent en meme temps
    // (deploiement, suite de tests parallele) ne doivent pas appliquer la
    // meme migration deux fois. La seconde attend puis ne trouve plus rien
    // a faire. Le verrou est pose au niveau session et libere en sortie.
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     text PRIMARY KEY,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )
    `);

    const applied = new Set(
      (await client.query('SELECT version FROM schema_migrations')).rows.map((r) => r.version),
    );
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();

    let count = 0;
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(join(migrationsDir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
        log(`  applied ${file}`);
        count += 1;
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} a echoue: ${error.message}`, { cause: error });
      }
    }
    return count;
  } finally {
    // La fermeture de la session libere le verrou, mais on est explicite :
    // une erreur de migration ne doit pas laisser les autres instances
    // bloquees si la connexion tarde a se fermer.
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const count = await migrate();
  console.log(count === 0 ? 'Schema deja a jour.' : `${count} migration(s) appliquee(s).`);
}
