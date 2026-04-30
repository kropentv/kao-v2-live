# 🚀 KAO V2 — README MAÎTRE

> **Pour Pierre.** Tout ce que tu dois savoir pour mettre à jour, débugger, comprendre.
> 
> **Version actuelle : V4.8** (Volume tracking + Trump Market Impact)
> Voir `TUTO_V48.md` pour les détails de cette version.

---

## 📑 Sommaire rapide

1. [Architecture du système](#architecture)
2. [Mise à jour V4.6 → V4.7 (5 minutes)](#mise-a-jour)
3. [Premier déploiement (si tu repars de zéro)](#premier-deploiement)
4. [URLs importantes à retenir](#urls)
5. [Vérifier que tout marche](#verifier)
6. [Troubleshooting commun](#troubleshooting)
7. [Composants techniques](#composants)

---

## <a name="architecture"></a>🏗️ Architecture du système

```
┌─────────────────┐
│  TOI sur MT5    │  ← Tu trades normalement
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────────────┐
│  KaoV2_Observer.mq5 (EA dans MT5)       │
│  - LECTURE SEULE · jamais de trade      │
│  - Envoie toutes les 15 sec :           │
│    RSI M1/M5/M15/H1, EMA, pivots,       │
│    sweeps, marubozu, BOS, CHoCH,        │
│    PDH/PDL, sessions, prix broker live  │
└────────┬────────────────────────────────┘
         │ HTTPS POST
         ▼
┌─────────────────────────────────────────┐
│  Serveur Railway (Node.js + PostgreSQL) │
│  https://kao-v2-live-production-73ab    │
│        .up.railway.app                  │
│                                         │
│  - Smart Engine analyse 18 setups       │
│  - News Guard auto                      │
│  - Stocke trades en DB persistante      │
│  - Calcule consistency, P&L jour        │
└────┬────────────────────────────┬───────┘
     │                            │
     ▼                            ▼
┌──────────────┐          ┌──────────────────┐
│  TELEGRAM    │          │  DASHBOARD WEB   │
│  Bot push    │          │  /dashboard      │
│  alertes     │          │  /world          │
│  Telegram    │          │                  │
│  sur ton tel │          │  Visuel premium  │
└──────────────┘          └──────────────────┘
```

---

## <a name="mise-a-jour"></a>⚡ Mise à jour V4.6 → V4.7 (5 min)

Si tu as déjà la V4.6 qui tourne, voilà la procédure rapide :

### **Étape 1 : Backup (30 sec)**
1. Sur GitHub, repo `kao-v2-live` → bouton **Code** → **Download ZIP**
2. Sauve le ZIP quelque part (filet de sécurité)

### **Étape 2 : Replace 2 fichiers GitHub (3 min)**
Sur ton repo `kao-v2-live`, tu remplaces **2 fichiers seulement** :

**Fichier 1 : `server.js`**
1. Clique sur `server.js`
2. Crayon ✏️ → tout sélectionner (Cmd/Ctrl+A) → supprimer
3. Colle le contenu de `kao_v47_server.js`
4. **Commit changes** (bouton vert)

**Fichier 2 : `KaoV2_Observer.mq5`**
- Si tu l'as dans le repo → même procédure
- Sinon → tu le mets que dans MT5 (étape 3)

✅ Railway redéploie automatiquement en 1 min.

**Inchangés** (ne touche pas) :
- `dashboard.html` (idem V4.6)
- `world.html`
- `package.json`

### **Étape 3 : Update EA dans MT5 (2 min)**

1. Dans MT5 : **Fichier → Ouvrir le dossier des données**
2. Va dans `MQL5/Experts/`
3. Renomme l'ancien `KaoV2_Observer.mq5` en `KaoV2_Observer_OLD.mq5`
4. Copie le nouveau `KaoV2_Observer_v47.mq5` ici, **renomme-le** en `KaoV2_Observer.mq5`
5. Dans MT5 : appuie **F4** (MetaEditor s'ouvre)
6. Dans MetaEditor : double-clic sur `KaoV2_Observer.mq5`
7. **F7** pour compiler → vérifie "**0 error(s), 0 warning(s)**"
8. Ferme MetaEditor

### **Étape 4 : Recharger l'EA dans MT5**
1. Sur ton chart Gold, clic droit sur le nom EA en haut à droite → **Expert Advisors → Remove**
2. Dans Navigator → clic droit sur **Expert Advisors** → **Refresh**
3. Glisse `KaoV2_Observer` à nouveau sur le chart Gold
4. Onglet **Common** → coche "Allow Algo Trading"
5. Onglet **Inputs** : URL et token doivent être pré-remplis
6. **OK**
7. Vérifie le smiley **🙂 vert** en haut à droite du chart

### **Étape 5 : Vérification finale (30 sec)**
Ouvre dans ton navigateur :
```
https://kao-v2-live-production-73ab.up.railway.app/api/all
```

Cherche dans le JSON les nouveautés V4.7 :
- ✅ `marubozu_bull` / `marubozu_bear`
- ✅ `marubozu_reversal_bull` / `marubozu_reversal_bear` (NOUVEAU)
- ✅ `marubozu_continuation_bull/bear` (NOUVEAU)
- ✅ `choch_bullish` / `choch_bearish` (NOUVEAU)

Si tu vois ces champs → **V4.7 active et opérationnelle** ✅

---

## <a name="premier-deploiement"></a>🆕 Premier déploiement (repartir de zéro)

Si jamais tu dois tout refaire (changement de compte, etc.) :

### **1. Crée un compte Railway** (gratuit)
- [railway.app](https://railway.app) → Login GitHub

### **2. Crée le repo GitHub**
- Crée `kao-v2-live`
- Upload les 5 fichiers du ZIP `KAO_V2_V47_FINAL.zip` :
  - `server.js`
  - `dashboard.html`
  - `world.html`
  - `package.json`
  - `KaoV2_Observer.mq5`

### **3. Deploy sur Railway**
- New Project → Deploy from GitHub → choisis `kao-v2-live`
- Settings → Generate public domain
- Variables → ajoute :
  - `TELEGRAM_TOKEN` = (créé via @BotFather sur Telegram)
  - `TELEGRAM_CHAT_ID` = (donné par @userinfobot)
  - `AUTH_TOKEN` = `kaov2secret`

### **4. Add PostgreSQL** (pour persistence)
- Dans ton projet Railway, bouton **+ Create** → Database → PostgreSQL
- Railway lie auto la variable `DATABASE_URL`

### **5. Setup MT5** (étape 3 et 4 ci-dessus)

### **6. Telegram bot**
1. Sur Telegram, cherche **@BotFather** → `/newbot`
2. Copie le **token**
3. Cherche **@userinfobot** → `/start` → copie ton **Chat ID**
4. Ouvre ton nouveau bot et envoie `/start` (important !)

---

## <a name="urls"></a>🔗 URLs importantes à retenir

| URL | Description |
|---|---|
| `https://kao-v2-live-production-73ab.up.railway.app/` | Page d'accueil serveur (lien dashboard + world) |
| `https://kao-v2-live-production-73ab.up.railway.app/dashboard` | **Dashboard trading principal** |
| `https://kao-v2-live-production-73ab.up.railway.app/world` | **World Intelligence** (carte + TV + ticker) |
| `https://kao-v2-live-production-73ab.up.railway.app/api/all` | JSON brut (debug) |
| `https://kao-v2-live-production-73ab.up.railway.app/api/telegram/test` | Test Telegram |
| `https://kao-v2-live-production-73ab.up.railway.app/api/confluences` | Setups détectés en live |

---

## <a name="verifier"></a>✅ Vérifier que tout marche

### **Checklist santé** (ouvre les URLs dans le navigateur)

| Test | URL | Résultat attendu |
|---|---|---|
| 1. Serveur en vie | `/` | "Kao V2 Live Server v3 · Dashboard · World" |
| 2. API répond | `/api/all` | Gros JSON avec tout dedans |
| 3. EA connecté | `/api/all` → `accounts:{}` | Doit contenir TON numéro de compte (pas vide) |
| 4. Prix broker | `/api/all` → `brokerPrice` | Numérique récent (pas null) |
| 5. Smart Engine | `/api/confluences` | Tu vois `marketData` avec RSI |
| 6. Telegram | `/api/telegram/test` | Tu reçois "Test OK" sur ton tel |
| 7. EA actif | MT5 chart Gold | 🙂 smiley vert en haut à droite |

Si **tous les 7** sont ✅ → **système 100% opérationnel**.

---

## <a name="troubleshooting"></a>🔧 Troubleshooting commun

### **`accounts:{}` vide**
→ L'EA ne communique pas avec le serveur. Vérifier dans l'ordre :
1. Smiley 🙂 vert sur chart MT5 ?
2. Algo Trading bouton vert en haut de MT5 ?
3. **Outils → Options → Expert Advisors** : URL whitelistée `https://kao-v2-live-production-73ab.up.railway.app` (sans `/` à la fin) ?
4. AUTH_TOKEN identique entre EA et Railway ?

### **Telegram pas d'alerte**
→ `/api/telegram/test` renvoie quoi ?
- `{"ok":true}` → Telegram OK, attends une vraie alerte
- `chat not found` → Tu n'as pas envoyé `/start` à ton bot
- `Bot not configured` → Variables Railway manquantes

### **Trades disparaissent après redeploy**
→ PostgreSQL pas branché. Railway → Variables → vérifier `DATABASE_URL` existe.

### **Prix dashboard ≠ prix MT5**
→ Normal si EA pas encore connecté (utilise Yahoo Finance). Une fois EA actif, badge vert "🔴 LIVE BROKER" apparaît, prix exact MT5.

### **Erreur compilation EA (F7)**
→ Copie-moi les erreurs en chat, je corrige.

### **Chaînes TV cassées sur /world**
→ YouTube ferme parfois les streams 24/7. Les autres restent actives. Cliquer sur une autre chaîne dans la barre.

---

## <a name="composants"></a>🧩 Composants techniques

### **Fichiers et leur rôle**

| Fichier | Rôle | Tu modifies quand ? |
|---|---|---|
| `server.js` | Cerveau du système · Smart Engine · API | Mise à jour version |
| `dashboard.html` | Interface trading principale | Mise à jour version |
| `world.html` | Carte + Live TV + Ticker | Très rare |
| `package.json` | Dépendances Node.js | Très rare |
| `KaoV2_Observer.mq5` | EA MT5 · capture data + trades | Mise à jour version |

### **Variables d'environnement Railway**
- `TELEGRAM_TOKEN` → Token bot Telegram (de @BotFather)
- `TELEGRAM_CHAT_ID` → Ton ID Telegram (de @userinfobot)
- `AUTH_TOKEN` → Mot de passe entre EA et serveur (par défaut: `kaov2secret`)
- `DATABASE_URL` → Auto-générée par Railway PostgreSQL
- `PORT` → Auto-généré par Railway

### **Endpoints serveur**

**Lecture publique** (pas d'auth requise) :
- `GET /` → Page d'accueil
- `GET /dashboard` → Dashboard HTML
- `GET /world` → World Intelligence HTML
- `GET /api/all` → Tout le state (prices, news, trades, confluences, etc.)
- `GET /api/confluences` → Setups détectés
- `GET /api/news` → News filtrées
- `GET /api/trump` → Posts Trump
- `GET /api/calendar` → Calendrier éco
- `GET /api/refresh` → Force un refresh
- `GET /api/telegram/test` → Test bot

**Écriture protégée** (X-Auth-Token requis) :
- `POST /api/trade/ping` → EA s'identifie
- `POST /api/price` → EA envoie prix live
- `POST /api/market` → EA envoie indicateurs multi-TF
- `POST /api/trade/new` → EA signale nouveau trade
- `POST /api/trade/close` → EA signale trade fermé

**DB queries** :
- `GET /api/history/:account` → Historique trades d'un compte
- `GET /api/stats/:account` → Stats globales + par jour
- `GET /api/export/:account` → Export CSV Excel

---

## 🎯 Comment fonctionne le scan

### **EA (MT5) toutes les 15 sec** :
Calcule et envoie au serveur :
- 4 RSI (M1, M5, M15, H1)
- 3 EMA (50/200 H1, 50 M15)
- 1 ATR (M15)
- Pivots des 3 TF (M5, M15, H1)
- 1 candle M5 complète (open/close/high/low/wicks)
- Détections (sweeps, marubozu, BOS, CHoCH, PDH/PDL)

### **Serveur calcule** :
- 18 types de setups (9 SHORT, 9 BUY)
- Score 0-100 par setup
- Grade (A++, A+, A, B, C)
- Plan SL/TP1/TP2/TP3 calculé
- News Guard status (NORMAL / PRE_NEWS / DURING / POST_CAUTIOUS)

### **Serveur envoie sur Telegram** :
- Setup score ≥ 50 (sauf si News Guard bloque)
- Cooldown 8 min par type pour éviter spam
- Format Markdown avec confluences listées

---

## 📊 Liste des 18 setups V4.7

### 🔴 SHORT (9)
1. 🎯 Liquidity Sweep High
2. 🔥 PDH (Previous Day High) Sweep
3. ⭐ Double Top M5
4. 🎯 Résistance Multi-TF (M5/M15/H1)
5. 🔻 BOS Bearish M15 *(close required)*
6. 🔁 **CHoCH Bearish M15** *(reversal de tendance)*
7. 🔄 **Marubozu Reversal Bear** *(engulfing pattern)*
8. 📉 Marubozu Continuation Bear
9. 💀 John Wick Bear *(impulsion forte)*
10. ⚡ Scalp M1 RSI ≥80
11. 🔴 Pin Bar M5

### 🟢 BUY (9, miroirs)
1-9. Mêmes types inversés.

---

## 🛡️ News Guard auto

| Phase | Durée | Comportement |
|---|---|---|
| **NORMAL** | Tout le temps sauf news | Toutes alertes passent |
| **PRE_NEWS** | 15 min avant | Alertes BLOQUÉES + Telegram warning |
| **DURING_NEWS** | 15 min pendant | BLOQUÉES + alerte volatilité max |
| **POST_NEWS_CAUTIOUS** | 30 min après | Seules les **A++** passent |

Détecte **automatiquement** les news high impact USD/EUR depuis le calendrier ForexFactory.

---

## 🆘 Si tout casse

1. **Restaure** ton ZIP de backup GitHub (étape 1 mise à jour)
2. **Redeploy** Railway depuis le commit précédent
3. Reviens vers Claude avec les **logs Railway** + **logs MT5 Experts**

Le système est conçu pour être **sans risque trade** : l'EA est lecture seule, il ne touche jamais à tes positions. Le pire qui peut arriver est de ne plus recevoir d'alertes.

---

## 📞 Support

Si quelque chose marche pas, copie-colle :
1. Le contenu de `/api/all` (tronqué si gros)
2. Les 10 dernières lignes des logs **Experts** dans MT5
3. Les 10 dernières lignes des logs **Deployments** sur Railway

→ Avec ces 3 infos, je débugge en 1 message.

---

**KAO V2 V4.7** · Built for XAU/USD scalp precision · Stay disciplined 🎯
