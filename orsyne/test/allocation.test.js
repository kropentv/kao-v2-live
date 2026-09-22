import test from 'node:test';
import assert from 'node:assert/strict';

import { rankAllocations, rankServers } from '../src/domain/allocation.js';

const table = (id, seats, extra = {}) => ({
  id, seats_min: 1, seats_max: seats, zone_id: 'zone-main',
  priority: 100, attributes: [], ...extra,
});

test('la table la mieux dimensionnee passe devant', () => {
  const ranked = rankAllocations({
    tables: [table('t6', 6), table('t2', 2), table('t4', 4)],
    partySize: 4,
  });
  assert.equal(ranked[0].tableIds[0], 't4');
  assert.equal(ranked[0].reason, 'capacite exacte');
  // La table de 2 est trop petite : elle ne doit pas etre candidate.
  assert.ok(!ranked.some((r) => r.tableIds.includes('t2')));
});

test('la zone demandee prime sur le dimensionnement exact', () => {
  const ranked = rankAllocations({
    tables: [
      table('salle-4', 4, { zone_id: 'zone-main' }),
      table('terrasse-6', 6, { zone_id: 'zone-terrace' }),
    ],
    partySize: 4,
    requestedZoneId: 'zone-terrace',
  });
  assert.equal(ranked[0].tableIds[0], 'terrasse-6');
  assert.match(ranked[0].reason, /zone demandee/);
});

test('les preferences du profil client departagent deux tables equivalentes', () => {
  const ranked = rankAllocations({
    tables: [
      table('standard', 4),
      table('fenetre', 4, { attributes: ['window'] }),
    ],
    partySize: 4,
    guestPreferredAttributes: ['window'],
  });
  assert.equal(ranked[0].tableIds[0], 'fenetre');
  assert.match(ranked[0].reason, /preference client/);
});

test('une table demandee explicitement court-circuite le scoring', () => {
  const ranked = rankAllocations({
    tables: [table('t4', 4), table('t8', 8)],
    partySize: 2,
    requestedTableId: 't8',
  });
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].tableIds[0], 't8');
});

test('une table demandee trop petite ne produit aucun candidat', () => {
  const ranked = rankAllocations({
    tables: [table('t2', 2)],
    partySize: 6,
    requestedTableId: 't2',
  });
  assert.deepEqual(ranked, []);
});

test('une combinaison ne sert qu en dernier recours', () => {
  const ranked = rankAllocations({
    tables: [table('a', 4), table('b', 4), table('grande', 8)],
    combinations: [{ id: 'c1', seats_min: 5, seats_max: 8, priority: 200, table_ids: ['a', 'b'] }],
    partySize: 8,
  });
  assert.equal(ranked[0].tableIds.length, 1);
  assert.equal(ranked[0].tableIds[0], 'grande');
});

test('la rotation privilegie la table dont la suite est la plus proche', () => {
  const occupancyEnd = new Date('2026-01-10T20:45:00Z');
  const ranked = rankAllocations({
    tables: [table('libre-toute-la-soiree', 4), table('reprise-21h', 4)],
    partySize: 4,
    occupancyEnd,
    nextOccupiedAt: new Map([
      ['reprise-21h', new Date('2026-01-10T21:00:00Z')],
      // 'libre-toute-la-soiree' n'a aucune suite.
    ]),
  });
  assert.equal(
    ranked[0].tableIds[0], 'reprise-21h',
    'compacter le service plutot que fragmenter les creneaux libres',
  );
});

test('le serveur le moins charge recoit la table suivante', () => {
  const ranked = rankServers({
    shifts: [
      { id: 's1', user_id: 'lucas', zone_ids: ['z1'], table_ids: [], max_tables: 8, max_covers: 32, current_tables: 8, current_covers: 25 },
      { id: 's2', user_id: 'sarah', zone_ids: ['z1'], table_ids: [], max_tables: 8, max_covers: 32, current_tables: 4, current_covers: 12 },
      { id: 's3', user_id: 'hugo',  zone_ids: ['z1'], table_ids: [], max_tables: 8, max_covers: 32, current_tables: 6, current_covers: 19 },
    ],
    tableIds: ['t1'],
    zoneId: 'z1',
    partySize: 4,
  });
  assert.equal(ranked[0].userId, 'sarah');
});

test('le rang declare d un serveur prime sur sa charge', () => {
  const ranked = rankServers({
    shifts: [
      { id: 's1', user_id: 'titulaire', zone_ids: [], table_ids: ['t1'], max_tables: 8, max_covers: 32, current_tables: 5, current_covers: 18 },
      { id: 's2', user_id: 'dispo', zone_ids: ['z9'], table_ids: [], max_tables: 8, max_covers: 32, current_tables: 0, current_covers: 0 },
    ],
    tableIds: ['t1'],
    zoneId: 'z1',
    partySize: 2,
  });
  assert.equal(ranked[0].userId, 'titulaire');
  assert.match(ranked[0].reason, /table dans son rang/);
});

test('un service complet reste attribuable malgre le depassement', () => {
  const ranked = rankServers({
    shifts: [
      { id: 's1', user_id: 'a', zone_ids: [], table_ids: [], max_tables: 2, max_covers: 8, current_tables: 2, current_covers: 8 },
      { id: 's2', user_id: 'b', zone_ids: [], table_ids: [], max_tables: 2, max_covers: 8, current_tables: 3, current_covers: 12 },
    ],
    tableIds: ['t1'], zoneId: null, partySize: 2,
  });
  assert.equal(ranked.length, 2, "aucun serveur n'est ecarte : le service doit pouvoir tourner");
  assert.equal(ranked[0].userId, 'a', 'le moins en depassement passe devant');
});
