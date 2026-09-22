import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

import { ensureSchema, closePool, admin } from './helpers/db.js';
import { startTestServer } from './helpers/api.js';

let server;
const unique = () => Math.random().toString(36).slice(2, 10);

before(async () => { await ensureSchema(); server = await startTestServer(); });
after(async () => { await server.close(); await closePool(); });

test('les interfaces sont servies', async () => {
  for (const [path, needle] of [
    ['/', 'Réserver'],
    ['/assets/orsyne.css', '--accent'],
    ['/assets/orsyne.js', 'connectStream'],
    ['/app/', 'Connexion'],
    ['/app/salle.html', 'Mon service'],
    ['/app/salle.webmanifest', 'standalone'],
    // Routes cote client : un lien partage doit toujours ouvrir la page.
    ['/r/nimporte-quel-restaurant', 'Réserver'],
    ['/app/vue/qui-nexiste-pas', 'Connexion'],
  ]) {
    const response = await fetch(`${server.url}${path}`);
    assert.equal(response.status, 200, `${path} doit repondre 200`);
    const body = await response.text();
    assert.ok(body.includes(needle), `${path} doit contenir « ${needle} »`);
  }
});

test('un fichier absent renvoie 404 sans abattre le serveur', async () => {
  const missing = await fetch(`${server.url}/assets/inexistant.css`);
  assert.equal(missing.status, 404);
  await missing.text();
  // Le serveur doit encore repondre juste apres : une requete invalide
  // ne doit jamais emporter le processus.
  const health = await fetch(`${server.url}/health`);
  assert.equal(health.status, 200);
  await health.text();
});

test('la traversee de chemin est bloquee', async () => {
  for (const attempt of [
    '/../package.json',
    '/assets/../../package.json',
    '/%2e%2e/%2e%2e/package.json',
  ]) {
    const response = await fetch(`${server.url}${attempt}`);
    const body = await response.text();
    assert.ok(
      !body.includes('"name": "orsyne"'),
      `${attempt} ne doit jamais servir un fichier hors de public/`,
    );
  }
});

test("scenario complet d'un service, du widget a l'assiette", async () => {
  // ---- 1. Le restaurateur s'inscrit et monte sa salle -----------------
  const owner = server.client();
  const slug = `bistrot-${unique()}`;
  const account = (await owner.post('/api/auth/register', {
    tenantName: 'Bistrot du Coin', slug,
    restaurantName: 'Bistrot du Coin',
    email: `patron-${unique()}@orsyne.test`,
    password: 'motdepasse-solide-2026',
    fullName: 'Camille Patron',
  })).data;
  const restaurantId = account.restaurant.id;

  const salle = (await owner.post(`/api/restaurants/${restaurantId}/zones`, {
    name: 'Salle', kind: 'dining_room', guestSelectable: true,
  })).data;
  const terrasse = (await owner.post(`/api/restaurants/${restaurantId}/zones`, {
    name: 'Terrasse', kind: 'terrace', guestSelectable: true,
  })).data;

  for (const [code, seats, zoneId] of [
    ['T1', 2, salle.id], ['T2', 4, salle.id], ['T3', 6, salle.id],
    ['TE1', 4, terrasse.id],
  ]) {
    const created = await owner.post(`/api/restaurants/${restaurantId}/tables`, {
      code, seatsMax: seats, zoneId, guestSelectable: true,
    });
    assert.equal(created.status, 201);
  }

  await owner.post(`/api/restaurants/${restaurantId}/services`, {
    name: 'Service', daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
    startsAt: '00:00', endsAt: '23:59',
    lastSeatingOffsetMinutes: 0, defaultDurationMinutes: 90, turnBufferMinutes: 15,
  });

  // ---- 2. Il embauche un serveur et le met en service ------------------
  const waiterEmail = `lucas-${unique()}@orsyne.test`;
  const waiterStaff = (await owner.post(`/api/restaurants/${restaurantId}/staff`, {
    email: waiterEmail, fullName: 'Lucas Serveur', role: 'server',
    password: 'motdepasse-solide-2026',
  })).data;

  await owner.post(`/api/restaurants/${restaurantId}/shifts`, {
    userId: waiterStaff.id,
    startsAt: new Date(Date.now() - 3_600_000).toISOString(),
    endsAt: new Date(Date.now() + 8 * 3_600_000).toISOString(),
    zoneIds: [salle.id, terrasse.id],
    status: 'clocked_in',
  });

  const waiter = server.client();
  await waiter.post('/api/auth/login', { email: waiterEmail, password: 'motdepasse-solide-2026' });

  // ---- 3. Un client reserve depuis le widget public --------------------
  const visitor = server.client();
  const venue = await visitor.get(`/api/public/${slug}`);
  assert.equal(venue.status, 200);
  assert.equal(venue.data.zones.length, 2);

  const startsAt = new Date(Date.now() + 45 * 60_000).toISOString();
  const booking = await visitor.post(`/api/public/${slug}/reservations`, {
    startsAt, partySize: 4, zoneId: terrasse.id,
    occasion: 'Anniversaire',
    notes: 'Allergie aux arachides',
    guest: {
      firstName: 'Thomas', lastName: 'Martin',
      phone: `+33600${String(Date.now()).slice(-6)}`,
      email: `thomas-${unique()}@example.test`,
      marketingConsent: true,
    },
  });
  assert.equal(booking.status, 201, JSON.stringify(booking.data));
  const reference = booking.data.reference;

  // La zone demandee a bien ete honoree.
  const seatedOnTerrace = await admin((db) => db.query(
    `SELECT t.code FROM reservations r
       JOIN table_occupancies o ON o.reservation_id = r.id AND o.is_active
       JOIN restaurant_tables t ON t.id = o.table_id
      WHERE r.reference = $1`, [reference]));
  assert.equal(seatedOnTerrace.rows[0].code, 'TE1');

  // Le consentement marketing est trace, il ne se devine pas.
  const consent = await admin((db) => db.query(
    `SELECT granted FROM guest_consents WHERE purpose = 'marketing'
      AND guest_id = (SELECT guest_id FROM reservations WHERE reference = $1)`, [reference]));
  assert.equal(consent.rows[0].granted, true);

  // ---- 4. La reservation est attribuee et notifiee au serveur ----------
  const inbox = await waiter.get('/api/notifications?unread=true');
  assert.equal(inbox.status, 200);
  const assigned = inbox.data.find((n) => n.kind === 'table_assigned');
  assert.ok(assigned, 'le serveur doit etre prevenu de sa nouvelle table');
  assert.match(assigned.title, /TE1/);

  // ---- 5. Le client enrichit son profil : allergie declaree ------------
  const reservationId = (await admin((db) => db.query(
    `SELECT id, guest_id FROM reservations WHERE reference = $1`, [reference]))).rows[0];
  await owner.post(`/api/guests/${reservationId.guest_id}/preferences`, {
    kind: 'allergy', value: 'Arachides', isCritical: true,
  });

  // ---- 6. Le serveur voit sa table, et seulement la sienne -------------
  const waiterService = await waiter.get(`/api/restaurants/${restaurantId}/service`);
  assert.equal(waiterService.status, 200);
  assert.equal(waiterService.data.reservations.length, 1);
  assert.equal(waiterService.data.reservations[0].reference, reference);
  assert.equal(waiterService.data.reservations[0].has_critical_preference, true);

  // ---- 7. La fiche client lui donne l'essentiel, pas le CRM ------------
  const brief = await waiter.get(
    `/api/guests/${reservationId.guest_id}/brief?restaurantId=${restaurantId}`);
  assert.equal(brief.status, 200);
  assert.ok(brief.data.hasCritical);
  assert.match(brief.data.lines[0].text, /Arachides/);
  assert.equal((await waiter.get(`/api/guests/${reservationId.guest_id}`)).status, 403);

  // ---- 8. Arrivee, service, depart -------------------------------------
  assert.equal((await waiter.post(`/api/reservations/${reservationId.id}/seat`)).status, 200);
  await server.drainOutbox();

  const duringService = await owner.get(`/api/restaurants/${restaurantId}/service`);
  assert.equal(duringService.data.stats.seatedCovers, 4);
  assert.equal(duringService.data.stats.tablesOccupied, 1);

  assert.equal((await waiter.post(`/api/reservations/${reservationId.id}/complete`)).status, 200);

  // ---- 9. Le CRM s'est enrichi tout seul --------------------------------
  const stats = await admin((db) => db.query(
    `SELECT visits, covers FROM guest_restaurant_stats WHERE guest_id = $1`,
    [reservationId.guest_id]));
  assert.equal(stats.rows[0].visits, 1);
  assert.equal(stats.rows[0].covers, 4);

  // ---- 10. La table est repartie au service -----------------------------
  const afterService = await owner.get(`/api/restaurants/${restaurantId}/service`);
  const table = afterService.data.tables.find((t) => t.code === 'TE1');
  assert.equal(table.live_status, 'cleaning');
  assert.equal(table.current_reservation_id, null);

  // ---- 11. Analytics : les chiffres sont calcules, pas inventes ---------
  const analytics = await owner.get(`/api/restaurants/${restaurantId}/analytics`
    + `?from=${new Date(Date.now() - 86_400_000).toISOString()}`
    + `&to=${new Date(Date.now() + 86_400_000).toISOString()}`);
  assert.equal(analytics.status, 200);
  assert.equal(analytics.data.totals.reservations, 1);
  assert.equal(analytics.data.totals.covers, 4);
  assert.equal(analytics.data.totals.completed, 1);
  assert.equal(analytics.data.bySource[0].source, 'widget');
  assert.equal(analytics.data.guests.new_guests, 1);
});

test('le widget refuse une taille de groupe impossible', async () => {
  const owner = server.client();
  const slug = `petit-${unique()}`;
  const account = (await owner.post('/api/auth/register', {
    tenantName: 'Petit', slug, restaurantName: 'Petit',
    email: `p-${unique()}@orsyne.test`, password: 'motdepasse-solide-2026', fullName: 'P',
  })).data;
  await owner.post(`/api/restaurants/${account.restaurant.id}/tables`, { code: 'T1', seatsMax: 2 });
  await owner.post(`/api/restaurants/${account.restaurant.id}/services`, {
    name: 'S', daysOfWeek: [0, 1, 2, 3, 4, 5, 6], startsAt: '00:00', endsAt: '23:59',
    lastSeatingOffsetMinutes: 0,
  });

  const visitor = server.client();
  const response = await visitor.post(`/api/public/${slug}/reservations`, {
    startsAt: new Date(Date.now() + 45 * 60_000).toISOString(),
    partySize: 20,
    guest: { firstName: 'Groupe', email: `g-${unique()}@example.test` },
  });
  assert.equal(response.status, 409);
  assert.equal(response.data.error.code, 'no_availability');
});
