# ORSYNE — Feuille de route

La règle qui prime sur tout le reste : **ne jamais sacrifier la fiabilité du
moteur de réservation pour une fonctionnalité marketing.** Chaque étape est
livrée avec ses tests automatisés.

## Étapes

| # | Étape | État |
|---|---|---|
| 1 | Architecture + schéma DB + multi-tenant | ✅ |
| 2 | Authentification + rôles (RBAC) | ✅ |
| 3 | Restaurant + tables + plan de salle | ✅ |
| 4 | Moteur de réservation | ✅ |
| 5 | CRM | ✅ |
| 6 | Serveurs + attribution | ✅ |
| 7 | Notifications temps réel | ✅ |
| 8 | Interface client | ✅ |
| 9 | IA téléphonique | à faire — le reste du produit est prêt à la recevoir |
| 10 | Intégrations | ✅ paiement (Stripe), email (Resend, Postmark), SMS/WhatsApp (Twilio) — POS/KDS à faire |

Livré en plus du périmètre MVP, parce que « tout doit marcher » : liste
d'attente (V2 du cahier des charges), rappels, no-shows automatiques,
remboursements selon la politique d'annulation.

## Ce qui reste

**IA téléphonique (étape 9).** Schéma et traçabilité en place (`ai_calls`).
L'agent vocal appellera les mêmes routes que le widget : disponibilité,
réservation, annulation, liste d'attente. Il reste à choisir le fournisseur
voix et à écrire l'agent.

**Connecteurs POS / KDS.** La couche d'intégration existe
(`src/integrations/`, `integrations`, `external_references`,
`webhook_deliveries`). Chaque caisse est un connecteur à écrire, sans
toucher au produit.

**Marketing, AI Manager, multi-sites avancé** : V3, conformément au cahier
des charges.

## Prochaine étape recommandée

Le produit est commercialisable. La suite n'est plus du code : un nom de
domaine, un compte Stripe, un compte Resend, un hébergeur — puis cinq
restaurants, et les regarder s'en servir. Voir
[`05-deploiement.md`](05-deploiement.md).

## V2 / V3

Conformes au cahier des charges : liste d'attente, rappels, WhatsApp,
intégrations POS, commandes, QR menu, client intelligence en V2 ; marketing,
AI Manager, analytics avancés, multi-sites, API publique en V3.

Le schéma anticipe déjà ces objets (`waitlist_entries`, `orders`,
`ai_calls`, `guest_messages`, `integrations`), pour que les ajouter ne
demande pas de migration destructrice.
