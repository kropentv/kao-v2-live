/**
 * Construit la demo navigateur dans demo/dist :
 *   - orsyne-backend.js : le vrai serveur ORSYNE + PGlite, en un module ;
 *   - orsyne-client.js  : les utilitaires des interfaces (public/assets) ;
 *   - index.html        : la coque qui affiche les trois vraies interfaces ;
 *   - pglite.wasm/.data et extensions PostgreSQL (btree_gist, citext).
 *
 * Les pages de public/ ne sont pas recopiees a la main : elles sont lues
 * ici et seulement adaptees au bac a sable (adresse virtuelle, styles
 * integres). Toute evolution du produit se retrouve donc dans la demo.
 */
import { build } from 'esbuild';
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const dist = join(here, 'dist');
const pglite = join(here, 'node_modules', '@electric-sql', 'pglite', 'dist');

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

// 1. Migrations : les fichiers SQL du produit, embarques tels quels.
const migrationsDir = join(root, 'db', 'migrations');
const migrations = [];
for (const name of (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort()) {
  migrations.push({ name, sql: await readFile(join(migrationsDir, name), 'utf8') });
}
await writeFile(join(here, 'browser', 'migrations.generated.js'),
  `// Genere par build.mjs depuis db/migrations — ne pas modifier.\nexport const MIGRATIONS = ${JSON.stringify(migrations)};\n`);

// Extensions PostgreSQL embarquees dans le module : le lecteur d'artefacts
// ne sert pas les archives .tar.gz.
const extensions = {};
for (const name of ['btree_gist', 'citext']) {
  extensions[name] = (await readFile(join(pglite, `${name}.tar.gz`))).toString('base64');
}
await writeFile(join(here, 'browser', 'extensions.generated.js'),
  `// Genere par build.mjs depuis @electric-sql/pglite — ne pas modifier.\nexport const EXTENSIONS = ${JSON.stringify(extensions)};\n`);

// 2. Le serveur : src/ inchange, modules Node remplaces par des equivalents navigateur.
const shim = (file) => join(here, 'shims', file);
await build({
  entryPoints: [join(here, 'browser', 'backend.js')],
  outfile: join(dist, 'orsyne-backend.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  legalComments: 'none',
  alias: {
    pg: shim('pg.js'),
    'node:crypto': shim('crypto.js'),
    'node:util': shim('util.js'),
    'node:process': shim('process.js'),
    'node:http': shim('node-stubs.js'),
    'node:fs': shim('node-stubs.js'),
    'node:fs/promises': shim('node-stubs.js'),
    'node:path': shim('node-stubs.js'),
    'node:url': shim('node-stubs.js'),
  },
  inject: [shim('globals.js')],
  plugins: [{
    // PGlite importe fs et path pour son mode Node, jamais execute ici.
    name: 'modules-node-absents',
    setup(b) {
      b.onResolve({ filter: /^(fs|path)$/ }, () => ({ path: shim('empty.js') }));
    },
  }],
  external: ['fs/promises', 'url', 'zlib', 'module', 'crypto', 'child_process', 'os', 'stream', 'util', 'worker_threads'],
  logLevel: 'warning',
});

// 3. Moteur PostgreSQL. L'image du systeme de fichiers (pglite.data) est
// publiee sous une extension binaire servie par le lecteur d'artefacts ;
// la page la lit en octets bruts, le nom n'a pas d'autre effet.
await copyFile(join(pglite, 'pglite.wasm'), join(dist, 'pglite.wasm'));
await copyFile(join(pglite, 'pglite.data'), join(dist, 'pglite-data.wasm'));

// 4. Interfaces : public/ adapte au bac a sable.
const css = await readFile(join(root, 'public', 'assets', 'orsyne.css'), 'utf8');
await writeFile(join(dist, 'orsyne-client.js'),
  await readFile(join(root, 'public', 'assets', 'orsyne.js'), 'utf8'));

function mustReplace(source, pattern, replacement, label) {
  const next = source.replace(pattern, replacement);
  if (next === source) throw new Error(`Adaptation impossible (${label}) : le motif a change.`);
  return next;
}

function adapt(html, label) {
  let out = mustReplace(html, /<link rel="stylesheet" href="\/assets\/orsyne\.css">/,
    () => `<style>${css}</style>`, `${label}: feuille de style`);
  out = out.replace(/<link rel="manifest"[^>]*>/, '');
  out = mustReplace(out, /from '\/assets\/orsyne\.js'/g, "from '__CLIENT_URL__'", `${label}: module client`);
  // Le document tourne dans une iframe « srcdoc » : son adresse reelle ne
  // veut rien dire. On lui donne l'adresse virtuelle de l'interface.
  out = out.replace(/\blocation\./g, '__vloc.').replace(/\bhistory\.replaceState\(/g, '__vhistory.replaceState(');
  return out;
}

const screens = {
  widget: adapt(await readFile(join(root, 'public', 'index.html'), 'utf8'), 'widget'),
  dashboard: adapt(await readFile(join(root, 'public', 'app', 'index.html'), 'utf8'), 'dashboard'),
  salle: adapt(await readFile(join(root, 'public', 'app', 'salle.html'), 'utf8'), 'salle'),
  css,
};

const shell = await readFile(join(here, 'browser', 'shell.html'), 'utf8');
const screensJson = JSON.stringify(screens).replace(/</g, '\\u003c');
await writeFile(join(dist, 'index.html'), mustReplace(shell, '__SCREENS_JSON__', () => screensJson, 'coque'));

const listing = await readdir(dist);
console.log(`Demo construite dans demo/dist : ${listing.join(', ')}`);
