import { config } from '../config.js';

/**
 * Durcissement HTTP.
 *
 * Ce qu'un produit exposé sur internet doit avoir avant le premier
 * client : des en-tetes qui bornent ce que le navigateur accepte, et une
 * limite de debit sur les points d'entree publics.
 */

export function securityHeaders(res, { html = false } = {}) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'SAMEORIGIN');
  res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
  res.setHeader('cross-origin-opener-policy', 'same-origin');
  // Pas de geolocalisation ni de micro : le produit n'en a aucun usage.
  res.setHeader('permissions-policy', 'geolocation=(), microphone=(), camera=(), payment=()');
  if (config.isProduction) {
    res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
  }
  if (html) {
    // Le produit n'embarque aucun script tiers : la politique peut etre
    // stricte. `unsafe-inline` reste necessaire pour les scripts de page,
    // qui sont servis depuis la meme origine et versionnes avec le code.
    res.setHeader('content-security-policy', [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'self'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '));
  }
}

/**
 * Limite de debit a fenetre glissante, en memoire du processus.
 *
 * Suffisant pour une instance, qui est le cas de la grande majorite des
 * restaurants. Derriere plusieurs instances la limite devient par
 * instance : c'est une degradation acceptable, pas une faille, et le
 * jour ou cela ne suffit plus, seul ce fichier change.
 */
export class RateLimiter {
  constructor({ windowMs = 60_000 } = {}) {
    this.windowMs = windowMs;
    this.hits = new Map();
    this.sweeper = setInterval(() => this.sweep(), windowMs);
    this.sweeper.unref?.();
  }

  /** @returns {{allowed: boolean, remaining: number, retryAfterSeconds: number}} */
  take(key, limit, now = Date.now()) {
    const cutoff = now - this.windowMs;
    const times = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (times.length >= limit) {
      this.hits.set(key, times);
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((times[0] + this.windowMs - now) / 1000)),
      };
    }
    times.push(now);
    this.hits.set(key, times);
    return { allowed: true, remaining: limit - times.length, retryAfterSeconds: 0 };
  }

  sweep(now = Date.now()) {
    const cutoff = now - this.windowMs;
    for (const [key, times] of this.hits) {
      const kept = times.filter((t) => t > cutoff);
      if (kept.length === 0) this.hits.delete(key);
      else this.hits.set(key, kept);
    }
  }

  close() { clearInterval(this.sweeper); }
}

export const limiter = new RateLimiter({ windowMs: config.rateLimit.windowMs });

/** Quel quota s'applique a ce chemin. */
export function limitFor(method, pathname) {
  if (pathname === '/api/auth/login' || pathname === '/api/auth/register') {
    return { bucket: 'auth', limit: config.rateLimit.login };
  }
  // Le widget public est la porte ouverte sur internet : c'est la qu'on
  // se protege d'un robot qui remplirait la salle de fausses tables.
  if (pathname.startsWith('/api/public/') && method === 'POST') {
    return { bucket: 'booking', limit: config.rateLimit.publicBooking };
  }
  if (pathname.startsWith('/api/')) {
    return { bucket: 'api', limit: config.rateLimit.api };
  }
  return null;
}

/**
 * Adresse du client. Derriere un proxy de confiance on lit
 * x-forwarded-for ; sinon on ignore cet en-tete, qui serait sinon un
 * moyen trivial de contourner la limite.
 */
export function clientIp(req) {
  if (config.trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return String(forwarded).split(',')[0].trim();
  }
  return req.socket?.remoteAddress ?? 'inconnu';
}
