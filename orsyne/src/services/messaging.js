import { messenger } from '../integrations/index.js';
import { config } from '../config.js';
import { utcToZonedParts } from '../lib/time.js';

/**
 * Messages au client (sections 14 et 21).
 *
 * Trois regles tenues ici, et nulle part ailleurs :
 *   1. La langue du message est celle du profil client, pas celle du
 *      restaurant ni du navigateur du serveur.
 *   2. Un message marketing exige un consentement enregistre. Un message
 *      transactionnel (confirmation, rappel) n'en a pas besoin : il
 *      execute le contrat que le client vient de passer.
 *   3. Tout envoi est trace dans guest_messages, reussite comme echec —
 *      c'est la preuve en cas de litige et la matiere des statistiques.
 */

const LOCALES = {
  'fr': {
    confirmed: {
      subject: (c) => `Réservation confirmée — ${c.restaurant}`,
      text: (c) => [
        `Bonjour ${c.firstName || ''},`.trim(),
        ``,
        `Votre table est confirmée chez ${c.restaurant}.`,
        ``,
        `  ${c.date} à ${c.time}`,
        `  ${c.partySize} personne${c.partySize > 1 ? 's' : ''}`,
        `  Référence : ${c.reference}`,
        c.allergies.length ? `  Allergies transmises : ${c.allergies.join(', ')}` : null,
        ``,
        `Modifier ou annuler : ${c.manageUrl}`,
        c.allergies.length
          ? `Pensez à rappeler vos allergies à votre serveur en arrivant : c'est la confirmation de vive voix qui fait foi en cuisine.`
          : null,
        ``,
        `À très bientôt,`,
        c.restaurant,
      ].filter((l) => l !== null).join('\n'),
    },
    pending_payment: {
      subject: (c) => `Votre table est maintenue — ${c.restaurant}`,
      text: (c) => [
        `Bonjour ${c.firstName || ''},`.trim(),
        ``,
        `Nous gardons votre table pour ${c.date} à ${c.time}.`,
        `Il reste à régler ${c.amount} pour confirmer définitivement.`,
        ``,
        `  ${c.payUrl}`,
        ``,
        `Sans règlement, la table sera remise à la disposition d'autres clients.`,
        ``,
        c.restaurant,
      ].join('\n'),
    },
    reminder: {
      subject: (c) => `Demain, ${c.time} — ${c.restaurant}`,
      text: (c) => [
        `Bonjour ${c.firstName || ''},`.trim(),
        ``,
        `Petit rappel : nous vous attendons demain à ${c.time}, ${c.partySize} personne${c.partySize > 1 ? 's' : ''}.`,
        c.allergies.length ? `Vos allergies sont notées : ${c.allergies.join(', ')}.` : null,
        ``,
        `Un empêchement ? Prévenez-nous ici : ${c.manageUrl}`,
        ``,
        c.restaurant,
      ].filter((l) => l !== null).join('\n'),
    },
    cancelled: {
      subject: (c) => `Réservation annulée — ${c.restaurant}`,
      text: (c) => [
        `Bonjour ${c.firstName || ''},`.trim(),
        ``,
        `Votre réservation du ${c.date} à ${c.time} (${c.reference}) a bien été annulée.`,
        `Au plaisir de vous accueillir une prochaine fois.`,
        ``,
        c.restaurant,
      ].join('\n'),
    },
    waitlist_offer: {
      subject: (c) => `Une table s'est libérée — ${c.restaurant}`,
      text: (c) => [
        `Bonjour ${c.firstName || ''},`.trim(),
        ``,
        `Une table pour ${c.partySize} vient de se libérer le ${c.date} à ${c.time}.`,
        `Elle vous est réservée jusqu'à ${c.expiresAt}.`,
        ``,
        `  Accepter : ${c.acceptUrl}`,
        ``,
        c.restaurant,
      ].join('\n'),
    },
  },
  'en': {
    confirmed: {
      subject: (c) => `Booking confirmed — ${c.restaurant}`,
      text: (c) => [
        `Hello ${c.firstName || ''},`.trim(),
        ``,
        `Your table at ${c.restaurant} is confirmed.`,
        ``,
        `  ${c.date} at ${c.time}`,
        `  ${c.partySize} guest${c.partySize > 1 ? 's' : ''}`,
        `  Reference: ${c.reference}`,
        c.allergies.length ? `  Allergies on file: ${c.allergies.join(', ')}` : null,
        ``,
        `Change or cancel: ${c.manageUrl}`,
        c.allergies.length
          ? `Please remind your server about your allergies on arrival — the kitchen acts on the spoken confirmation.`
          : null,
        ``,
        `See you soon,`,
        c.restaurant,
      ].filter((l) => l !== null).join('\n'),
    },
    pending_payment: {
      subject: (c) => `Your table is being held — ${c.restaurant}`,
      text: (c) => [
        `Hello ${c.firstName || ''},`.trim(), ``,
        `We are holding your table for ${c.date} at ${c.time}.`,
        `${c.amount} is still due to confirm it.`, ``,
        `  ${c.payUrl}`, ``,
        `Without payment the table returns to other guests.`, ``,
        c.restaurant,
      ].join('\n'),
    },
    reminder: {
      subject: (c) => `Tomorrow, ${c.time} — ${c.restaurant}`,
      text: (c) => [
        `Hello ${c.firstName || ''},`.trim(), ``,
        `A quick reminder: we look forward to seeing you tomorrow at ${c.time}, ${c.partySize} guest${c.partySize > 1 ? 's' : ''}.`,
        c.allergies.length ? `Your allergies are on file: ${c.allergies.join(', ')}.` : null,
        ``, `Something came up? Let us know: ${c.manageUrl}`, ``,
        c.restaurant,
      ].filter((l) => l !== null).join('\n'),
    },
    cancelled: {
      subject: (c) => `Booking cancelled — ${c.restaurant}`,
      text: (c) => [
        `Hello ${c.firstName || ''},`.trim(), ``,
        `Your booking on ${c.date} at ${c.time} (${c.reference}) has been cancelled.`,
        `We hope to welcome you another time.`, ``,
        c.restaurant,
      ].join('\n'),
    },
    waitlist_offer: {
      subject: (c) => `A table just opened — ${c.restaurant}`,
      text: (c) => [
        `Hello ${c.firstName || ''},`.trim(), ``,
        `A table for ${c.partySize} just opened on ${c.date} at ${c.time}.`,
        `It is held for you until ${c.expiresAt}.`, ``,
        `  Accept: ${c.acceptUrl}`, ``,
        c.restaurant,
      ].join('\n'),
    },
  },
};

/** Repli sur le francais : la langue du produit, jamais une page vide. */
function templatesFor(locale) {
  const short = String(locale ?? 'fr').slice(0, 2).toLowerCase();
  return LOCALES[short] ?? LOCALES.fr;
}

export function renderMessage(template, locale, context) {
  const set = templatesFor(locale);
  const tpl = set[template] ?? LOCALES.fr[template];
  if (!tpl) throw new Error(`Gabarit inconnu : ${template}`);
  return { subject: tpl.subject(context), text: tpl.text(context) };
}

function formatDateTime(instant, timeZone, locale) {
  const tag = String(locale ?? 'fr').slice(0, 2).toLowerCase() === 'en' ? 'en-GB' : 'fr-FR';
  return {
    date: new Date(instant).toLocaleDateString(tag, {
      weekday: 'long', day: 'numeric', month: 'long', timeZone,
    }),
    time: new Date(instant).toLocaleTimeString(tag, {
      hour: '2-digit', minute: '2-digit', timeZone,
    }),
  };
}

/** Le consentement n'est exige que pour le marketing. */
async function consentGranted(client, { guestId, channel, purpose }) {
  if (purpose !== 'marketing') return true;
  if (!guestId) return false;
  const { rows } = await client.query(
    `SELECT granted FROM guest_consents
      WHERE guest_id = $1 AND channel = $2 AND purpose = 'marketing'`,
    [guestId, channel],
  );
  return rows[0]?.granted === true;
}

/**
 * Envoie un message a un client et le trace.
 * Ne leve jamais : un fournisseur en panne ne doit pas faire echouer la
 * reservation qui a declenche l'envoi.
 */
export async function sendGuestMessage(client, {
  tenantId, restaurantId, guestId, reservationId = null,
  channel, purpose = 'transactional', template, context, locale,
}) {
  const allowed = await consentGranted(client, { guestId, channel, purpose });
  if (!allowed) {
    await record(client, {
      tenantId, restaurantId, guestId, reservationId, channel, purpose, locale,
      template, body: '(non envoyé : consentement marketing absent)',
      status: 'blocked', provider: null, providerRef: null,
      failureReason: 'consentement marketing absent',
    });
    return { sent: false, reason: 'no_consent' };
  }

  const { subject, text } = renderMessage(template, locale, context);
  const transport = messenger(channel);

  try {
    const result = await transport.send({ to: context.to, subject, text });
    await record(client, {
      tenantId, restaurantId, guestId, reservationId, channel, purpose, locale,
      template, body: text, status: 'sent',
      provider: transport.name, providerRef: result.providerRef ?? null, failureReason: null,
    });
    return { sent: true, provider: transport.name, subject, text };
  } catch (error) {
    await record(client, {
      tenantId, restaurantId, guestId, reservationId, channel, purpose, locale,
      template, body: text, status: 'failed',
      provider: transport.name, providerRef: null,
      failureReason: String(error?.message ?? error).slice(0, 500),
    });
    return { sent: false, reason: 'provider_error', error: error?.message };
  }
}

async function record(client, m) {
  await client.query(
    `INSERT INTO guest_messages
       (tenant_id, restaurant_id, guest_id, reservation_id, channel, direction,
        purpose, locale, template, body, status, provider, provider_ref,
        failure_reason, sent_at)
     VALUES ($1,$2,$3,$4,$5::consent_channel,'outbound',$6::consent_purpose,$7,$8,$9,
             $10::message_status,$11,$12,$13,
             CASE WHEN $10::message_status = 'sent' THEN now() ELSE NULL END)`,
    [m.tenantId, m.restaurantId, m.guestId, m.reservationId, m.channel,
     m.purpose, m.locale ?? 'fr-FR', m.template, m.body, m.status,
     m.provider, m.providerRef, m.failureReason],
  );
}

/**
 * Prepare le contexte d'un message a partir d'une reservation.
 * Choisit aussi le canal : email si on en a un, sinon SMS.
 */
export async function buildReservationContext(client, reservationId) {
  const { rows: [row] } = await client.query(
    `SELECT r.id, r.reference, r.party_size, r.starts_at, r.status, r.locale,
            r.tenant_id, r.restaurant_id, r.guest_id,
            rest.name AS restaurant_name, rest.timezone, rest.slug, rest.currency,
            g.first_name, g.last_name, g.email, g.phone_e164, g.locale AS guest_locale,
            COALESCE((SELECT array_agg(p.value ORDER BY p.value)
                        FROM guest_preferences p
                       WHERE p.guest_id = g.id AND p.is_critical AND p.kind = 'allergy'),
                     '{}') AS allergies
       FROM reservations r
       JOIN restaurants rest ON rest.id = r.restaurant_id
       LEFT JOIN guests g ON g.id = r.guest_id
      WHERE r.id = $1`,
    [reservationId],
  );
  if (!row) return null;

  // La langue du client prime sur celle de l'etablissement.
  const locale = row.guest_locale ?? row.locale ?? 'fr-FR';
  const { date, time } = formatDateTime(row.starts_at, row.timezone, locale);
  const manageUrl = `${config.publicUrl}/r/${row.slug}?ref=${row.reference}`;

  const channel = row.email ? 'email' : row.phone_e164 ? 'sms' : null;
  return {
    row, locale, channel,
    to: row.email ?? row.phone_e164 ?? null,
    context: {
      to: row.email ?? row.phone_e164 ?? '',
      firstName: row.first_name ?? '',
      restaurant: row.restaurant_name,
      reference: row.reference,
      partySize: row.party_size,
      date, time,
      allergies: row.allergies ?? [],
      manageUrl,
      payUrl: manageUrl,
      amount: '',
    },
  };
}

/** Confirmation, rappel ou annulation — le chemin commun. */
export async function notifyReservation(client, { reservationId, template, extra = {} }) {
  const prepared = await buildReservationContext(client, reservationId);
  if (!prepared || !prepared.channel) return { sent: false, reason: 'no_contact' };

  return sendGuestMessage(client, {
    tenantId: prepared.row.tenant_id,
    restaurantId: prepared.row.restaurant_id,
    guestId: prepared.row.guest_id,
    reservationId,
    channel: prepared.channel,
    purpose: 'transactional',
    template,
    locale: prepared.locale,
    context: { ...prepared.context, ...extra },
  });
}

export { utcToZonedParts };
