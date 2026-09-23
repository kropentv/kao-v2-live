import pg from 'pg';
import { config } from '../config.js';

// Les timestamptz reviennent en Date natives ; les bigint en Number tant
// qu'ils tiennent (compteurs d'audit), sinon en string pour ne rien perdre.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => {
  const asNumber = Number(value);
  return Number.isSafeInteger(asNumber) ? asNumber : value;
});

let pool;

export function getPool() {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: config.databaseUrl,
      max: Number(process.env.ORSYNE_PG_POOL_MAX ?? 10),
      idleTimeoutMillis: 30_000,
      // Pin explicite : la valeur par defaut ("$user", public) ferait
      // dependre la resolution des tables du nom du role de connexion.
      options: '-c search_path=public,orsyne_core',
    });
  }
  return pool;
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

/**
 * Ouvre une transaction dont TOUTES les requetes sont bornees au tenant.
 *
 * Le contexte est pose avec SET LOCAL : il disparait avec la transaction,
 * donc une connexion rendue au pool ne peut pas fuiter le tenant precedent
 * vers la requete suivante. C'est le seul point d'entree autorise pour
 * lire ou ecrire des donnees metier.
 *
 * @param {{tenantId: string, userId?: string|null, isolation?: string}} ctx
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 * @template T
 */
export async function withTenant(ctx, fn) {
  if (!ctx?.tenantId) {
    throw new Error('withTenant: tenantId est obligatoire');
  }
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    if (ctx.isolation) {
      await client.query(`SET TRANSACTION ISOLATION LEVEL ${ctx.isolation}`);
    }
    // set_config(..., true) = portee transaction, equivalent de SET LOCAL
    // mais parametrable sans concatenation de chaine.
    await client.query('SELECT set_config($1, $2, true)', ['orsyne.tenant_id', ctx.tenantId]);
    await client.query('SELECT set_config($1, $2, true)', ['orsyne.user_id', ctx.userId ?? '']);

    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Le compte applicatif peut-il contourner l'isolation entre restaurants ?
 *
 * Un superutilisateur, ou un role BYPASSRLS, ignore toutes les politiques
 * de securite ligne a ligne : chaque restaurant verrait les donnees des
 * autres, sans la moindre erreur. C'est exactement ce qui arrive quand on
 * branche l'application sur le `DATABASE_URL` d'un hebergeur. On le
 * verifie donc au demarrage, plutot que de le decouvrir en production.
 *
 * @returns {Promise<string|null>} le probleme, ou null si le role est sain
 */
export async function isolationProblem(connectionString = config.databaseUrl) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const { rows: [role] } = await client.query(
      `SELECT current_user AS name, rolsuper, rolbypassrls
         FROM pg_roles WHERE rolname = current_user`);
    if (role.rolsuper || role.rolbypassrls) {
      return `le compte « ${role.name} » contourne l'isolation entre restaurants `
        + `(${role.rolsuper ? 'superutilisateur' : 'BYPASSRLS'}). `
        + "Utilisez le role orsyne_app (ORSYNE_DATABASE_URL, ou ORSYNE_APP_DB_PASSWORD).";
    }
    return null;
  } finally {
    await client.end();
  }
}
