import assert from 'node:assert/strict';

export const unique = () => Math.random().toString(36).slice(2, 10);
export const soon = (minutes = 45) => new Date(Date.now() + minutes * 60_000).toISOString();

/**
 * Monte un restaurant complet via l'API publique du produit : compte,
 * salle, tables, service continu. Passer par l'API plutot que par des
 * INSERT garantit que les tests exercent le meme chemin qu'un client.
 */
export async function buildRestaurant(server, {
  tables = [['T1', 2], ['T2', 4], ['T3', 4], ['T4', 6]],
  prefix = 'r',
} = {}) {
  const owner = server.client();
  const slug = `${prefix}-${unique()}`;
  const response = await owner.post('/api/auth/register', {
    tenantName: `Groupe ${slug}`, slug, restaurantName: `Restaurant ${slug}`,
    email: `owner-${unique()}@orsyne.test`, password: 'motdepasse-solide-2026',
    fullName: 'Proprietaire Test',
  });
  assert.equal(response.status, 201, JSON.stringify(response.data));
  const restaurantId = response.data.restaurant.id;

  const zone = (await owner.post(`/api/restaurants/${restaurantId}/zones`, { name: 'Salle' })).data;
  const created = {};
  for (const [code, seats] of tables) {
    const t = await owner.post(`/api/restaurants/${restaurantId}/tables`, {
      code, seatsMax: seats, zoneId: zone.id, guestSelectable: true,
    });
    assert.equal(t.status, 201, JSON.stringify(t.data));
    created[code] = t.data;
  }
  const service = await owner.post(`/api/restaurants/${restaurantId}/services`, {
    name: 'Continu', daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
    startsAt: '00:00', endsAt: '23:59', lastSeatingOffsetMinutes: 0,
    defaultDurationMinutes: 90, turnBufferMinutes: 15,
  });
  assert.equal(service.status, 201, JSON.stringify(service.data));

  return { owner, slug, restaurantId, zone, tables: created, tenantId: response.data.tenant.id };
}

/** Collecteur de messages : remplace un fournisseur le temps d'un test. */
export function collectingMessenger(channel = 'email') {
  const sent = [];
  return {
    sent,
    instance: {
      name: 'test',
      channel,
      async send(message) {
        sent.push(message);
        return { providerRef: `test_${sent.length}` };
      },
    },
  };
}
