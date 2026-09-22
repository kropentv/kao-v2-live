import process from 'node:process';

export const config = {
  databaseUrl: process.env.ORSYNE_DATABASE_URL
    ?? process.env.DATABASE_URL
    ?? 'postgres://orsyne_app@localhost:5432/orsyne',
  // URL privilegiee, utilisee uniquement par les migrations et l'outillage.
  adminDatabaseUrl: process.env.ORSYNE_ADMIN_DATABASE_URL
    ?? process.env.ORSYNE_DATABASE_URL
    ?? 'postgres://orsyne@localhost:5432/orsyne',
  nodeEnv: process.env.NODE_ENV ?? 'development',
};
