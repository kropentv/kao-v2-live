import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

import { ensureSchema, closePool, admin } from './helpers/db.js';
import { startTestServer } from './helpers/api.js';

let server;
const unique = () => Math.random().toString(36).slice(2, 10);

before(async () => { await ensureSchema(); server = await startTestServer(); });
after(async () => { await server.close(); await closePool(); });

/** Restaurant complet : salle, service, equipe, shifts en cours. */
async function buildRestaurant() {
  const owner = server.client();
  const slug = `rbac-${unique()}`;
  const account = (await owner.post('/api/auth/register', {
    tenantName: 'Groupe RBAC', slug, restaurantName: 'Le Rang',
    email: `owner-${unique()}@orsyne.test`, password: 'motdepasse-solide-2026',
    fullName: 'Patron Test',
  })).data;
  const restaurantId = account.restaurant.id;

  const zone = (await owner.post(`/api/restaurants/${restaurantId}/zones`, { name: 'Salle' })).data;
  const terrace = (await owner.post(`/api/restaurants/${restaurantId}/zones`, {
    name: 'Terrasse', kind: 'terrace',
  })).data;

  const tables = {};
  for (const [code, seats, zoneId] of [
    ['T1', 4, zone.id], ['T2', 4, zone.id], ['TE1', 4, terrace.id], ['TE2', 4, terrace.id],
  ]) {
    tables[code] = (await owner.post(`/api/restaurants/${restaurantId}/tables`, {
      code, seatsMax: seats, zoneId,
    })).data;
  }

  await owner.post(`/api/restaurants/${restaurantId}/services`, {
    name: 'Service continu', daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
    startsAt: '00:00', endsAt: '23:59',
    lastSeatingOffsetMinutes: 0, defaultDurationMinutes: 90,
  });

  return { owner, slug, restaurantId, zone, terrace, tables, account };
}

async function addStaff(owner, restaurantId, role, { password = 'motdepasse-solide-2026' } = {}) {
  const email = `${role}-${unique()}@orsyne.test`;
  const created = await owner.post(`/api/restaurants/${restaurantId}/staff`, {
    email, fullName: `${role} Test`, role, password,
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const client = server.client();
  const login = await client.post('/api/auth/login', { email, password });
  assert.equal(login.status, 200);
  return { client, userId: created.data.id, email };
}

/** Shift couvrant maintenant, pour que l'attribution ait des candidats. */
async function openShift(owner, restaurantId, userId, { zoneIds = [], tableIds = [] } = {}) {
  const startsAt = new Date(Date.now() - 3_600_000).toISOString();
  const endsAt = new Date(Date.now() + 8 * 3_600_000).toISOString();
  const shift = await owner.post(`/api/restaurants/${restaurantId}/shifts`, {
    userId, startsAt, endsAt, role: 'server', status: 'clocked_in', zoneIds, tableIds,
  });
  assert.equal(shift.status, 201, JSON.stringify(shift.data));
  return shift.data;
}

const soon = (minutes = 60) => new Date(Date.now() + minutes * 60_000).toISOString();

test('un serveur ne peut pas modifier le plan de salle', async () => {
  const { owner, restaurantId } = await buildRestaurant();
  const server1 = await addStaff(owner, restaurantId, 'server');

  const attempt = await server1.client.post(`/api/restaurants/${restaurantId}/tables`, {
    code: 'PIRATE', seatsMax: 4,
  });
  assert.equal(attempt.status, 403);
  assert.equal(attempt.data.error.code, 'forbidden');

  // Il peut en revanche changer le statut d'une table pendant le service.
  const floor = await server1.client.get(`/api/restaurants/${restaurantId}/floor`);
  assert.equal(floor.status, 200);
  const status = await server1.client.post(
    `/api/restaurants/${restaurantId}/tables/${floor.data.tables[0].id}/status`,
    { status: 'cleaning' });
  assert.equal(status.status, 200);
  assert.equal(status.data.live_status, 'cleaning');
});

test('un serveur ne voit pas le profil CRM complet, seulement la note', async () => {
  const { owner, restaurantId } = await buildRestaurant();
  const waiter = await addStaff(owner, restaurantId, 'server');

  const guest = await owner.post('/api/guests', {
    firstName: 'Thomas', lastName: 'Martin', phone: `+3361${Date.now() % 10_000_000}`,
  });
  assert.equal(guest.status, 201);
  await owner.post(`/api/guests/${guest.data.id}/preferences`, {
    kind: 'allergy', value: 'Fruits à coque', isCritical: true,
  });

  const full = await waiter.client.get(`/api/guests/${guest.data.id}`);
  assert.equal(full.status, 403, 'le profil complet est refuse au serveur');

  const brief = await waiter.client.get(
    `/api/guests/${guest.data.id}/brief?restaurantId=${restaurantId}`);
  assert.equal(brief.status, 200);
  assert.ok(brief.data.hasCritical, "l'allergie doit remonter");
  assert.match(brief.data.lines[0].text, /Fruits à coque/);
});

test('la note serveur separe les faits des deductions IA', async () => {
  const { owner, restaurantId } = await buildRestaurant();
  const waiter = await addStaff(owner, restaurantId, 'server');
  const guest = await owner.post('/api/guests', {
    firstName: 'Claire', phone: `+3362${Date.now() % 10_000_000}`,
  });

  await admin(async (db) => {
    const { rows: [{ tenant_id }] } = await db.query(
      'SELECT tenant_id FROM guests WHERE id = $1', [guest.data.id]);
    const { rows: [fact] } = await db.query(
      `INSERT INTO guest_facts (tenant_id, guest_id, restaurant_id, subject, occurrences)
       VALUES ($1,$2,$3,'dish:entrecote',5) RETURNING id`,
      [tenant_id, guest.data.id, restaurantId]);
    await db.query(
      `INSERT INTO guest_insights
         (tenant_id, guest_id, restaurant_id, statement, confidence, evidence_fact_ids)
       VALUES ($1,$2,$3,'Semble apprécier l''entrecôte.',0.82,ARRAY[$4::uuid])`,
      [tenant_id, guest.data.id, restaurantId, fact.id]);
  });

  const brief = await waiter.client.get(
    `/api/guests/${guest.data.id}/brief?restaurantId=${restaurantId}`);
  assert.equal(brief.status, 200);

  const fact = brief.data.lines.find((l) => /Entrecote|Entrecôte/i.test(l.text));
  assert.ok(fact, 'le fait mesure doit apparaitre');
  assert.equal(fact.kind, 'fact');
  assert.match(fact.text, /commandé 5 fois/);

  // La deduction est hors des lignes de faits, et marquee comme inference.
  assert.ok(brief.data.suggestion, 'la suggestion IA doit etre presente');
  assert.equal(brief.data.suggestion.kind, 'inference');
  assert.equal(brief.data.suggestion.confidence, 0.82);
  assert.ok(
    !brief.data.lines.some((l) => l.kind === 'inference'),
    'aucune deduction ne doit se glisser parmi les faits',
  );
});

test('la note serveur ne repete pas une information et reste lisible', async () => {
  const { owner, restaurantId } = await buildRestaurant();
  const waiter = await addStaff(owner, restaurantId, 'server');
  const guest = await owner.post('/api/guests', {
    firstName: 'Paul', phone: `+3364${Date.now() % 10_000_000}`,
  });

  // Meme sujet des deux cotes : une preference declaree et un fait compte.
  await owner.post(`/api/guests/${guest.data.id}/preferences`, { kind: 'dish', value: 'Entrecôte' });
  // Vocabulaire technique, partage avec les attributs des tables.
  await owner.post(`/api/guests/${guest.data.id}/preferences`, { kind: 'zone', value: 'outdoor' });
  await admin(async (db) => {
    const { rows: [{ tenant_id }] } = await db.query(
      'SELECT tenant_id FROM guests WHERE id = $1', [guest.data.id]);
    await db.query(
      `INSERT INTO guest_facts (tenant_id, guest_id, restaurant_id, subject, occurrences)
       VALUES ($1,$2,$3,'dish:Entrecôte',4)`,
      [tenant_id, guest.data.id, restaurantId]);
  });

  const brief = await waiter.client.get(
    `/api/guests/${guest.data.id}/brief?restaurantId=${restaurantId}`);
  assert.equal(brief.status, 200);

  const entrecote = brief.data.lines.filter((l) => /entrec[oô]te/i.test(l.text));
  assert.equal(entrecote.length, 1, 'l information ne doit apparaitre qu une fois');
  assert.match(entrecote[0].text, /commandé 4 fois/, 'le fait chiffre doit primer sur la preference');

  const zone = brief.data.lines.find((l) => /terrasse/i.test(l.text));
  assert.ok(zone, 'la preference de zone doit etre lisible en francais');
  assert.ok(
    !brief.data.lines.some((l) => l.text === 'outdoor'),
    'aucun vocabulaire technique ne doit atteindre le serveur',
  );
});

test('un serveur ne voit que ses propres tables dans la vue service', async () => {
  const { owner, restaurantId, zone, terrace } = await buildRestaurant();
  const salle = await addStaff(owner, restaurantId, 'server');
  const terrasse = await addStaff(owner, restaurantId, 'server');
  await openShift(owner, restaurantId, salle.userId, { zoneIds: [zone.id] });
  await openShift(owner, restaurantId, terrasse.userId, { zoneIds: [terrace.id] });

  const inSalle = await owner.post(`/api/restaurants/${restaurantId}/reservations`, {
    startsAt: soon(30), partySize: 4, zoneId: zone.id,
  });
  assert.equal(inSalle.status, 201, JSON.stringify(inSalle.data));
  const onTerrace = await owner.post(`/api/restaurants/${restaurantId}/reservations`, {
    startsAt: soon(30), partySize: 4, zoneId: terrace.id,
  });
  assert.equal(onTerrace.status, 201);

  // Chaque reservation part au serveur qui couvre la zone.
  assert.equal(inSalle.data.assignment?.user_id, salle.userId);
  assert.equal(onTerrace.data.assignment?.user_id, terrasse.userId);

  const salleView = await salle.client.get(`/api/restaurants/${restaurantId}/service`);
  assert.equal(salleView.status, 200);
  assert.equal(salleView.data.reservations.length, 1);
  assert.equal(salleView.data.reservations[0].id, inSalle.data.reservation.id);

  // Le manager, lui, voit toute la salle.
  const ownerView = await owner.get(`/api/restaurants/${restaurantId}/service`);
  assert.equal(ownerView.data.reservations.length, 2);
});

test('l attribution automatique choisit le serveur le moins charge', async () => {
  const { owner, restaurantId, zone } = await buildRestaurant();
  const charge = await addStaff(owner, restaurantId, 'server');
  const libre = await addStaff(owner, restaurantId, 'server');
  await openShift(owner, restaurantId, charge.userId, { zoneIds: [zone.id] });
  await openShift(owner, restaurantId, libre.userId, { zoneIds: [zone.id] });

  // On charge volontairement le premier serveur.
  const first = await owner.post(`/api/restaurants/${restaurantId}/reservations`, {
    startsAt: soon(30), partySize: 4, zoneId: zone.id, serverUserId: charge.userId,
  });
  assert.equal(first.status, 201);

  const second = await owner.post(`/api/restaurants/${restaurantId}/reservations`, {
    startsAt: soon(45), partySize: 4, zoneId: zone.id,
  });
  assert.equal(second.status, 201);
  assert.equal(second.data.assignment.user_id, libre.userId);
  assert.equal(second.data.assignment.mode, 'auto');

  const load = await owner.get(`/api/restaurants/${restaurantId}/load`);
  assert.equal(load.status, 200);
  assert.equal(load.data.servers.length, 2);
  assert.ok(load.data.recommendation, 'le manager doit recevoir une recommandation');
});

test('le manager peut reprendre la main sur l attribution', async () => {
  const { owner, restaurantId, zone } = await buildRestaurant();
  const a = await addStaff(owner, restaurantId, 'server');
  const b = await addStaff(owner, restaurantId, 'server');
  await openShift(owner, restaurantId, a.userId, { zoneIds: [zone.id] });
  await openShift(owner, restaurantId, b.userId, { zoneIds: [zone.id] });

  const created = await owner.post(`/api/restaurants/${restaurantId}/reservations`, {
    startsAt: soon(30), partySize: 4, zoneId: zone.id,
  });
  const autoUser = created.data.assignment.user_id;
  const other = autoUser === a.userId ? b.userId : a.userId;

  const reassigned = await owner.post(
    `/api/reservations/${created.data.reservation.id}/assign-server`, { userId: other });
  assert.equal(reassigned.status, 200);
  assert.equal(reassigned.data.user_id, other);
  assert.equal(reassigned.data.mode, 'manual');

  // L'historique conserve les deux decisions : on doit pouvoir mesurer
  // a quelle frequence l'humain corrige la machine.
  const history = await admin((db) => db.query(
    `SELECT mode, is_current FROM server_assignments WHERE reservation_id = $1 ORDER BY created_at`,
    [created.data.reservation.id]));
  assert.equal(history.rows.length, 2);
  assert.equal(history.rows[0].is_current, false);
  assert.equal(history.rows[1].is_current, true);
});

test('un serveur ne peut pas attribuer une table a quelqu un d autre', async () => {
  const { owner, restaurantId, zone } = await buildRestaurant();
  const waiter = await addStaff(owner, restaurantId, 'server');
  await openShift(owner, restaurantId, waiter.userId, { zoneIds: [zone.id] });
  const created = await owner.post(`/api/restaurants/${restaurantId}/reservations`, {
    startsAt: soon(30), partySize: 4, zoneId: zone.id,
  });

  const attempt = await waiter.client.post(
    `/api/reservations/${created.data.reservation.id}/assign-server`, { userId: waiter.userId });
  assert.equal(attempt.status, 403);
});

test('un manager d un etablissement ne touche pas a celui d a cote', async () => {
  const a = await buildRestaurant();
  const b = await buildRestaurant();
  const manager = await addStaff(a.owner, a.restaurantId, 'manager');

  const ownScope = await manager.client.get(`/api/restaurants/${a.restaurantId}/floor`);
  assert.equal(ownScope.status, 200);

  // Etablissement d'un autre tenant : invisible, meme avec la permission.
  const foreign = await manager.client.get(`/api/restaurants/${b.restaurantId}/floor`);
  assert.equal(foreign.status, 403);
  assert.equal(foreign.data.error.code, 'forbidden');
});

test('la cuisine n a acces ni aux reservations ni au CRM', async () => {
  const { owner, restaurantId } = await buildRestaurant();
  const kitchen = await addStaff(owner, restaurantId, 'kitchen');

  assert.equal((await kitchen.client.get(`/api/restaurants/${restaurantId}/reservations`)).status, 403);
  assert.equal((await kitchen.client.get('/api/guests')).status, 403);
  assert.equal((await kitchen.client.get(`/api/restaurants/${restaurantId}/service`)).status, 200);
});

test('un role owner ne peut pas etre accorde depuis la gestion d equipe', async () => {
  const { owner, restaurantId } = await buildRestaurant();
  const attempt = await owner.post(`/api/restaurants/${restaurantId}/staff`, {
    email: `pirate-${unique()}@orsyne.test`, fullName: 'Pirate', role: 'owner',
  });
  assert.equal(attempt.status, 400);
});

test('anonymiser un client efface ses donnees sans casser l historique', async () => {
  const { owner, restaurantId, zone } = await buildRestaurant();
  const guest = await owner.post('/api/guests', {
    firstName: 'Effacer', lastName: 'Moi', email: `rgpd-${unique()}@example.test`,
  });
  const reservation = await owner.post(`/api/restaurants/${restaurantId}/reservations`, {
    startsAt: soon(30), partySize: 2, zoneId: zone.id, guestId: guest.data.id,
  });
  assert.equal(reservation.status, 201);

  const exported = await owner.get(`/api/guests/${guest.data.id}/export`);
  assert.equal(exported.status, 200);
  assert.equal(exported.data.reservations.length, 1);

  const deleted = await owner.delete(`/api/guests/${guest.data.id}`);
  assert.equal(deleted.status, 200);

  const after = await admin((db) => db.query(
    `SELECT first_name, email, phone_e164, anonymized_at FROM guests WHERE id = $1`,
    [guest.data.id]));
  assert.equal(after.rows[0].email, null);
  assert.equal(after.rows[0].first_name, 'Client');
  assert.ok(after.rows[0].anonymized_at);

  // La reservation survit : le restaurant garde son historique de service.
  const stillThere = await admin((db) => db.query(
    `SELECT id FROM reservations WHERE id = $1`, [reservation.data.reservation.id]));
  assert.equal(stillThere.rows.length, 1);

  const audit = await admin((db) => db.query(
    `SELECT action FROM audit_logs WHERE entity_id = $1`, [guest.data.id]));
  assert.equal(audit.rows[0].action, 'guest.anonymized');
});
