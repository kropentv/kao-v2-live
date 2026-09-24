/**
 * Verification de bout en bout de la demo navigateur, dans Chromium :
 *   1. le serveur ORSYNE demarre dans la page (PostgreSQL local, RLS) ;
 *   2. un client reserve pour 8 via le vrai widget, paie l'acompte sur
 *      la page de paiement de demonstration, et la table est confirmee ;
 *   3. la reservation apparait en direct dans le tableau de bord ;
 *   4. douze demandes simultanees sur la meme table : une seule passe.
 *
 * Usage : npm run build && npm run check
 */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { serveDemo } from './serve.mjs';

const server = await serveDemo();
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
const problems = [];
page.on('pageerror', (error) => problems.push(error.message));
page.on('console', (message) => { if (message.type() === 'error') problems.push(message.text()); });

const step = (label) => console.log(`• ${label}`);

try {
  const started = Date.now();
  await page.goto(`http://localhost:${server.address().port}/`);
  await page.waitForFunction(() => document.getElementById('boot').hidden
    || !document.getElementById('boot-error').hidden, null, { timeout: 120_000 });
  assert.equal(await page.isVisible('#boot-error'), false, await page.textContent('#boot-error'));
  assert.match(await page.textContent('#live-label'), /isolation par restaurant active/);
  step(`serveur demarre en ${((Date.now() - started) / 1000).toFixed(1)} s, role applicatif sans BYPASSRLS`);

  await page.click('#layout-toggle').catch(() => {});
  if (await page.getAttribute('#stage', 'data-layout') !== 'split') await page.click('#layout-toggle');

  const client = page.frameLocator('.pane[data-pane="client"] iframe');
  const gestion = page.frameLocator('.pane[data-pane="gestion"] iframe');
  const salle = page.frameLocator('.pane[data-pane="salle"] iframe');

  await gestion.getByText('Service en cours').waitFor({ timeout: 20_000 });
  await salle.getByText('Mes tables').waitFor({ timeout: 20_000 });
  step('tableau de bord (patron) et application de salle (Lucas) connectes');

  // 2. Reservation client avec acompte.
  const lastName = `Verif${Date.now().toString(36).slice(-5)}`;
  await client.getByRole('button', { name: '8', exact: true }).click();
  await client.locator('.slots button').first().click({ timeout: 20_000 });
  await client.locator('#firstName').fill('Nora');
  await client.locator('#lastName').fill(lastName);
  await client.locator('#phone').fill('+33611223344');
  await client.locator('#email').fill('nora@example.com');
  await client.locator('#submit-btn').click();
  await client.locator('#pay-btn').click({ timeout: 20_000 });
  await client.locator('#pay').click({ timeout: 20_000 });
  await client.getByText(/confirmée/i).first().waitFor({ timeout: 20_000 });
  const clientUrl = await page.textContent('.pane[data-pane="client"] .pane__url');
  step(`widget : 8 couverts, acompte paye, reservation confirmee (${clientUrl.trim()})`);

  // 3. Temps reel : le tableau de bord n'a pas ete recharge.
  await gestion.getByRole('button', { name: /^Réservations$/ }).first().click().catch(() => {});
  await gestion.getByText(lastName).first().waitFor({ timeout: 20_000 });
  step('la reservation apparait dans le tableau de bord');

  // 4. Aucune double reservation, meme en rafale.
  const race = await page.evaluate(async () => {
    const host = window.OrsyneHost;
    const call = async (jar, method, url, body) => {
      const r = await host.request(jar, {
        method, url, headers: { 'content-type': 'application/json' },
        body: body === undefined ? null : JSON.stringify(body),
      });
      return { status: r.status, data: r.body ? JSON.parse(r.body) : null };
    };
    const me = await call('gestion', 'GET', '/api/me');
    const restaurantId = me.data.restaurants[0].id;
    const floor = await call('gestion', 'GET', `/api/restaurants/${restaurantId}/floor`);
    const tables = floor.data.tables ?? floor.data.zones.flatMap((z) => z.tables);
    const t1 = tables.find((t) => t.code === 'B1');
    const day = new Date(Date.now() + 7 * 86_400_000);
    const availability = await call('client', 'GET',
      `/api/public/comptoir-demo/availability?date=${day.toISOString().slice(0, 10)}&partySize=2`);
    const slots = availability.data.slots ?? availability.data;
    const slot = slots.find((s) => s.available !== false);
    const startsAt = slot.time;
    const attempts = await Promise.all(Array.from({ length: 12 }, (_, i) => call('client', 'POST',
      '/api/public/comptoir-demo/reservations', {
        partySize: 2, startsAt, tableId: t1.id,
        guest: { firstName: `Course${i}`, lastName: 'Test', phone: `+3360000${String(i).padStart(4, '0')}` },
      })));
    return { statuses: attempts.map((a) => a.status), errors: [...new Set(attempts.map((a) => a.data?.error?.message).filter(Boolean))], startsAt };
  });
  const won = race.statuses.filter((s) => s === 201 || s === 200).length;
  assert.equal(won, 1, `une seule reservation attendue sur B1, obtenu ${won} (${race.statuses.join(',')}) ${race.errors.join(' | ')}`);
  assert.ok(race.statuses.every((s) => s < 300 || s === 409), race.statuses.join(','));
  step(`12 demandes simultanees sur la table B1 a ${race.startsAt} : 1 acceptee, 11 refusees (409)`);

  const unexpected = problems.filter((p) => !/favicon/.test(p));
  assert.deepEqual(unexpected, [], 'erreurs dans la console');
  console.log('\nDemo navigateur : tout fonctionne.');
} catch (error) {
  await page.screenshot({ path: 'check-failure.png' }).catch(() => {});
  console.error('\nECHEC :', error.message);
  if (problems.length) console.error('Console :', problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
