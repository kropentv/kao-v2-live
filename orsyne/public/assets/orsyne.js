/* =====================================================================
   ORSYNE — utilitaires partages par les trois interfaces.
   Aucune dependance, aucune etape de build.
   ===================================================================== */

/** Appel API. Renvoie toujours {status, data} ; ne leve que sur reseau. */
export async function api(method, path, body) {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  const text = await response.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  return { status: response.status, ok: response.ok, data };
}

export const get = (path) => api('GET', path);
export const post = (path, body) => api('POST', path, body ?? {});
export const patch = (path, body) => api('PATCH', path, body ?? {});
export const del = (path) => api('DELETE', path);

/** Message d'erreur lisible, jamais un objet brut a l'ecran. */
export function errorMessage(result, fallback = 'Une erreur est survenue.') {
  return result?.data?.error?.message ?? fallback;
}

export function toast(message, kind = '') {
  let host = document.querySelector('.toast-host');
  if (!host) {
    host = document.createElement('div');
    host.className = 'toast-host';
    document.body.append(host);
  }
  const el = document.createElement('div');
  el.className = `toast ${kind ? `toast--${kind}` : ''}`;
  el.textContent = message;
  el.setAttribute('role', 'status');
  host.append(el);
  setTimeout(() => el.remove(), 4200);
}

/** Echappement systematique : aucune donnee serveur n'entre en innerHTML. */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** Heure locale du restaurant, jamais celle du navigateur. */
export function formatTime(iso, timeZone) {
  return new Date(iso).toLocaleTimeString('fr-FR', {
    hour: '2-digit', minute: '2-digit', timeZone,
  });
}

export function formatDate(iso, timeZone) {
  return new Date(iso).toLocaleDateString('fr-FR', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone,
  });
}

export function formatMoney(cents, currency = 'EUR') {
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency }).format(cents / 100);
}

export const STATUS_LABELS = {
  draft: 'Brouillon',
  pending_payment: 'Acompte en attente',
  pending_approval: 'À valider',
  confirmed: 'Confirmée',
  arrived: 'Arrivé',
  seated: 'À table',
  completed: 'Terminée',
  cancelled: 'Annulée',
  no_show: 'No-show',
};

export const TABLE_STATUS_LABELS = {
  available: 'Libre',
  reserved: 'Réservée',
  guest_expected: 'Client attendu',
  seated: 'Installé',
  ordered: 'Commande passée',
  in_service: 'En service',
  check_requested: 'Addition',
  finished: 'Terminée',
  cleaning: 'Nettoyage',
  unavailable: 'Indisponible',
};

export function statusTag(status) {
  const tone = {
    confirmed: 'accent', arrived: 'amber', seated: 'ok',
    completed: '', cancelled: '', no_show: 'danger',
    pending_payment: 'warn', pending_approval: 'warn',
  }[status] ?? '';
  return el('span', { class: `tag ${tone ? `tag--${tone}` : ''}`, text: STATUS_LABELS[status] ?? status });
}

/**
 * Abonnement au flux temps reel, avec reconnexion automatique.
 * En plein service, une coupure reseau ne doit pas laisser le dashboard
 * figer sur un etat perime sans que personne ne le voie.
 */
export function connectStream(restaurantId, handlers = {}) {
  let source = null;
  let retryMs = 1000;
  let closed = false;

  const open = () => {
    if (closed) return;
    source = new EventSource(`/api/restaurants/${restaurantId}/stream`);

    source.addEventListener('open', () => {
      retryMs = 1000;
      handlers.onStatus?.(true);
    });

    source.addEventListener('error', () => {
      handlers.onStatus?.(false);
      source?.close();
      if (closed) return;
      setTimeout(open, retryMs);
      // Recul exponentiel plafonne : on ne matraque pas un serveur qui
      // redemarre, mais on revient vite quand c'est un simple hoquet.
      retryMs = Math.min(retryMs * 2, 20_000);
    });

    for (const [topic, handler] of Object.entries(handlers.on ?? {})) {
      source.addEventListener(topic, (event) => {
        try { handler(JSON.parse(event.data)); } catch { /* trame partielle */ }
      });
    }
  };

  open();
  return { close() { closed = true; source?.close(); } };
}

/** Date du jour au format YYYY-MM-DD, dans le fuseau donne. */
export function todayIso(timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
