import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

import { ensureSchema, createFixture, eveningAt, admin, closePool, APP_URL } from './helpers/db.js';
import { withTenant, getPool } from '../src/db/pool.js';
import { createReservation } from '../src/domain/reservation-engine.js';
import { zonedTimeToUtc } from '../src/lib/time.js';

before(async () => { await ensureSchema(); });
after(async () => { await closePool(); });

const at = (hour, daysFromNow = 7) =>
  zonedTimeToUtc(eveningAt(hour, 0, daysFromNow), 'Europe/Paris');

test('un tenant ne voit jamais les reservations d un autre', async () => {
  const a = await createFixture({ slugPrefix: 'iso-a' });
  const b = await createFixture({ slugPrefix: 'iso-b' });

  const booked = await withTenant({ tenantId: a.tenantId }, (client) =>
    createReservation(client, { restaurantId: a.restaurantId, partySize: 2, startsAt: at(20) }));

  const seenByA = await withTenant({ tenantId: a.tenantId }, async (client) =>
    (await client.query('SELECT id FROM reservations')).rows);
  assert.equal(seenByA.length, 1);
  assert.equal(seenByA[0].id, booked.reservation.id);

  const seenByB = await withTenant({ tenantId: b.tenantId }, async (client) =>
    (await client.query('SELECT id FROM reservations')).rows);
  assert.equal(seenByB.length, 0, "le tenant B ne doit rien voir du tenant A");

  // Meme en visant explicitement l'identifiant, la ligne reste invisible.
  const targeted = await withTenant({ tenantId: b.tenantId }, async (client) =>
    (await client.query('SELECT id FROM reservations WHERE id = $1', [booked.reservation.id])).rows);
  assert.equal(targeted.length, 0);
});

test('un tenant ne peut pas lire les clients ni les tables d un autre', async () => {
  const a = await createFixture({ slugPrefix: 'iso-c' });
  const b = await createFixture({ slugPrefix: 'iso-d' });

  await admin((db) => db.query(
    `INSERT INTO guests (tenant_id, first_name, phone_e164) VALUES ($1, 'Confidentiel', '+33611111111')`,
    [a.tenantId],
  ));

  const guests = await withTenant({ tenantId: b.tenantId }, async (client) =>
    (await client.query('SELECT id FROM guests')).rows);
  assert.equal(guests.length, 0);

  const tables = await withTenant({ tenantId: b.tenantId }, async (client) =>
    (await client.query('SELECT id FROM restaurant_tables WHERE restaurant_id = $1', [a.restaurantId])).rows);
  assert.equal(tables.length, 0);
});

test('ecrire une ligne au nom d un autre tenant est rejete', async () => {
  const a = await createFixture({ slugPrefix: 'iso-e' });
  const b = await createFixture({ slugPrefix: 'iso-f' });

  await assert.rejects(
    withTenant({ tenantId: b.tenantId }, (client) => client.query(
      `INSERT INTO guests (tenant_id, first_name, phone_e164)
       VALUES ($1, 'Injecte', '+33622222222')`,
      [a.tenantId],
    )),
    // 42501 : violation de la clause WITH CHECK de la politique RLS.
    (error) => error.code === '42501',
    'la politique WITH CHECK doit refuser un tenant_id etranger',
  );
});

test('modifier une ligne d un autre tenant ne touche aucune ligne', async () => {
  const a = await createFixture({ slugPrefix: 'iso-g' });
  const b = await createFixture({ slugPrefix: 'iso-h' });

  const booked = await withTenant({ tenantId: a.tenantId }, (client) =>
    createReservation(client, { restaurantId: a.restaurantId, partySize: 2, startsAt: at(20) }));

  const changed = await withTenant({ tenantId: b.tenantId }, async (client) => {
    const res = await client.query(
      `UPDATE reservations SET party_size = 99 WHERE id = $1`, [booked.reservation.id]);
    return res.rowCount;
  });
  assert.equal(changed, 0);

  const untouched = await admin((db) => db.query(
    `SELECT party_size FROM reservations WHERE id = $1`, [booked.reservation.id]));
  assert.equal(untouched.rows[0].party_size, 2);
});

test('sans contexte de tenant, aucune donnee n est lisible', async () => {
  const a = await createFixture({ slugPrefix: 'iso-i' });
  await withTenant({ tenantId: a.tenantId }, (client) =>
    createReservation(client, { restaurantId: a.restaurantId, partySize: 2, startsAt: at(20) }));

  // Connexion applicative brute, sans passer par withTenant.
  const client = await getPool().connect();
  try {
    const { rows } = await client.query('SELECT id FROM reservations');
    assert.equal(rows.length, 0, 'une requete hors contexte ne doit rien renvoyer');
  } finally {
    client.release();
  }
});

test('withTenant refuse de s executer sans tenantId', async () => {
  await assert.rejects(
    withTenant({}, async () => 'ne doit pas arriver'),
    /tenantId est obligatoire/,
  );
});

test('le contexte tenant ne fuit pas d une transaction a la suivante', async () => {
  const a = await createFixture({ slugPrefix: 'iso-j' });
  const b = await createFixture({ slugPrefix: 'iso-k' });

  await withTenant({ tenantId: a.tenantId }, (client) =>
    createReservation(client, { restaurantId: a.restaurantId, partySize: 2, startsAt: at(20) }));

  // Meme connexion physique reutilisee depuis le pool : SET LOCAL a expire
  // avec la transaction precedente, le contexte de A ne survit pas.
  for (let i = 0; i < 5; i += 1) {
    const rows = await withTenant({ tenantId: b.tenantId }, async (client) =>
      (await client.query('SELECT id FROM reservations')).rows);
    assert.equal(rows.length, 0, `iteration ${i}: fuite de contexte detectee`);
  }
});

test('le role applicatif ne peut pas contourner la RLS', async () => {
  assert.ok(APP_URL.includes('orsyne_app'), 'les tests doivent tourner avec le role applicatif');
  const bypass = await admin((db) => db.query(
    `SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'orsyne_app'`));
  assert.equal(bypass.rows[0].rolbypassrls, false);
  assert.equal(bypass.rows[0].rolsuper, false);
});

test('toute table metier porte tenant_id et une politique RLS', async () => {
  // Filet de securite structurel : une future migration qui oublierait
  // la RLS fait echouer ce test, pas la production.
  const exempt = new Set(['tenants', 'schema_migrations', 'table_combination_members',
    'guest_restaurant_stats', 'shift_zones', 'shift_tables']);

  const { rows } = await admin((db) => db.query(`
    SELECT c.relname,
           c.relrowsecurity,
           c.relforcerowsecurity,
           EXISTS (SELECT 1 FROM information_schema.columns col
                    WHERE col.table_name = c.relname
                      AND col.table_schema = 'public'
                      AND col.column_name = 'tenant_id') AS has_tenant_id
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
     ORDER BY c.relname`));

  // Tables d'exploitation : aucune donnee client, donc pas de tenant_id.
  const operational = new Set(['schema_migrations', 'job_runs']);

  const offenders = rows.filter((r) => {
    if (operational.has(r.relname)) return false;
    if (r.relname === 'tenants') return !r.relrowsecurity;
    if (!r.has_tenant_id) return true;
    return !r.relrowsecurity || !r.relforcerowsecurity;
  });

  assert.deepEqual(
    offenders.map((r) => r.relname), [],
    'ces tables n ont pas de tenant_id ou pas de RLS forcee',
  );
  // Les tables de jonction sont couvertes aussi : elles portent tenant_id.
  for (const name of exempt) {
    if (name === 'tenants' || name === 'schema_migrations') continue;
    const row = rows.find((r) => r.relname === name);
    assert.ok(row?.has_tenant_id, `${name} doit porter tenant_id`);
  }
});

test('le demarrage detecte un compte applicatif qui contournerait l isolation', async () => {
  const { isolationProblem } = await import('../src/db/pool.js');
  // Le role applicatif des tests : sain.
  assert.equal(await isolationProblem(process.env.ORSYNE_DATABASE_URL), null);
  // Le proprietaire, superutilisateur : exactement ce que fournit un
  // DATABASE_URL d'hebergeur. Le service doit refuser de s'en servir.
  const problem = await isolationProblem(process.env.ORSYNE_ADMIN_DATABASE_URL);
  assert.match(problem ?? '', /contourne l'isolation/);
});

test('DATABASE_URL d un hebergeur ne sert jamais de connexion applicative', async () => {
  const { deriveAppUrl } = await import('../src/config.js');
  const derived = new URL(deriveAppUrl('postgresql://postgres:secret@db.internal:5432/railway', 'mot de passe'));
  assert.equal(derived.username, 'orsyne_app');
  assert.equal(decodeURIComponent(derived.password), 'mot de passe');
  assert.equal(derived.host, 'db.internal:5432');
  assert.equal(derived.pathname, '/railway');
  assert.equal(deriveAppUrl('postgresql://postgres:secret@db/x', undefined), null,
    'sans mot de passe applicatif, rien n est deduit : pas de repli silencieux sur le proprietaire');
});
