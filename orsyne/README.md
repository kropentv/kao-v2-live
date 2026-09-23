# ORSYNE

### Tout s'accorde.

Le système d'exploitation du restaurant : réservations, plan de salle,
équipes, clients et IA dans un seul système — connecté à la caisse que le
restaurant a déjà, pas à la place.

> ORSYNE ne remplace pas le POS. Le POS reste le système de référence pour
> l'encaissement, la fiscalité et la comptabilité. ORSYNE orchestre tout ce
> qui se passe autour.

## Ce qui tourne aujourd'hui

Un produit complet, du widget client jusqu'à l'encaissement.

| | |
|---|---|
| **Widget client** | Disponibilité en direct, choix de zone, allergies structurées, acompte par paiement sécurisé, annulation, liste d'attente |
| **Dashboard manager** | Service temps réel, plan de salle, réservations, liste d'attente, CRM, équipe, analytics |
| **Application de salle** | Les tables du serveur, ses alertes allergies, la fiche client — rien d'autre |
| **Paiements** | Stripe : acompte, empreinte bancaire, paiement intégral ; remboursement selon la politique ; capture sur no-show |
| **Messages** | Confirmation, rappel de la veille, annulation, proposition de liste d'attente — email (Resend, Postmark) ou SMS (Twilio), dans la langue du client |
| **Automatismes** | Rappels, libération des tables non payées, no-shows, expiration des propositions |
| **API** | ~60 routes, sessions, RBAC à 5 rôles, limite de débit |

**128 tests automatisés, tous verts.**

## Démarrer

```bash
docker compose up
```

Puis `http://localhost:3000/r/comptoir-demo`. Tout est en mode
démonstration : rien n'est débité, les messages s'affichent dans les
journaux. Mise en production : [`docs/05-deploiement.md`](docs/05-deploiement.md).

Sans Docker : PostgreSQL 16+ et Node.js 20+.

```bash
npm install
./scripts/dev-db.sh start
export ORSYNE_ADMIN_DATABASE_URL=postgres://orsyne@127.0.0.1:5433/orsyne_dev
export ORSYNE_DATABASE_URL=postgres://orsyne_app@127.0.0.1:5433/orsyne_dev
ORSYNE_SEED_DEMO=true npm start
```

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
src/services/      auth, attribution, briefing, paiements, messages,
                   liste d'attente, tâches automatiques
src/integrations/  Stripe, Resend, Postmark, Twilio — interchangeables
src/api/           routeur HTTP, RBAC, routes
src/realtime/      diffusion SSE
public/            widget client, dashboard, application de salle
test/              128 tests (node --test)
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
