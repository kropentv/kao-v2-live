# ORSYNE — API

Toutes les réponses sont en JSON. L'authentification passe par un cookie
de session `HttpOnly` posé à la connexion.

Les erreurs ont toujours la même forme :

```json
{ "error": { "code": "no_availability", "message": "Aucune table disponible pour cette demande." } }
```

Les codes métier sont stables et destinés à être branchés directement
(interface, IA téléphonique, intégration). Les principaux :
`no_availability` (409), `table_unavailable` (409), `restaurant_closed`
(422), `booking_rule_violation` (422), `invalid_transition` (409),
`invalid_credentials` (401), `forbidden` (403).

## Public — aucune authentification

| | |
|---|---|
| `GET /api/public/:slug` | Fiche du restaurant, zones réservables, taille de groupe maximale |
| `GET /api/public/:slug/availability?date=&partySize=&zoneId=` | Créneaux, avec la raison d'indisponibilité |
| `POST /api/public/:slug/reservations` | Réserver. Applique les règles publiques et l'acompte |
| `GET /api/public/:slug/reservations/:reference` | Retrouver sa réservation |
| `POST /api/public/:slug/reservations/:reference/cancel` | Annuler |
| `POST /api/public/:slug/reservations/:reference/confirm-payment` | Confirmer l'acompte (appelé par le webhook du PSP en production) |

La table attribuée n'est jamais renvoyée au client : c'est une
information d'exploitation, et elle peut encore changer.

## Session

| | |
|---|---|
| `POST /api/auth/register` | Crée tenant + propriétaire + premier établissement |
| `POST /api/auth/login` / `logout` | |
| `GET /api/me` | Identité, rôles, permissions, établissements accessibles |

## Établissement

| | Permission |
|---|---|
| `GET /api/restaurants/:id/floor` | `floor:read` |
| `POST /api/restaurants/:id/zones` · `tables` · `combinations` | `floor:write` |
| `PATCH /api/restaurants/:id/tables/:tableId` | `floor:write` |
| `POST /api/restaurants/:id/tables/:tableId/status` | `service:write` |
| `DELETE /api/restaurants/:id/tables/:tableId` | `floor:write` (désactive, ne supprime pas) |
| `GET`/`POST /api/restaurants/:id/services` | `restaurants:read` / `settings:*` |
| `POST /api/restaurants/:id/closures` · `deposit-policies` | `settings:*` |

## Service

| | Permission |
|---|---|
| `GET /api/restaurants/:id/service?date=` | `service:read` — un serveur ne reçoit que ses tables |
| `GET /api/restaurants/:id/availability?date=&partySize=` | `reservations:read` |
| `GET /api/restaurants/:id/reservations?from=&to=&status=` | `reservations:read` |
| `POST /api/restaurants/:id/reservations` | `reservations:write` — crée et attribue |
| `POST /api/restaurants/:id/walk-ins` | `reservations:write` |
| `POST /api/reservations/:id/seat` · `complete` · `no-show` | `service:write` |
| `POST /api/reservations/:id/cancel` · `move` | `reservations:write` |
| `GET /api/reservations/:id/server-suggestions` | `staff:read` |
| `POST /api/reservations/:id/assign-server` | `staff:schedule` |

## Clients

| | Permission |
|---|---|
| `GET /api/guests?q=` | `guests:read` |
| `GET /api/guests/:id` | `guests:read` — refusé aux serveurs |
| `GET /api/guests/:id/brief?restaurantId=` | `guests:read_brief` — ce que voit un serveur |
| `POST`/`PATCH /api/guests` · `:id` | `guests:write` |
| `POST /api/guests/:id/preferences` · `notes` | `guests:write` |
| `POST /api/insights/:id/review` | `guests:write` — accepter ou rejeter une déduction IA |
| `GET /api/guests/:id/export` | `guests:*` — RGPD, portabilité |
| `DELETE /api/guests/:id` | `guests:*` — RGPD, anonymisation |

## Équipe

| | Permission |
|---|---|
| `GET`/`POST /api/restaurants/:id/staff` | `staff:read` / `staff:*` |
| `PATCH /api/restaurants/:id/staff/:userId/profile` | `staff:*` |
| `GET`/`POST /api/restaurants/:id/shifts` | `staff:read` / `staff:schedule` |
| `POST /api/shifts/:id/clock` | `service:write` |
| `GET /api/restaurants/:id/load` | `staff:read` — charge + recommandation |

## Temps réel et notifications

| | |
|---|---|
| `GET /api/restaurants/:id/stream` | Flux SSE du service |
| `GET /api/notifications?unread=true` | |
| `POST /api/notifications/:id/read` · `read-all` | |
| `POST /api/restaurants/:id/broadcast` | Message à toute la salle |

Événements diffusés : `reservation.confirmed`, `reservation.pending_payment`,
`reservation.cancelled`, `reservation.seated`, `reservation.completed`,
`reservation.no_show`, `reservation.moved`, `reservation.server_assigned`,
`table.status_changed`, `notification.created`, `manager.broadcast`.

## Analytics

`GET /api/restaurants/:id/analytics?from=&to=` — `analytics:read`.
Réservations, couverts, taux d'annulation et de no-show, occupation,
sources, performance par serveur, nouveaux clients contre fidèles, appels IA.

## Rôles

| Rôle | Portée |
|---|---|
| `owner` | Tout, sur tous les établissements du tenant |
| `manager` | Réservations, salle, clients, service, analytics |
| `floor_manager` | Salle, réservations, clients, service |
| `server` | Ses tables, ses notifications, la fiche de briefing |
| `kitchen` | Service et commandes uniquement |
