import { startServer } from '../../src/api/server.js';
import { outboxWorker } from '../../src/services/outbox-worker.js';

/** Client HTTP de test : conserve le cookie de session entre les appels. */
export class ApiClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.cookie = null;
  }

  async request(method, path, body, { raw = false } = {}) {
    const headers = { 'content-type': 'application/json' };
    if (this.cookie) headers.cookie = this.cookie;
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    if (raw) return response;
    const text = await response.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch { data = text; } }
    return { status: response.status, data, headers: response.headers };
  }

  get(path, options) { return this.request('GET', path, undefined, options); }
  post(path, body, options) { return this.request('POST', path, body ?? {}, options); }
  patch(path, body) { return this.request('PATCH', path, body ?? {}); }
  delete(path) { return this.request('DELETE', path); }
}

export async function startTestServer() {
  // Port 0 : le systeme attribue un port libre, les fichiers de test
  // peuvent donc tourner en parallele sans se disputer une adresse.
  const instance = await startServer({ port: 0, withWorker: false });
  return {
    ...instance,
    url: `http://127.0.0.1:${instance.port}`,
    client: () => new ApiClient(`http://127.0.0.1:${instance.port}`),
    /** Vide l'outbox a la demande, pour tester sans attendre le worker. */
    drainOutbox: () => outboxWorker.tick(),
  };
}
