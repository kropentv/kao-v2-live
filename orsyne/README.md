# ORSYNE

### Tout s'accorde.

Le système d'exploitation du restaurant : réservations, plan de salle,
équipes, clients et IA dans un seul système — connecté à la caisse que le
restaurant a déjà, pas à la place.

> ORSYNE ne remplace pas le POS. Le POS reste le système de référence pour
> l'encaissement, la fiscalité et la comptabilité. ORSYNE orchestre tout ce
> qui se passe autour.

## Ce qui tourne aujourd'hui

Un produit complet et fonctionnel, de la réservation client jusqu'à la
table nettoyée.

| | |
|---|---|
| **Widget client** | Disponibilité en direct, choix de zone, acompte, confirmation, annulation par référence |
| **Dashboard manager** | Service temps réel, plan de salle, réservations, CRM, équipe, analytics |
| **Application de salle** | Les tables du serveur, ses alertes, la fiche client — rien d'autre |
| **API** | 45 routes, authentification par session, RBAC à 5 rôles |
| **Temps réel** | SSE alimenté par un outbox transactionnel, reconnexion automatique |

**81 tests automatisés, tous verts.**

## Démarrer

Prérequis : PostgreSQL 16+ (`pgcrypto`, `btree_gist`, `citext`) et Node.js 20+.

```bash
npm install
./scripts/dev-db.sh start        # base de développement locale, jetable

export ORSYNE_ADMIN_DATABASE_URL=postgres://orsyne@127.0.0.1:5433/orsyne_dev
export ORSYNE_DATABASE_URL=postgres://orsyne_app@127.0.0.1:5433/orsyne_dev

npm run migrate
npm run seed                     # restaurant de démonstration complet
npm start                        # http://localhost:3000
```

`npm run seed` affiche les URL et les comptes de démonstration
(propriétaire, manager, trois serveurs).

| Interface | Adresse |
|---|---|
| Widget client | `/r/comptoir-demo` |
| Dashboard | `/app/` |
| Application de salle | `/app/salle.html` |

## Tests

```bash
./scripts/dev-db.sh test
```

Le test qui compte est dans `test/reservation-engine.test.js` :
*« deux clients ne peuvent jamais obtenir la même table »* lance 25
réservations simultanées sur un restaurant à table unique et vérifie, dans
la base et non via le code métier, qu'exactement une aboutit.

## Structure

```
db/migrations/     schéma versionné, une transaction par fichier
src/domain/        moteur de réservation, disponibilité, attribution (pur)
src/services/      auth, attribution serveur, briefing client, outbox
src/api/           routeur HTTP, RBAC, routes
src/realtime/      diffusion SSE
public/            widget client, dashboard, application de salle
test/              81 tests (node --test)
docs/              marque, architecture, feuille de route
```

## Les règles du projet

1. **Une table, un convive, à un instant donné** — garanti par une
   contrainte de base, jamais par du code applicatif.
2. **Toute donnée métier porte `tenant_id`** et la RLS est forcée. Le rôle
   applicatif est créé `NOBYPASSRLS` : aucune exception, même pour le
   worker d'événements.
3. **Faits et déductions IA ne partagent jamais de table**, ni même une
   liste à l'écran.
4. **Acompte, préautorisation et paiement final sont trois objets
   distincts.**
5. **L'IA propose, l'humain décide** — une attribution manuelle
   court-circuite toujours le scoring.

Détail dans [`docs/02-architecture.md`](docs/02-architecture.md).
