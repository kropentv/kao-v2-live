import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

// Quotas volontairement bas, poses AVANT de charger la configuration :
// ce fichier tourne dans son propre processus, les autres ne sont pas
// concernes.
process.env.ORSYNE_RATE_LOGIN = '3';
process.env.ORSYNE_RATE_BOOKING = '2';
process.env.ORSYNE_RATE_API = '100000';
process.env.ORSYNE_JOBS_ENABLED = 'false';

const { ensureSchema, closePool } = await import('./helpers/db.js');
const { startTestServer } = await import('./helpers/api.js');
const { RateLimiter } = await import('../src/api/security.js');
const { productionConfigProblems } = await import('../src/config.js');

let server;
before(async () => { await ensureSchema(); server = await startTestServer(); });
after(async () => { await server.close(); await closePool(); });

test('la limite de debit autorise jusqu au quota puis refuse avec un delai', () => {
  const limiter = new RateLimiter({ windowMs: 1000 });
  const t0 = 1_000_000;
  assert.equal(limiter.take('k', 2, t0).allowed, true);
  assert.equal(limiter.take('k', 2, t0 + 10).allowed, true);
  const refused = limiter.take('k', 2, t0 + 20);
  assert.equal(refused.allowed, false);
  assert.ok(refused.retryAfterSeconds >= 1);
  // La fenetre glisse : une seconde plus tard, c'est de nouveau permis.
  assert.equal(limiter.take('k', 2, t0 + 1100).allowed, true);
  // Les cles sont independantes.
  assert.equal(limiter.take('autre', 2, t0 + 20).allowed, true);
  limiter.close();
});

test('les tentatives de connexion en rafale sont bloquees (force brute)', async () => {
  const client = server.client();
  const statuses = [];
  for (let i = 0; i < 5; i += 1) {
    const r = await client.post('/api/auth/login', { email: 'inconnu@orsyne.test', password: 'mauvais-mot-de-passe' });
    statuses.push(r.status);
  }
  assert.deepEqual(statuses.slice(0, 3), [401, 401, 401]);
  assert.equal(statuses[3], 429);
  const blocked = await client.post('/api/auth/login', { email: 'x@orsyne.test', password: 'y' });
  assert.equal(blocked.data.error.code, 'rate_limited');
  assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
});

test('le widget public est protege contre le remplissage par un robot', async () => {
  const client = server.client();
  const statuses = [];
  for (let i = 0; i < 4; i += 1) {
    const r = await client.post('/api/public/nexiste-pas/reservations', { startsAt: new Date().toISOString() });
    statuses.push(r.status);
  }
  assert.ok(statuses.slice(0, 2).every((s) => s !== 429));
  assert.equal(statuses[2], 429);
});

test('les en-tetes de securite sont poses partout', async () => {
  const api = await fetch(`${server.url}/health`);
  assert.equal(api.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(api.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.ok(api.headers.get('referrer-policy'));
  await api.text();

  const page = await fetch(`${server.url}/`);
  const csp = page.headers.get('content-security-policy');
  assert.ok(csp, 'une page HTML porte une CSP');
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /frame-ancestors 'self'/);
  await page.text();
});

test('la sonde de disponibilite verifie la base et decrit les branchements', async () => {
  const response = await fetch(`${server.url}/ready`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'ready');
  assert.equal(body.integrations.payments.provider, 'console');
});

test('la configuration de production refuse ce qui la rendrait silencieusement inoperante', () => {
  const base = {
    isProduction: true,
    databaseUrl: 'postgres://app@db.internal:5432/orsyne',
    publicUrl: 'https://reservation.example',
    payments: { provider: 'stripe', stripeSecretKey: 'sk_live', stripeWebhookSecret: 'whsec' },
    email: { provider: 'resend', resendApiKey: 're_x' },
    sms: { provider: 'twilio', twilioAccountSid: 'AC', twilioAuthToken: 't', from: '+33100000000' },
  };
  assert.deepEqual(productionConfigProblems(base), [], 'une configuration complete passe');

  const noWebhook = productionConfigProblems({ ...base, payments: { ...base.payments, stripeWebhookSecret: null } });
  assert.ok(noWebhook.some((p) => /WEBHOOK/.test(p)), 'sans secret de webhook, aucun paiement ne serait confirme');

  const demoPayments = productionConfigProblems({ ...base, payments: { provider: 'console' } });
  assert.ok(demoPayments.some((p) => /aucun acompte/.test(p)), 'le mode demonstration est interdit en production');

  const http = productionConfigProblems({ ...base, publicUrl: 'http://reservation.example' });
  assert.ok(http.some((p) => /https/.test(p)));

  const smsNoSender = productionConfigProblems({ ...base, sms: { ...base.sms, from: null } });
  assert.ok(smsNoSender.some((p) => /ORSYNE_SMS_FROM/.test(p)));
});
