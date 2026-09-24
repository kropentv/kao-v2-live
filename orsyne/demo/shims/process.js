/** Variables d'environnement de la demo : fournisseurs « console », aucun envoi reel. */
const env = {
  NODE_ENV: 'development',
  ORSYNE_PUBLIC_URL: 'https://orsyne.demo',
  ORSYNE_PAYMENT_PROVIDER: 'console',
  ORSYNE_EMAIL_PROVIDER: 'console',
  ORSYNE_SMS_PROVIDER: 'console',
  ORSYNE_JOBS_TICK_SECONDS: '30',
};
const processShim = globalThis.process?.versions?.node ? globalThis.process : {
  env, argv: [], versions: {}, platform: 'browser',
  on() {}, exit() {}, cwd: () => '/', nextTick: (fn, ...a) => queueMicrotask(() => fn(...a)),
};
export default processShim;
export { env };
