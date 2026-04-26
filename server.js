/**
 * KAO V2 LIVE SERVER v3.0 — PERSISTENT + CONSISTENCY ALERTS
 * NEW: PostgreSQL persistence, multi-accounts, consistency alerts, export CSV
 */
const express = require('express');
const cors = require('cors');
const path = require('path');
const fetch = require('node-fetch');
const Parser = require('rss-parser');
const cron = require('node-cron');
const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const parser = new Parser({ timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0 KaoV2' } });

const PORT = process.env.PORT || 3000;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'kaov2secret';
const DATABASE_URL = process.env.DATABASE_URL || '';

const pool = DATABASE_URL ? new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
}) : null;

async function initDatabase() {
  if (!pool) { console.log('⚠️ No DATABASE_URL'); return; }
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS trades (
      id SERIAL PRIMARY KEY, ticket BIGINT UNIQUE NOT NULL,
      account VARCHAR(50), symbol VARCHAR(20), direction VARCHAR(10),
      volume DECIMAL(10,2), entry DECIMAL(15,5), sl DECIMAL(15,5), tp DECIMAL(15,5),
      sl_pts DECIMAL(10,2), tp_pts DECIMAL(10,2),
      opened_at TIMESTAMP, closed_at TIMESTAMP, price_close DECIMAL(15,5),
      profit DECIMAL(10,2), commission DECIMAL(10,2), swap DECIMAL(10,2),
      net_profit DECIMAL(10,2), verdict VARCHAR(20), score INTEGER,
      advice_json TEXT, status VARCHAR(10) DEFAULT 'open',
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS accounts (
      account VARCHAR(50) PRIMARY KEY, broker VARCHAR(100),
      balance DECIMAL(15,2), equity DECIMAL(15,2), leverage INTEGER,
      account_type VARCHAR(20), daily_target DECIMAL(10,2),
      max_best_day DECIMAL(10,2), payout DECIMAL(10,2), last_ping TIMESTAMP
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_trades_account ON trades(account)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_trades_closed ON trades(closed_at)`);
    console.log('✅ Database initialized');
  } catch (e) { console.error('DB init error:', e.message); }
}

function detectAccountProfile(balance) {
  if (!balance) return null;
  if (balance >= 90000 && balance <= 110000) return { type: 'EQUITY_EDGE_100K', daily_target: 800, max_best_day: 859, payout: 8000 };
  if (balance >= 45000 && balance <= 55000) return { type: 'FTM_50K', daily_target: 360, max_best_day: 375, payout: 2400 };
  if (balance >= 18000 && balance <= 22000) return { type: 'FTM_20K', daily_target: 144, max_best_day: 150, payout: 960 };
  if (balance >= 9000 && balance <= 11000) return { type: 'ATOMS_10K', daily_target: 72, max_best_day: 75, payout: 480 };
  return { type: 'CUSTOM', daily_target: balance * 0.01, max_best_day: balance * 0.012, payout: balance * 0.08 };
}

const LEVELS = { major_resistance: 4900, resistance: 4889, kijun_h1: 4850, friday_close: 4834, support: 4790, intermediate_support: 4760, critical_pivot: 4744 };

let bot = null;
if (TELEGRAM_TOKEN) {
  try { bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false }); console.log('✅ Telegram OK'); }
  catch (e) { console.log('⚠️ Telegram:', e.message); }
}

let cache = {
  prices: {}, news: [], trump: [], calendar: [], matrix: {},
  trades: [], closedTrades: [], advices: [], accounts: {}, lastUpdate: null,
  brokerPrice: null,  // v3: live broker price from EA
  brokerPriceTime: null,
  // v4: market data from EA
  marketData: null,
  marketDataTime: null,
  activeConfluences: []  // detected setups
};

const RSS_SOURCES = {
  gold: [{ name: 'Kitco', url: 'https://www.kitco.com/rss/KitcoNews.xml' },
         { name: 'ForexLive', url: 'https://www.forexlive.com/feed' }],
  fed: [{ name: 'Federal Reserve', url: 'https://www.federalreserve.gov/feeds/press_all.xml' }],
  trump: [{ name: 'White House', url: 'https://www.whitehouse.gov/feed/' }],
  markets: [{ name: 'MarketWatch', url: 'https://www.marketwatch.com/rss/topstories' }]
};

function analyzeSentiment(text) {
  const bullish = ['dovish','cut','weak dollar','inflation','war','tension','crisis','decline','geopolitical','safe haven','uncertainty','fear','tariff','sanctions','escalation'];
  const bearish = ['hawkish','hike','strong dollar','peace','deal','resolution','optimism','calm','easing'];
  const t = text.toLowerCase();
  let bull = 0, bear = 0;
  bullish.forEach(w => { if (t.includes(w)) bull++; });
  bearish.forEach(w => { if (t.includes(w)) bear++; });
  if (bull > bear) return 'bull';
  if (bear > bull) return 'bear';
  return 'neutral';
}
function classifyImpact(text) {
  const high = ['fed','powell','trump','war','attack','crisis','fomc','rate decision','nfp','cpi','pmi'];
  const medium = ['gold','dollar','treasury','yield','inflation','jobless'];
  const t = text.toLowerCase();
  if (high.some(w => t.includes(w))) return 'high';
  if (medium.some(w => t.includes(w))) return 'medium';
  return 'low';
}
function classifyCategory(text) {
  const t = text.toLowerCase();
  if (t.includes('trump') || t.includes('president') || t.includes('white house')) return 'trump';
  if (t.includes('fed') || t.includes('powell') || t.includes('fomc')) return 'fed';
  if (t.includes('gold') || t.includes('xauusd') || t.includes('bullion')) return 'gold';
  if (t.includes('war') || t.includes('iran') || t.includes('china') || t.includes('geopolitic')) return 'geo';
  return 'other';
}
function goldImpactText(s, c) {
  if (c === 'fed' && s === 'bull') return 'Dovish Fed → USD faible → Gold bullish';
  if (c === 'fed' && s === 'bear') return 'Hawkish Fed → USD fort → Gold bearish';
  if (c === 'trump' && s === 'bull') return 'Trump vs USD/Fed → Gold bullish';
  if (c === 'geo' && s === 'bull') return 'Tensions géopolitiques → safe haven';
  if (c === 'gold' && s === 'bull') return 'Bullish direct XAU/USD';
  if (c === 'gold' && s === 'bear') return 'Pression vendeuse Gold';
  return 'Impact neutre';
}
function correlationToPlan(s, i) {
  if (s === 'bull' && i === 'high') return 'Biais BUY renforcé · 4790/4760';
  if (s === 'bear' && i === 'high') return 'Biais SELL renforcé · 4850/4889';
  if (i === 'high') return 'Volatilité attendue · serrer SL';
  return 'Contexte neutre';
}

function analyzeTrade(trade, accountInfo) {
  const sentiment = cache.matrix?.sentiment || 'NEUTRAL';
  const fedBias = cache.matrix?.fedBias || 'NEUTRAL';
  const usdStrength = cache.matrix?.usdStrength || 'NEUTRAL';
  const advice = { trade_ticket: trade.ticket, timestamp: new Date().toISOString(), score: 50, verdict: 'NEUTRAL', warnings: [], positives: [], context_notes: [], suggested_action: '' };
  const isBuy = trade.direction === 'BUY';
  const isSell = trade.direction === 'SELL';
  const entry = trade.entry;
  
  if (isSell) {
    if (Math.abs(entry - LEVELS.kijun_h1) < 3) { advice.positives.push(`✅ Entry proche Kijun H1 (${LEVELS.kijun_h1})`); advice.score += 15; }
    else if (Math.abs(entry - LEVELS.resistance) < 3) { advice.positives.push(`✅ Entry sur résistance ${LEVELS.resistance}`); advice.score += 15; }
    else if (entry > LEVELS.major_resistance) { advice.warnings.push(`🚨 SHORT au-dessus du mur ${LEVELS.major_resistance}`); advice.score -= 30; }
    else if (entry < LEVELS.support) { advice.warnings.push(`⚠️ SHORT sous support ${LEVELS.support}`); advice.score -= 25; }
  }
  if (isBuy) {
    if (Math.abs(entry - LEVELS.support) < 3) { advice.positives.push(`✅ Entry proche support ${LEVELS.support}`); advice.score += 15; }
    else if (Math.abs(entry - LEVELS.intermediate_support) < 3) { advice.positives.push(`✅ Entry sur support ${LEVELS.intermediate_support}`); advice.score += 15; }
    else if (entry < LEVELS.critical_pivot) { advice.warnings.push(`🚨 BUY sous pivot ${LEVELS.critical_pivot}`); advice.score -= 30; }
    else if (entry > LEVELS.kijun_h1) { advice.warnings.push(`⚠️ BUY au-dessus Kijun ${LEVELS.kijun_h1}`); advice.score -= 25; }
  }

  if (sentiment === 'BULLISH' && isBuy) { advice.positives.push(`✅ Aligné macro BULLISH`); advice.score += 10; }
  else if (sentiment === 'BULLISH' && isSell) { advice.warnings.push(`⚠️ SHORT contre BULLISH`); advice.score -= 15; }
  else if (sentiment === 'BEARISH' && isSell) { advice.positives.push(`✅ Aligné BEARISH`); advice.score += 10; }
  else if (sentiment === 'BEARISH' && isBuy) { advice.warnings.push(`⚠️ BUY contre BEARISH`); advice.score -= 15; }
  if (fedBias === 'DOVISH' && isBuy) { advice.positives.push(`✅ Fed DOVISH`); advice.score += 8; }
  if (fedBias === 'HAWKISH' && isBuy) { advice.warnings.push(`⚠️ Fed HAWKISH`); advice.score -= 8; }
  if (usdStrength === 'WEAK' && isBuy) { advice.positives.push(`✅ USD faible`); advice.score += 5; }

  if (trade.sl_pts === 0) { advice.warnings.push(`🚨 AUCUN SL · DANGER`); advice.score -= 40; }
  else if (trade.sl_pts > 20) { advice.warnings.push(`⚠️ SL large ${trade.sl_pts.toFixed(1)}pts`); advice.score -= 10; }
  else if (trade.sl_pts < 3) { advice.warnings.push(`⚠️ SL très serré`); advice.score -= 5; }
  if (trade.sl_pts > 0 && trade.tp_pts > 0) {
    const rr = trade.tp_pts / trade.sl_pts;
    if (rr >= 1.5) { advice.positives.push(`✅ R:R ${rr.toFixed(2)}`); advice.score += 8; }
    else if (rr < 1) { advice.warnings.push(`⚠️ R:R ${rr.toFixed(2)} · SL>TP`); advice.score -= 15; }
  }

  const profile = detectAccountProfile(accountInfo?.balance);
  if (profile) {
    if (profile.type.includes('50K') && trade.volume > 0.40) { advice.warnings.push(`⚠️ Lot ${trade.volume} trop gros pour 50K`); advice.score -= 15; }
    if (profile.type.includes('100K') && trade.volume > 0.60) { advice.warnings.push(`⚠️ Lot ${trade.volume} élevé pour 100K`); advice.score -= 10; }
    if (profile.type.includes('10K') && trade.volume > 0.08) { advice.warnings.push(`⚠️ Lot ${trade.volume} trop gros pour 10K`); advice.score -= 15; }
  }

  const hour = new Date().getHours();
  if (hour >= 9 && hour < 11) { advice.positives.push(`✅ Session Londres`); advice.score += 5; }
  else if (hour >= 14 && hour < 17) { advice.positives.push(`✅ Session NY`); advice.score += 5; }
  else if (hour >= 22 || hour < 7) { advice.warnings.push(`⚠️ Session Asie · volume faible`); advice.score -= 10; }

  const upcoming = cache.calendar?.filter(c => c.warn).length || 0;
  if (upcoming > 0) { advice.warnings.push(`⚠️ ${upcoming} news HIGH aujourd'hui`); advice.score -= 5; }

  advice.score = Math.max(0, Math.min(100, advice.score));
  if (advice.score >= 70) advice.verdict = 'GOOD';
  else if (advice.score >= 50) advice.verdict = 'ACCEPTABLE';
  else if (advice.score >= 30) advice.verdict = 'CAUTION';
  else advice.verdict = 'BAD';
  if (advice.verdict === 'GOOD') advice.suggested_action = 'Setup solide · maintenir discipline';
  else if (advice.verdict === 'ACCEPTABLE') advice.suggested_action = 'Setup correct · surveiller';
  else if (advice.verdict === 'CAUTION') advice.suggested_action = 'Attention · réduire lot';
  else advice.suggested_action = 'Setup risqué · sortie anticipée';
  return advice;
}

async function getDailyPnL(account) {
  if (!pool) return 0;
  try {
    const today = new Date().toISOString().split('T')[0];
    const res = await pool.query(`SELECT COALESCE(SUM(net_profit), 0) as total FROM trades WHERE account = $1 AND status = 'closed' AND DATE(closed_at) = $2`, [account, today]);
    return parseFloat(res.rows[0].total) || 0;
  } catch (e) { return 0; }
}

async function checkConsistencyAlert(account) {
  if (!pool) return null;
  const accountInfo = cache.accounts[account];
  if (!accountInfo) return null;
  const profile = detectAccountProfile(accountInfo.balance);
  if (!profile) return null;
  const currentPnL = await getDailyPnL(account);
  const bestDay = profile.max_best_day;
  if (currentPnL >= bestDay) return { level: 'CRITICAL', percentage: Math.round((currentPnL / bestDay) * 100), totalPnL: currentPnL, maxAllowed: bestDay, profile: profile.type, message: `🚨 PLAFOND DÉPASSÉ` };
  if (currentPnL >= bestDay * 0.80) return { level: 'WARNING', percentage: Math.round((currentPnL / bestDay) * 100), totalPnL: currentPnL, maxAllowed: bestDay, profile: profile.type, message: `Tu approches du plafond consistency` };
  return null;
}

async function sendConsistencyAlert(account, alert) {
  if (!bot || !TELEGRAM_CHAT_ID) return;
  const emoji = alert.level === 'CRITICAL' ? '🔴🚨' : '🟠⚠️';
  let msg = `${emoji} *KAO V2 · CONSISTENCY ALERT*\n\n`;
  msg += `📊 Compte : *${alert.profile}* (${account})\n`;
  msg += `💰 P&L jour : *$${alert.totalPnL.toFixed(2)}* / $${alert.maxAllowed}\n`;
  msg += `📈 Status : *${alert.percentage}%* du plafond\n\n`;
  msg += `*${alert.message}*\n\n`;
  if (alert.level === 'CRITICAL') {
    msg += `*RISQUE :*\n  ❌ Violation consistency 15%\n  ❌ Perte du payout\n  ❌ Compte perdu\n\n`;
    msg += `*🎯 ACTION IMMÉDIATE :*\n  ✅ FERME TES POSITIONS\n  ✅ N'ouvre AUCUN trade aujourd'hui\n  ✅ Préserve le compte`;
  } else {
    msg += `*CONSEIL :*\n  ⚠️ Stoppe aujourd'hui\n  ⚠️ Préserve ta consistency\n  ⚠️ Petit profit > compte perdu`;
  }
  try { await bot.sendMessage(TELEGRAM_CHAT_ID, msg, { parse_mode: 'Markdown' }); } catch (e) {}
}

async function sendTradeAdviceTelegram(trade, advice) {
  if (!bot || !TELEGRAM_CHAT_ID) return;
  const emoji = { 'GOOD':'🟢✅','ACCEPTABLE':'🟡','CAUTION':'🟠⚠️','BAD':'🔴🚨' }[advice.verdict];
  const profile = detectAccountProfile(cache.accounts[trade.account]?.balance);
  const dailyPnL = await getDailyPnL(trade.account);
  let msg = `${emoji} *KAO V2 · NEW TRADE*\n\n`;
  msg += `📊 *${trade.direction} ${trade.volume} ${trade.symbol}* @ ${trade.entry}\n`;
  if (profile) msg += `🏦 Compte : ${profile.type}\n`;
  if (trade.sl > 0) msg += `🛡 SL: ${trade.sl} (${trade.sl_pts.toFixed(1)}pts)\n`;
  else msg += `🚨 *NO SL*\n`;
  if (trade.tp > 0) msg += `🎯 TP: ${trade.tp} (${trade.tp_pts.toFixed(1)}pts)\n`;
  msg += `\n*VERDICT: ${advice.verdict}* · ${advice.score}/100\n`;
  if (profile) msg += `P&L jour : $${dailyPnL.toFixed(2)}/${profile.daily_target}\n`;
  msg += `\n`;
  if (advice.positives.length) msg += `*Forts:*\n${advice.positives.map(p => `  ${p}`).join('\n')}\n\n`;
  if (advice.warnings.length) msg += `*Alertes:*\n${advice.warnings.map(w => `  ${w}`).join('\n')}\n\n`;
  msg += `💡 ${advice.suggested_action}`;
  try { await bot.sendMessage(TELEGRAM_CHAT_ID, msg, { parse_mode: 'Markdown' }); } catch (e) {}
}

async function sendClosedTradeTelegram(trade) {
  if (!bot || !TELEGRAM_CHAT_ID) return;
  const emoji = trade.net_profit >= 0 ? '💰✅' : '❌📉';
  const profile = detectAccountProfile(cache.accounts[trade.account]?.balance);
  const dailyPnL = await getDailyPnL(trade.account);
  let msg = `${emoji} *KAO V2 · TRADE CLOSED*\n\n`;
  msg += `📊 ${trade.symbol} · ${trade.volume} lot\n`;
  msg += `💵 *P&L trade : ${trade.net_profit >= 0 ? '+' : ''}$${trade.net_profit.toFixed(2)}*\n`;
  if (profile) {
    const pct = Math.round((dailyPnL / profile.daily_target) * 100);
    msg += `\n📊 *Total jour : $${dailyPnL.toFixed(2)} / $${profile.daily_target}* (${pct}%)\n`;
    msg += `Plafond : $${profile.max_best_day}`;
  }
  try { await bot.sendMessage(TELEGRAM_CHAT_ID, msg, { parse_mode: 'Markdown' }); } catch (e) {}
}

async function fetchPrices() {
  const symbols = { 'XAUUSD':'GC=F','DXY':'DX-Y.NYB','US10Y':'^TNX','VIX':'^VIX','WTI':'CL=F' };
  const prices = {};
  for (const [key, symbol] of Object.entries(symbols)) {
    try {
      const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1m&range=1d`);
      const data = await res.json();
      const q = data?.chart?.result?.[0];
      if (q) { prices[key] = { price: q.meta.regularMarketPrice, change: parseFloat(((q.meta.regularMarketPrice - q.meta.chartPreviousClose) / q.meta.chartPreviousClose * 100).toFixed(2)) }; }
    } catch (e) {}
  }
  cache.prices = prices;
}

async function fetchNews() {
  const all = [];
  for (const [category, sources] of Object.entries(RSS_SOURCES)) {
    for (const source of sources) {
      try {
        const feed = await parser.parseURL(source.url);
        feed.items.slice(0, 6).forEach(item => {
          const text = (item.title + ' ' + (item.contentSnippet || '')).substring(0, 500);
          const s = analyzeSentiment(text); const i = classifyImpact(text); const ac = classifyCategory(text);
          all.push({ source: source.name, title: item.title, desc: (item.contentSnippet || '').substring(0, 200), link: item.link, time: item.pubDate || item.isoDate, impact: i, category: ac !== 'other' ? ac : category, signal: s, signalTitle: s === 'bull' ? 'Bullish Gold' : s === 'bear' ? 'Bearish Gold' : 'Neutre', signalText: goldImpactText(s, ac), correlation: correlationToPlan(s, i) });
        });
      } catch (e) {}
    }
  }
  all.sort((a, b) => new Date(b.time) - new Date(a.time));
  cache.news = all.slice(0, 25);
}

async function fetchTrump() {
  const allPosts = [];
  
  // Source 1: CNN archive (mis à jour toutes 5 min, plus fiable)
  try {
    const res = await fetch('https://ix.cnn.io/data/truth-social/truth_archive.json');
    if (res.ok) {
      const data = await res.json();
      const posts = Array.isArray(data) ? data : (data.posts || []);
      posts.slice(0, 30).forEach(p => {
        const text = stripHtml(p.content || p.text || '');
        if (text.length < 5) return;
        const sentiment = analyzeSentiment(text);
        const marketImpact = analyzeTrumpMarketImpact(text);
        allPosts.push({
          platform: 'TRUTH SOCIAL', time: p.created_at || p.date,
          text: text.substring(0, 500),
          link: p.url || `https://truthsocial.com/@realDonaldTrump/posts/${p.id || ''}`,
          impact: sentiment, analysis: marketImpact.analysis,
          marketImpact, source: 'cnn'
        });
      });
    }
  } catch (e) { console.log('CNN Trump archive error:', e.message); }
  
  // Source 2: trumpstruth.org RSS (fallback)
  if (allPosts.length === 0) {
    try {
      const feed = await parser.parseURL('https://trumpstruth.org/feed');
      feed.items.slice(0, 15).forEach(item => {
        const text = item.contentSnippet || item.title || '';
        const sentiment = analyzeSentiment(text);
        const marketImpact = analyzeTrumpMarketImpact(text);
        allPosts.push({
          platform: 'TRUTH SOCIAL', time: item.pubDate,
          text: text.substring(0, 500), link: item.link,
          impact: sentiment, analysis: marketImpact.analysis,
          marketImpact, source: 'trumpstruth'
        });
      });
    } catch (e) {}
  }
  
  allPosts.sort((a, b) => new Date(b.time) - new Date(a.time));
  
  // Detect new high-impact posts and notify
  const newImpactful = allPosts.filter(p => {
    if (!p.marketImpact || p.marketImpact.score < 70) return false;
    if (alertedTrumpPostIds.has(p.link)) return false;
    const ageHours = (Date.now() - new Date(p.time)) / 3600000;
    if (ageHours > 2 || ageHours < 0) return false;
    alertedTrumpPostIds.add(p.link);
    return true;
  });
  for (const p of newImpactful.slice(0, 3)) await sendTrumpAlertTelegram(p);
  
  if (alertedTrumpPostIds.size > 200) {
    const arr = Array.from(alertedTrumpPostIds);
    alertedTrumpPostIds.clear();
    arr.slice(-100).forEach(i => alertedTrumpPostIds.add(i));
  }
  
  cache.trump = allPosts.slice(0, 15);
}

let alertedTrumpPostIds = new Set();

function stripHtml(s) {
  if (!s) return '';
  return s.replace(/<[^>]*>/g, '').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();
}

// Analyze Trump post for Gold market impact
function analyzeTrumpMarketImpact(text) {
  const t = text.toLowerCase();
  let score = 0;
  let direction = 'neutral';
  let topics = [];
  
  const bullishGold = {
    'fed': { weight: 25, label: 'Fed pressure' },
    'powell': { weight: 25, label: 'Powell pressure' },
    'rate cut': { weight: 30, label: 'Rate cut call' },
    'cut rates': { weight: 30, label: 'Rate cut call' },
    'lower rates': { weight: 25, label: 'Lower rates' },
    'weak dollar': { weight: 30, label: 'Weak dollar' },
    'dollar too strong': { weight: 30, label: 'USD too strong' },
    'tariff': { weight: 30, label: 'Tariffs' },
    'tariffs': { weight: 30, label: 'Tariffs' },
    'china': { weight: 20, label: 'China tensions' },
    'iran': { weight: 25, label: 'Iran tensions' },
    'russia': { weight: 20, label: 'Russia tensions' },
    'war': { weight: 30, label: 'War rhetoric' },
    'military': { weight: 20, label: 'Military action' },
    'sanctions': { weight: 25, label: 'Sanctions' },
    'trade war': { weight: 35, label: 'Trade war' },
    'crisis': { weight: 20, label: 'Crisis rhetoric' },
    'inflation': { weight: 15, label: 'Inflation' },
    'attack': { weight: 30, label: 'Attack threat' },
    'strike': { weight: 25, label: 'Military strike' }
  };
  const bearishGold = {
    'peace': { weight: 25, label: 'Peace deal' },
    'agreement': { weight: 20, label: 'Agreement' },
    'ceasefire': { weight: 25, label: 'Ceasefire' },
    'strong dollar': { weight: 25, label: 'Strong USD' },
    'rate hike': { weight: 25, label: 'Rate hike' },
    'truce': { weight: 25, label: 'Truce' }
  };
  
  for (const [kw, info] of Object.entries(bullishGold)) {
    if (t.includes(kw)) {
      score += info.weight;
      topics.push(`📈 ${info.label}`);
      direction = direction === 'bear' ? 'mixed' : 'bull';
    }
  }
  for (const [kw, info] of Object.entries(bearishGold)) {
    if (t.includes(kw)) {
      score += info.weight;
      topics.push(`📉 ${info.label}`);
      direction = direction === 'bull' ? 'mixed' : 'bear';
    }
  }
  
  // CAPS LOCK = emotion
  const capsCount = (text.match(/[A-Z]/g) || []).length;
  const capsRatio = capsCount / Math.max(text.length, 1);
  if (capsRatio > 0.4 && text.length > 30) {
    score += 10;
    topics.push('🔊 CAPS LOCK (emotion)');
  }
  // Exclamations = urgency
  const excl = (text.match(/!/g) || []).length;
  if (excl >= 3) {
    score += 5;
    topics.push(`❗ ${excl} exclamations`);
  }
  
  score = Math.min(100, score);
  
  let analysis = 'Impact neutre sur Gold';
  if (direction === 'bull' && score >= 50) analysis = '📈 Très bullish Gold (USD pressure / géopolitique)';
  else if (direction === 'bull' && score >= 30) analysis = '📈 Bullish Gold modéré';
  else if (direction === 'bull') analysis = '📈 Léger biais bullish Gold';
  else if (direction === 'bear' && score >= 50) analysis = '📉 Très bearish Gold (USD strong / peace)';
  else if (direction === 'bear' && score >= 30) analysis = '📉 Bearish Gold modéré';
  else if (direction === 'bear') analysis = '📉 Léger biais bearish Gold';
  else if (direction === 'mixed') analysis = '🟡 Signaux mixtes';
  
  return { score, direction, topics, analysis };
}

async function sendTrumpAlertTelegram(post) {
  if (!bot || !TELEGRAM_CHAT_ID) return;
  const m = post.marketImpact;
  const arrowEmoji = m.direction === 'bull' ? '📈🟢' : m.direction === 'bear' ? '📉🔴' : '🟡';
  let msg = `${arrowEmoji} *KAO V2 · TRUMP POST IMPACT*\n\n`;
  msg += `*Impact Gold : ${m.score}/100*\n`;
  msg += `${m.analysis}\n\n`;
  if (m.topics.length) msg += `*Triggers :*\n${m.topics.map(t => `  ${t}`).join('\n')}\n\n`;
  msg += `*Post :*\n_"${post.text.substring(0, 280)}${post.text.length > 280 ? '...' : ''}"_\n\n`;
  msg += `📅 ${new Date(post.time).toLocaleString('fr-FR')}`;
  try { await bot.sendMessage(TELEGRAM_CHAT_ID, msg, { parse_mode: 'Markdown', disable_web_page_preview: true }); }
  catch (e) { console.log('TG Trump:', e.message); }
}

async function fetchCalendar() {
  try {
    const res = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json');
    const data = await res.json();
    const today = new Date().toDateString();
    cache.calendar = data.filter(e => e.date && new Date(e.date).toDateString() === today).map(e => ({ time: new Date(e.date).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }), event: e.title, sub: `${e.country} ${e.forecast ? '· F:' + e.forecast : ''} ${e.previous ? '· P:' + e.previous : ''}`, impact: e.impact?.toLowerCase() || 'low', warn: e.impact?.toLowerCase() === 'high' && ['USD', 'EUR'].includes(e.country) }));
  } catch (e) { cache.calendar = []; }
}

function computeMatrix() {
  const news = cache.news || [];
  const last15 = news.slice(0, 15);
  let bull = 0, bear = 0;
  last15.forEach(n => { if (n.signal === 'bull') bull++; if (n.signal === 'bear') bear++; });
  const sentiment = bull > bear * 1.3 ? 'BULLISH' : bear > bull * 1.3 ? 'BEARISH' : 'NEUTRAL';
  const fedNews = news.filter(n => n.category === 'fed').slice(0, 5);
  const fedBias = fedNews.filter(n => n.signal === 'bull').length >= 2 ? 'DOVISH' : fedNews.filter(n => n.signal === 'bull').length === 0 ? 'HAWKISH' : 'MIXED';
  const dxyChange = cache.prices?.DXY?.change || 0;
  const usdStrength = dxyChange < -0.3 ? 'WEAK' : dxyChange > 0.3 ? 'STRONG' : 'NEUTRAL';
  const geoTension = news.filter(n => n.category === 'geo' && n.impact === 'high').length >= 2 ? 'HIGH' : 'MODERATE';
  let reco = 'Attendre setup sur zones clés';
  if (sentiment === 'BULLISH' && geoTension === 'HIGH') reco = 'Prioriser BUY 4790/4760';
  else if (sentiment === 'BEARISH') reco = 'Setups SHORT privilégiés';
  cache.matrix = { sentiment, sentimentClass: sentiment === 'BULLISH' ? 'bull' : sentiment === 'BEARISH' ? 'bear' : 'neutral', fedBias, fedBiasClass: fedBias === 'DOVISH' ? 'bull' : fedBias === 'HAWKISH' ? 'bear' : 'neutral', usdStrength, usdStrengthClass: usdStrength === 'WEAK' ? 'bear' : usdStrength === 'STRONG' ? 'bull' : 'neutral', geoTension, geoTensionClass: geoTension === 'HIGH' ? 'bull' : 'neutral', reco };
}

async function loadFromDatabase() {
  if (!pool) return;
  try {
    const accRes = await pool.query('SELECT * FROM accounts');
    accRes.rows.forEach(a => { cache.accounts[a.account] = { broker: a.broker, balance: parseFloat(a.balance), equity: parseFloat(a.equity), leverage: a.leverage, lastPing: a.last_ping }; });
    const openRes = await pool.query(`SELECT * FROM trades WHERE status = 'open' ORDER BY opened_at DESC`);
    cache.trades = openRes.rows.map(r => ({ ticket: r.ticket, account: r.account, symbol: r.symbol, direction: r.direction, volume: parseFloat(r.volume), entry: parseFloat(r.entry), sl: parseFloat(r.sl), tp: parseFloat(r.tp), sl_pts: parseFloat(r.sl_pts), tp_pts: parseFloat(r.tp_pts), time: r.opened_at }));
    const closedRes = await pool.query(`SELECT * FROM trades WHERE status = 'closed' ORDER BY closed_at DESC LIMIT 100`);
    cache.closedTrades = closedRes.rows.map(r => ({ ticket: r.ticket, account: r.account, symbol: r.symbol, volume: parseFloat(r.volume), price_close: parseFloat(r.price_close), profit: parseFloat(r.profit), commission: parseFloat(r.commission), swap: parseFloat(r.swap), net_profit: parseFloat(r.net_profit), time: r.closed_at }));
    const adviceRes = await pool.query(`SELECT ticket, verdict, score, advice_json FROM trades WHERE advice_json IS NOT NULL ORDER BY created_at DESC LIMIT 50`);
    cache.advices = adviceRes.rows.map(r => { try { const a = JSON.parse(r.advice_json); return { ...a, trade_ticket: r.ticket, verdict: r.verdict, score: r.score }; } catch (e) { return null; } }).filter(Boolean);
    console.log(`📂 Loaded: ${cache.trades.length} open, ${cache.closedTrades.length} closed, ${Object.keys(cache.accounts).length} accounts`);
  } catch (e) { console.error('Load DB:', e.message); }
}

// ============ SMART LEVELS ENGINE v4.5 - COMPLETE STRATEGY ============
// Pierre's full strategy:
//  - RSI overbought/oversold multi-TF (M1, M5, M15, H1)
//  - Liquidity sweeps (high/low taken out then reversed)
//  - Support/Resistance (M5, M15, H1 pivots)
//  - Double tops/bottoms
//  - Pin bars / rejection candles
//  - Confirmation: H1 OR M15 (one is enough)
//  - Alert even small 3+ pts moves

let lastConfluenceAlerts = {};

function detectDoubleTop(pivots_high, currentPrice, tolerancePts = 4) {
  if (!pivots_high || pivots_high.length < 2) return false;
  const [h1, h2] = pivots_high.slice(0, 2);
  if (Math.abs(h1 - h2) > tolerancePts) return false;
  if (currentPrice > h1 + 2) return false;
  if (currentPrice < h1 - 18) return false;
  return { top1: h1, top2: h2, avg: (h1 + h2) / 2 };
}

function detectDoubleBottom(pivots_low, currentPrice, tolerancePts = 4) {
  if (!pivots_low || pivots_low.length < 2) return false;
  const [l1, l2] = pivots_low.slice(0, 2);
  if (Math.abs(l1 - l2) > tolerancePts) return false;
  if (currentPrice < l1 - 2) return false;
  if (currentPrice > l1 + 18) return false;
  return { bottom1: l1, bottom2: l2, avg: (l1 + l2) / 2 };
}

// Find nearest resistance/support level (multi-TF combined)
function findNearestLevels(price, m) {
  const allHighs = [];
  const allLows = [];
  
  if (m.pivots_high) m.pivots_high.forEach(p => allHighs.push({price: p, tf: 'M5', weight: 1}));
  if (m.pivots_high_m15) m.pivots_high_m15.forEach(p => allHighs.push({price: p, tf: 'M15', weight: 2}));
  if (m.pivots_high_h1) m.pivots_high_h1.forEach(p => allHighs.push({price: p, tf: 'H1', weight: 3}));
  if (m.pivots_low) m.pivots_low.forEach(p => allLows.push({price: p, tf: 'M5', weight: 1}));
  if (m.pivots_low_m15) m.pivots_low_m15.forEach(p => allLows.push({price: p, tf: 'M15', weight: 2}));
  if (m.pivots_low_h1) m.pivots_low_h1.forEach(p => allLows.push({price: p, tf: 'H1', weight: 3}));
  
  // Find resistance above price (within 10 pts)
  const resistances = allHighs
    .filter(h => h.price > price && h.price - price < 10)
    .sort((a, b) => a.price - b.price);
  // Find support below price (within 10 pts)
  const supports = allLows
    .filter(l => l.price < price && price - l.price < 10)
    .sort((a, b) => b.price - a.price);
  
  return { resistances, supports };
}

// Check if price is "at" a level (within 1.5 pts)
function nearLevel(price, level, tolerance = 1.5) {
  return Math.abs(price - level) <= tolerance;
}

function analyzeSmartLevels() {
  const m = cache.marketData;
  if (!m || !m.mid) return [];
  
  const setups = [];
  const price = m.mid;
  const COOLDOWN_MS = 8 * 60 * 1000;  // 8 min cooldown
  
  // === Indicators flags ===
  const rsi_m1_70 = m.rsi_m1 >= 70;
  const rsi_m1_75 = m.rsi_m1 >= 75;
  const rsi_m1_80 = m.rsi_m1 >= 80;
  const rsi_m5_70 = m.rsi_m5 >= 70;
  const rsi_m5_75 = m.rsi_m5 >= 75;
  const rsi_m15_65 = m.rsi_m15 >= 65;
  const rsi_m15_70 = m.rsi_m15 >= 70;
  const rsi_h1_60 = m.rsi_h1 >= 60;
  const rsi_h1_65 = m.rsi_h1 >= 65;
  
  const rsi_m1_30 = m.rsi_m1 <= 30;
  const rsi_m1_25 = m.rsi_m1 <= 25;
  const rsi_m1_20 = m.rsi_m1 <= 20;
  const rsi_m5_30 = m.rsi_m5 <= 30;
  const rsi_m5_25 = m.rsi_m5 <= 25;
  const rsi_m15_35 = m.rsi_m15 <= 35;
  const rsi_m15_30 = m.rsi_m15 <= 30;
  const rsi_h1_40 = m.rsi_h1 <= 40;
  
  const h1_trend_up = m.ema50_h1 > m.ema200_h1;
  const h1_trend_down = m.ema50_h1 < m.ema200_h1;
  const m15_above_ema50 = price > m.ema50_m15;
  const m15_below_ema50 = price < m.ema50_m15;
  
  const doubleTop = detectDoubleTop(m.pivots_high, price);
  const doubleBottom = detectDoubleBottom(m.pivots_low, price);
  const { resistances, supports } = findNearestLevels(price, m);
  const nearestRes = resistances[0];
  const nearestSup = supports[0];
  
  const nearResistance = nearestRes && nearLevel(price, nearestRes.price, 2);
  const nearSupport = nearestSup && nearLevel(price, nearestSup.price, 2);
  
  // ============================================================
  // SHORT SETUPS (BEARISH)
  // ============================================================
  
  // === A++ SHORT: Liquidity Sweep High + RSI confluence ===
  // Le sweep est le setup le plus puissant
  if (m.sweep_high && (rsi_m5_70 || rsi_m1_75)) {
    const conf = [];
    conf.push(`✅ LIQUIDITY SWEEP @ ${m.sweep_high_level.toFixed(2)} (mèche au-dessus puis retour)`);
    if (rsi_m1_75) conf.push(`✅ RSI M1 ${m.rsi_m1.toFixed(1)} (≥75)`);
    if (rsi_m5_70) conf.push(`✅ RSI M5 ${m.rsi_m5.toFixed(1)} (≥70)`);
    
    let score = 75;
    let grade = 'A+';
    if (rsi_m15_65) { conf.push(`✅ RSI M15 ${m.rsi_m15.toFixed(1)} (≥65)`); score += 10; grade = 'A++'; }
    if (m.is_pin_bear) { conf.push(`✅ Pin bar bearish M5`); score += 5; }
    if (h1_trend_down) { conf.push(`✅ H1 trend baissier`); score += 8; grade = 'A++'; }
    else if (h1_trend_up) conf.push(`⚠️ H1 trend haussier (mais sweep prime)`);
    
    setups.push({
      type: 'SHORT', grade, score,
      label: `🎯 LIQUIDITY SWEEP SHORT`,
      entry: price,
      sl: m.sweep_high_level + 3,
      tp1: price - 3, tp2: price - 5, tp3: price - 8,
      sl_pts: (m.sweep_high_level + 3 - price).toFixed(1),
      tp1_pts: '3.0', tp2_pts: '5.0', tp3_pts: '8.0',
      rr: ((price - (price - 5)) / (m.sweep_high_level + 3 - price)).toFixed(2),
      confluences: conf,
      alertKey: 'SHORT_SWEEP'
    });
  }
  
  // === A++ SHORT: Double Top + RSI multi-TF ===
  if (doubleTop && rsi_m5_70 && rsi_m1_70) {
    const conf = [];
    conf.push(`✅ DOUBLE TOP M5 @ ${doubleTop.avg.toFixed(2)} (tops ${doubleTop.top1.toFixed(2)} & ${doubleTop.top2.toFixed(2)})`);
    conf.push(`✅ RSI M5 ${m.rsi_m5.toFixed(1)} (≥70)`);
    conf.push(`✅ RSI M1 ${m.rsi_m1.toFixed(1)} (≥70)`);
    
    let score = 80;
    let grade = 'A+';
    // Need H1 OR M15 confirmation
    if (rsi_m15_65 || rsi_h1_60) {
      if (rsi_m15_65) conf.push(`✅ RSI M15 ${m.rsi_m15.toFixed(1)} confirme`);
      if (rsi_h1_60) conf.push(`✅ RSI H1 ${m.rsi_h1.toFixed(1)} confirme`);
      score += 10; grade = 'A++';
    }
    if (h1_trend_down) { conf.push(`✅ H1 trend baissier`); score += 5; }
    else if (h1_trend_up) { conf.push(`⚠️ H1 haussier (contre-tendance)`); score -= 8; }
    if (m.is_pin_bear) { conf.push(`✅ Pin bar bearish M5`); score += 5; }
    
    setups.push({
      type: 'SHORT', grade, score,
      label: `⭐ A+ DOUBLE TOP SHORT`,
      entry: price,
      sl: doubleTop.avg + 4,
      tp1: price - 4, tp2: price - 7, tp3: price - 12,
      sl_pts: (doubleTop.avg + 4 - price).toFixed(1),
      tp1_pts: '4.0', tp2_pts: '7.0', tp3_pts: '12.0',
      rr: '1.0',
      confluences: conf,
      alertKey: 'SHORT_DT'
    });
  }
  
  // === A SHORT: Resistance + RSI overbought ===
  if (nearResistance && rsi_m5_70 && rsi_m1_70) {
    const conf = [];
    conf.push(`✅ RÉSISTANCE ${nearestRes.tf} @ ${nearestRes.price.toFixed(2)}`);
    conf.push(`✅ RSI M5 ${m.rsi_m5.toFixed(1)} (≥70)`);
    conf.push(`✅ RSI M1 ${m.rsi_m1.toFixed(1)} (≥70)`);
    
    let score = 70;
    let grade = 'A';
    if (rsi_m15_65 || rsi_h1_60) {
      if (rsi_m15_65) conf.push(`✅ RSI M15 ${m.rsi_m15.toFixed(1)} confirme`);
      if (rsi_h1_60) conf.push(`✅ RSI H1 ${m.rsi_h1.toFixed(1)} confirme`);
      score += 8; grade = 'A+';
    }
    if (h1_trend_down) { conf.push(`✅ H1 baissier`); score += 5; }
    if (m.is_pin_bear) { conf.push(`✅ Pin bar bearish`); score += 5; }
    
    setups.push({
      type: 'SHORT', grade, score,
      label: `🎯 RÉSISTANCE ${nearestRes.tf} SHORT`,
      entry: price,
      sl: nearestRes.price + 4,
      tp1: price - 3, tp2: price - 5, tp3: price - 8,
      sl_pts: (nearestRes.price + 4 - price).toFixed(1),
      tp1_pts: '3.0', tp2_pts: '5.0', tp3_pts: '8.0',
      rr: '1.0',
      confluences: conf,
      alertKey: `SHORT_RES_${nearestRes.tf}`
    });
  }
  
  // === B SCALP SHORT: RSI M1 extrême (4-5 pts) ===
  if (rsi_m1_80 && rsi_m5_70) {
    const conf = [];
    conf.push(`⚡ RSI M1 ${m.rsi_m1.toFixed(1)} EXTRÊME (≥80)`);
    conf.push(`✅ RSI M5 ${m.rsi_m5.toFixed(1)} confirme`);
    
    let score = 65;
    let grade = 'B';
    if (rsi_m15_65) { conf.push(`✅ RSI M15 ${m.rsi_m15.toFixed(1)}`); score += 8; }
    if (m.is_pin_bear) { conf.push(`✅ Pin bar bearish`); score += 8; }
    if (h1_trend_down) { conf.push(`✅ H1 baissier`); score += 5; }
    else if (h1_trend_up) { conf.push(`⚠️ H1 haussier`); score -= 10; }
    
    setups.push({
      type: 'SHORT', grade, score,
      label: `⚡ B SCALP SHORT · RSI M1 extrême`,
      entry: price,
      sl: price + 5,
      tp1: price - 3, tp2: price - 5,
      sl_pts: '5.0', tp1_pts: '3.0', tp2_pts: '5.0',
      tp3: price - 7, tp3_pts: '7.0',
      rr: '0.60',
      confluences: conf,
      alertKey: 'SHORT_SCALP_M1'
    });
  }
  
  // === C SHORT: Pin bar M5 + RSI overbought ===
  if (m.is_pin_bear && (rsi_m5_70 || rsi_m1_75)) {
    const conf = [];
    conf.push(`✅ PIN BAR BEARISH M5 (mèche ${m.m5_upper_wick.toFixed(1)} pts)`);
    if (rsi_m5_70) conf.push(`✅ RSI M5 ${m.rsi_m5.toFixed(1)}`);
    if (rsi_m1_75) conf.push(`✅ RSI M1 ${m.rsi_m1.toFixed(1)}`);
    
    let score = 55;
    if (rsi_m15_65) { conf.push(`✅ RSI M15 ${m.rsi_m15.toFixed(1)}`); score += 5; }
    if (h1_trend_down) { conf.push(`✅ H1 baissier`); score += 8; }
    
    setups.push({
      type: 'SHORT', grade: 'C', score,
      label: `🔴 C SHORT · Pin bar + RSI`,
      entry: price,
      sl: price + 5,
      tp1: price - 3, tp2: price - 5, tp3: price - 7,
      sl_pts: '5.0', tp1_pts: '3.0', tp2_pts: '5.0', tp3_pts: '7.0',
      rr: '0.60',
      confluences: conf,
      alertKey: 'SHORT_PIN'
    });
  }
  
  // === A++ SHORT: PDH (Previous Day High) sweep + RSI ===
  // Le PDH est un niveau institutionnel ultra-puissant
  if (m.pdh && Math.abs(price - m.pdh) <= 2 && (rsi_m5_70 || rsi_m1_75)) {
    const conf = [];
    conf.push(`🔥 PDH (Previous Day High) @ ${m.pdh.toFixed(2)}`);
    if (rsi_m5_70) conf.push(`✅ RSI M5 ${m.rsi_m5.toFixed(1)} overbought`);
    if (rsi_m1_75) conf.push(`✅ RSI M1 ${m.rsi_m1.toFixed(1)} overbought`);
    
    let score = 78;
    let grade = 'A+';
    if (m.sweep_high && Math.abs(m.sweep_high_level - m.pdh) < 3) {
      conf.push(`🎯 Sweep du PDH confirmé`); score += 12; grade = 'A++';
    }
    if (rsi_m15_65 || rsi_h1_60) { conf.push(`✅ Multi-TF confirme`); score += 8; }
    if (m.is_pin_bear) { conf.push(`✅ Pin bar bearish`); score += 5; }
    if (h1_trend_down) { conf.push(`✅ H1 baissier`); score += 5; }
    
    setups.push({
      type: 'SHORT', grade, score,
      label: `🔥 PDH SHORT · niveau institutionnel`,
      entry: price,
      sl: m.pdh + 4,
      tp1: price - 4, tp2: price - 7, tp3: price - 12,
      sl_pts: (m.pdh + 4 - price).toFixed(1),
      tp1_pts: '4.0', tp2_pts: '7.0', tp3_pts: '12.0',
      rr: '1.0',
      confluences: conf,
      alertKey: 'SHORT_PDH'
    });
  }
  
  // === A SHORT: BOS (Break of Structure) bearish + RSI ===
  // BOS = casse de structure baissière, momentum confirmé
  if (m.bos_bearish && (rsi_m5_70 || rsi_m1_70)) {
    const conf = [];
    conf.push(`🔻 BOS BEARISH M15 @ ${m.bos_level?.toFixed(2)} (structure cassée)`);
    if (rsi_m5_70) conf.push(`✅ RSI M5 ${m.rsi_m5.toFixed(1)}`);
    if (rsi_m1_70) conf.push(`✅ RSI M1 ${m.rsi_m1.toFixed(1)}`);
    
    let score = 70;
    let grade = 'A';
    if (rsi_m15_65) { conf.push(`✅ RSI M15 ${m.rsi_m15.toFixed(1)} confirme`); score += 8; grade = 'A+'; }
    if (h1_trend_down) { conf.push(`✅ H1 baissier`); score += 8; }
    if (m.huge_impulse_bear) { conf.push(`💥 Impulsion baissière forte`); score += 10; grade = 'A+'; }
    
    setups.push({
      type: 'SHORT', grade, score,
      label: `🔻 BOS BEARISH · momentum confirmé`,
      entry: price,
      sl: m.bos_level + 5,
      tp1: price - 4, tp2: price - 7, tp3: price - 12,
      sl_pts: (m.bos_level + 5 - price).toFixed(1),
      tp1_pts: '4.0', tp2_pts: '7.0', tp3_pts: '12.0',
      rr: '1.0',
      confluences: conf,
      alertKey: 'SHORT_BOS'
    });
  }
  
  // === A SHORT: John Wick Candle bearish (gros mouvement directionnel) ===
  if (m.john_wick_bear && (rsi_m5_70 || rsi_m1_75 || m.huge_impulse_bear)) {
    const conf = [];
    conf.push(`💀 JOHN WICK CANDLE BEARISH (body ${m.m5_body?.toFixed(1)} pts)`);
    if (m.huge_impulse_bear) conf.push(`💥 Impulsion >1.3x ATR`);
    if (rsi_m5_70) conf.push(`✅ RSI M5 ${m.rsi_m5.toFixed(1)}`);
    if (rsi_m1_75) conf.push(`✅ RSI M1 ${m.rsi_m1.toFixed(1)}`);
    
    let score = 65;
    let grade = 'A';
    if (h1_trend_down) { conf.push(`✅ H1 baissier`); score += 10; grade = 'A+'; }
    
    setups.push({
      type: 'SHORT', grade, score,
      label: `💀 JOHN WICK SHORT · momentum brutal`,
      entry: price,
      sl: price + 6,
      tp1: price - 4, tp2: price - 7, tp3: price - 10,
      sl_pts: '6.0', tp1_pts: '4.0', tp2_pts: '7.0', tp3_pts: '10.0',
      rr: '0.67',
      confluences: conf,
      alertKey: 'SHORT_JOHN_WICK'
    });
  }
  
  // ============================================================
  // BUY SETUPS (BULLISH)
  // ============================================================
  
  // === A++ BUY: Liquidity Sweep Low + RSI ===
  if (m.sweep_low && (rsi_m5_30 || rsi_m1_25)) {
    const conf = [];
    conf.push(`✅ LIQUIDITY SWEEP @ ${m.sweep_low_level.toFixed(2)} (mèche en-dessous puis retour)`);
    if (rsi_m1_25) conf.push(`✅ RSI M1 ${m.rsi_m1.toFixed(1)} (≤25)`);
    if (rsi_m5_30) conf.push(`✅ RSI M5 ${m.rsi_m5.toFixed(1)} (≤30)`);
    
    let score = 75;
    let grade = 'A+';
    if (rsi_m15_35) { conf.push(`✅ RSI M15 ${m.rsi_m15.toFixed(1)} (≤35)`); score += 10; grade = 'A++'; }
    if (m.is_pin_bull) { conf.push(`✅ Pin bar bullish M5`); score += 5; }
    if (h1_trend_up) { conf.push(`✅ H1 trend haussier`); score += 8; grade = 'A++'; }
    else if (h1_trend_down) conf.push(`⚠️ H1 baissier (mais sweep prime)`);
    
    setups.push({
      type: 'BUY', grade, score,
      label: `🎯 LIQUIDITY SWEEP BUY`,
      entry: price,
      sl: m.sweep_low_level - 3,
      tp1: price + 3, tp2: price + 5, tp3: price + 8,
      sl_pts: (price - (m.sweep_low_level - 3)).toFixed(1),
      tp1_pts: '3.0', tp2_pts: '5.0', tp3_pts: '8.0',
      rr: '1.0',
      confluences: conf,
      alertKey: 'BUY_SWEEP'
    });
  }
  
  // === A++ BUY: Double Bottom + RSI multi-TF ===
  if (doubleBottom && rsi_m5_30 && rsi_m1_30) {
    const conf = [];
    conf.push(`✅ DOUBLE BOTTOM M5 @ ${doubleBottom.avg.toFixed(2)}`);
    conf.push(`✅ RSI M5 ${m.rsi_m5.toFixed(1)} (≤30)`);
    conf.push(`✅ RSI M1 ${m.rsi_m1.toFixed(1)} (≤30)`);
    
    let score = 80;
    let grade = 'A+';
    if (rsi_m15_35 || rsi_h1_40) {
      if (rsi_m15_35) conf.push(`✅ RSI M15 ${m.rsi_m15.toFixed(1)}`);
      if (rsi_h1_40) conf.push(`✅ RSI H1 ${m.rsi_h1.toFixed(1)}`);
      score += 10; grade = 'A++';
    }
    if (h1_trend_up) { conf.push(`✅ H1 haussier`); score += 5; }
    else if (h1_trend_down) { conf.push(`⚠️ H1 baissier (contre-tendance)`); score -= 8; }
    if (m.is_pin_bull) { conf.push(`✅ Pin bar bullish M5`); score += 5; }
    
    setups.push({
      type: 'BUY', grade, score,
      label: `⭐ A+ DOUBLE BOTTOM BUY`,
      entry: price,
      sl: doubleBottom.avg - 4,
      tp1: price + 4, tp2: price + 7, tp3: price + 12,
      sl_pts: (price - (doubleBottom.avg - 4)).toFixed(1),
      tp1_pts: '4.0', tp2_pts: '7.0', tp3_pts: '12.0',
      rr: '1.0',
      confluences: conf,
      alertKey: 'BUY_DB'
    });
  }
  
  // === A BUY: Support + RSI oversold ===
  if (nearSupport && rsi_m5_30 && rsi_m1_30) {
    const conf = [];
    conf.push(`✅ SUPPORT ${nearestSup.tf} @ ${nearestSup.price.toFixed(2)}`);
    conf.push(`✅ RSI M5 ${m.rsi_m5.toFixed(1)} (≤30)`);
    conf.push(`✅ RSI M1 ${m.rsi_m1.toFixed(1)} (≤30)`);
    
    let score = 70;
    let grade = 'A';
    if (rsi_m15_35 || rsi_h1_40) {
      if (rsi_m15_35) conf.push(`✅ RSI M15 ${m.rsi_m15.toFixed(1)}`);
      if (rsi_h1_40) conf.push(`✅ RSI H1 ${m.rsi_h1.toFixed(1)}`);
      score += 8; grade = 'A+';
    }
    if (h1_trend_up) { conf.push(`✅ H1 haussier`); score += 5; }
    if (m.is_pin_bull) { conf.push(`✅ Pin bar bullish`); score += 5; }
    
    setups.push({
      type: 'BUY', grade, score,
      label: `🎯 SUPPORT ${nearestSup.tf} BUY`,
      entry: price,
      sl: nearestSup.price - 4,
      tp1: price + 3, tp2: price + 5, tp3: price + 8,
      sl_pts: (price - (nearestSup.price - 4)).toFixed(1),
      tp1_pts: '3.0', tp2_pts: '5.0', tp3_pts: '8.0',
      rr: '1.0',
      confluences: conf,
      alertKey: `BUY_SUP_${nearestSup.tf}`
    });
  }
  
  // === B SCALP BUY: RSI M1 extrême ===
  if (rsi_m1_20 && rsi_m5_30) {
    const conf = [];
    conf.push(`⚡ RSI M1 ${m.rsi_m1.toFixed(1)} EXTRÊME (≤20)`);
    conf.push(`✅ RSI M5 ${m.rsi_m5.toFixed(1)} confirme`);
    
    let score = 65;
    let grade = 'B';
    if (rsi_m15_35) { conf.push(`✅ RSI M15 ${m.rsi_m15.toFixed(1)}`); score += 8; }
    if (m.is_pin_bull) { conf.push(`✅ Pin bar bullish`); score += 8; }
    if (h1_trend_up) { conf.push(`✅ H1 haussier`); score += 5; }
    else if (h1_trend_down) { conf.push(`⚠️ H1 baissier`); score -= 10; }
    
    setups.push({
      type: 'BUY', grade, score,
      label: `⚡ B SCALP BUY · RSI M1 extrême`,
      entry: price,
      sl: price - 5,
      tp1: price + 3, tp2: price + 5, tp3: price + 7,
      sl_pts: '5.0', tp1_pts: '3.0', tp2_pts: '5.0', tp3_pts: '7.0',
      rr: '0.60',
      confluences: conf,
      alertKey: 'BUY_SCALP_M1'
    });
  }
  
  // === C BUY: Pin bar M5 + RSI ===
  if (m.is_pin_bull && (rsi_m5_30 || rsi_m1_25)) {
    const conf = [];
    conf.push(`✅ PIN BAR BULLISH M5 (mèche ${m.m5_lower_wick.toFixed(1)} pts)`);
    if (rsi_m5_30) conf.push(`✅ RSI M5 ${m.rsi_m5.toFixed(1)}`);
    if (rsi_m1_25) conf.push(`✅ RSI M1 ${m.rsi_m1.toFixed(1)}`);
    
    let score = 55;
    if (rsi_m15_35) { conf.push(`✅ RSI M15 ${m.rsi_m15.toFixed(1)}`); score += 5; }
    if (h1_trend_up) { conf.push(`✅ H1 haussier`); score += 8; }
    
    setups.push({
      type: 'BUY', grade: 'C', score,
      label: `🟢 C BUY · Pin bar + RSI`,
      entry: price,
      sl: price - 5,
      tp1: price + 3, tp2: price + 5, tp3: price + 7,
      sl_pts: '5.0', tp1_pts: '3.0', tp2_pts: '5.0', tp3_pts: '7.0',
      rr: '0.60',
      confluences: conf,
      alertKey: 'BUY_PIN'
    });
  }
  
  // === A++ BUY: PDL (Previous Day Low) sweep + RSI ===
  if (m.pdl && Math.abs(price - m.pdl) <= 2 && (rsi_m5_30 || rsi_m1_25)) {
    const conf = [];
    conf.push(`🔥 PDL (Previous Day Low) @ ${m.pdl.toFixed(2)}`);
    if (rsi_m5_30) conf.push(`✅ RSI M5 ${m.rsi_m5.toFixed(1)} oversold`);
    if (rsi_m1_25) conf.push(`✅ RSI M1 ${m.rsi_m1.toFixed(1)} oversold`);
    
    let score = 78;
    let grade = 'A+';
    if (m.sweep_low && Math.abs(m.sweep_low_level - m.pdl) < 3) {
      conf.push(`🎯 Sweep du PDL confirmé`); score += 12; grade = 'A++';
    }
    if (rsi_m15_35 || rsi_h1_40) { conf.push(`✅ Multi-TF confirme`); score += 8; }
    if (m.is_pin_bull) { conf.push(`✅ Pin bar bullish`); score += 5; }
    if (h1_trend_up) { conf.push(`✅ H1 haussier`); score += 5; }
    
    setups.push({
      type: 'BUY', grade, score,
      label: `🔥 PDL BUY · niveau institutionnel`,
      entry: price,
      sl: m.pdl - 4,
      tp1: price + 4, tp2: price + 7, tp3: price + 12,
      sl_pts: (price - (m.pdl - 4)).toFixed(1),
      tp1_pts: '4.0', tp2_pts: '7.0', tp3_pts: '12.0',
      rr: '1.0',
      confluences: conf,
      alertKey: 'BUY_PDL'
    });
  }
  
  // === A BUY: BOS bullish + RSI ===
  if (m.bos_bullish && (rsi_m5_30 || rsi_m1_30 || m.rsi_m5 < 50)) {
    const conf = [];
    conf.push(`🔺 BOS BULLISH M15 @ ${m.bos_level?.toFixed(2)} (structure cassée)`);
    if (rsi_m5_30) conf.push(`✅ RSI M5 ${m.rsi_m5.toFixed(1)}`);
    if (rsi_m1_30) conf.push(`✅ RSI M1 ${m.rsi_m1.toFixed(1)}`);
    
    let score = 65;
    let grade = 'A';
    if (rsi_m15_35) { conf.push(`✅ RSI M15 ${m.rsi_m15.toFixed(1)} confirme`); score += 8; grade = 'A+'; }
    if (h1_trend_up) { conf.push(`✅ H1 haussier`); score += 8; }
    if (m.huge_impulse_bull) { conf.push(`💥 Impulsion haussière forte`); score += 10; grade = 'A+'; }
    
    setups.push({
      type: 'BUY', grade, score,
      label: `🔺 BOS BULLISH · momentum confirmé`,
      entry: price,
      sl: m.bos_level - 5,
      tp1: price + 4, tp2: price + 7, tp3: price + 12,
      sl_pts: (price - (m.bos_level - 5)).toFixed(1),
      tp1_pts: '4.0', tp2_pts: '7.0', tp3_pts: '12.0',
      rr: '1.0',
      confluences: conf,
      alertKey: 'BUY_BOS'
    });
  }
  
  // === A BUY: John Wick Candle bullish ===
  if (m.john_wick_bull && (rsi_m5_30 || rsi_m1_25 || m.huge_impulse_bull)) {
    const conf = [];
    conf.push(`💀 JOHN WICK CANDLE BULLISH (body ${m.m5_body?.toFixed(1)} pts)`);
    if (m.huge_impulse_bull) conf.push(`💥 Impulsion >1.3x ATR`);
    if (rsi_m5_30) conf.push(`✅ RSI M5 ${m.rsi_m5.toFixed(1)}`);
    if (rsi_m1_25) conf.push(`✅ RSI M1 ${m.rsi_m1.toFixed(1)}`);
    
    let score = 65;
    let grade = 'A';
    if (h1_trend_up) { conf.push(`✅ H1 haussier`); score += 10; grade = 'A+'; }
    
    setups.push({
      type: 'BUY', grade, score,
      label: `💀 JOHN WICK BUY · momentum brutal`,
      entry: price,
      sl: price - 6,
      tp1: price + 4, tp2: price + 7, tp3: price + 10,
      sl_pts: '6.0', tp1_pts: '4.0', tp2_pts: '7.0', tp3_pts: '10.0',
      rr: '0.67',
      confluences: conf,
      alertKey: 'BUY_JOHN_WICK'
    });
  }
  
  // ============================================================
  // MARUBOZU SETUPS (corrected from Pitchfork)
  // ============================================================
  // Marubozu = strong directional candle, body fills 75%+ of range
  // PRIMARY USE: Reversal when preceded by opposite candle (engulfing-style)
  // SECONDARY USE: Continuation when 2 same-direction in a row
  
  // === MARUBOZU REVERSAL SHORT (engulfing-style bear after bull) ===
  if (m.marubozu_reversal_bear) {
    const conf = [];
    conf.push(`🔄 MARUBOZU REVERSAL · bougie d'achat avalée par bougie de vente`);
    conf.push(`✅ Engulfing pattern bearish M5`);
    if (rsi_m5_70 || rsi_m1_75) conf.push(`✅ RSI M5/M1 overbought (cohérent reversal)`);
    
    let score = 70;
    let grade = 'A';
    if (rsi_m5_70) score += 8;
    if (rsi_m1_75) score += 5;
    if (m.bos_bearish || m.choch_bearish) { conf.push(`✅ BOS/CHoCH bearish confirme`); score += 10; grade = 'A+'; }
    if (m.sweep_high) { conf.push(`✅ Sweep high récent (liquidity grab)`); score += 8; grade = 'A+'; }
    if (h1_trend_down) { conf.push(`✅ H1 baissier`); score += 5; }
    
    setups.push({
      type: 'SHORT', grade, score,
      label: `🔄 MARUBOZU REVERSAL SHORT`,
      entry: price,
      sl: price + 5,
      tp1: price - 4, tp2: price - 7, tp3: price - 10,
      sl_pts: '5.0', tp1_pts: '4.0', tp2_pts: '7.0', tp3_pts: '10.0',
      rr: '0.80',
      confluences: conf,
      alertKey: 'SHORT_MARUBOZU_REV'
    });
  }
  
  // === MARUBOZU CONTINUATION SHORT (2 bear in a row, only with H1 down) ===
  if (m.marubozu_continuation_bear && h1_trend_down && !m.marubozu_reversal_bear) {
    const conf = [];
    conf.push(`📉 MARUBOZU CONTINUATION · 2 bougies bear consécutives`);
    conf.push(`✅ H1 trend baissier · alignment parfait`);
    if (rsi_m5_70) conf.push(`✅ RSI M5 ${m.rsi_m5.toFixed(1)}`);
    
    let score = 60;
    let grade = 'B';
    if (m.bos_bearish) { conf.push(`✅ BOS bearish confirme`); score += 10; grade = 'A'; }
    if (m.huge_impulse_bear) { conf.push(`💥 Impulsion forte`); score += 8; }
    
    setups.push({
      type: 'SHORT', grade, score,
      label: `📉 MARUBOZU CONTINUATION SHORT`,
      entry: price,
      sl: price + 5,
      tp1: price - 4, tp2: price - 7, tp3: price - 10,
      sl_pts: '5.0', tp1_pts: '4.0', tp2_pts: '7.0', tp3_pts: '10.0',
      rr: '0.80',
      confluences: conf,
      alertKey: 'SHORT_MARUBOZU_CONT'
    });
  }
  
  // === MARUBOZU REVERSAL BUY (engulfing-style bull after bear) ===
  if (m.marubozu_reversal_bull) {
    const conf = [];
    conf.push(`🔄 MARUBOZU REVERSAL · bougie de vente avalée par bougie d'achat`);
    conf.push(`✅ Engulfing pattern bullish M5`);
    if (rsi_m5_30 || rsi_m1_25) conf.push(`✅ RSI M5/M1 oversold (cohérent reversal)`);
    
    let score = 70;
    let grade = 'A';
    if (rsi_m5_30) score += 8;
    if (rsi_m1_25) score += 5;
    if (m.bos_bullish || m.choch_bullish) { conf.push(`✅ BOS/CHoCH bullish confirme`); score += 10; grade = 'A+'; }
    if (m.sweep_low) { conf.push(`✅ Sweep low récent (liquidity grab)`); score += 8; grade = 'A+'; }
    if (h1_trend_up) { conf.push(`✅ H1 haussier`); score += 5; }
    
    setups.push({
      type: 'BUY', grade, score,
      label: `🔄 MARUBOZU REVERSAL BUY`,
      entry: price,
      sl: price - 5,
      tp1: price + 4, tp2: price + 7, tp3: price + 10,
      sl_pts: '5.0', tp1_pts: '4.0', tp2_pts: '7.0', tp3_pts: '10.0',
      rr: '0.80',
      confluences: conf,
      alertKey: 'BUY_MARUBOZU_REV'
    });
  }
  
  // === MARUBOZU CONTINUATION BUY ===
  if (m.marubozu_continuation_bull && h1_trend_up && !m.marubozu_reversal_bull) {
    const conf = [];
    conf.push(`📈 MARUBOZU CONTINUATION · 2 bougies bull consécutives`);
    conf.push(`✅ H1 trend haussier · alignment parfait`);
    if (rsi_m5_30) conf.push(`✅ RSI M5 ${m.rsi_m5.toFixed(1)}`);
    
    let score = 60;
    let grade = 'B';
    if (m.bos_bullish) { conf.push(`✅ BOS bullish confirme`); score += 10; grade = 'A'; }
    if (m.huge_impulse_bull) { conf.push(`💥 Impulsion forte`); score += 8; }
    
    setups.push({
      type: 'BUY', grade, score,
      label: `📈 MARUBOZU CONTINUATION BUY`,
      entry: price,
      sl: price - 5,
      tp1: price + 4, tp2: price + 7, tp3: price + 10,
      sl_pts: '5.0', tp1_pts: '4.0', tp2_pts: '7.0', tp3_pts: '10.0',
      rr: '0.80',
      confluences: conf,
      alertKey: 'BUY_MARUBOZU_CONT'
    });
  }
  
  // ============================================================
  // CHoCH SETUPS (Change of Character = TRUE REVERSAL signal)
  // ============================================================
  
  // === CHoCH BEARISH SHORT (was uptrend, now structure broken down) ===
  if (m.choch_bearish && (rsi_m5_70 || rsi_h1_60)) {
    const conf = [];
    conf.push(`🔁 CHoCH BEARISH M15 @ ${m.choch_level?.toFixed(2)} · CHANGEMENT DE TENDANCE`);
    conf.push(`📉 Tendance haussière cassée vers le bas`);
    if (rsi_m5_70) conf.push(`✅ RSI M5 ${m.rsi_m5.toFixed(1)} cohérent`);
    
    let score = 75;
    let grade = 'A+';
    if (m.sweep_high) { conf.push(`✅ Sweep high préalable (manipulation institutionnelle)`); score += 10; grade = 'A++'; }
    if (rsi_h1_60) { conf.push(`✅ RSI H1 confirme momentum`); score += 5; }
    
    setups.push({
      type: 'SHORT', grade, score,
      label: `🔁 CHoCH BEARISH · vrai retournement`,
      entry: price,
      sl: m.choch_level + 5,
      tp1: price - 5, tp2: price - 10, tp3: price - 15,
      sl_pts: (m.choch_level + 5 - price).toFixed(1),
      tp1_pts: '5.0', tp2_pts: '10.0', tp3_pts: '15.0',
      rr: '1.0',
      confluences: conf,
      alertKey: 'SHORT_CHOCH'
    });
  }
  
  // === CHoCH BULLISH BUY ===
  if (m.choch_bullish && (rsi_m5_30 || rsi_h1_40)) {
    const conf = [];
    conf.push(`🔁 CHoCH BULLISH M15 @ ${m.choch_level?.toFixed(2)} · CHANGEMENT DE TENDANCE`);
    conf.push(`📈 Tendance baissière cassée vers le haut`);
    if (rsi_m5_30) conf.push(`✅ RSI M5 ${m.rsi_m5.toFixed(1)} cohérent`);
    
    let score = 75;
    let grade = 'A+';
    if (m.sweep_low) { conf.push(`✅ Sweep low préalable (manipulation institutionnelle)`); score += 10; grade = 'A++'; }
    if (rsi_h1_40) { conf.push(`✅ RSI H1 confirme momentum`); score += 5; }
    
    setups.push({
      type: 'BUY', grade, score,
      label: `🔁 CHoCH BULLISH · vrai retournement`,
      entry: price,
      sl: m.choch_level - 5,
      tp1: price + 5, tp2: price + 10, tp3: price + 15,
      sl_pts: (price - (m.choch_level - 5)).toFixed(1),
      tp1_pts: '5.0', tp2_pts: '10.0', tp3_pts: '15.0',
      rr: '1.0',
      confluences: conf,
      alertKey: 'BUY_CHOCH'
    });
  }
  
  // Filter by score and cooldown
  const now_ms = Date.now();
  
  // v4.8: Volume confirmation boost
  if (m.volume_huge) {
    setups.forEach(s => {
      s.score += 12;
      s.confluences.push(`💥 VOLUME HUGE (${m.volume_ratio?.toFixed(1)}x avg) · institutionnel actif`);
    });
  } else if (m.volume_spike) {
    setups.forEach(s => {
      s.score += 8;
      s.confluences.push(`📊 VOLUME SPIKE (${m.volume_ratio?.toFixed(1)}x avg) · activité forte`);
    });
  } else if (m.volume_ratio && m.volume_ratio < 0.5) {
    // Volume très bas = signal faible (souvent fake breakout)
    setups.forEach(s => {
      s.score -= 8;
      s.confluences.push(`⚠️ Volume faible (${m.volume_ratio.toFixed(1)}x avg) · attention fake move`);
    });
  }
  
  cache.activeConfluences = setups.filter(s => {
    if (s.score < 50) return false;  // Lower threshold to alert small moves
    const lastAlert = lastConfluenceAlerts[s.alertKey] || 0;
    if (now_ms - lastAlert < COOLDOWN_MS) {
      s.onCooldown = true;
    }
    return true;
  });
  // Sort by score desc
  cache.activeConfluences.sort((a, b) => b.score - a.score);
  
  return cache.activeConfluences;
}

async function sendConfluenceAlert(setup) {
  if (!bot || !TELEGRAM_CHAT_ID) return;
  const emoji = setup.type === 'SHORT' ? '🔴' : '🟢';
  const gradeEmoji = {
    'A++': '⭐⭐⭐⭐',
    'A+': '⭐⭐⭐',
    'A': '⭐⭐⭐',
    'B': '⭐⭐',
    'C': '⭐'
  }[setup.grade] || '⭐';
  
  let msg = `${emoji} *KAO V2 · ${setup.grade} ${setup.type}*\n\n`;
  msg += `${setup.label}\n`;
  msg += `${gradeEmoji} Score *${setup.score}/100*\n\n`;
  msg += `📍 *Prix : ${setup.entry.toFixed(2)}*\n\n`;
  msg += `*Confluences :*\n`;
  setup.confluences.forEach(c => msg += `  ${c}\n`);
  msg += `\n🎯 *Plan :*\n`;
  msg += `  Entry : ${setup.entry.toFixed(2)}\n`;
  msg += `  SL : ${setup.sl.toFixed(2)} (${setup.sl_pts} pts)\n`;
  msg += `  TP1 : ${setup.tp1.toFixed(2)} (${setup.tp1_pts} pts) · scalp\n`;
  msg += `  TP2 : ${setup.tp2.toFixed(2)} (${setup.tp2_pts} pts)\n`;
  if (setup.tp3) msg += `  TP3 : ${setup.tp3.toFixed(2)} (${setup.tp3_pts} pts)\n`;
  msg += `\n_Observation only · décision = toi_`;
  
  try { await bot.sendMessage(TELEGRAM_CHAT_ID, msg, { parse_mode: 'Markdown' }); }
  catch (e) { console.log('TG confluence:', e.message); }
}

// ============ NEWS GUARD v4.6 ============
// Protect from trading during high-impact news + cautious post-news mode
//
// Behavior:
//  - 15 min BEFORE news high: BLOCK all alerts + Telegram warning
//  - DURING news (15 min after): BLOCK all alerts + warning if trade open
//  - 30 min POST news: CAUTIOUS mode (only A++ setups, others muted)
//  - Resume normal after 45 min total

let newsGuardState = {
  status: 'NORMAL',  // NORMAL | PRE_NEWS | DURING_NEWS | POST_NEWS_CAUTIOUS
  activeNews: null,  // The news event currently affecting state
  nextEvent: null,   // Next high-impact news upcoming
  lastStatusChange: null,
  lastNotifiedEventKey: null  // To avoid double-notifying same event
};

function getEventKey(event) {
  return `${event.event}_${event.time}_${event.country}`;
}

function evaluateNewsGuard() {
  const now = new Date();
  const calendar = cache.calendar || [];
  
  // Filter only HIGH impact news from USD/EUR (most impactful for Gold)
  const highImpactNews = calendar.filter(c => 
    c.warn && c.event && c.time
  );
  
  if (!highImpactNews.length) {
    newsGuardState.status = 'NORMAL';
    newsGuardState.activeNews = null;
    newsGuardState.nextEvent = null;
    return newsGuardState;
  }
  
  // Parse "HH:MM" times into Date objects for today
  const today = new Date();
  const eventsWithDates = highImpactNews.map(c => {
    const [hours, minutes] = (c.time || '00:00').split(':').map(Number);
    const eventDate = new Date(today);
    eventDate.setHours(hours, minutes, 0, 0);
    return { ...c, dateTime: eventDate, key: getEventKey(c) };
  }).sort((a, b) => a.dateTime - b.dateTime);
  
  let newStatus = 'NORMAL';
  let activeEvent = null;
  let nextEvent = null;
  
  for (const event of eventsWithDates) {
    const minutesToEvent = (event.dateTime - now) / 60000;
    
    // PRE_NEWS: 15 min avant
    if (minutesToEvent <= 15 && minutesToEvent > 0) {
      newStatus = 'PRE_NEWS';
      activeEvent = event;
      break;
    }
    // DURING_NEWS: 0-15 min après
    if (minutesToEvent <= 0 && minutesToEvent > -15) {
      newStatus = 'DURING_NEWS';
      activeEvent = event;
      break;
    }
    // POST_NEWS_CAUTIOUS: 15-45 min après
    if (minutesToEvent <= -15 && minutesToEvent > -45) {
      newStatus = 'POST_NEWS_CAUTIOUS';
      activeEvent = event;
      break;
    }
    // Pas encore arrivé → c'est le next event
    if (minutesToEvent > 15 && !nextEvent) {
      nextEvent = event;
    }
  }
  
  // Find next event if none was active
  if (newStatus === 'NORMAL' && !nextEvent) {
    nextEvent = eventsWithDates.find(e => e.dateTime > now);
  }
  
  // Detect status change
  if (newStatus !== newsGuardState.status) {
    newsGuardState.lastStatusChange = now.toISOString();
    // Notify Telegram of status change
    notifyNewsStatusChange(newsGuardState.status, newStatus, activeEvent);
  }
  
  newsGuardState.status = newStatus;
  newsGuardState.activeNews = activeEvent;
  newsGuardState.nextEvent = nextEvent;
  
  return newsGuardState;
}

async function notifyNewsStatusChange(oldStatus, newStatus, event) {
  if (!bot || !TELEGRAM_CHAT_ID) return;
  if (!event) return;
  
  // Avoid notifying same event twice for same status
  const eventKey = `${event.key}_${newStatus}`;
  if (newsGuardState.lastNotifiedEventKey === eventKey) return;
  newsGuardState.lastNotifiedEventKey = eventKey;
  
  let msg = '';
  
  if (newStatus === 'PRE_NEWS') {
    msg = `⚠️ *KAO V2 · NEWS GUARD ACTIVÉ*\n\n`;
    msg += `🚨 *Alertes setups SUSPENDUES*\n\n`;
    msg += `📰 News dans 15 min :\n`;
    msg += `   *${event.event}* (${event.country || 'USD'})\n`;
    msg += `   ⏰ ${event.time}\n\n`;
    msg += `*ACTION RECOMMANDÉE :*\n`;
    msg += `  ❌ NE PAS ouvrir de nouveau trade\n`;
    msg += `  ⚠️ Surveiller les positions ouvertes\n`;
    msg += `  ⚠️ Spread va s'élargir\n`;
    msg += `  💡 Considérer fermer 5 min avant\n\n`;
    msg += `_Reprise normale 45 min après l'event_`;
  }
  else if (newStatus === 'DURING_NEWS') {
    msg = `🚨 *KAO V2 · NEWS EN COURS*\n\n`;
    msg += `📰 *${event.event}*\n`;
    msg += `🔴 Volatilité MAXIMALE attendue\n\n`;
    msg += `*ACTION :*\n`;
    msg += `  ❌ AUCUN nouveau trade\n`;
    msg += `  🛡 Vérifier que tes SL sont serrés\n`;
    msg += `  ⚠️ Spread peut x10\n\n`;
    msg += `_Phase prudente dans 15 min_`;
  }
  else if (newStatus === 'POST_NEWS_CAUTIOUS') {
    msg = `🟡 *KAO V2 · MODE PRUDENT*\n\n`;
    msg += `📊 News passée : *${event.event}*\n\n`;
    msg += `*PHASE OPPORTUNITÉ POST-NEWS :*\n`;
    msg += `  ✅ Setups A++ uniquement validés\n`;
    msg += `  ⚠️ B et C ignorés (encore volatil)\n`;
    msg += `  💡 Souvent gros mouvements directionnels\n\n`;
    msg += `_Mode normal dans 30 min_`;
  }
  else if (newStatus === 'NORMAL' && oldStatus !== 'NORMAL') {
    msg = `🟢 *KAO V2 · MODE NORMAL*\n\n`;
    msg += `✅ News window terminée\n`;
    msg += `✅ Tous setups réactivés\n`;
    msg += `✅ Trading normal possible`;
  }
  
  if (msg) {
    try { await bot.sendMessage(TELEGRAM_CHAT_ID, msg, { parse_mode: 'Markdown' }); }
    catch (e) { console.log('TG news guard:', e.message); }
  }
}

function shouldAllowAlert(setup) {
  // Check news guard before alerting
  switch (newsGuardState.status) {
    case 'NORMAL':
      return true;  // All alerts allowed
    case 'PRE_NEWS':
    case 'DURING_NEWS':
      return false;  // Block all alerts
    case 'POST_NEWS_CAUTIOUS':
      // Only A++ setups pass during cautious mode
      return setup.grade === 'A++';
    default:
      return true;
  }
}

// ============ END NEWS GUARD ============

async function runSmartEngine() {
  // First, evaluate news guard state
  evaluateNewsGuard();
  
  const setups = analyzeSmartLevels();
  const now = Date.now();
  for (const s of setups) {
    if (s.onCooldown) continue;
    if (s.score < 50) continue;
    
    // News guard filter
    if (!shouldAllowAlert(s)) {
      s.blockedByNews = true;
      s.newsStatus = newsGuardState.status;
      continue;
    }
    
    await sendConfluenceAlert(s);
    lastConfluenceAlerts[s.alertKey] = now;
    console.log(`🎯 Alert: ${s.label} (score ${s.score})`);
  }
}

// ============ AUTO SETUP SCANNER (v3 static levels, kept) ============
let levelAlertHistory = {};
let activeSetups = [];

function scanForSetups(currentPrice) {
  if (!currentPrice) return [];
  const setups = [];
  const now = Date.now();
  const COOLDOWN_MS = 15 * 60 * 1000;
  const zones = [
    { name: 'MAJOR_RESISTANCE', price: LEVELS.major_resistance, type: 'CRITICAL', direction: 'STOP', label: `Mur institutionnel ${LEVELS.major_resistance}`, action: `⛔ STOP SHORT si cassé` },
    { name: 'RESISTANCE', price: LEVELS.resistance, type: 'SHORT', direction: 'SELL', label: `Résistance ${LEVELS.resistance}`, action: `🎯 SELL SCALP · SL ${LEVELS.resistance + 6} · TP ${LEVELS.resistance - 10}` },
    { name: 'KIJUN_H1', price: LEVELS.kijun_h1, type: 'SHORT', direction: 'SELL', label: `⭐ Kijun H1 ${LEVELS.kijun_h1} (favori)`, action: `🎯 SELL ⭐ · SL ${LEVELS.kijun_h1 + 6} · TP ${LEVELS.kijun_h1 - 10}` },
    { name: 'SUPPORT', price: LEVELS.support, type: 'BUY', direction: 'BUY', label: `⭐ Support ${LEVELS.support}`, action: `🎯 BUY · SL ${LEVELS.support - 6} · TP ${LEVELS.support + 10}` },
    { name: 'INTERMEDIATE_SUPPORT', price: LEVELS.intermediate_support, type: 'BUY', direction: 'BUY', label: `Support 2 ${LEVELS.intermediate_support}`, action: `🎯 BUY · SL ${LEVELS.intermediate_support - 8} · TP ${LEVELS.intermediate_support + 10}` },
    { name: 'CRITICAL_PIVOT', price: LEVELS.critical_pivot, type: 'CRITICAL', direction: 'STOP', label: `Pivot Fibo 0.5 ${LEVELS.critical_pivot}`, action: `⛔ STOP TRADE si cassé` }
  ];
  zones.forEach(zone => {
    const distance = Math.abs(currentPrice - zone.price);
    const lastAlert = levelAlertHistory[zone.name] || 0;
    if (distance <= 2 && (now - lastAlert) > COOLDOWN_MS) {
      const sentiment = cache.matrix?.sentiment || 'NEUTRAL';
      const fed = cache.matrix?.fedBias || 'NEUTRAL';
      let grade = 'NEUTRAL';
      let notes = [];
      if (zone.direction === 'STOP') { grade = 'CRITICAL'; notes.push('Zone critique · pas de trade'); }
      else if (zone.direction === 'SELL') {
        if (sentiment === 'BEARISH') { grade = 'EXCELLENT'; notes.push('Aligné BEARISH'); }
        else if (sentiment === 'BULLISH') { grade = 'RISKY'; notes.push('⚠️ Contre BULLISH'); }
        else grade = 'GOOD';
        if (fed === 'HAWKISH') notes.push('Fed HAWKISH');
      } else if (zone.direction === 'BUY') {
        if (sentiment === 'BULLISH') { grade = 'EXCELLENT'; notes.push('Aligné BULLISH'); }
        else if (sentiment === 'BEARISH') { grade = 'RISKY'; notes.push('⚠️ Contre BEARISH'); }
        else grade = 'GOOD';
        if (fed === 'DOVISH') notes.push('Fed DOVISH');
      }
      setups.push({ level: zone.name, type: zone.type, direction: zone.direction, price: zone.price, currentPrice, distance: distance.toFixed(2), label: zone.label, action: zone.action, sentiment, grade, note: notes.join(' · ') });
      levelAlertHistory[zone.name] = now;
    }
  });
  return setups;
}

async function sendSetupAlertTelegram(setup) {
  if (!bot || !TELEGRAM_CHAT_ID) return;
  const emoji = { CRITICAL: '⛔', SHORT: '🔴', BUY: '🟢' }[setup.type];
  const gradeEmoji = { EXCELLENT: '⭐⭐⭐', GOOD: '⭐⭐', NEUTRAL: '⭐', RISKY: '⚠️', CRITICAL: '⛔' }[setup.grade];
  let msg = `${emoji} *KAO V2 · SETUP DETECTED*\n\n`;
  msg += `📍 *Prix actuel : ${setup.currentPrice.toFixed(2)}*\n`;
  msg += `🎯 ${setup.label}\n`;
  msg += `📏 Distance : ${setup.distance} pts\n\n`;
  msg += `${gradeEmoji} *Grade : ${setup.grade}*\n`;
  if (setup.note) msg += `${setup.note}\n`;
  msg += `\n${setup.action}\n\n`;
  msg += `📊 Sentiment : ${setup.sentiment}\n`;
  msg += `_Décision = toi · Kao V2 ne trade pas_`;
  try { await bot.sendMessage(TELEGRAM_CHAT_ID, msg, { parse_mode: 'Markdown' }); } catch (e) {}
}

async function scanAndAlert() {
  // v3: Prefer broker price (from EA) over Yahoo if available and recent
  let goldPrice = cache.prices?.XAUUSD?.price;
  const brokerPriceAgeMs = cache.brokerPriceTime ? (Date.now() - cache.brokerPriceTime) : Infinity;
  if (cache.brokerPrice && brokerPriceAgeMs < 30000) {
    // Use broker price if less than 30 seconds old
    goldPrice = cache.brokerPrice;
  }
  if (!goldPrice) return;
  const newSetups = scanForSetups(goldPrice);
  for (const setup of newSetups) {
    await sendSetupAlertTelegram(setup);
    console.log(`🎯 Setup: ${setup.label} @ ${setup.currentPrice}`);
  }
  activeSetups = [
    { name: 'MAJOR_RESISTANCE', price: LEVELS.major_resistance, type: 'CRITICAL', label: `Mur ${LEVELS.major_resistance}` },
    { name: 'RESISTANCE', price: LEVELS.resistance, type: 'SHORT', label: `Rés. ${LEVELS.resistance}` },
    { name: 'KIJUN_H1', price: LEVELS.kijun_h1, type: 'SHORT', label: `⭐ Kijun ${LEVELS.kijun_h1}` },
    { name: 'SUPPORT', price: LEVELS.support, type: 'BUY', label: `⭐ Supp. ${LEVELS.support}` },
    { name: 'INTERMEDIATE_SUPPORT', price: LEVELS.intermediate_support, type: 'BUY', label: `Supp2 ${LEVELS.intermediate_support}` },
    { name: 'CRITICAL_PIVOT', price: LEVELS.critical_pivot, type: 'CRITICAL', label: `Pivot ${LEVELS.critical_pivot}` }
  ].map(zone => {
    const dist = goldPrice - zone.price;
    return { ...zone, currentPrice: goldPrice, distance: dist, distanceAbs: Math.abs(dist), status: Math.abs(dist) <= 2 ? 'HOT' : Math.abs(dist) <= 10 ? 'NEAR' : 'FAR' };
  }).sort((a, b) => a.distanceAbs - b.distanceAbs);
}

async function refreshAll() {
  console.log('🔄 Refresh', new Date().toISOString());
  await Promise.all([fetchPrices(), fetchNews(), fetchTrump(), fetchCalendar()]);
  computeMatrix();
  await scanAndAlert();
  cache.lastUpdate = new Date().toISOString();
}

function checkAuth(req, res, next) {
  if (req.headers['x-auth-token'] !== AUTH_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

initDatabase().then(() => loadFromDatabase()).then(() => refreshAll());
cron.schedule('*/2 * * * *', refreshAll);
// News Guard runs every minute to track time-sensitive news windows
cron.schedule('* * * * *', () => { try { evaluateNewsGuard(); } catch(e) {} });

app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/world', (req, res) => res.sendFile(path.join(__dirname, 'world.html')));
app.get('/', (req, res) => res.send('Kao V2 Live Server v3 · <a href="/dashboard">Dashboard</a> · <a href="/world">World Intelligence</a>'));

app.get('/api/all', async (req, res) => {
  const dailyStats = {};
  for (const acc of Object.keys(cache.accounts)) {
    const pnl = await getDailyPnL(acc);
    const profile = detectAccountProfile(cache.accounts[acc].balance);
    dailyStats[acc] = { dailyPnL: pnl, profile, progressPct: profile ? Math.round((pnl / profile.daily_target) * 100) : 0, consistencyPct: profile ? Math.round((pnl / profile.max_best_day) * 100) : 0 };
  }
  res.json({
    prices: cache.prices, news: cache.news, trump: cache.trump, calendar: cache.calendar, matrix: cache.matrix,
    trades: cache.trades, closedTrades: cache.closedTrades.slice(0, 30), advices: cache.advices.slice(0, 30),
    accounts: cache.accounts, dailyStats, activeSetups, 
    brokerPrice: cache.brokerPrice, brokerPriceTime: cache.brokerPriceTime, brokerSymbol: cache.brokerSymbol,
    marketData: cache.marketData, activeConfluences: cache.activeConfluences,
    newsGuard: newsGuardState,
    lastUpdate: cache.lastUpdate
  });
});

app.get('/api/history/:account', async (req, res) => {
  if (!pool) return res.json({ error: 'DB not available' });
  try {
    const r = await pool.query(`SELECT * FROM trades WHERE account = $1 AND status = 'closed' ORDER BY closed_at DESC LIMIT 500`, [req.params.account]);
    res.json(r.rows);
  } catch (e) { res.json({ error: e.message }); }
});

app.get('/api/stats/:account', async (req, res) => {
  if (!pool) return res.json({ error: 'DB not available' });
  try {
    const acc = req.params.account;
    const stats = await pool.query(`SELECT COUNT(*) as total_trades, SUM(CASE WHEN net_profit > 0 THEN 1 ELSE 0 END) as wins, SUM(CASE WHEN net_profit < 0 THEN 1 ELSE 0 END) as losses, SUM(net_profit) as total_pnl, AVG(net_profit) as avg_pnl, MAX(net_profit) as best_trade, MIN(net_profit) as worst_trade FROM trades WHERE account = $1 AND status = 'closed'`, [acc]);
    const byDay = await pool.query(`SELECT DATE(closed_at) as day, SUM(net_profit) as pnl, COUNT(*) as trades FROM trades WHERE account = $1 AND status = 'closed' GROUP BY DATE(closed_at) ORDER BY day DESC LIMIT 30`, [acc]);
    res.json({ global: stats.rows[0], byDay: byDay.rows });
  } catch (e) { res.json({ error: e.message }); }
});

app.get('/api/export/:account', async (req, res) => {
  if (!pool) return res.status(500).send('DB not available');
  try {
    const r = await pool.query(`SELECT * FROM trades WHERE account = $1 ORDER BY opened_at DESC`, [req.params.account]);
    const csv = ['ticket,symbol,direction,volume,entry,sl,tp,opened,closed,price_close,profit,commission,net_profit,verdict,score'];
    r.rows.forEach(t => { csv.push([t.ticket, t.symbol, t.direction, t.volume, t.entry, t.sl, t.tp, t.opened_at, t.closed_at, t.price_close, t.profit, t.commission, t.net_profit, t.verdict, t.score].join(',')); });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=kao_v2_${req.params.account}_${Date.now()}.csv`);
    res.send(csv.join('\n'));
  } catch (e) { res.status(500).send(e.message); }
});

app.get('/api/setups', (req, res) => res.json({ active: activeSetups, price: cache.prices?.XAUUSD?.price }));
app.get('/api/confluences', (req, res) => res.json({ 
  active: cache.activeConfluences || [], 
  marketData: cache.marketData,
  marketDataTime: cache.marketDataTime
}));
app.get('/api/refresh', async (req, res) => { await refreshAll(); res.json({ ok: true }); });

// v3: Receive live broker price from EA
app.post('/api/price', checkAuth, (req, res) => {
  const { symbol, bid, ask, mid } = req.body;
  cache.brokerPrice = mid || bid;
  cache.brokerPriceTime = Date.now();
  cache.brokerSymbol = symbol;
  // Re-scan setups with new price (async, don't wait)
  scanAndAlert().catch(() => {});
  res.json({ ok: true });
});

// v4: Receive full market data (RSI, EMA, pivots) from EA every 15 sec
app.post('/api/market', checkAuth, async (req, res) => {
  cache.marketData = req.body;
  cache.marketDataTime = Date.now();
  cache.brokerPrice = req.body.mid;
  cache.brokerPriceTime = Date.now();
  cache.brokerSymbol = req.body.symbol;
  // Run smart engine
  try {
    await runSmartEngine();
  } catch (e) { console.error('Smart engine:', e.message); }
  res.json({ ok: true });
});

app.post('/api/trade/ping', checkAuth, async (req, res) => {
  const { account, broker, balance, equity, leverage } = req.body;
  cache.accounts[account] = { broker, balance, equity, leverage, lastPing: new Date().toISOString() };
  if (pool) {
    try {
      const profile = detectAccountProfile(balance);
      await pool.query(`INSERT INTO accounts (account, broker, balance, equity, leverage, account_type, daily_target, max_best_day, payout, last_ping) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW()) ON CONFLICT (account) DO UPDATE SET broker=$2, balance=$3, equity=$4, leverage=$5, account_type=$6, daily_target=$7, max_best_day=$8, payout=$9, last_ping=NOW()`, [account, broker, balance, equity, leverage, profile?.type, profile?.daily_target, profile?.max_best_day, profile?.payout]);
    } catch (e) { console.error('ping DB:', e.message); }
  }
  console.log(`📡 Ping ${account} (${broker})`);
  res.json({ ok: true });
});

app.post('/api/trade/new', checkAuth, async (req, res) => {
  const trade = req.body;
  console.log(`📥 New: ${trade.direction} ${trade.volume} ${trade.symbol}`);
  const accountInfo = cache.accounts[trade.account] || {};
  const advice = analyzeTrade(trade, accountInfo);
  if (pool) {
    try {
      await pool.query(`INSERT INTO trades (ticket, account, symbol, direction, volume, entry, sl, tp, sl_pts, tp_pts, opened_at, verdict, score, advice_json, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'open') ON CONFLICT (ticket) DO NOTHING`, [trade.ticket, trade.account, trade.symbol, trade.direction, trade.volume, trade.entry, trade.sl, trade.tp, trade.sl_pts, trade.tp_pts, trade.time || new Date(), advice.verdict, advice.score, JSON.stringify(advice)]);
    } catch (e) { console.error('trade new DB:', e.message); }
  }
  cache.trades.unshift(trade); cache.trades = cache.trades.slice(0, 50);
  cache.advices.unshift({ ...advice, trade }); cache.advices = cache.advices.slice(0, 100);
  await sendTradeAdviceTelegram(trade, advice);
  res.json({ ok: true, advice });
});

app.post('/api/trade/close', checkAuth, async (req, res) => {
  const trade = req.body;
  console.log(`📤 Close: ${trade.symbol} P&L ${trade.net_profit}`);
  if (pool) {
    try {
      await pool.query(`UPDATE trades SET status='closed', closed_at=$1, price_close=$2, profit=$3, commission=$4, swap=$5, net_profit=$6 WHERE ticket=$7`, [trade.time || new Date(), trade.price_close, trade.profit, trade.commission, trade.swap, trade.net_profit, trade.ticket]);
    } catch (e) { console.error('trade close DB:', e.message); }
  }
  cache.trades = cache.trades.filter(t => t.ticket !== trade.ticket);
  cache.closedTrades.unshift(trade); cache.closedTrades = cache.closedTrades.slice(0, 100);
  await sendClosedTradeTelegram(trade);
  // CONSISTENCY CHECK
  const alert = await checkConsistencyAlert(trade.account);
  if (alert) await sendConsistencyAlert(trade.account, alert);
  res.json({ ok: true });
});

app.get('/api/telegram/test', async (req, res) => {
  if (!bot) return res.json({ ok: false, error: 'Bot not configured' });
  try {
    await bot.sendMessage(TELEGRAM_CHAT_ID, '✅ *Kao V2 v3* · Test OK · DB active', { parse_mode: 'Markdown' });
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.listen(PORT, () => {
  console.log(`🚀 Kao V2 v3 on ${PORT} · DB: ${pool ? 'ON' : 'OFF'}`);
});
