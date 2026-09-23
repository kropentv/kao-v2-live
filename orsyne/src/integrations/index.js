import { config } from '../config.js';
import { createStripeProvider } from './payments/stripe.js';
import { createConsoleProvider } from './payments/console.js';
import {
  createConsoleMessenger, createResendMessenger, createPostmarkMessenger, createTwilioMessenger,
} from './messaging/providers.js';

/**
 * Registre des integrations.
 *
 * Un seul endroit decide quel fournisseur est branche. Le reste du
 * produit appelle `payments()` ou `messenger('email')` et ne sait jamais
 * s'il parle a Stripe ou a la console : ajouter un fournisseur se fait
 * ici, sans toucher au metier.
 */
const cache = new Map();

function memo(key, build) {
  if (!cache.has(key)) cache.set(key, build());
  return cache.get(key);
}

export function payments() {
  return memo('payments', () => {
    if (config.payments.provider === 'stripe') {
      return createStripeProvider({
        secretKey: config.payments.stripeSecretKey,
        webhookSecret: config.payments.stripeWebhookSecret,
        publicUrl: config.publicUrl,
      });
    }
    return createConsoleProvider({ publicUrl: config.publicUrl });
  });
}

export function messenger(channel) {
  return memo(`messenger:${channel}`, () => {
    if (channel === 'email') {
      if (config.email.provider === 'resend') {
        return createResendMessenger({ apiKey: config.email.resendApiKey, from: config.email.from });
      }
      if (config.email.provider === 'postmark') {
        return createPostmarkMessenger({ token: config.email.postmarkToken, from: config.email.from });
      }
      return createConsoleMessenger({ channel: 'email' });
    }
    if (channel === 'sms' || channel === 'whatsapp') {
      if (config.sms.provider === 'twilio') {
        return createTwilioMessenger({
          accountSid: config.sms.twilioAccountSid,
          authToken: config.sms.twilioAuthToken,
          from: config.sms.from,
          channel,
        });
      }
      return createConsoleMessenger({ channel });
    }
    return createConsoleMessenger({ channel });
  });
}

/** Utilise par les tests pour substituer un fournisseur. */
export function overrideIntegration(key, instance) {
  cache.set(key, instance);
}

export function resetIntegrations() {
  cache.clear();
}

/** Etat des branchements, pour la page de sante et le dashboard. */
export function integrationStatus() {
  return {
    payments: { provider: payments().name, live: payments().publicConfigured },
    email: { provider: messenger('email').name },
    sms: { provider: messenger('sms').name },
  };
}
