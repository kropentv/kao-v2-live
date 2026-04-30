# 🚨 KAO V2 V5.1 — Anti-Surprise Update

## 🎯 Pour ne plus jamais te faire surprendre comme avec le Politburo

Suite à ton expérience du **28 avril 2026** où Gold a chuté brutalement à cause du combo **Politburo China dovish + OPEC + USD fort**, j'ai ajouté un système complet pour **anticiper les events** et **détecter les mouvements anormaux en temps réel**.

---

## 🆕 Nouveautés V5.1

### **1. 🌏 Calendrier élargi multi-pays**

**Avant V5.1** : seuls USD/EUR déclenchaient les warnings
**Maintenant** : 8 pays surveillés
- 🇺🇸 USD (Fed)
- 🇪🇺 EUR (ECB)
- 🇨🇳 **CNY** (Politburo, PBoC) ⬅️ NOUVEAU
- 🇬🇧 GBP (BoE)
- 🇯🇵 JPY (BoJ)
- 🇨🇭 CHF (SNB)
- 🇦🇺 AUD (RBA)
- 🇨🇦 CAD (BoC)

**Plus une détection des mots-clés critiques** :
- Politburo, FOMC, OPEC, PMI, CPI, NFP, GDP
- Discours banquiers centraux (Powell, Lagarde, Ueda...)
- Crude oil, retail sales, consumer confidence

### **2. 📰 Pre-Event Briefing (1h avant)**

**1 heure avant** chaque event high impact, tu reçois sur Telegram :
- Description de l'event
- Impact attendu sur Gold (bullish/bearish/mixte)
- Plan d'action minute par minute
- Recommandation pour positions ouvertes

**30 minutes avant** : warning final urgent

### **3. 🚨 Breaking News Detector**

Scrappe les news en temps réel, analyse avec keywords critiques :

**Catégories détectées** :
- ⚠️ **Critical** : breaking, urgent, attack, ceasefire, tariff, crash
- 🏦 **Central Banks** : Fed, ECB, BoJ, PBoC, dovish, hawkish, pivot
- 🏛️ **Political** : Trump, Xi, Politburo, election, default
- 📊 **Market shock** : all-time high/low, circuit breaker, flash crash

**Score 0-100** par news. Alerte Telegram si **score ≥ 50** sur news high impact < 30 min d'âge.

### **4. 📈 Abnormal Movement Detector**

**Détecte les pumps/dumps** en temps réel :
- Si Gold bouge **≥ $10 en 5 minutes** → alerte instantanée
- Cherche automatiquement la cause dans les news/posts Trump récents
- T'envoie le contexte : *"Gold a chuté de $15 - news Politburo dovish à 8h32"*
- Cooldown 5 min pour éviter spam

### **5. 📅 Dashboard amélioré**

Section calendrier transformée :
- 🔥 Events critiques mis en avant (Politburo, FOMC, OPEC)
- ⏰ **Countdown live** : "Dans 23min" avec couleur urgence
- 🚨 Bordure rouge animée si event imminent ≤ 30min
- Tri auto : events à venir en haut

---

## 📦 Fichiers à remplacer

| Fichier | Action |
|---|---|
| `server.js` | **Replace** sur GitHub |
| `dashboard.html` | **Replace** sur GitHub |
| `KaoV2_Observer.mq5` | Replace (juste la version, pas obligatoire) |

L'EA n'a pas besoin d'être modifié pour cette V5.1, c'est tout côté serveur.

---

## 🚀 Déploiement (3 min)

1. **Replace** `server.js` et `dashboard.html` sur GitHub
2. Railway redéploie automatiquement (1 min)
3. Test : `https://kao-v2-live-production-73ab.up.railway.app/api/all`
4. Cherche dans `calendar` : tu vois maintenant `country`, `isCritical`, `rawDate`

C'est tout. Pas besoin de toucher MT5.

---

## 📱 Exemples d'alertes V5.1

### **📰 1H Briefing**
```
📰 KAO V2 · BRIEFING 1H AVANT

⏰ Dans 1h : Politburo Meeting Statement
🌍 CNY
📅 09:30 · Impact HIGH

Impact attendu sur Gold :
🌏 Chine (1er importateur Gold)
  Stimulus → 📈 Gold bullish (demande boost)
  Tightening → 📉 Gold bearish

Plan d'action :
  ⏱️ T-30min : warning final + protection enclenchée
  ⏱️ T-15min : News Guard ACTIF · alertes setups SUSPENDUES
  ⏱️ T+15min : Mode prudent · seuls A++ alertés
  ⏱️ T+45min : Reprise normale

💡 Si tu as une position ouverte, considère sécuriser ou fermer.
```

### **🚨 Breaking News**
```
🚨📰 KAO V2 · BREAKING NEWS

China Politburo signals further easing in 2026

📰 Source : Reuters
⏰ 3min
🔥 Score impact : 75/100
🏷️ political, cb
💰 📉🔴 Bearish Gold

"China's Politburo readout strikes a relatively dovish tone, suggesting that more fiscal support and monetary easing is on the cards..."

Recommendation :
  ⚠️ Possible chute Gold · prudence longs
  🛡️ Vérifie tes SL
  ⏱️ Volatilité 15-30 min
```

### **💥 Abnormal Movement**
```
💥 KAO V2 · MOUVEMENT ANORMAL

📉⬇️ DUMP Gold a bougé -$15.30 en 5 min
📊 4642.50 → 4627.20

Cause possible (news récentes) :
  📰 Reuters : China Politburo signals further easing
  📰 Bloomberg : Gold drops as risk appetite returns
  📰 ForexLive : USD strengthens on China stimulus hopes

💡 Action :
  ⚠️ Pas de trade pendant 10 min
  🛡️ Vérifie tes positions ouvertes
  📊 Attends que la volatilité retombe
```

### **📅 Dashboard calendrier**
```
🔥 Politburo Meeting Statement
   CNY · 09:30 · Dans 23min !  ⬅️ countdown rouge animé
   ●●● [NO TRADE]
```

---

## 🎯 Ce que ça aurait fait pour toi ce matin

**Scénario du 28/04/2026 (ce qui s'est passé)** :

🕗 **08:30** - Politburo Meeting démarre
🕗 **08:32** - Statement dovish publié
🕗 **08:33** - Gold chute de $15 en 5 minutes
🕗 **08:33-08:38** - Tu te demandes ce qui se passe

**Avec V5.1** :

🕖 **07:30** - 📰 Briefing 1H : "Dans 1h Politburo Statement, attendu dovish = Gold bearish, plan d'action..."
🕗 **08:00** - ⚠️ Warning T-30min : "Politburo dans 30 min, ne pas trader, protéger SL"
🕗 **08:30-08:45** - News Guard ACTIF, aucune alerte setup
🕗 **08:33** - 💥 Abnormal Movement : "DUMP $15 en 5 min, cause : Politburo dovish"
🕗 **08:35** - 🚨 Breaking News : "Politburo signals easing → Bearish Gold"

**Résultat** : tu **savais** ce qui allait se passer 1h avant. Tu as eu le temps de fermer ou sécuriser tes positions. Tu as compris la cause **immédiatement**.

---

## ⚙️ Cooldowns et anti-spam

- **1H briefing** : 1× par event (déduit du nom + heure)
- **30min warning** : 1× par event
- **Breaking news** : 1× par news (déduit de l'URL)
- **Abnormal movement** : cooldown 5 min entre alertes

Tu ne risques pas d'être spammé.

---

## 🌍 Pourquoi 8 pays maintenant

Gold est influencé par :
- **CNY** : Chine = #1 importateur Gold mondial
- **USD/EUR** : devises dominantes du marché
- **JPY** : carry trade et BoJ policy
- **GBP/CHF** : safe havens européens
- **AUD/CAD** : currencies matières premières

**Avant V5.1** : tu rates les events Chine, BoJ, etc.
**Maintenant** : couverture complète

---

## 🔧 Si tu veux ajuster

Dis-moi :
- Pays à enlever (ex: pas besoin AUD)
- Pays à ajouter
- Threshold abnormal movement (actuellement $10/5min)
- Score min pour breaking news (actuellement 50)
- Cooldown différent

---

**KAO V2 V5.1** · Plus jamais surpris par le marché 🎯
