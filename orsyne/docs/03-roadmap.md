# ORSYNE — Feuille de route

La règle qui prime sur tout le reste : **ne jamais sacrifier la fiabilité du
moteur de réservation pour une fonctionnalité marketing.** Chaque étape est
livrée avec ses tests automatisés.

## Étapes

| # | Étape | État |
|---|---|---|
| 1 | Architecture + schéma DB + multi-tenant | ✅ livré |
| 2 | Authentification + rôles (RBAC) | à faire |
| 3 | Restaurant + tables + plan de salle (API + UI) | schéma livré, UI à faire |
| 4 | Moteur de réservation | ✅ cœur livré |
| 5 | CRM | schéma livré, API à faire |
| 6 | Serveurs + attribution | ✅ scoring livré, planning API à faire |
| 7 | Notifications temps réel | outbox livré, WebSocket à faire |
| 8 | Interface client (widget de réservation) | à faire |
| 9 | IA téléphonique | schéma livré, agent à faire |
| 10 | Intégrations POS/KDS/PSP | couche d'abstraction livrée |

## Ce qui est livré aujourd'hui

**Étape 1 — complète.**
- 6 migrations, 30 tables, multi-tenant avec RLS forcée sur toutes.
- Rôle applicatif `NOBYPASSRLS`, contexte par transaction.
- Audit log append-only, outbox transactionnel.

**Étape 4 — le cœur.**
- Disponibilité par service, règles de réservation, fermetures.
- Attribution automatique classée (capacité, zone, préférences CRM,
  rotation, combinaisons) et attribution manuelle prioritaire.
- Cycle de vie complet : création, acompte, confirmation, installation,
  fin de service, annulation, no-show, déplacement, walk-in.
- Acomptes / préautorisations / paiement intégral modélisés séparément,
  avec maintien de table expirant.

**Étape 6 — le scoring.**
- Classement des serveurs par charge réelle, rang déclaré, couverts.

**46 tests automatisés, tous verts**, dont la preuve par la concurrence que
deux clients ne peuvent pas obtenir la même table.

## Prochaine étape recommandée

**Étape 2 (auth + RBAC) puis étape 8 (widget client).**

Raison : le moteur est solide mais invisible. Un widget de réservation
branché dessus est ce qui permet de mettre le produit devant cinq
restaurants et de vérifier qu'ils paient — avant d'écrire les trois ans de
produit que décrit le cahier des charges.

Ordre de travail suggéré :

1. Auth (sessions, rôles, périmètre par établissement) — 1 sprint.
2. API HTTP sur le moteur existant — 1 sprint.
3. Widget client : disponibilité, choix de zone, acompte Stripe — 1 sprint.
4. Dashboard de service temps réel (le plus vendeur en démo) — 1 sprint.
5. PWA serveur — 1 sprint.

À ce stade le produit est démontrable et facturable. L'IA téléphonique et
les intégrations POS viennent ensuite, sur des clients réels.

## V2 / V3

Conformes au cahier des charges : liste d'attente, rappels, WhatsApp,
intégrations POS, commandes, QR menu, client intelligence en V2 ; marketing,
AI Manager, analytics avancés, multi-sites, API publique en V3.

Le schéma anticipe déjà ces objets (`waitlist_entries`, `orders`,
`ai_calls`, `guest_messages`, `integrations`), pour que les ajouter ne
demande pas de migration destructrice.
