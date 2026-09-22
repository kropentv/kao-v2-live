import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

import { ensureSchema, closePool, admin } from './helpers/db.js';
import { startTestServer } from './helpers/api.js';

let server;
const unique = () => Math.random().toString(36).slice(2, 10);

before(async () => { await ensureSchema(); server = await startTestServer(); });
after(async () => { await server.close(); await closePool(); });

/** Cree un compte complet et renvoie un client authentifie. */
async function signUp(overrides = {}) {
  const slug = `resto-${unique()}`;
  const client = server.client();
  const payload = {
    tenantName: 'Groupe Test', slug,
    restaurantName: 'Le Test', email: `owner-${unique()}@orsyne.test`,
    password: 'motdepasse-solide-2026', fullName: 'Camille Durand',
    ...overrides,
  };
  const response = await client.post('/api/auth/register', payload);
  assert.equal(response.status, 201, JSON.stringify(response.data));
  return { client, slug, ...response.data, password: payload.password, email: payload.email };
}

/** Salle minimale : une zone, trois tables, un service tous les soirs. */
async function setupFloor(client, restaurantId) {
  const zone = await client.post(`/api/restaurants/${restaurantId}/zones`, {
    name: 'Salle', kind: 'dining_room', guestSelectable: true,
  });
  assert.equal(zone.status, 201);
  const tables = [];
  for (const [code, seats] of [['T1', 2], ['T2', 4], ['T3', 6]]) {
    const created = await client.post(`/api/restaurants/${restaurantId}/tables`, {
      code, seatsMax: seats, zoneId: zone.data.id, guestSelectable: true,
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    tables.push(created.data);
  }
  const service = await client.post(`/api/restaurants/${restaurantId}/services`, {
    name: 'Dîner', daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
    startsAt: '18:00', endsAt: '23:00', defaultDurationMinutes: 90,
  });
  assert.equal(service.status, 201, JSON.stringify(service.data));
  return { zone: zone.data, tables, service: service.data };
}

/** Prochain jour a 20h00 heure de Paris, en ISO. */
function nextEveningIso(daysFromNow = 7, hour = 20) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + daysFromNow);
  const iso = date.toISOString().slice(0, 10);
  // 20h Paris = 18h ou 19h UTC selon la saison ; on laisse la couche
  // metier trancher en envoyant l'heure locale convertie.
  const offsetHours = new Date(`${iso}T12:00:00Z`)
    .toLocaleString('en-US', { timeZone: 'Europe/Paris', hour12: false, hour: '2-digit' });
  const shift = Number(offsetHours) - 12;
  return { iso, startsAt: new Date(`${iso}T${String(hour - shift).padStart(2, '0')}:00:00Z`).toISOString() };
}

test('inscription, session et identite', async () => {
  const account = await signUp();
  const me = await account.client.get('/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.data.user.email, account.email);
  assert.ok(me.data.permissions.includes('reservations:*'));
  assert.equal(me.data.restaurants.length, 1);
  assert.equal(me.data.memberships[0].role, 'owner');
});

test('une requete sans session est refusee', async () => {
  const anonymous = server.client();
  const response = await anonymous.get('/api/me');
  assert.equal(response.status, 401);
  assert.equal(response.data.error.code, 'unauthorized');
});

test('connexion, mauvais mot de passe et deconnexion', async () => {
  const account = await signUp();

  const wrong = await server.client().post('/api/auth/login', {
    email: account.email, password: 'mauvais-mot-de-passe',
  });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.data.error.code, 'invalid_credentials');

  const fresh = server.client();
  const ok = await fresh.post('/api/auth/login', {
    email: account.email, password: account.password,
  });
  assert.equal(ok.status, 200);
  assert.equal((await fresh.get('/api/me')).status, 200);

  await fresh.post('/api/auth/logout');
  // Le cookie efface est conserve par le client : la session est bien
  // revoquee cote serveur, pas seulement oubliee cote navigateur.
  assert.equal((await fresh.get('/api/me')).status, 401);
});

test('un mot de passe trop court est refuse', async () => {
  const response = await server.client().post('/api/auth/register', {
    tenantName: 'X', slug: `court-${unique()}`, restaurantName: 'X',
    email: `x-${unique()}@orsyne.test`, password: 'court', fullName: 'X',
  });
  assert.equal(response.status, 400);
  assert.equal(response.data.error.code, 'weak_password');
});

test('plan de salle : creation, deplacement, desactivation', async () => {
  const account = await signUp();
  const { restaurant, client } = { ...account, client: account.client };
  const floor = await setupFloor(client, restaurant.id);

  const moved = await client.patch(
    `/api/restaurants/${restaurant.id}/tables/${floor.tables[0].id}`,
    { posX: 12.5, posY: 7.25, seatsMax: 3 },
  );
  assert.equal(moved.status, 200);
  assert.equal(Number(moved.data.pos_x), 12.5);
  assert.equal(moved.data.seats_max, 3);

  const view = await client.get(`/api/restaurants/${restaurant.id}/floor`);
  assert.equal(view.data.tables.length, 3);
  assert.equal(view.data.zones.length, 1);

  await client.delete(`/api/restaurants/${restaurant.id}/tables/${floor.tables[2].id}`);
  const after = await client.get(`/api/restaurants/${restaurant.id}/floor`);
  assert.equal(after.data.tables.filter((t) => t.is_active).length, 2);
});

test('cycle complet : disponibilite, reservation, installation, fin de service', async () => {
  const account = await signUp();
  const { client } = account;
  const restaurantId = account.restaurant.id;
  await setupFloor(client, restaurantId);
  const { iso, startsAt } = nextEveningIso();

  const availability = await client.get(
    `/api/restaurants/${restaurantId}/availability?date=${iso}&partySize=4`);
  assert.equal(availability.status, 200);
  assert.ok(availability.data.slots.some((s) => s.available), 'des creneaux doivent etre libres');

  const created = await client.post(`/api/restaurants/${restaurantId}/reservations`, {
    startsAt, partySize: 4,
    guest: { firstName: 'Thomas', lastName: 'Martin', phone: `+3361${Date.now() % 10_000_000}` },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.reservation.status, 'confirmed');
  assert.equal(created.data.tableIds.length, 1);
  const reservationId = created.data.reservation.id;

  const seated = await client.post(`/api/reservations/${reservationId}/seat`);
  assert.equal(seated.status, 200);

  // La vue service est bornee a une journee d'exploitation : on demande
  // celle de la reservation, pas celle d'aujourd'hui.
  const service = await client.get(`/api/restaurants/${restaurantId}/service?date=${iso}`);
  assert.equal(service.status, 200);
  assert.equal(service.data.stats.seatedCovers, 4);
  assert.equal(service.data.reservations.length, 1);

  const today = await client.get(`/api/restaurants/${restaurantId}/service`);
  assert.equal(today.data.reservations.length, 0, "le service du jour ne doit pas melanger les dates");

  const completed = await client.post(`/api/reservations/${reservationId}/complete`);
  assert.equal(completed.status, 200);
});

test('une table deja prise renvoie 409, pas 500', async () => {
  const account = await signUp();
  const { client } = account;
  const restaurantId = account.restaurant.id;
  const floor = await setupFloor(client, restaurantId);
  const { startsAt } = nextEveningIso();

  const first = await client.post(`/api/restaurants/${restaurantId}/reservations`, {
    startsAt, partySize: 2, tableId: floor.tables[0].id,
  });
  assert.equal(first.status, 201);

  const second = await client.post(`/api/restaurants/${restaurantId}/reservations`, {
    startsAt, partySize: 2, tableId: floor.tables[0].id,
  });
  assert.equal(second.status, 409);
  assert.equal(second.data.error.code, 'table_unavailable');
});

test('widget public : consultation, reservation et annulation par reference', async () => {
  const account = await signUp();
  await setupFloor(account.client, account.restaurant.id);
  const { iso, startsAt } = nextEveningIso();
  const visitor = server.client();

  const info = await visitor.get(`/api/public/${account.slug}`);
  assert.equal(info.status, 200);
  assert.equal(info.data.restaurant.name, 'Le Test');
  assert.equal(info.data.zones.length, 1, 'seules les zones visibles client sortent');
  assert.equal(info.data.maxPartySize, 6);

  const slots = await visitor.get(`/api/public/${account.slug}/availability?date=${iso}&partySize=2`);
  assert.equal(slots.status, 200);
  assert.ok(slots.data.slots.some((s) => s.available));

  const booking = await visitor.post(`/api/public/${account.slug}/reservations`, {
    startsAt, partySize: 2,
    guest: { firstName: 'Alice', lastName: 'Dubois', email: `alice-${unique()}@example.test` },
    notes: 'Table calme si possible',
  });
  assert.equal(booking.status, 201, JSON.stringify(booking.data));
  assert.match(booking.data.reference, /^[2-9A-HJ-NP-Z]{3}-[2-9A-HJ-NP-Z]{3}$/);
  assert.equal(booking.data.status, 'confirmed');
  // La table attribuee ne doit pas fuiter vers le client.
  assert.equal(booking.data.tableIds, undefined);

  const lookup = await visitor.get(
    `/api/public/${account.slug}/reservations/${booking.data.reference}`);
  assert.equal(lookup.status, 200);
  assert.equal(lookup.data.party_size, 2);

  const cancelled = await visitor.post(
    `/api/public/${account.slug}/reservations/${booking.data.reference}/cancel`);
  assert.equal(cancelled.status, 200);

  const after = await visitor.get(
    `/api/public/${account.slug}/reservations/${booking.data.reference}`);
  assert.equal(after.data.status, 'cancelled');
});

test('widget public : acompte exige, table maintenue puis confirmee', async () => {
  const account = await signUp();
  const { client } = account;
  const restaurantId = account.restaurant.id;
  await setupFloor(client, restaurantId);
  const { startsAt } = nextEveningIso();

  const policy = await client.post(`/api/restaurants/${restaurantId}/deposit-policies`, {
    name: 'Acompte standard', mechanism: 'deposit', amountMode: 'per_person', amountCents: 1500,
  });
  assert.equal(policy.status, 201);

  const visitor = server.client();
  const booking = await visitor.post(`/api/public/${account.slug}/reservations`, {
    startsAt, partySize: 4,
    guest: { firstName: 'Sofia', email: `sofia-${unique()}@example.test` },
  });
  assert.equal(booking.status, 201);
  assert.equal(booking.data.status, 'pending_payment');
  assert.equal(booking.data.deposit.amountCents, 6000);
  assert.equal(booking.data.deposit.mechanism, 'deposit');

  const paid = await visitor.post(
    `/api/public/${account.slug}/reservations/${booking.data.reference}/confirm-payment`,
    { provider: 'stripe', providerRef: `pi_${unique()}` });
  assert.equal(paid.status, 200);
  assert.equal(paid.data.status, 'confirmed');

  // Le paiement est trace avec son mecanisme, jamais confondu avec un autre.
  const payments = await admin((db) => db.query(
    `SELECT mechanism, status, amount_cents, captured_amount_cents FROM payment_intents
      WHERE restaurant_id = $1`, [restaurantId]));
  assert.equal(payments.rows.length, 1);
  assert.equal(payments.rows[0].mechanism, 'deposit');
  assert.equal(payments.rows[0].status, 'captured');
  assert.equal(payments.rows[0].captured_amount_cents, 6000);
});

test('une preautorisation est autorisee, pas encaissee', async () => {
  const account = await signUp();
  const { client } = account;
  const restaurantId = account.restaurant.id;
  await setupFloor(client, restaurantId);
  const { startsAt } = nextEveningIso();

  await client.post(`/api/restaurants/${restaurantId}/deposit-policies`, {
    name: 'Empreinte week-end', mechanism: 'preauthorization',
    amountMode: 'per_person', amountCents: 2000,
  });

  const visitor = server.client();
  const booking = await visitor.post(`/api/public/${account.slug}/reservations`, {
    startsAt, partySize: 2,
    guest: { firstName: 'James', email: `james-${unique()}@example.test` },
  });
  await visitor.post(
    `/api/public/${account.slug}/reservations/${booking.data.reference}/confirm-payment`, {});

  const payments = await admin((db) => db.query(
    `SELECT mechanism, status, captured_amount_cents FROM payment_intents WHERE restaurant_id = $1`,
    [restaurantId]));
  assert.equal(payments.rows[0].mechanism, 'preauthorization');
  assert.equal(payments.rows[0].status, 'authorized');
  assert.equal(payments.rows[0].captured_amount_cents, 0, "une empreinte n'encaisse rien");
});

test('un slug inconnu ne revele rien', async () => {
  const response = await server.client().get('/api/public/restaurant-inexistant-xyz');
  assert.equal(response.status, 404);
});

test('les routes inconnues et les mauvaises methodes sont distinguees', async () => {
  const account = await signUp();
  assert.equal((await account.client.get('/api/inexistant')).status, 404);
  assert.equal((await account.client.delete('/api/me')).status, 405);
});

test('le health check repond sans authentification', async () => {
  const response = await server.client().get('/health');
  assert.equal(response.status, 200);
  assert.equal(response.data.status, 'ok');
});
