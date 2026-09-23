#!/usr/bin/env node
/**
 * Point d'entree de production.
 *
 * Ordre de demarrage, et pourquoi :
 *   1. Controle de configuration — en production, un manque (cle Stripe,
 *      URL publique) arrete tout. Un service qui tourne sans encaisser
 *      les acomptes est pire qu'un service qui refuse de demarrer.
 *   2. Migrations — sous verrou consultatif : plusieurs conteneurs
 *      peuvent demarrer ensemble, un seul applique.
 *   3. Mot de passe du role applicatif — le role est cree par les
 *      migrations, mais un secret n'a rien a faire dans un fichier SQL
 *      versionne : il vient de l'environnement.
 *   4. Serveur, worker d'evenements et ordonnanceur.
 *   5. Arret propre sur SIGTERM : on finit les requetes en cours avant de
 *      couper, pour qu'un deploiement ne perde aucune reservation.
 */
import pg from 'pg';
import { config, assertProductionConfig } from './config.js';
import { migrate } from './db/migrate.js';
import { closePool, isolationProblem } from './db/pool.js';
import { startServer } from './api/server.js';

const log = (...args) => console.log('[orsyne]', ...args);

async function setAppRolePassword(password) {
  const client = new pg.Client({ connectionString: config.adminDatabaseUrl });
  await client.connect();
  try {
    // ALTER ROLE n'accepte pas de parametre lie : on laisse Postgres
    // echapper lui-meme la valeur via format(%L), jamais une concatenation.
    const { rows: [{ sql }] } = await client.query(
      "SELECT format('ALTER ROLE orsyne_app WITH LOGIN PASSWORD %L', $1::text) AS sql", [password]);
    await client.query(sql);
  } finally {
    await client.end();
  }
}

async function main() {
  if (!assertProductionConfig()) process.exit(1);

  if (config.migrateOnBoot) {
    const applied = await migrate({ log: (line) => log(line.trim()) });
    log(applied === 0 ? 'schema a jour' : `${applied} migration(s) appliquee(s)`);
  }

  if (process.env.ORSYNE_APP_DB_PASSWORD) {
    await setAppRolePassword(process.env.ORSYNE_APP_DB_PASSWORD);
    log('mot de passe du role applicatif applique');
  }

  const problem = await isolationProblem();
  if (problem) {
    console.error(`[orsyne] demarrage refuse — ${problem}`);
    process.exit(1);
  }

  if (process.env.ORSYNE_SEED_DEMO === 'true') {
    const { seed, seedReservations } = await import('./db/seed.js');
    const result = await seed({ log });
    if (typeof result === 'object') await seedReservations({ ...result, log });
  }

  const instance = await startServer({ withWorker: true, withScheduler: true });
  log(`Tout s'accorde. En ecoute sur le port ${instance.port} — ${config.publicUrl}`);

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    log(`${signal} recu : arret propre en cours`);
    const force = setTimeout(() => { log('arret force apres 15 s'); process.exit(1); }, 15_000);
    force.unref();
    try {
      await instance.close();
      await closePool();
      log('arret termine');
      process.exit(0);
    } catch (error) {
      log(`erreur a l'arret : ${error.message}`);
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => log('promesse rejetee non geree :', reason));
}

main().catch((error) => {
  console.error('[orsyne] demarrage impossible :', error);
  process.exit(1);
});
