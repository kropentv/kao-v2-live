# ORSYNE — Architecture

## Position

ORSYNE ne remplace pas la caisse. Le POS reste le système de référence pour
l'encaissement, le paiement final, la fiscalité, les tickets et la
comptabilité. ORSYNE orchestre tout ce qui se passe autour et s'y branche.

Cette décision n'est pas commerciale, elle est structurelle : elle interdit
d'écrire quoi que ce soit dans le produit qui suppose qu'ORSYNE détient la
vérité financière.

## Vue d'ensemble

```
   Client                Personnel                Manager / Owner
 (web, tel, QR)      (PWA mobile/tablette)         (dashboard web)
      |                      |                            |
      +----------------------+----------------------------+
                             |
                    API HTTP (REST + événements)
                             |
      +----------------------+----------------------------+
      |               |              |              |      |
  Moteur de       Plan de       CRM / Client    Équipes  Couche IA
  réservation      salle        Intelligence   & attrib. (tel, manager)
      |               |              |              |      |
      +----------------------+----------------------------+
                             |
                  PostgreSQL (multi-tenant, RLS)
                             |
                     Outbox transactionnel
                             |
      +----------------------+----------------------------+
      |               |              |              |      |
   Temps réel     Notifications   POS / KDS     SMS / WA   Analytics
   (WebSocket)                   (intégrations)   Email
```

## Les cinq invariants

Ce sont les règles qu'aucune fonctionnalité future n'a le droit de casser.

### 1. Une table, un convive, à un instant donné

Garanti par une contrainte d'exclusion GiST sur `table_occupancies`, pas
par le code applicatif :

```sql
EXCLUDE USING gist (table_id WITH =, occupied_during WITH &&) WHERE (is_active)
```

Conséquence : même un script d'import, un correctif manuel en production
ou un second service écrivant directement en base ne peut pas produire de
double réservation. Le moteur n'utilise aucun verrou applicatif ni mutex
distribué — il propose des candidats classés et laisse la base arbitrer.
Voir `src/domain/reservation-engine.js`.

### 2. Toute donnée métier porte `tenant_id`, et la RLS est forcée

Chaque table porte `tenant_id` et une politique `FORCE ROW LEVEL SECURITY`.
L'application se connecte avec le rôle `orsyne_app`, créé `NOBYPASSRLS`.
Le contexte est posé par transaction via `SET LOCAL` (`withTenant`) : il
expire avec la transaction, donc une connexion rendue au pool ne peut pas
transporter le tenant précédent vers la requête suivante.

Une requête sans contexte ne renvoie pas « toutes les lignes » : elle en
renvoie zéro.

Un test structurel (`test/tenant-isolation.test.js`) échoue si une future
migration ajoute une table sans `tenant_id` ou sans RLS forcée.

### 3. Les faits et les déductions IA ne partagent pas de table

`guest_facts` contient ce qui s'est produit et se compte
(« entrecôte commandée 5 fois »). `guest_insights` contient ce que l'IA en
déduit, avec une confiance, les faits qui l'ont produite, et un statut que
le restaurant peut passer à `rejected`.

Séparation physique : aucune requête ne peut afficher une déduction à la
place d'un fait par inadvertance.

### 4. Acompte, préautorisation et paiement final ne se mélangent jamais

`guarantee_mechanism` est explicite (`deposit`, `preauthorization`,
`full_payment`) et une ligne de `payment_intents` porte un seul mécanisme.
Une empreinte bancaire capturée pour no-show et un acompte encaissé à la
réservation sont deux objets différents dans la base, pas deux valeurs
d'un champ « montant ».

### 5. L'IA propose, l'humain décide

L'attribution automatique (`src/domain/allocation.js`) renvoie une liste
**classée** avec un score et une raison lisible. Elle n'écrit rien. Le
manager peut imposer une table (`tableIds`), et cette instruction
court-circuite tout le scoring. Aucune fonctionnalité IA ne doit pouvoir
bloquer une action humaine.

## Couches

| Couche | Rôle | État |
|---|---|---|
| `db/migrations` | Schéma versionné, une transaction par fichier | ✅ étape 1 |
| `src/db` | Pool, contexte tenant, migrations | ✅ étape 1 |
| `src/lib` | Fuseaux horaires, utilitaires purs | ✅ étape 1 |
| `src/domain` | Disponibilité, réservation, attribution | ✅ étape 1 (cœur) |
| `src/api` | HTTP, auth, RBAC | étape 2 |
| `src/realtime` | WebSocket, diffusion des événements | étape 7 |
| `src/integrations` | POS, KDS, PSP, SMS, WhatsApp | étape 10 |
| `src/ai` | Réceptionniste, AI Manager | étape 9 |

## Temps réel et événements

Tout changement métier écrit son événement dans `outbox_events` **dans la
même transaction**. Un worker le publie ensuite vers le WebSocket, les
notifications et les intégrations.

Conséquence : pas d'événement pour un changement qui a été annulé, pas de
changement sans événement. C'est ce qui rend le dashboard de service
fiable pendant un coup de feu.

## Fuseaux horaires

Un restaurant raisonne en heure murale (« le service démarre à 19h30 »),
la base en instants. Toutes les conversions passent par `src/lib/time.js`,
testé aux deux bascules d'heure d'été. Un groupe multi-sites peut avoir un
établissement à Paris et un à New York sans code conditionnel.

## Choix techniques

- **PostgreSQL 16** — les contraintes d'exclusion GiST et la RLS sont la
  raison du choix, pas un détail d'implémentation.
- **Node.js 20+, ESM, sans framework** dans le domaine — le moteur de
  réservation ne doit dépendre que de `pg`.
- **Aucun ORM** sur le chemin critique — les requêtes de disponibilité et
  d'occupation sont écrites à la main et lisibles.
- **`node --test`** — pas de framework de test à maintenir.
