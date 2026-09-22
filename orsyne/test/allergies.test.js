import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

import { ensureSchema, closePool, admin } from './helpers/db.js';
import { startTestServer } from './helpers/api.js';
import { normalizeAllergies, EU_ALLERGENS } from '../src/services/guest-profile.js';

let server;
const unique = () => Math.random().toString(36).slice(2, 10);

before(async () => { await ensureSchema(); server = await startTestServer(); });
after(async () => { await server.close(); await closePool(); });

async function buildRestaurant() {
  const owner = server.client();
  const slug = `allerg-${unique()}`;
  const account = (await owner.post('/api/auth/register', {
    tenantName: 'Groupe Allergie', slug, restaurantName: 'La Table Sûre',
    email: `owner-${unique()}@orsyne.test`, password: 'motdepasse-solide-2026',
    fullName: 'Chef Test',
  })).data;
  const restaurantId = account.restaurant.id;
  const zone = (await owner.post(`/api/restaurants/${restaurantId}/zones`, { name: 'Salle' })).data;
  for (const [code, seats] of [['T1', 4], ['T2', 4], ['T3', 6]]) {
    await owner.post(`/api/restaurants/${restaurantId}/tables`, { code, seatsMax: seats, zoneId: zone.id });
  }
  await owner.post(`/api/restaurants/${restaurantId}/services`, {
    name: 'Continu', daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
    startsAt: '00:00', endsAt: '23:59', lastSeatingOffsetMinutes: 0,
  });
  return { owner, slug, restaurantId, zone };
}

const soon = (minutes = 45) => new Date(Date.now() + minutes * 60_000).toISOString();

test('la normalisation nettoie, tronque et deduplique', () => {
  assert.deepEqual(normalizeAllergies(['  Gluten  ', 'gluten', 'GLUTEN']), ['Gluten']);
  // Accents ignores pour la comparaison : « Œufs » et « oeufs » sont distincts
  // en revanche, car on ne devine pas les equivalences typographiques.
  assert.deepEqual(normalizeAllergies(['Céleri', 'celeri']), ['Céleri']);
  assert.deepEqual(normalizeAllergies(['Fruits   à    coque']), ['Fruits à coque']);
  assert.deepEqual(normalizeAllergies(['', '   ', null, 42, {}]), []);
  assert.deepEqual(normalizeAllergies('pas un tableau'), []);
  assert.equal(normalizeAllergies(Array.from({ length: 50 }, (_, i) => `A${i}`)).length, 12);
  assert.equal(normalizeAllergies(['x'.repeat(500)])[0].length, 80);
});

test('les 14 allergenes reglementaires sont proposes par l API publique', async () => {
  const { slug } = await buildRestaurant();
  const venue = await server.client().get(`/api/public/${slug}`);
  assert.equal(venue.status, 200);
  assert.equal(venue.data.allergenSuggestions.length, 14);
  for (const expected of ['Gluten', 'Arachides', 'Fruits à coque', 'Crustacés', 'Mollusques']) {
    assert.ok(venue.data.allergenSuggestions.includes(expected), `${expected} doit etre propose`);
  }
  assert.deepEqual(venue.data.allergenSuggestions, EU_ALLERGENS);
});

test('une allergie declaree au widget devient une donnee structuree', async () => {
  const { owner, slug, restaurantId } = await buildRestaurant();
  const visitor = server.client();

  const booking = await visitor.post(`/api/public/${slug}/reservations`, {
    startsAt: soon(), partySize: 2,
    allergies: ['Arachides', 'Fruits à coque'],
    notes: 'Table calme si possible',
    guest: { firstName: 'Julie', lastName: 'Moreau', phone: `+3361${Date.now() % 10_000_000}` },
  });
  assert.equal(booking.status, 201, JSON.stringify(booking.data));

  // Elle est en base comme preference critique, pas comme note libre.
  const stored = await admin((db) => db.query(
    `SELECT p.value, p.is_critical, p.source, p.kind
       FROM guest_preferences p
       JOIN guests g ON g.id = p.guest_id
      WHERE g.first_name = 'Julie' AND g.tenant_id = (
        SELECT tenant_id FROM restaurants WHERE id = $1)
      ORDER BY p.value`, [restaurantId]));
  assert.equal(stored.rows.length, 2);
  for (const row of stored.rows) {
    assert.equal(row.kind, 'allergy');
    assert.equal(row.is_critical, true);
    assert.equal(row.source, 'guest_declared');
  }

  // La demande de confort reste bien une note, pas une alerte.
  const reservation = await admin((db) => db.query(
    `SELECT guest_notes FROM reservations WHERE reference = $1`, [booking.data.reference]));
  assert.equal(reservation.rows[0].guest_notes, 'Table calme si possible');

  // Et elle declenche l'alerte dans la vue service.
  const service = await owner.get(`/api/restaurants/${restaurantId}/service`);
  const line = service.data.reservations.find((r) => r.reference === booking.data.reference);
  assert.equal(line.has_critical_preference, true, "l'alerte doit se declencher");
  assert.deepEqual([...line.allergies].sort(), ['Arachides', 'Fruits à coque']);
  assert.equal(line.allergy_needs_confirmation, true, 'une declaration en ligne reste a confirmer');
});

test('l allergie est memorisee pour les visites suivantes', async () => {
  const { owner, slug, restaurantId } = await buildRestaurant();
  const phone = `+3362${Date.now() % 10_000_000}`;
  const visitor = server.client();

  await visitor.post(`/api/public/${slug}/reservations`, {
    startsAt: soon(45), partySize: 2, allergies: ['Gluten'],
    guest: { firstName: 'Paul', lastName: 'Durand', phone },
  });

  // Deuxieme visite : le client ne redeclare rien.
  const second = await visitor.post(`/api/public/${slug}/reservations`, {
    startsAt: soon(200), partySize: 2,
    guest: { firstName: 'Paul', lastName: 'Durand', phone },
  });
  assert.equal(second.status, 201);

  const service = await owner.get(`/api/restaurants/${restaurantId}/service`);
  const line = service.data.reservations.find((r) => r.reference === second.data.reference);
  assert.deepEqual(line.allergies, ['Gluten'], "l'allergie doit survivre a la premiere visite");
});

test('une saisie par l equipe prime sur une declaration en ligne', async () => {
  const { owner, slug, restaurantId } = await buildRestaurant();
  const phone = `+3363${Date.now() % 10_000_000}`;

  await server.client().post(`/api/public/${slug}/reservations`, {
    startsAt: soon(45), partySize: 2, allergies: ['Crustacés'],
    guest: { firstName: 'Nora', phone },
  });

  const guestId = (await admin((db) => db.query(
    `SELECT id FROM guests WHERE phone_e164 = $1`, [phone]))).rows[0].id;

  // Le serveur reconfirme de vive voix via la fiche client.
  const confirmed = await owner.post(`/api/guests/${guestId}/preferences`, {
    kind: 'allergy', value: 'Crustacés', isCritical: true, source: 'staff_entered',
  });
  assert.equal(confirmed.status, 201);

  const stored = await admin((db) => db.query(
    `SELECT source FROM guest_preferences WHERE guest_id = $1`, [guestId]));
  assert.equal(stored.rows[0].source, 'staff_entered');

  const service = await owner.get(`/api/restaurants/${restaurantId}/service`);
  const line = service.data.reservations.find((r) => r.guest_id === guestId);
  assert.equal(line.allergy_needs_confirmation, false,
    'une fois confirmee de vive voix, elle ne demande plus confirmation');
});

test('une allergie remonte toujours dans la note du serveur, avec sa provenance', async () => {
  const { owner, slug, restaurantId } = await buildRestaurant();
  const phone = `+3364${Date.now() % 10_000_000}`;

  await server.client().post(`/api/public/${slug}/reservations`, {
    startsAt: soon(45), partySize: 2,
    allergies: ['Arachides'],
    guest: { firstName: 'Léa', phone },
  });
  const guestId = (await admin((db) => db.query(
    `SELECT id FROM guests WHERE phone_e164 = $1`, [phone]))).rows[0].id;

  // On sature volontairement le profil de preferences non critiques :
  // l'allergie doit passer devant, quoi qu'il arrive.
  for (const value of ['Terrasse', 'Vin rouge', 'Sans bulles', 'Près de la fenêtre', 'Menu dégustation']) {
    await owner.post(`/api/guests/${guestId}/preferences`, { kind: 'dish', value });
  }

  const brief = await owner.get(`/api/guests/${guestId}/brief?restaurantId=${restaurantId}`);
  assert.equal(brief.status, 200);
  assert.equal(brief.data.hasCritical, true);
  assert.equal(brief.data.needsAllergyConfirmation, true);

  const first = brief.data.lines[0];
  assert.equal(first.kind, 'critical', "l'allergie doit occuper la premiere ligne");
  assert.match(first.text, /Arachides/);
  assert.equal(first.source, 'guest_declared');
  assert.equal(first.needsConfirmation, true);
});

test('une reservation prise par l equipe accepte aussi les allergies', async () => {
  const { owner, restaurantId } = await buildRestaurant();
  const created = await owner.post(`/api/restaurants/${restaurantId}/reservations`, {
    startsAt: soon(45), partySize: 2,
    allergies: ['Lait / lactose'],
    guest: { firstName: 'Marc', phone: `+3365${Date.now() % 10_000_000}` },
  });
  assert.equal(created.status, 201);

  const service = await owner.get(`/api/restaurants/${restaurantId}/service`);
  const line = service.data.reservations.find((r) => r.reference === created.data.reservation.reference);
  assert.deepEqual(line.allergies, ['Lait / lactose']);
  // Saisie par l'equipe : consideree comme confirmee de vive voix.
  assert.equal(line.allergy_needs_confirmation, false);
});

test('une reservation sans allergie ne declenche aucune alerte', async () => {
  const { owner, slug, restaurantId } = await buildRestaurant();
  const booking = await server.client().post(`/api/public/${slug}/reservations`, {
    startsAt: soon(45), partySize: 2,
    notes: 'Juste une table tranquille',
    guest: { firstName: 'Sans', lastName: 'Allergie', phone: `+3366${Date.now() % 10_000_000}` },
  });
  assert.equal(booking.status, 201);

  const service = await owner.get(`/api/restaurants/${restaurantId}/service`);
  const line = service.data.reservations.find((r) => r.reference === booking.data.reference);
  assert.equal(line.has_critical_preference, false);
  assert.deepEqual(line.allergies, []);
});

test('une saisie hostile ne casse rien et reste bornee', async () => {
  const { owner, slug, restaurantId } = await buildRestaurant();
  const booking = await server.client().post(`/api/public/${slug}/reservations`, {
    startsAt: soon(45), partySize: 2,
    allergies: ['<script>alert(1)</script>', 'x'.repeat(1000), ...Array.from({ length: 40 }, (_, i) => `A${i}`)],
    guest: { firstName: 'Test', phone: `+3367${Date.now() % 10_000_000}` },
  });
  assert.equal(booking.status, 201);

  const service = await owner.get(`/api/restaurants/${restaurantId}/service`);
  const line = service.data.reservations.find((r) => r.reference === booking.data.reference);
  assert.ok(line.allergies.length <= 12, 'le nombre d allergies est borne');
  for (const value of line.allergies) {
    assert.ok(value.length <= 80, 'chaque valeur est tronquee');
  }
  // La chaine est stockee telle quelle : c'est l'affichage qui echappe,
  // jamais le stockage qui mutile la donnee du client.
  assert.ok(line.allergies.some((v) => v.includes('<script>')));
});
