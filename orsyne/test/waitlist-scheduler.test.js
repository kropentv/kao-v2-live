import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { ensureSchema, closePool, admin } from './helpers/db.js';
import { startTestServer } from './helpers/api.js';
import { buildRestaurant, collectingMessenger, soon, unique } from './helpers/restaurant.js';
import { overrideIntegration, resetIntegrations } from '../src/integrations/index.js';
import { Scheduler } from '../src/services/scheduler.js';

let server;
let email;
before(async () => { await ensureSchema(); server = await startTestServer(); });
after(async () => { resetIntegrations(); await server.close(); await closePool(); });
beforeEach(() => {
  resetIntegrations();
  email = collectingMessenger('email');
  overrideIntegration('messenger:email', email.instance);
  overrideIntegration('messenger:sms', collectingMessenger('sms').instance);
});

/* ---------------- Liste d'attente ---------------- */

test('complet, puis une annulation : la table est proposee au premier en attente', async () => {
  // Une seule table : le restaurant est complet des la premiere reservation.
  const fx = await buildRestaurant(server, { prefix: 'wl', tables: [['T1', 4]] });
  const startsAt = soon(60);

  const first = await server.client().post(`/api/public/${fx.slug}/reservations`, {
    startsAt, partySize: 4, guest: { firstName: 'Premier', email: `p-${unique()}@example.test` },
  });
  assert.equal(first.status, 201);

  const refused = await server.client().post(`/api/public/${fx.slug}/reservations`, {
    startsAt, partySize: 4, guest: { firstName: 'Second', email: `s-${unique()}@example.test` },
  });
  assert.equal(refused.status, 409, 'complet');

  const waitAddress = `attente-${unique()}@example.test`;
  const joined = await server.client().post(`/api/public/${fx.slug}/waitlist`, {
    partySize: 4,
    desiredFrom: new Date(Date.parse(startsAt) - 30 * 60_000).toISOString(),
    desiredTo: new Date(Date.parse(startsAt) + 3 * 3_600_000).toISOString(),
    allergies: ['Soja'],
    guest: { firstName: 'Attente', email: waitAddress },
  });
  assert.equal(joined.status, 201, JSON.stringify(joined.data));

  const before = email.sent.length;
  const cancel = await server.client().post(
    `/api/public/${fx.slug}/reservations/${first.data.reference}/cancel`);
  assert.equal(cancel.status, 200);

  // La proposition est partie a la personne en attente…
  const offer = email.sent.slice(before).find((m) => m.to === waitAddress);
  assert.ok(offer, 'le client en attente doit etre prevenu');
  assert.match(offer.subject, /libérée/);

  // …et la table lui est tenue, en attente de sa reponse.
  const entry = (await admin((db) => db.query(
    `SELECT status, offered_reservation_id FROM waitlist_entries WHERE id = $1`, [joined.data.id]))).rows[0];
  assert.equal(entry.status, 'offered');
  const held = (await admin((db) => db.query(
    `SELECT status FROM reservations WHERE id = $1`, [entry.offered_reservation_id]))).rows[0];
  assert.equal(held.status, 'pending_approval');

  // Pendant ce temps, personne d'autre ne peut prendre la table.
  const intruder = await server.client().post(`/api/public/${fx.slug}/reservations`, {
    startsAt, partySize: 4, guest: { firstName: 'Intrus', email: `i-${unique()}@example.test` },
  });
  assert.equal(intruder.status, 409);

  // Le client accepte : la reservation est confirmee.
  const accepted = await server.client().post(
    `/api/public/${fx.slug}/waitlist/${joined.data.id}/accept`);
  assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
  const confirmed = (await admin((db) => db.query(
    `SELECT status FROM reservations WHERE id = $1`, [entry.offered_reservation_id]))).rows[0];
  assert.equal(confirmed.status, 'confirmed');

  // L'allergie declaree en s'inscrivant a suivi.
  const allergy = (await admin((db) => db.query(
    `SELECT p.value FROM guest_preferences p JOIN guests g ON g.id = p.guest_id
      WHERE g.email = $1 AND p.is_critical`, [waitAddress]))).rows;
  assert.deepEqual(allergy.map((r) => r.value), ['Soja']);
});

test('refuser une proposition rend la table immediatement', async () => {
  const fx = await buildRestaurant(server, { prefix: 'wld', tables: [['T1', 2]] });
  const startsAt = soon(60);
  const first = await server.client().post(`/api/public/${fx.slug}/reservations`, {
    startsAt, partySize: 2, guest: { firstName: 'A', email: `a-${unique()}@example.test` },
  });
  const joined = await server.client().post(`/api/public/${fx.slug}/waitlist`, {
    partySize: 2,
    desiredFrom: new Date(Date.parse(startsAt) - 3_600_000).toISOString(),
    desiredTo: new Date(Date.parse(startsAt) + 3_600_000).toISOString(),
    guest: { firstName: 'B', email: `b-${unique()}@example.test` },
  });
  await server.client().post(`/api/public/${fx.slug}/reservations/${first.data.reference}/cancel`);

  const declined = await server.client().post(`/api/public/${fx.slug}/waitlist/${joined.data.id}/decline`);
  assert.equal(declined.status, 200);

  const again = await server.client().post(`/api/public/${fx.slug}/reservations`, {
    startsAt, partySize: 2, guest: { firstName: 'C', email: `c-${unique()}@example.test` },
  });
  assert.equal(again.status, 201, 'la table doit etre de nouveau libre');
});

test('l equipe voit la liste et les candidats compatibles', async () => {
  const fx = await buildRestaurant(server, { prefix: 'wls', tables: [['T1', 4], ['T2', 2]] });
  const startsAt = soon(90);
  await fx.owner.post(`/api/restaurants/${fx.restaurantId}/waitlist`, {
    partySize: 4,
    desiredFrom: new Date(Date.parse(startsAt) - 3_600_000).toISOString(),
    desiredTo: new Date(Date.parse(startsAt) + 3_600_000).toISOString(),
    guest: { firstName: 'Quatre', phone: `+3369${Date.now() % 10_000_000}` },
  });
  await fx.owner.post(`/api/restaurants/${fx.restaurantId}/waitlist`, {
    partySize: 9, // aucune table ne peut l'accueillir
    desiredFrom: new Date(Date.parse(startsAt) - 3_600_000).toISOString(),
    desiredTo: new Date(Date.parse(startsAt) + 3_600_000).toISOString(),
    guest: { firstName: 'Neuf', phone: `+3360${Date.now() % 10_000_000}` },
  });

  const list = await fx.owner.get(`/api/restaurants/${fx.restaurantId}/waitlist`);
  assert.equal(list.data.length, 2);

  const matches = await fx.owner.get(
    `/api/restaurants/${fx.restaurantId}/waitlist/matches?startsAt=${encodeURIComponent(startsAt)}`);
  assert.equal(matches.status, 200);
  assert.deepEqual(matches.data.map((m) => m.name), ['Quatre'],
    'seul un groupe que la salle peut accueillir est propose');
});

/* ---------------- Ordonnanceur ---------------- */

const quiet = () => new Scheduler({ log: () => {} });

test('un acompte jamais regle libere la table a l expiration', async () => {
  const fx = await buildRestaurant(server, { prefix: 'hold', tables: [['T1', 2]] });
  await fx.owner.post(`/api/restaurants/${fx.restaurantId}/deposit-policies`, {
    name: 'Acompte', mechanism: 'deposit', amountMode: 'fixed', amountCents: 1000,
  });
  const startsAt = soon(120);
  const held = await server.client().post(`/api/public/${fx.slug}/reservations`, {
    startsAt, partySize: 2, guest: { firstName: 'Oubli', email: `o-${unique()}@example.test` },
  });
  assert.equal(held.data.status, 'pending_payment');

  // Seize minutes plus tard, pour l'ordonnanceur.
  const outcome = await quiet().tick({ now: new Date(Date.now() + 16 * 60_000) });
  assert.ok(outcome.holds >= 1, JSON.stringify(outcome));

  const status = await server.client().get(`/api/public/${fx.slug}/reservations/${held.data.reference}`);
  assert.equal(status.data.status, 'cancelled');

  const retry = await server.client().post(`/api/public/${fx.slug}/reservations`, {
    startsAt, partySize: 2, guest: { firstName: 'Suivant', email: `s-${unique()}@example.test` },
  });
  assert.equal(retry.status, 201, 'la table doit etre de nouveau reservable');
});

test('le rappel de la veille part une fois, et une seule', async () => {
  const fx = await buildRestaurant(server, { prefix: 'rem' });
  const address = `rappel-${unique()}@example.test`;
  const booking = await server.client().post(`/api/public/${fx.slug}/reservations`, {
    startsAt: soon(10 * 60), partySize: 2, guest: { firstName: 'Rappel', email: address },
  });
  assert.equal(booking.status, 201);

  const scheduler = quiet();
  await scheduler.tick();
  await scheduler.tick();

  const reminders = email.sent.filter((m) => m.to === address && /Demain/.test(m.subject));
  assert.equal(reminders.length, 1, 'exactement un rappel');
  const flag = await admin((db) => db.query(
    `SELECT reminder_sent_at FROM reservations WHERE reference = $1`, [booking.data.reference]));
  assert.ok(flag.rows[0].reminder_sent_at);
});

test('un client jamais arrive bascule en no-show et libere sa table', async () => {
  const fx = await buildRestaurant(server, { prefix: 'ns', tables: [['T1', 2]] });
  // Reservation passee, saisie par l'equipe (hors regles publiques).
  const past = new Date(Date.now() - 50 * 60_000).toISOString();
  const created = await fx.owner.post(`/api/restaurants/${fx.restaurantId}/reservations`, {
    startsAt: past, partySize: 2, source: 'staff', notifyGuest: false,
    guest: { firstName: 'Absent', phone: `+3361${Date.now() % 10_000_000}` },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));

  const outcome = await quiet().tick();
  assert.ok(outcome.noShows >= 1, JSON.stringify(outcome));

  const row = (await admin((db) => db.query(
    `SELECT status FROM reservations WHERE id = $1`, [created.data.reservation.id]))).rows[0];
  assert.equal(row.status, 'no_show');
  const active = (await admin((db) => db.query(
    `SELECT count(*)::int AS n FROM table_occupancies WHERE reservation_id = $1 AND is_active`,
    [created.data.reservation.id]))).rows[0];
  assert.equal(active.n, 0);
});

test('un client en retard de dix minutes reste un client attendu', async () => {
  const fx = await buildRestaurant(server, { prefix: 'late', tables: [['T1', 2]] });
  const created = await fx.owner.post(`/api/restaurants/${fx.restaurantId}/reservations`, {
    startsAt: new Date(Date.now() - 10 * 60_000).toISOString(), partySize: 2,
    source: 'staff', notifyGuest: false,
  });
  await quiet().tick();
  const row = (await admin((db) => db.query(
    `SELECT status FROM reservations WHERE id = $1`, [created.data.reservation.id]))).rows[0];
  assert.equal(row.status, 'confirmed');
});

test('deux ordonnanceurs en parallele ne font pas le travail deux fois', async () => {
  const fx = await buildRestaurant(server, { prefix: 'dup' });
  const address = `double-${unique()}@example.test`;
  await server.client().post(`/api/public/${fx.slug}/reservations`, {
    startsAt: soon(11 * 60), partySize: 2, guest: { firstName: 'Double', email: address },
  });
  await Promise.all([quiet().tick(), quiet().tick(), quiet().tick()]);
  const reminders = email.sent.filter((m) => m.to === address && /Demain/.test(m.subject));
  assert.equal(reminders.length, 1);
});

test('chaque passage est journalise', async () => {
  await quiet().tick();
  const runs = await admin((db) => db.query(
    `SELECT job, outcome FROM job_runs ORDER BY id DESC LIMIT 1`));
  assert.equal(runs.rows[0].job, 'scheduler.tick');
  assert.ok('reminders' in runs.rows[0].outcome);
});
