/** Modules serveur inutiles dans le navigateur : le routage HTTP est fait par la page. */
const unavailable = (name) => () => { throw new Error(`${name} indisponible dans le navigateur`); };
export const createServer = unavailable('http.createServer');
export const createReadStream = unavailable('fs.createReadStream');
export const stat = async () => null;
export const readdir = async () => [];
export const readFile = unavailable('fs.readFile');
export const dirname = (p) => p.split('/').slice(0, -1).join('/') || '/';
export const join = (...parts) => parts.join('/').replace(/\/+/g, '/');
export const normalize = (p) => p;
export const extname = (p) => (p.match(/\.[^./]*$/) ?? [''])[0];
export const fileURLToPath = () => '/orsyne/src/api/server.js';
export default { createServer, createReadStream, stat, readdir, readFile, dirname, join, normalize, extname, fileURLToPath };
