import process from 'node:process';

/**
 * Configuration du produit.
 *
 * Tout ce qui varie entre un poste de developpement et la production
 * passe par ici, et rien d'autre. `assertProductionConfig()` refuse de
 * demarrer si un reglage indispensable manque : mieux vaut un serveur
 * qui ne demarre pas qu'un serveur qui tourne en silence sans encaisser
 * les acomptes ni envoyer les confirmations.
 */

const bool = (value, fallback = false) => {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

const int = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};


/**
 * Adresse publique. Railway et Render l'exposent dans l'environnement ;
 * un reglage explicite gagne toujours.
 */
export function resolvePublicUrl(e) {
  const explicit = e.ORSYNE_PUBLIC_URL
    ?? (e.RAILWAY_PUBLIC_DOMAIN ? `https://${e.RAILWAY_PUBLIC_DOMAIN}` : null)
    ?? e.RENDER_EXTERNAL_URL
    ?? `http://localhost:${int(e.PORT, 3000)}`;
  return explicit.replace(/\/+$/, '');
}

/**
 * Connexion applicative deduite de la connexion admin : meme serveur,
 * meme base, role orsyne_app. Evite de recopier a la main hote, port et
 * nom de base chez un hebergeur — une source d'erreur de moins.
 */
export function deriveAppUrl(adminUrl, appPassword) {
  if (!adminUrl || !appPassword) return null;
  try {
    const url = new URL(adminUrl);
    url.username = 'orsyne_app';
    url.password = appPassword;
    return url.toString();
  } catch {
    return null;
  }
}

const env = process.env;

export const config = {
  nodeEnv: env.NODE_ENV ?? 'development',
  get isProduction() { return this.nodeEnv === 'production'; },

  port: int(env.PORT, 3000),
  // Adresse publique du service : sert aux liens dans les emails et SMS,
  // et aux retours du prestataire de paiement. Les hebergeurs courants
  // l'annoncent eux-memes : un reglage de moins a oublier.
  publicUrl: resolvePublicUrl(env),

  // Deux connexions, jamais confondues :
  //   - admin : proprietaire du schema, migrations uniquement ;
  //   - app   : role orsyne_app, NOBYPASSRLS, tout le reste.
  // `DATABASE_URL`, injecte par la plupart des hebergeurs, pointe sur le
  // proprietaire : il ne sert donc QUE de connexion admin. S'en servir
  // pour l'application contournerait l'isolation entre restaurants.
  adminDatabaseUrl: env.ORSYNE_ADMIN_DATABASE_URL
    ?? env.DATABASE_URL
    ?? env.ORSYNE_DATABASE_URL
    ?? 'postgres://orsyne@localhost:5432/orsyne',
  databaseUrl: env.ORSYNE_DATABASE_URL
    ?? deriveAppUrl(env.ORSYNE_ADMIN_DATABASE_URL ?? env.DATABASE_URL, env.ORSYNE_APP_DB_PASSWORD)
    ?? 'postgres://orsyne_app@localhost:5432/orsyne',
  pgPoolMax: int(env.ORSYNE_PG_POOL_MAX, 10),
  // Migrer au demarrage convient a un conteneur unique ; sur plusieurs
  // instances, le verrou consultatif des migrations fait que seule la
  // premiere applique, les autres attendent puis constatent.
  migrateOnBoot: bool(env.ORSYNE_MIGRATE_ON_BOOT, true),

  trustProxy: bool(env.ORSYNE_TRUST_PROXY, false),
  // Derriere un reverse proxy TLS, les cookies doivent etre Secure meme
  // si le processus lui-meme ecoute en clair.
  forceSecureCookies: bool(env.ORSYNE_SECURE_COOKIES, env.NODE_ENV === 'production'),

  payments: {
    provider: env.ORSYNE_PAYMENT_PROVIDER ?? 'console',
    stripeSecretKey: env.STRIPE_SECRET_KEY ?? null,
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET ?? null,
    stripePublishableKey: env.STRIPE_PUBLISHABLE_KEY ?? null,
  },

  email: {
    provider: env.ORSYNE_EMAIL_PROVIDER ?? 'console',
    from: env.ORSYNE_EMAIL_FROM ?? 'ORSYNE <ne-pas-repondre@orsyne.local>',
    resendApiKey: env.RESEND_API_KEY ?? null,
    postmarkToken: env.POSTMARK_SERVER_TOKEN ?? null,
  },

  sms: {
    provider: env.ORSYNE_SMS_PROVIDER ?? 'console',
    from: env.ORSYNE_SMS_FROM ?? null,
    twilioAccountSid: env.TWILIO_ACCOUNT_SID ?? null,
    twilioAuthToken: env.TWILIO_AUTH_TOKEN ?? null,
  },

  jobs: {
    enabled: bool(env.ORSYNE_JOBS_ENABLED, true),
    // Rappel envoye la veille du service, a l'heure locale du restaurant.
    reminderHoursBefore: int(env.ORSYNE_REMINDER_HOURS_BEFORE, 20),
    // Au-dela, une reservation confirmee dont personne n'est arrive
    // bascule en no-show et libere la table.
    noShowAfterMinutes: int(env.ORSYNE_NO_SHOW_AFTER_MINUTES, 30),
    tickSeconds: int(env.ORSYNE_JOBS_TICK_SECONDS, 60),
  },

  rateLimit: {
    // Fenetre glissante simple, en memoire du processus. Suffisante pour
    // une instance ; derriere plusieurs, la limite devient par instance.
    windowMs: int(env.ORSYNE_RATE_WINDOW_MS, 60_000),
    login: int(env.ORSYNE_RATE_LOGIN, 10),
    publicBooking: int(env.ORSYNE_RATE_BOOKING, 20),
    api: int(env.ORSYNE_RATE_API, 600),
  },
};

/** Manques qui rendraient la production silencieusement inoperante. */
export function productionConfigProblems(c = config) {
  const problems = [];

  if (c.databaseUrl.includes('@localhost') && c.isProduction) {
    problems.push('ORSYNE_DATABASE_URL pointe encore sur localhost.');
  }
  if (!c.publicUrl.startsWith('https://') && c.isProduction) {
    problems.push('ORSYNE_PUBLIC_URL doit etre une adresse https en production.');
  }
  if (c.payments.provider === 'stripe') {
    if (!c.payments.stripeSecretKey) problems.push('STRIPE_SECRET_KEY manquant.');
    if (!c.payments.stripeWebhookSecret) problems.push('STRIPE_WEBHOOK_SECRET manquant : les paiements ne seraient jamais confirmes.');
  }
  if (c.email.provider === 'resend' && !c.email.resendApiKey) problems.push('RESEND_API_KEY manquant.');
  if (c.email.provider === 'postmark' && !c.email.postmarkToken) problems.push('POSTMARK_SERVER_TOKEN manquant.');
  if (c.sms.provider === 'twilio') {
    if (!c.sms.twilioAccountSid || !c.sms.twilioAuthToken) problems.push('Identifiants Twilio manquants.');
    if (!c.sms.from) problems.push('ORSYNE_SMS_FROM manquant : Twilio refuserait chaque envoi.');
  }
  if (c.isProduction && c.payments.provider === 'console') {
    problems.push('Le prestataire de paiement est « console » : aucun acompte ne serait reellement encaisse.');
  }
  return problems;
}

/** Appele au demarrage. En production, un manque est fatal. */
export function assertProductionConfig({ log = console.error } = {}) {
  const problems = productionConfigProblems();
  if (problems.length === 0) return true;
  if (!config.isProduction) {
    log(`[orsyne] configuration incomplete (${problems.length}) — mode ${config.nodeEnv}, on continue :`);
    for (const p of problems) log(`  · ${p}`);
    return true;
  }
  log('[orsyne] demarrage refuse — configuration de production incomplete :');
  for (const p of problems) log(`  · ${p}`);
  return false;
}
