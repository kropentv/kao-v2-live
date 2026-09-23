import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { ensureSchema, closePool, admin } from './helpers/db.js';
import { startTestServer } from './helpers/api.js';
import { buildRestaurant, collectingMessenger, soon, unique } from './helpers/restaurant.js';
import { overrideIntegration, resetIntegrations } from '../src/integrations/index.js';
import { renderMessage, sendGuestMessage } from '../src/services/messaging.js';
import { withTenant } from '../src/db/pool.js';

let server;
let email;
let sms;
before(async () => { await ensureSchema(); server = await startTestServer(); });
after(async () => { resetIntegrations(); await server.close(); await closePool(); });
beforeEach(() => {
  resetIntegrations();
  email = collectingMessenger('email');
  sms = collectingMessenger('sms');
  overrideIntegration('messenger:email', email.instance);
  overrideIntegration('messenger:sms', sms.instance);
});

const context = {
  to: 'x@example.test', firstName: 'Julie', restaurant: 'Le Comptoir', reference: 'ABC-DEF',
  partySize: 4, date: 'mardi 22 septembre', time: '20:00', allergies: ['Arachides'],
  manageUrl: 'https://o.test/r/x?ref=ABC-DEF', payUrl: '', amount: '20,00 €',
};

test('les gabarits existent en francais et en anglais, avec repli sur le francais', () => {
  const fr = renderMessage('confirmed', 'fr-FR', context);
  assert.match(fr.subject, /Réservation confirmée/);
  assert.match(fr.text, /ABC-DEF/);
  assert.match(fr.text, /Allergies transmises : Arachides/);

  const en = renderMessage('confirmed', 'en-GB', context);
  assert.match(en.subject, /Booking confirmed/);
  assert.match(en.text, /Allergies on file: Arachides/);

  // Langue sans gabarit : on repond en francais plutot que pas du tout.
  const de = renderMessage('confirmed', 'de-DE', context);
  assert.match(de.subject, /Réservation confirmée/);
});

test('sans allergie, le message n en parle pas', () => {
  const message = renderMessage('confirmed', 'fr-FR', { ...context, allergies: [] });
  assert.ok(!/allergie/i.test(message.text));
});

test('une reservation au widget envoie la confirmation dans la langue du client', async () => {
  const fx = await buildRestaurant(server, { prefix: 'msg' });
  const address = `james-${unique()}@example.test`;
  const booking = await server.client().post(`/api/public/${fx.slug}/reservations`, {
    startsAt: soon(), partySize: 2, allergies: ['Gluten'],
    guest: { firstName: 'James', email: address, locale: 'en-GB' },
  });
  assert.equal(booking.status, 201, JSON.stringify(booking.data));

  assert.equal(email.sent.length, 1, 'une confirmation, une seule');
  const [message] = email.sent;
  assert.equal(message.to, address);
  assert.match(message.subject, /Booking confirmed/);
  assert.match(message.text, new RegExp(booking.data.reference));
  assert.match(message.text, /Gluten/);

  // L'envoi est trace, avec son statut.
  const log = await admin((db) => db.query(
    `SELECT m.channel, m.status, m.template, m.purpose FROM guest_messages m
       JOIN reservations r ON r.id = m.reservation_id WHERE r.reference = $1`,
    [booking.data.reference]));
  assert.equal(log.rows.length, 1);
  assert.equal(log.rows[0].status, 'sent');
  assert.equal(log.rows[0].template, 'confirmed');
  assert.equal(log.rows[0].purpose, 'transactional');
});

test('sans email, la confirmation part par SMS', async () => {
  const fx = await buildRestaurant(server, { prefix: 'sms' });
  const phone = `+3368${Date.now() % 10_000_000}`;
  await server.client().post(`/api/public/${fx.slug}/reservations`, {
    startsAt: soon(), partySize: 2, guest: { firstName: 'Léa', phone },
  });
  assert.equal(email.sent.length, 0);
  assert.equal(sms.sent.length, 1);
  assert.equal(sms.sent[0].to, phone);
});

test('une annulation par le client envoie un message d annulation', async () => {
  const fx = await buildRestaurant(server, { prefix: 'can' });
  const booking = await server.client().post(`/api/public/${fx.slug}/reservations`, {
    startsAt: soon(), partySize: 2, guest: { firstName: 'Marc', email: `marc-${unique()}@example.test` },
  });
  await server.client().post(`/api/public/${fx.slug}/reservations/${booking.data.reference}/cancel`);
  assert.equal(email.sent.length, 2);
  assert.match(email.sent[1].subject, /annulée/);
});

test('un fournisseur en panne ne fait pas echouer la reservation, et l echec est trace', async () => {
  overrideIntegration('messenger:email', {
    name: 'panne', channel: 'email',
    async send() { throw new Error('service indisponible'); },
  });
  const fx = await buildRestaurant(server, { prefix: 'down' });
  const booking = await server.client().post(`/api/public/${fx.slug}/reservations`, {
    startsAt: soon(), partySize: 2, guest: { firstName: 'Nina', email: `nina-${unique()}@example.test` },
  });
  assert.equal(booking.status, 201, 'la table est reservee malgre la panne');

  const log = await admin((db) => db.query(
    `SELECT m.status, m.failure_reason FROM guest_messages m
       JOIN reservations r ON r.id = m.reservation_id WHERE r.reference = $1`,
    [booking.data.reference]));
  assert.equal(log.rows[0].status, 'failed');
  assert.match(log.rows[0].failure_reason, /indisponible/);
});

test('un message marketing sans consentement est bloque et trace comme tel', async () => {
  const fx = await buildRestaurant(server, { prefix: 'mkt' });
  const guest = await fx.owner.post('/api/guests', {
    firstName: 'Sans', lastName: 'Consentement', email: `nc-${unique()}@example.test`,
  });

  const result = await withTenant({ tenantId: fx.tenantId }, (client) => sendGuestMessage(client, {
    tenantId: fx.tenantId, restaurantId: fx.restaurantId, guestId: guest.data.id,
    channel: 'email', purpose: 'marketing', template: 'confirmed', locale: 'fr-FR',
    context: { ...context, to: 'nc@example.test' },
  }));
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'no_consent');
  assert.equal(email.sent.length, 0, 'rien ne doit partir');

  const log = await admin((db) => db.query(
    `SELECT status FROM guest_messages WHERE guest_id = $1`, [guest.data.id]));
  assert.equal(log.rows[0].status, 'blocked');
});

test('avec consentement explicite, le message marketing part', async () => {
  const fx = await buildRestaurant(server, { prefix: 'mko' });
  const address = `oui-${unique()}@example.test`;
  const booking = await server.client().post(`/api/public/${fx.slug}/reservations`, {
    startsAt: soon(), partySize: 2,
    guest: { firstName: 'Oui', email: address, marketingConsent: true },
  });
  const guestId = (await admin((db) => db.query(
    `SELECT guest_id FROM reservations WHERE reference = $1`, [booking.data.reference]))).rows[0].guest_id;

  const result = await withTenant({ tenantId: fx.tenantId }, (client) => sendGuestMessage(client, {
    tenantId: fx.tenantId, restaurantId: fx.restaurantId, guestId,
    channel: 'email', purpose: 'marketing', template: 'confirmed', locale: 'fr-FR',
    context: { ...context, to: address },
  }));
  assert.equal(result.sent, true);
});
