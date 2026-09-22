# ORSYNE

### Tout s'accorde.

Le système d'exploitation du restaurant : réservations, plan de salle,
équipes, clients et IA dans un seul système — connecté à la caisse que le
restaurant a déjà, pas à la place.

> ORSYNE ne remplace pas le POS. Le POS reste le système de référence pour
> l'encaissement, la fiscalité et la comptabilité. ORSYNE orchestre tout ce
> qui se passe autour.

## État du projet

Étape 1 (architecture, schéma, multi-tenant) et le cœur de l'étape 4
(moteur de réservation) sont livrés et testés. Voir
[`docs/03-roadmap.md`](docs/03-roadmap.md).

## Démarrer

Prérequis : PostgreSQL 16+ (extensions `pgcrypto`, `btree_gist`, `citext`)
et Node.js 20+.

```bash
npm install

# Base de développement locale, jetable
./scripts/dev-db.sh start

# Schéma + jeu de démonstration
export $(grep -v '^#' .env.example | xargs)
npm run migrate
npm run seed
```

## Tests

```bash
./scripts/dev-db.sh start
./scripts/dev-db.sh test
```

Le test qui compte est `test/reservation-engine.test.js` :
*« deux clients ne peuvent jamais obtenir la même table »* lance 25
réservations simultanées sur un restaurant à table unique et vérifie, dans
la base et non via le code métier, qu'exactement une aboutit.

## Structure

```
db/migrations/     schéma versionné, une transaction par fichier
src/db/            pool, contexte tenant (RLS), migrations
src/lib/           fuseaux horaires et utilitaires purs
src/domain/        disponibilité, moteur de réservation, attribution
test/              46 tests (node --test)
docs/              marque, architecture, feuille de route
```

## Les règles du projet

1. **Une table, un convive, à un instant donné** — garanti par une
   contrainte de base, jamais par du code applicatif.
2. **Toute donnée métier porte `tenant_id`** et la RLS est forcée.
3. **Faits et déductions IA ne partagent jamais de table.**
4. **Acompte, préautorisation et paiement final sont trois objets
   distincts.**
5. **L'IA propose, l'humain décide** — une attribution manuelle
   court-circuite toujours le scoring.

Détail dans [`docs/02-architecture.md`](docs/02-architecture.md).
