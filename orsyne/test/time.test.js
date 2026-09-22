import test from 'node:test';
import assert from 'node:assert/strict';

import { dayOfWeekInZone, parseTimeToMinutes, utcToZonedParts, zonedTimeToUtc } from '../src/lib/time.js';

test('20h00 a Paris en hiver correspond a 19h00 UTC', () => {
  const instant = zonedTimeToUtc({ year: 2026, month: 1, day: 15, hour: 20 }, 'Europe/Paris');
  assert.equal(instant.toISOString(), '2026-01-15T19:00:00.000Z');
});

test('20h00 a Paris en ete correspond a 18h00 UTC', () => {
  const instant = zonedTimeToUtc({ year: 2026, month: 7, day: 15, hour: 20 }, 'Europe/Paris');
  assert.equal(instant.toISOString(), '2026-07-15T18:00:00.000Z');
});

test('le passage a l heure d ete ne decale pas le service', () => {
  // Nuit du 28 au 29 mars 2026 : 02h00 -> 03h00 a Paris.
  const before = zonedTimeToUtc({ year: 2026, month: 3, day: 28, hour: 20 }, 'Europe/Paris');
  const after = zonedTimeToUtc({ year: 2026, month: 3, day: 29, hour: 20 }, 'Europe/Paris');
  assert.equal(before.toISOString(), '2026-03-28T19:00:00.000Z');
  assert.equal(after.toISOString(), '2026-03-29T18:00:00.000Z');

  // Le service reste a 20h en heure murale des deux cotes du changement.
  assert.equal(utcToZonedParts(before, 'Europe/Paris').hour, 20);
  assert.equal(utcToZonedParts(after, 'Europe/Paris').hour, 20);
});

test('un restaurant a New York et un a Paris ne partagent pas le meme instant', () => {
  const paris = zonedTimeToUtc({ year: 2026, month: 6, day: 10, hour: 20 }, 'Europe/Paris');
  const newYork = zonedTimeToUtc({ year: 2026, month: 6, day: 10, hour: 20 }, 'America/New_York');
  assert.equal(newYork.getTime() - paris.getTime(), 6 * 3_600_000);
});

test('le jour de la semaine suit le fuseau du restaurant', () => {
  // Meme convention que Date#getDay : 0 = dimanche.
  assert.equal(dayOfWeekInZone('2026-01-15', 'Europe/Paris'), 4); // jeudi
  assert.equal(dayOfWeekInZone('2026-01-18', 'Europe/Paris'), 0); // dimanche
});

test('les heures de service sont converties en minutes', () => {
  assert.equal(parseTimeToMinutes('18:30'), 1110);
  assert.equal(parseTimeToMinutes('23:00:00'), 1380);
  assert.throws(() => parseTimeToMinutes('7:30'), TypeError);
});

test('un aller-retour heure murale -> instant -> heure murale est stable', () => {
  for (const month of [1, 3, 6, 10, 12]) {
    const wall = { year: 2026, month, day: 15, hour: 21, minute: 30 };
    const parts = utcToZonedParts(zonedTimeToUtc(wall, 'Europe/Paris'), 'Europe/Paris');
    assert.equal(parts.hour, 21, `mois ${month}`);
    assert.equal(parts.minute, 30, `mois ${month}`);
    assert.equal(parts.day, 15, `mois ${month}`);
  }
});
