import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { ensureSchema, closePool, admin } from './helpers/db.js';
import { startTestServer } from './helpers/api.js';
import { buildRestaurant, soon, unique } from './helpers/restaurant.js';
import { createStripeProvider, returnUrl } from '../src/integrations/payments/stripe.js';
import { overrideIntegration, resetIntegrations } from '../src/integrations/index.js';
import { createConsoleProvider } from '../src/integrations/payments/console.js';

let server;
before(async () => { await ensureSchema(); server = await startTestServer(); });
after(async () => { resetIntegrations(); await server.close(); await closePool(); });
beforeEach(() => resetIntegrations());

const SECRET = 'whsec_test_orsyne';
function sign(body, { secret = SECRET, timestamp = Math.floor(Date.now() / 1000) } = {}) {
  const v1 = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${v1}`;
}

/* ---------- Stripe : verification de signature (unitaire) ---------- */

test('un webhook Stripe correctement signe est accepte', () => {
  const stripe = createStripeProvider({ secretKey: 'sk_test', webhookSecret: SECRET, publicUrl: 'https://x.test' });
  const body = JSON.stringify({ type: 'payment_intent.succeeded', data: { object: { id: 'pi_1' } } });
  const event = stripe.verifyWebhook({ rawBody: body, signatureHeader: sign(body) });
  assert.equal(event.type, 'payment_intent.succeeded');
});

test('une signature fausse, absente ou rejouee est refusee', () => {
  const stripe = createStripeProvider({ secretKey: 'sk_test', webhookSecret: SECRET, publicUrl: 'https://x.test' });
  const body = JSON.stringify({ type: 'payment_intent.succeeded' });

  assert.throws(() => stripe.verifyWebhook({ rawBody: body, signatureHeader: sign(body, { secret: 'autre' }) }),
    /Signature invalide/);
  assert.throws(() => stripe.verifyWebhook({ rawBody: body, signatureHeader: null }), /absente/);
  // Rejeu d'un evenement capture il y a une heure.
  const old = Math.floor(Date.now() / 1000) - 3600;
  assert.throws(() => stripe.verifyWebhook({ rawBody: body, signatureHeader: sign(body, { timestamp: old }) }),
    /expiree/);
  // Corps modifie apres signature.
  const header = sign(body);
  assert.throws(() => stripe.verifyWebhook({ rawBody: body.replace('succeeded', 'failed'), signatureHeader: header }),
    /Signature invalide/);
});

test('les evenements Stripe sont traduits sans confondre empreinte et encaissement', () => {
  const stripe = createStripeProvider({ secretKey: 'sk_test', webhookSecret: SECRET, publicUrl: 'https://x.test' });

  const completed = stripe.interpretEvent({
    type: 'checkout.session.completed',
    data: { object: { client_reference_id: 'res_1', payment_intent: 'pi_1', amount_total: 4000,
      currency: 'eur', metadata: { orsyne_mechanism: 'preauthorization' } } },
  });
  assert.equal(completed.reservationId, 'res_1');
  assert.equal(completed.mechanism, 'preauthorization');
  assert.equal(completed.currency, 'EUR');

  const failed = stripe.interpretEvent({
    type: 'payment_intent.payment_failed',
    data: { object: { id: 'pi_2', metadata: { orsyne_reservation_id: 'res_2' },
      last_payment_error: { message: 'Carte refusée' } } },
  });
  assert.equal(failed.kind, 'failed');
  assert.equal(failed.reason, 'Carte refusée');

  assert.equal(stripe.interpretEvent({ type: 'customer.created', data: { object: {} } }), null);
});

test('l URL de retour porte la reference et reste sur le domaine du produit', () => {
  const url = new URL(returnUrl('https://orsyne.example', '/r/bistrot', 'ABC-DEF', 'ok'));
  assert.equal(url.origin, 'https://orsyne.example');
  assert.equal(url.searchParams.get('ref'), 'ABC-DEF');
  assert.equal(url.searchParams.get('paiement'), 'ok');
});

/* ---------- Parcours complet avec le prestataire de demonstration ---------- */

async function restaurantWithPolicy(policy) {
  const fx = await buildRestaurant(server, { prefix: 'pay' });
  const created = await fx.owner.post(`/api/restaurants/${fx.restaurantId}/deposit-policies`, policy);
  assert.equal(created.status, 201, JSON.stringify(created.data));
  return fx;
}

async function bookPending(fx, partySize = 4) {
  const visitor = server.client();
  const booking = await visitor.post(`/api/public/${fx.slug}/reservations`, {
    startsAt: soon(), partySize,
    guest: { firstName: 'Paul', email: `paul-${unique()}@example.test` },
  });
  assert.equal(booking.status, 201, JSON.stringify(booking.data));
  assert.equal(booking.data.status, 'pending_payment');
  return { visitor, booking: booking.data };
}

test('acompte : checkout, webhook, reservation confirmee et encaissement trace', async () => {
  const fx = await restaurantWithPolicy({
    name: 'Acompte', mechanism: 'deposit', amountMode: 'per_person', amountCents: 1500,
  });
  const { visitor, booking } = await bookPending(fx, 4);

  const checkout = await visitor.post(`/api/public/${fx.slug}/reservations/${booking.reference}/checkout`);
  assert.equal(checkout.status, 200, JSON.stringify(checkout.data));
  assert.equal(checkout.data.amountCents, 6000);
  assert.equal(checkout.data.mechanism, 'deposit');
  const url = new URL(checkout.data.url);
  assert.equal(url.pathname, '/paiement-demo');

  // Le prestataire notifie : c'est la seule source de verite.
  const webhook = await server.client().post('/api/webhooks/payments', {
    type: 'captured',
    reservationId: url.searchParams.get('rid'),
    providerRef: url.searchParams.get('pid'),
    mechanism: 'deposit', amountCents: 6000, currency: 'EUR',
  });
  assert.equal(webhook.status, 200, JSON.stringify(webhook.data));
  assert.equal(webhook.data.outcome, 'confirmed');

  const after = await visitor.get(`/api/public/${fx.slug}/reservations/${booking.reference}`);
  assert.equal(after.data.status, 'confirmed');

  const intents = await admin((db) => db.query(
    `SELECT mechanism, status, amount_cents, captured_amount_cents FROM payment_intents
      WHERE reservation_id = $1`, [url.searchParams.get('rid')]));
  assert.equal(intents.rows.length, 1, 'une seule ligne : checkout et webhook se rejoignent');
  assert.equal(intents.rows[0].status, 'captured');
  assert.equal(intents.rows[0].captured_amount_cents, 6000);
});

test('un webhook recu deux fois ne produit ni double confirmation ni double ligne', async () => {
  const fx = await restaurantWithPolicy({
    name: 'Acompte fixe', mechanism: 'deposit', amountMode: 'fixed', amountCents: 2000,
  });
  const { visitor, booking } = await bookPending(fx, 2);
  const url = new URL((await visitor.post(
    `/api/public/${fx.slug}/reservations/${booking.reference}/checkout`)).data.url);
  const payload = {
    type: 'captured', reservationId: url.searchParams.get('rid'),
    providerRef: url.searchParams.get('pid'), mechanism: 'deposit', amountCents: 2000,
  };
  const first = await server.client().post('/api/webhooks/payments', payload);
  const second = await server.client().post('/api/webhooks/payments', payload);
  assert.equal(first.data.outcome, 'confirmed');
  assert.equal(second.data.outcome, 'payment_recorded');

  const count = await admin((db) => db.query(
    `SELECT count(*)::int AS n FROM payment_intents WHERE reservation_id = $1`,
    [url.searchParams.get('rid')]));
  assert.equal(count.rows[0].n, 1);
});

test('empreinte : autorisee sans debit, puis capturee seulement sur decision de no-show', async () => {
  const fx = await restaurantWithPolicy({
    name: 'Empreinte', mechanism: 'preauthorization', amountMode: 'per_person', amountCents: 2500,
  });
  const { visitor, booking } = await bookPending(fx, 2);
  const url = new URL((await visitor.post(
    `/api/public/${fx.slug}/reservations/${booking.reference}/checkout`)).data.url);
  const reservationId = url.searchParams.get('rid');

  await server.client().post('/api/webhooks/payments', {
    type: 'authorized', reservationId, providerRef: url.searchParams.get('pid'),
    mechanism: 'preauthorization', amountCents: 5000,
  });

  let intent = (await admin((db) => db.query(
    `SELECT status, captured_amount_cents FROM payment_intents WHERE reservation_id = $1`,
    [reservationId]))).rows[0];
  assert.equal(intent.status, 'authorized');
  assert.equal(intent.captured_amount_cents, 0, "une empreinte n'encaisse rien");

  await fx.owner.post(`/api/reservations/${reservationId}/no-show`);
  const charged = await fx.owner.post(`/api/reservations/${reservationId}/charge-no-show`);
  assert.equal(charged.status, 200, JSON.stringify(charged.data));
  assert.equal(charged.data.charged, true);

  intent = (await admin((db) => db.query(
    `SELECT status, captured_amount_cents FROM payment_intents WHERE reservation_id = $1`,
    [reservationId]))).rows[0];
  assert.equal(intent.status, 'captured');
  assert.equal(intent.captured_amount_cents, 5000);
});

test('un paiement echoue ne confirme rien et laisse la table maintenue', async () => {
  const fx = await restaurantWithPolicy({
    name: 'Acompte', mechanism: 'deposit', amountMode: 'fixed', amountCents: 1000,
  });
  const { visitor, booking } = await bookPending(fx, 2);
  const url = new URL((await visitor.post(
    `/api/public/${fx.slug}/reservations/${booking.reference}/checkout`)).data.url);

  const failed = await server.client().post('/api/webhooks/payments', {
    type: 'failed', reservationId: url.searchParams.get('rid'),
    providerRef: url.searchParams.get('pid'), reason: 'Carte refusée',
  });
  assert.equal(failed.data.outcome, 'failed');

  const after = await visitor.get(`/api/public/${fx.slug}/reservations/${booking.reference}`);
  assert.equal(after.data.status, 'pending_payment');
});

test('annulation dans les delais : l acompte est rembourse', async () => {
  const fx = await restaurantWithPolicy({
    name: 'Acompte souple', mechanism: 'deposit', amountMode: 'fixed', amountCents: 3000,
    freeCancellationHours: 0,
  });
  const { visitor, booking } = await bookPending(fx, 2);
  const url = new URL((await visitor.post(
    `/api/public/${fx.slug}/reservations/${booking.reference}/checkout`)).data.url);
  await server.client().post('/api/webhooks/payments', {
    type: 'captured', reservationId: url.searchParams.get('rid'),
    providerRef: url.searchParams.get('pid'), mechanism: 'deposit', amountCents: 3000,
  });

  const cancelled = await visitor.post(`/api/public/${fx.slug}/reservations/${booking.reference}/cancel`);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.data.freeCancellation, true);
  assert.deepEqual(cancelled.data.refunds, ['remboursé']);

  const intent = (await admin((db) => db.query(
    `SELECT status, refunded_amount_cents FROM payment_intents WHERE reservation_id = $1`,
    [url.searchParams.get('rid')]))).rows[0];
  assert.equal(intent.status, 'refunded');
  assert.equal(intent.refunded_amount_cents, 3000);
});

test('annulation hors delai : l acompte est conserve, comme annonce', async () => {
  const fx = await restaurantWithPolicy({
    name: 'Acompte strict', mechanism: 'deposit', amountMode: 'fixed', amountCents: 3000,
    freeCancellationHours: 48,
  });
  const { visitor, booking } = await bookPending(fx, 2);
  const url = new URL((await visitor.post(
    `/api/public/${fx.slug}/reservations/${booking.reference}/checkout`)).data.url);
  await server.client().post('/api/webhooks/payments', {
    type: 'captured', reservationId: url.searchParams.get('rid'),
    providerRef: url.searchParams.get('pid'), mechanism: 'deposit', amountCents: 3000,
  });

  const cancelled = await visitor.post(`/api/public/${fx.slug}/reservations/${booking.reference}/cancel`);
  assert.equal(cancelled.data.freeCancellation, false);
  assert.deepEqual(cancelled.data.refunds, []);
  const intent = (await admin((db) => db.query(
    `SELECT status FROM payment_intents WHERE reservation_id = $1`,
    [url.searchParams.get('rid')]))).rows[0];
  assert.equal(intent.status, 'captured');
});

test('quand c est le restaurant qui annule, le client est toujours rembourse', async () => {
  const fx = await restaurantWithPolicy({
    name: 'Acompte strict', mechanism: 'deposit', amountMode: 'fixed', amountCents: 3000,
    freeCancellationHours: 48,
  });
  const { visitor, booking } = await bookPending(fx, 2);
  const url = new URL((await visitor.post(
    `/api/public/${fx.slug}/reservations/${booking.reference}/checkout`)).data.url);
  const reservationId = url.searchParams.get('rid');
  await server.client().post('/api/webhooks/payments', {
    type: 'captured', reservationId, providerRef: url.searchParams.get('pid'),
    mechanism: 'deposit', amountCents: 3000,
  });

  const cancelled = await fx.owner.post(`/api/reservations/${reservationId}/cancel`, { reason: 'fermeture' });
  assert.equal(cancelled.status, 200);
  assert.deepEqual(cancelled.data.refunds, ['remboursé']);
});

test('avec Stripe branche, un webhook non signe ne confirme rien', async () => {
  overrideIntegration('payments', createStripeProvider({
    secretKey: 'sk_test_fake', webhookSecret: SECRET, publicUrl: server.url,
  }));
  const forged = await server.client().post('/api/webhooks/payments', {
    type: 'checkout.session.completed',
    data: { object: { client_reference_id: '00000000-0000-0000-0000-000000000000' } },
  });
  assert.equal(forged.status, 400);
  assert.equal(forged.data.error.code, 'invalid_signature');
});

test('avec Stripe branche, le raccourci de confirmation sans paiement disparait', async () => {
  const fx = await restaurantWithPolicy({
    name: 'Acompte', mechanism: 'deposit', amountMode: 'fixed', amountCents: 1000,
  });
  const { visitor, booking } = await bookPending(fx, 2);

  overrideIntegration('payments', createStripeProvider({
    secretKey: 'sk_test_fake', webhookSecret: SECRET, publicUrl: server.url,
  }));
  const bypass = await visitor.post(
    `/api/public/${fx.slug}/reservations/${booking.reference}/confirm-payment`);
  assert.equal(bypass.status, 404, 'personne ne doit pouvoir confirmer sans payer');

  const demoPage = await visitor.get('/paiement-demo?ref=X');
  assert.equal(demoPage.status, 404, 'la page de paiement factice ne doit pas exister en production');

  overrideIntegration('payments', createConsoleProvider({ publicUrl: server.url, log: () => {} }));
});

test('la page de paiement de demonstration refuse une redirection vers un site tiers', async () => {
  const response = await fetch(`${server.url}/paiement-demo?ref=ABC-DEF&montant=1000&retour=https://pirate.example`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.ok(!html.includes('pirate.example'), 'aucune redirection ouverte');
});
