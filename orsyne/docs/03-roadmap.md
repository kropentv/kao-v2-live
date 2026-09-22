# ORSYNE — Feuille de route

La règle qui prime sur tout le reste : **ne jamais sacrifier la fiabilité du
moteur de réservation pour une fonctionnalité marketing.** Chaque étape est
livrée avec ses tests automatisés.

## Étapes

| # | Étape | État |
|---|---|---|
| 1 | Architecture + schéma DB + multi-tenant | ✅ livré |
| 2 | Authentification + rôles (RBAC) | ✅ livré |
| 3 | Restaurant + tables + plan de salle | ✅ livré |
| 4 | Moteur de réservation | ✅ livré |
| 5 | CRM | ✅ livré |
| 6 | Serveurs + attribution | ✅ livré |
| 7 | Notifications temps réel | ✅ livré |
| 8 | Interface client | ✅ livré |
| 9 | IA téléphonique | schéma et traçabilité prêts, agent à brancher |
| 10 | Intégrations POS/KDS/PSP | couche d'abstraction prête, connecteurs à écrire |

Les huit premières étapes sont terminées et testées. C'est un produit
commercialisable : un restaurant peut l'installer, prendre des
réservations en ligne, faire tourner son service et suivre ses clients.

## Ce qui reste à brancher

**Étape 9 — IA téléphonique.** Le schéma (`ai_calls`, transcriptions,
issue d'appel, transfert humain) et toute la logique métier sont en
place : l'agent vocal n'a qu'à appeler les mêmes routes que le widget.
Il reste à choisir le fournisseur voix et à écrire l'agent.

**Étape 10 — Intégrations.** `integrations`, `external_references` et
`webhook_deliveries` existent, avec le stockage des charges brutes. Il
reste à écrire les connecteurs POS et PSP eux-mêmes — un par fournisseur,
sans toucher au produit.

**Paiement réel.** Le cycle acompte / préautorisation / paiement intégral
est modélisé et testé de bout en bout ; `confirm-payment` enregistre le
résultat. Il reste à intercaler Stripe (ou un autre PSP) entre les deux,
et à traiter son webhook.

## Prochaine étape recommandée

Mettre le produit devant cinq restaurants avant d'écrire l'étape 9.

Ce qui est livré suffit à vendre : un restaurateur peut créer son compte,
dessiner sa salle, ouvrir ses réservations en ligne et faire son service
le soir même. Les retours de ces cinq clients vaudront plus que six mois
de développement supplémentaire à l'aveugle.

Dans l'ordre :

1. Brancher un vrai PSP sur l'acompte (2–3 jours).
2. Envoi des emails et SMS de confirmation et de rappel (2–3 jours).
3. Mise en production : hébergement, sauvegardes, monitoring (2–3 jours).
4. Installer cinq restaurants, les regarder s'en servir.
5. **Ensuite seulement** : IA téléphonique, puis intégrations POS.

## V2 / V3

Conformes au cahier des charges : liste d'attente, rappels, WhatsApp,
intégrations POS, commandes, QR menu, client intelligence en V2 ; marketing,
AI Manager, analytics avancés, multi-sites, API publique en V3.

Le schéma anticipe déjà ces objets (`waitlist_entries`, `orders`,
`ai_calls`, `guest_messages`, `integrations`), pour que les ajouter ne
demande pas de migration destructrice.
