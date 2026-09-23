import { DomainError } from '../domain/errors.js';

/** Routeur minimal : motifs `/restaurants/:id/tables`, sans dependance. */
export class Router {
  constructor() { this.routes = []; }

  add(method, pattern, handler, options = {}) {
    const names = [];
    const regex = new RegExp(`^${pattern
      .replace(/\/:([A-Za-z_]+)/g, (_, name) => { names.push(name); return '/([^/]+)'; })
      .replace(/\*$/, '.*')}$`);
    this.routes.push({ method, regex, names, handler, options });
    return this;
  }

  get(p, h, o) { return this.add('GET', p, h, o); }
  post(p, h, o) { return this.add('POST', p, h, o); }
  patch(p, h, o) { return this.add('PATCH', p, h, o); }
  put(p, h, o) { return this.add('PUT', p, h, o); }
  delete(p, h, o) { return this.add('DELETE', p, h, o); }

  match(method, pathname) {
    let pathExists = false;
    for (const route of this.routes) {
      const match = route.regex.exec(pathname);
      if (!match) continue;
      pathExists = true;
      if (route.method !== method) continue;
      const params = {};
      route.names.forEach((name, i) => { params[name] = decodeURIComponent(match[i + 1]); });
      return { route, params };
    }
    // Distinguer « chemin inconnu » de « methode interdite » evite de
    // faire croire a un bug de route lors d'une erreur de verbe.
    return pathExists ? { methodNotAllowed: true } : null;
  }
}

export class HttpError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (m, d) => new HttpError(400, 'bad_request', m, d);
export const unauthorized = (m = 'Authentification requise.') => new HttpError(401, 'unauthorized', m);
export const forbidden = (m = 'Acces refuse.') => new HttpError(403, 'forbidden', m);
export const notFound = (m = 'Ressource introuvable.') => new HttpError(404, 'not_found', m);

/** Traduit une erreur metier en reponse HTTP, sans fuite d'interne. */
const DOMAIN_STATUS = {
  no_availability: 409,
  table_unavailable: 409,
  restaurant_closed: 422,
  booking_rule_violation: 422,
  invalid_transition: 409,
  reservation_not_found: 404,
  invalid_party_size: 400,
  invalid_start: 400,
  weak_password: 400,
  invalid_credentials: 401,
  invitation_pending: 403,
  already_exists: 409,
};

export function toHttpError(error) {
  if (error instanceof HttpError) return error;
  if (error instanceof DomainError) {
    return new HttpError(DOMAIN_STATUS[error.code] ?? 400, error.code, error.message, error.details);
  }
  // Contrainte d'exclusion remontee brute : c'est un conflit, pas un bug.
  if (error.code === '23P01') {
    return new HttpError(409, 'table_unavailable', "La table vient d'etre prise.");
  }
  if (error.code === '23505') {
    return new HttpError(409, 'already_exists', 'Cette ressource existe deja.');
  }
  if (error.code === '42501') {
    return new HttpError(403, 'forbidden', 'Acces refuse.');
  }
  return null;
}

export async function readJson(req, { limit = 1_000_000 } = {}) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw badRequest('Corps de requete trop volumineux.');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw badRequest('JSON invalide.');
  }
}

export function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

export function sessionCookie(token, expiresAt, { secure = false } = {}) {
  const attributes = [
    `orsyne_session=${token}`,
    'Path=/',
    'HttpOnly',
    // Lax plutot que Strict : la confirmation par email renvoie vers
    // l'application, et Strict casserait cette navigation.
    'SameSite=Lax',
    `Expires=${expiresAt.toUTCString()}`,
  ];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}

export const clearedSessionCookie =
  'orsyne_session=; Path=/; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT';

/**
 * Pour les effets secondaires qui ne doivent pas faire echouer la requete
 * (message au client, proposition de liste d'attente) : l'echec n'annule
 * rien, mais il n'est JAMAIS silencieux. Un `.catch(() => {})` a deja
 * cache ici un envoi de confirmations qui ne partait plus du tout.
 */
export function reportSideEffect(label) {
  return (error) => {
    console.error(`[orsyne] ${label} en echec :`, error?.message ?? error);
  };
}
