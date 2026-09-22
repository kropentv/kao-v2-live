import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { DomainError } from '../domain/errors.js';
import { getPool, withTenant } from '../db/pool.js';

const scrypt = promisify(scryptCb);

// Parametres scrypt : cout memoire eleve, suffisant pour un usage SaaS et
// sans dependance native a compiler.
//
// `maxmem` doit etre declare explicitement : le calcul consomme
// 128 * N * r = 33,5 Mo, au-dessus du plafond par defaut de Node (32 Mo),
// qui refuserait l'operation.
const SCRYPT_MEMORY = 128 * (2 ** 15) * 8 * 2;
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keylen: 64, maxmem: SCRYPT_MEMORY };
export const SESSION_TTL_DAYS = 30;

export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 10) {
    throw new DomainError('weak_password', 'Le mot de passe doit faire au moins 10 caracteres.');
  }
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  if (!stored?.startsWith('scrypt$')) return false;
  const [, N, r, p, salt, hash] = stored.split('$');
  const expected = Buffer.from(hash, 'base64');
  const derived = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT_MEMORY,
  });
  // Comparaison a temps constant : le temps de reponse ne doit rien dire
  // sur le nombre d'octets corrects.
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/** Le jeton circule en clair chez le client, seul son hash est stocke. */
export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export async function login({ email, password, userAgent = null, ip = null }) {
  const pool = getPool();
  const { rows } = await pool.query(
    'SELECT * FROM orsyne_core.lookup_login($1)', [String(email ?? '').trim()],
  );
  const found = rows[0];

  // Meme travail cryptographique que le cas nominal, pour qu'un email
  // inconnu ne reponde pas plus vite qu'un mot de passe faux.
  const ok = found
    ? await verifyPassword(password, found.password_hash)
    : await verifyPassword(password, await hashPassword('mot-de-passe-factice-orsyne'));

  if (!found || !ok) {
    throw new DomainError('invalid_credentials', 'Identifiants incorrects.');
  }
  if (found.status === 'invited') {
    throw new DomainError('invitation_pending', "Cette invitation n'a pas encore ete acceptee.");
  }

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000);

  await withTenant({ tenantId: found.tenant_id, userId: found.user_id }, async (client) => {
    await client.query(
      `INSERT INTO auth_sessions (tenant_id, user_id, token_hash, user_agent, ip, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [found.tenant_id, found.user_id, hashToken(token), userAgent, ip, expiresAt],
    );
    await client.query('UPDATE users SET last_login_at = now() WHERE id = $1', [found.user_id]);
  });

  return { token, expiresAt, userId: found.user_id, tenantId: found.tenant_id };
}

/** Resout une requete entrante : session valide -> identite + roles. */
export async function resolveSession(token) {
  if (!token) return null;
  const { rows } = await getPool().query(
    'SELECT * FROM orsyne_core.lookup_session($1)', [hashToken(token)],
  );
  const session = rows[0];
  if (!session) return null;

  return withTenant({ tenantId: session.tenant_id, userId: session.user_id }, async (client) => {
    const { rows: [user] } = await client.query(
      `SELECT id, email, full_name, display_name, locale, status FROM users WHERE id = $1`,
      [session.user_id],
    );
    if (!user) return null;
    const { rows: memberships } = await client.query(
      `SELECT role, restaurant_id FROM memberships WHERE user_id = $1`, [session.user_id],
    );
    return {
      sessionId: session.session_id,
      tenantId: session.tenant_id,
      user,
      memberships,
    };
  });
}

export async function logout({ tenantId, userId, sessionId }) {
  await withTenant({ tenantId, userId }, (client) => client.query(
    `UPDATE auth_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`,
    [sessionId],
  ));
}

/**
 * Cree un tenant, son proprietaire et son premier etablissement.
 * Point d'entree de l'inscription : tout le reste en decoule.
 */
export async function registerTenant({ tenantName, slug, restaurantName, email, password, fullName, timezone = 'Europe/Paris' }) {
  const passwordHash = await hashPassword(password);
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Amorcage : creer un tenant exigerait deja un contexte tenant, que
    // la RLS refuse de deviner. On genere donc l'identifiant d'abord, on
    // pose le contexte, puis on insere avec cet identifiant — la clause
    // WITH CHECK est satisfaite et aucune exception a la RLS n'est
    // necessaire pour l'inscription.
    const { rows: [{ id: tenantId }] } = await client.query('SELECT gen_random_uuid() AS id');
    await client.query('SELECT set_config($1,$2,true)', ['orsyne.tenant_id', tenantId]);

    const { rows: [tenant] } = await client.query(
      `INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3) RETURNING *`,
      [tenantId, tenantName, slug],
    );

    const { rows: [user] } = await client.query(
      `INSERT INTO users (tenant_id, email, password_hash, full_name, status)
       VALUES ($1,$2,$3,$4,'active') RETURNING *`,
      [tenant.id, email, passwordHash, fullName],
    );
    const { rows: [restaurant] } = await client.query(
      `INSERT INTO restaurants (tenant_id, name, slug, timezone)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [tenant.id, restaurantName, slug, timezone],
    );
    await client.query(
      // restaurant_id NULL = portee tenant : le proprietaire couvre tous
      // les etablissements presents et futurs.
      `INSERT INTO memberships (tenant_id, user_id, restaurant_id, role)
       VALUES ($1,$2,NULL,'owner')`,
      [tenant.id, user.id],
    );
    await client.query('COMMIT');
    return { tenant, user, restaurant };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.code === '23505') {
      throw new DomainError('already_exists', 'Ce nom de compte ou cet email est deja utilise.');
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Ajoute un membre d'equipe (invitation simple, mot de passe fourni). */
export async function createStaffUser(client, { tenantId, email, fullName, password, role, restaurantId, locale = 'fr-FR' }) {
  const passwordHash = password ? await hashPassword(password) : null;
  const { rows: [user] } = await client.query(
    `INSERT INTO users (tenant_id, email, password_hash, full_name, locale, status)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, email, full_name, status, locale`,
    [tenantId, email, passwordHash, fullName, locale, password ? 'active' : 'invited'],
  );
  await client.query(
    `INSERT INTO memberships (tenant_id, user_id, restaurant_id, role) VALUES ($1,$2,$3,$4)`,
    [tenantId, user.id, restaurantId ?? null, role],
  );
  if (restaurantId && ['server', 'floor_manager'].includes(role)) {
    await client.query(
      `INSERT INTO staff_profiles (tenant_id, user_id, restaurant_id) VALUES ($1,$2,$3)
       ON CONFLICT DO NOTHING`,
      [tenantId, user.id, restaurantId],
    );
  }
  return { ...user, role };
}
