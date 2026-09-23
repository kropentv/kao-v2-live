import { DomainError } from '../../domain/errors.js';

/**
 * Fournisseurs de messages.
 *
 * Contrat unique : `send({to, subject, text, html})` renvoie
 * `{providerRef}` ou leve. Le service metier ne sait jamais lequel est
 * branche — c'est ce qui permet de changer de fournisseur sans toucher
 * au produit (section 17 du cahier des charges).
 */

export function createConsoleMessenger({ channel, log = console.log } = {}) {
  return {
    name: 'console',
    channel,
    async send({ to, subject, text }) {
      log(`[${channel}:demo] → ${to}${subject ? ` · ${subject}` : ''}\n${text}\n`);
      return { providerRef: `demo_${Date.now().toString(36)}` };
    },
  };
}

/** Resend — API JSON simple, bon defaut pour l'email transactionnel. */
export function createResendMessenger({ apiKey, from }) {
  return {
    name: 'resend',
    channel: 'email',
    async send({ to, subject, text, html }) {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject, text, html: html ?? undefined }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new DomainError('email_provider_error', body?.message ?? `Resend: ${response.status}`);
      }
      return { providerRef: body.id ?? null };
    },
  };
}

export function createPostmarkMessenger({ token, from }) {
  return {
    name: 'postmark',
    channel: 'email',
    async send({ to, subject, text, html }) {
      const response = await fetch('https://api.postmarkapp.com/email', {
        method: 'POST',
        headers: {
          'X-Postmark-Server-Token': token,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          From: from, To: to, Subject: subject,
          TextBody: text, HtmlBody: html ?? undefined,
          MessageStream: 'outbound',
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new DomainError('email_provider_error', body?.Message ?? `Postmark: ${response.status}`);
      }
      return { providerRef: body.MessageID ?? null };
    },
  };
}

/** Twilio — SMS, et WhatsApp via le prefixe `whatsapp:`. */
export function createTwilioMessenger({ accountSid, authToken, from, channel = 'sms' }) {
  const prefix = channel === 'whatsapp' ? 'whatsapp:' : '';
  return {
    name: 'twilio',
    channel,
    async send({ to, text }) {
      const response = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
        {
          method: 'POST',
          headers: {
            authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            To: `${prefix}${to}`, From: `${prefix}${from}`, Body: text,
          }).toString(),
        },
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new DomainError('sms_provider_error', body?.message ?? `Twilio: ${response.status}`);
      }
      return { providerRef: body.sid ?? null };
    },
  };
}
