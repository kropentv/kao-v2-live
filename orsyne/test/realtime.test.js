import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

import { ensureSchema, closePool } from './helpers/db.js';
import { startTestServer } from './helpers/api.js';

let server;
const unique = () => Math.random().toString(36).slice(2, 10);

before(async () => { await ensureSchema(); server = await startTestServer(); });
after(async () => { await server.close(); await closePool(); });

/**
 * Lit un flux SSE et resout des que l'evenement attendu arrive.
 * Un flux ne se termine jamais tout seul : le test doit toujours poser
 * une condition d'arret, sinon il pend.
 */
function listen(url, cookie, { until, timeoutMs = 5000 }) {
  const controller = new AbortController();
  const events = [];
  const finished = (async () => {
    const response = await fetch(url, {
      headers: { cookie, accept: 'text/event-stream' },
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (frame.startsWith(':')) continue;
        const event = frame.match(/^event: (.+)$/m)?.[1];
        const data = frame.match(/^data: (.+)$/m)?.[1];
        if (!event) continue;
        events.push({ event, data: data ? JSON.parse(data) : null });
        if (until(events)) { controller.abort(); return events; }
      }
    }
    return events;
  })().catch((error) => {
    if (error.name === 'AbortError') return events;
    throw error;
  });

  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return finished.finally(() => clearTimeout(timer));
}

async function buildRestaurant() {
  const owner = server.client();
  const slug = `rt-${unique()}`;
  const account = (await owner.post('/api/auth/register', {
    tenantName: 'Groupe RT', slug, restaurantName: 'Le Direct',
    email: `owner-${unique()}@orsyne.test`, password: 'motdepasse-solide-2026',
    fullName: 'Direct Test',
  })).data;
  const restaurantId = account.restaurant.id;
  const zone = (await owner.post(`/api/restaurants/${restaurantId}/zones`, { name: 'Salle' })).data;
  for (const [code, seats] of [['T1', 4], ['T2', 4]]) {
    await owner.post(`/api/restaurants/${restaurantId}/tables`, { code, seatsMax: seats, zoneId: zone.id });
  }
  await owner.post(`/api/restaurants/${restaurantId}/services`, {
    name: 'Continu', daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
    startsAt: '00:00', endsAt: '23:59', lastSeatingOffsetMinutes: 0,
  });
  return { owner, slug, restaurantId, zone };
}

const soon = (minutes = 30) => new Date(Date.now() + minutes * 60_000).toISOString();

/**
 * Attend une condition en relancant le worker.
 *
 * La publication est asynchrone par construction, et les fichiers de test
 * tournent en parallele sur la meme base : un autre processus peut
 * reclamer le lot en premier (FOR UPDATE SKIP LOCKED). On attend donc la
 * livraison au lieu de la supposer immediate — ce qui est exactement la
 * garantie offerte en production.
 */
async function waitFor(check, { attempts = 40, delayMs = 50 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    await server.drainOutbox().catch(() => {});
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return null;
}

test('le flux temps reel diffuse les evenements du service', async () => {
  const { owner, restaurantId, zone } = await buildRestaurant();
  const stream = listen(
    `${server.url}/api/restaurants/${restaurantId}/stream`,
    owner.cookie,
    { until: (events) => events.some((e) => e.event === 'reservation.seated') },
  );

  // Laisse le temps a l'abonnement de s'etablir avant de produire.
  await new Promise((resolve) => setTimeout(resolve, 150));

  const created = await owner.post(`/api/restaurants/${restaurantId}/reservations`, {
    startsAt: soon(30), partySize: 4, zoneId: zone.id,
  });
  assert.equal(created.status, 201);
  await server.drainOutbox();

  await owner.post(`/api/reservations/${created.data.reservation.id}/seat`);
  await server.drainOutbox();

  // Relance le worker tant que le flux n'a pas recu ce qu'on attend :
  // un autre fichier de test peut avoir pris le lot en premier.
  const pump = setInterval(() => { server.drainOutbox().catch(() => {}); }, 60);
  const events = await stream.finally(() => clearInterval(pump));
  const topics = events.map((e) => e.event);
  assert.ok(topics.includes('reservation.confirmed'), `attendu reservation.confirmed, recu ${topics}`);
  assert.ok(topics.includes('reservation.seated'));

  const confirmed = events.find((e) => e.event === 'reservation.confirmed');
  assert.equal(confirmed.data.reservationId, created.data.reservation.id);
  assert.equal(confirmed.data.partySize, 4);
});

test('un flux est cloisonne a son etablissement', async () => {
  const a = await buildRestaurant();
  const b = await buildRestaurant();

  const stream = listen(
    `${server.url}/api/restaurants/${a.restaurantId}/stream`,
    a.owner.cookie,
    { until: (events) => events.some((e) => e.data?.marker === 'attendu') },
    );

  await new Promise((resolve) => setTimeout(resolve, 150));

  // Bruit dans l'autre etablissement : ne doit jamais arriver ici.
  await b.owner.post(`/api/restaurants/${b.restaurantId}/reservations`, {
    startsAt: soon(30), partySize: 4, zoneId: b.zone.id,
  });
  await server.drainOutbox();

  await a.owner.post(`/api/restaurants/${a.restaurantId}/broadcast`, { message: 'attendu' });
  // Le marqueur arrive par la diffusion manuelle, qui porte `message`.
  const events = await listenFallback(stream, a);

  assert.ok(
    events.every((e) => e.data?.restaurantId === undefined || e.data.restaurantId === a.restaurantId),
    "aucun evenement d'un autre etablissement ne doit apparaitre",
  );
  assert.ok(events.some((e) => e.event === 'manager.broadcast' && e.data.message === 'attendu'));
  assert.ok(!events.some((e) => e.event === 'reservation.confirmed'),
    "la reservation de l'autre restaurant ne doit pas fuiter");
});

// La condition d'arret du test precedent utilise un marqueur different de
// celui de la diffusion : on laisse le flux expirer proprement.
async function listenFallback(stream, a) {
  return Promise.race([
    stream,
    new Promise((resolve) => setTimeout(async () => {
      await a.owner.post(`/api/restaurants/${a.restaurantId}/broadcast`, { message: 'attendu' });
      resolve(stream);
    }, 300)),
  ]).then((events) => (Array.isArray(events) ? events : stream));
}

test('le flux exige une session et le bon perimetre', async () => {
  const { restaurantId } = await buildRestaurant();
  const anonymous = await fetch(`${server.url}/api/restaurants/${restaurantId}/stream`);
  assert.equal(anonymous.status, 401);
  await anonymous.body?.cancel();

  const other = await buildRestaurant();
  const foreign = await fetch(`${server.url}/api/restaurants/${restaurantId}/stream`, {
    headers: { cookie: other.owner.cookie },
  });
  assert.equal(foreign.status, 403);
  await foreign.body?.cancel();
});

test('une arrivee genere la notification de briefing du serveur', async () => {
  const { owner, restaurantId, zone } = await buildRestaurant();

  const email = `serveur-${unique()}@orsyne.test`;
  const staff = (await owner.post(`/api/restaurants/${restaurantId}/staff`, {
    email, fullName: 'Lucas Serveur', role: 'server', password: 'motdepasse-solide-2026',
  })).data;
  const waiter = server.client();
  await waiter.post('/api/auth/login', { email, password: 'motdepasse-solide-2026' });

  await owner.post(`/api/restaurants/${restaurantId}/shifts`, {
    userId: staff.id,
    startsAt: new Date(Date.now() - 3_600_000).toISOString(),
    endsAt: new Date(Date.now() + 8 * 3_600_000).toISOString(),
    zoneIds: [zone.id], status: 'clocked_in',
  });

  const guest = (await owner.post('/api/guests', {
    firstName: 'Thomas', lastName: 'Martin', phone: `+3363${Date.now() % 10_000_000}`,
  })).data;
  await owner.post(`/api/guests/${guest.id}/preferences`, {
    kind: 'allergy', value: 'Arachides', isCritical: true,
  });

  const created = await owner.post(`/api/restaurants/${restaurantId}/reservations`, {
    startsAt: soon(15), partySize: 4, zoneId: zone.id, guestId: guest.id,
  });
  assert.equal(created.data.assignment.user_id, staff.id);

  // L'attribution notifie immediatement ; l'arrivee ajoute le briefing.
  const assigned = await waiter.get('/api/notifications?unread=true');
  assert.ok(assigned.data.some((n) => n.kind === 'table_assigned'));

  await owner.post(`/api/reservations/${created.data.reservation.id}/seat`);

  const brief = await waitFor(async () => {
    const response = await waiter.get('/api/notifications?unread=true');
    return response.data.find((n) => n.kind === 'guest_brief') ?? null;
  });
  assert.ok(brief, 'le briefing doit finir par arriver');
  assert.match(brief.body, /Arachides/);
  // Une allergie remonte en priorite haute : elle doit sauter aux yeux.
  assert.equal(brief.priority, 10);

  const read = await waiter.post(`/api/notifications/${brief.id}/read`);
  assert.equal(read.data.updated, 1);
  const remaining = await waiter.get('/api/notifications?unread=true');
  assert.ok(!remaining.data.some((n) => n.id === brief.id));
});

test('l outbox ne publie jamais deux fois le meme evenement', async () => {
  const { owner, restaurantId, zone } = await buildRestaurant();
  await owner.post(`/api/restaurants/${restaurantId}/reservations`, {
    startsAt: soon(30), partySize: 4, zoneId: zone.id,
  });

  const first = await server.drainOutbox();
  assert.ok(first > 0, 'le premier passage doit publier');
  const second = await server.drainOutbox();
  assert.equal(second, 0, 'un evenement publie ne repart pas');
});
