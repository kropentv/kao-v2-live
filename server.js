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
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');

const app = express();
app.use(cors());
app.use(express.json());
app.use(cookieParser());
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
      advice_json TEXT, status VARCHAR(20) DEFAULT 'open',
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    // Migration: enlarge status column if existing table has VARCHAR(10)
    try {
      await pool.query(`ALTER TABLE trades ALTER COLUMN status TYPE VARCHAR(20)`);
      console.log('✓ Status column enlarged to VARCHAR(20)');
    } catch (e) {
      // Already correct size or other minor error - safe to ignore
    }
    await pool.query(`CREATE TABLE IF NOT EXISTS accounts (
      account VARCHAR(50) PRIMARY KEY, broker VARCHAR(100),
      balance DECIMAL(15,2), equity DECIMAL(15,2), leverage INTEGER,
      account_type VARCHAR(20), daily_target DECIMAL(10,2),
      max_best_day DECIMAL(10,2), payout DECIMAL(10,2), last_ping TIMESTAMP
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_trades_account ON trades(account)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_trades_closed ON trades(closed_at)`);
    
    // V6.0: SaaS users tables
    await pool.query(`CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      username VARCHAR(50),
      auth_token VARCHAR(64) UNIQUE,
      telegram_token VARCHAR(255),
      telegram_chat_id VARCHAR(50),
      created_at TIMESTAMP DEFAULT NOW(),
      last_login TIMESTAMP
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS user_setups (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      level_name VARCHAR(50),
      level_value DECIMAL(15,5),
      level_type VARCHAR(20),
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, level_name)
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS user_trades (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      ticket BIGINT NOT NULL,
      account VARCHAR(50), symbol VARCHAR(20), direction VARCHAR(10),
      volume DECIMAL(10,2), entry DECIMAL(15,5), sl DECIMAL(15,5), tp DECIMAL(15,5),
      sl_pts DECIMAL(10,2), tp_pts DECIMAL(10,2),
      opened_at TIMESTAMP, closed_at TIMESTAMP, price_close DECIMAL(15,5),
      profit DECIMAL(10,2), commission DECIMAL(10,2), swap DECIMAL(10,2),
      net_profit DECIMAL(10,2), verdict VARCHAR(20), score INTEGER,
      status VARCHAR(20) DEFAULT 'open', created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, ticket)
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_trades_user ON user_trades(user_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_token ON users(auth_token)`);
    
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

// V6.0: Dynamic levels - calculated from EA market data instead of hardcoded
// Old hardcoded values kept as fallback if no EA data yet
const LEVELS_FALLBACK = { major_resistance: 4900, resistance: 4889, kijun_h1: 4850, friday_close: 4834, support: 4790, intermediate_support: 4760, critical_pivot: 4744 };

function getDynamicLevels() {
  const md = cache.marketData || {};
  const price = md.mid || cache.brokerPrice || 0;
  if (price === 0) return LEVELS_FALLBACK;
  
  // Build from real-time pivots
  const allHighs = [];
  const allLows = [];
  if (md.pivots_high_h1) md.pivots_high_h1.forEach(p => p > 0 && allHighs.push(p));
  if (md.pivots_high_m15) md.pivots_high_m15.forEach(p => p > 0 && allHighs.push(p));
  if (md.pivots_low_h1) md.pivots_low_h1.forEach(p => p > 0 && allLows.push(p));
  if (md.pivots_low_m15) md.pivots_low_m15.forEach(p => p > 0 && allLows.push(p));
  if (md.pdh > 0) allHighs.push(md.pdh);
  if (md.pdl > 0) allLows.push(md.pdl);
  
  // Sort and pick relevant levels
  const sortedHighs = allHighs.filter(p => p > price).sort((a, b) => a - b);
  const sortedLows = allLows.filter(p => p < price).sort((a, b) => b - a);
  
  return {
    major_resistance: sortedHighs[1] || sortedHighs[0] || (price + 50),
    resistance: sortedHighs[0] || (price + 15),
    kijun_h1: md.ema50_m15 || sortedHighs[0] || (price + 5),
    friday_close: md.pdc || price,
    support: sortedLows[0] || (price - 15),
    intermediate_support: sortedLows[1] || sortedLows[0] || (price - 30),
    critical_pivot: sortedLows[2] || sortedLows[1] || (price - 50)
  };
}

const LEVELS = LEVELS_FALLBACK;  // Kept for backward compat where used directly

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
    
    // V5.1: Expanded country impact mapping
    const goldImpactCountries = ['USD', 'EUR', 'CNY', 'GBP', 'JPY', 'CHF', 'AUD', 'CAD'];
    
    // V5.1: Critical event keywords that move Gold regardless of country
    const criticalKeywords = [
      'fomc', 'fed funds', 'rate decision', 'interest rate',
      'cpi', 'core cpi', 'ppi', 'pce',
      'nfp', 'non-farm', 'unemployment',
      'gdp', 'retail sales',
      'powell', 'lagarde', 'bailey', 'ueda',  // Central bank chiefs
      'politburo', 'pmi', 'manufacturing pmi', 'services pmi',
      'opec', 'crude oil',
      'consumer confidence'
    ];
    
    cache.calendar = data
      .filter(e => e.date && new Date(e.date).toDateString() === today)
      .map(e => {
        const eventLower = (e.title || '').toLowerCase();
        const isCritical = criticalKeywords.some(kw => eventLower.includes(kw));
        const isImpactCountry = goldImpactCountries.includes(e.country);
        const isHigh = e.impact?.toLowerCase() === 'high';
        
        // Warn if: high impact + (impact country OR critical keyword)
        // Also warn medium critical keywords from impact countries
        const warn = isHigh && (isImpactCountry || isCritical);
        const mediumWarn = e.impact?.toLowerCase() === 'medium' && isImpactCountry && isCritical;
        
        return {
          time: new Date(e.date).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
          event: e.title,
          country: e.country,
          sub: `${e.country} ${e.forecast ? '· F:' + e.forecast : ''} ${e.previous ? '· P:' + e.previous : ''}`,
          impact: e.impact?.toLowerCase() || 'low',
          warn: warn || mediumWarn,
          isCritical,
          isImpactCountry,
          rawDate: e.date
        };
      });
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
  
  // V6.0: DYNAMIC LEVELS · use real-time data from EA instead of hardcoded
  const md = cache.marketData || {};
  const currentPrice = md.mid || cache.brokerPrice || 0;
  
  // Find nearest support and resistance from EA pivots (M15 + H1 prioritaires)
  const allHighs = [];
  const allLows = [];
  if (md.pivots_high_h1) md.pivots_high_h1.forEach(p => p > 0 && allHighs.push(p));
  if (md.pivots_high_m15) md.pivots_high_m15.forEach(p => p > 0 && allHighs.push(p));
  if (md.pivots_low_h1) md.pivots_low_h1.forEach(p => p > 0 && allLows.push(p));
  if (md.pivots_low_m15) md.pivots_low_m15.forEach(p => p > 0 && allLows.push(p));
  if (md.pdh > 0) allHighs.push(md.pdh);
  if (md.pdl > 0) allLows.push(md.pdl);
  if (md.today_high > 0) allHighs.push(md.today_high);
  if (md.today_low > 0) allLows.push(md.today_low);
  
  // Find 2 nearest above and below
  const resistances = allHighs.filter(p => p > currentPrice).sort((a, b) => a - b).slice(0, 2);
  const supports = allLows.filter(p => p < currentPrice).sort((a, b) => b - a).slice(0, 2);
  
  // Build dynamic reco based on REAL price + sentiment
  let reco;
  if (currentPrice === 0) {
    reco = 'En attente données EA pour calcul niveaux dynamiques';
  } else if (sentiment === 'BULLISH' && supports.length > 0) {
    const supText = supports.map(s => s.toFixed(0)).join('/');
    reco = `Prioriser BUY sur supports ${supText}`;
  } else if (sentiment === 'BEARISH' && resistances.length > 0) {
    const resText = resistances.map(r => r.toFixed(0)).join('/');
    reco = `Setups SHORT sur résistances ${resText}`;
  } else if (sentiment === 'BULLISH') {
    reco = 'Bias bullish · attendre pullback sur support pour BUY';
  } else if (sentiment === 'BEARISH') {
    reco = 'Bias bearish · attendre rebond sur résistance pour SHORT';
  } else if (resistances.length > 0 && supports.length > 0) {
    reco = `Range entre ${supports[0].toFixed(0)} et ${resistances[0].toFixed(0)} · trader les rebonds`;
  } else {
    reco = 'Attendre setup sur zones clés';
  }
  
  cache.matrix = { 
    sentiment, sentimentClass: sentiment === 'BULLISH' ? 'bull' : sentiment === 'BEARISH' ? 'bear' : 'neutral', 
    fedBias, fedBiasClass: fedBias === 'DOVISH' ? 'bull' : fedBias === 'HAWKISH' ? 'bear' : 'neutral', 
    usdStrength, usdStrengthClass: usdStrength === 'WEAK' ? 'bear' : usdStrength === 'STRONG' ? 'bull' : 'neutral', 
    geoTension, geoTensionClass: geoTension === 'HIGH' ? 'bull' : 'neutral', 
    reco,
    // Bonus: expose dynamic levels for dashboard
    dynamicLevels: { resistances, supports, currentPrice }
  };
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
  
  // ============================================================
  // V5.0 · ORDER BLOCK SETUPS
  // ============================================================
  
  if (m.near_ob_bull && m.rsi_m5 < 50) {
    const conf = [];
    conf.push(`📦 ORDER BLOCK BULLISH @ ${m.ob_bull_low?.toFixed(2)}-${m.ob_bull_high?.toFixed(2)}`);
    conf.push(`✅ Zone d'achat institutionnelle`);
    if (rsi_m5_30) conf.push(`✅ RSI M5 ${m.rsi_m5.toFixed(1)} oversold`);
    if (m.is_pin_bull) conf.push(`✅ Pin bar bullish`);
    let score = 70;
    let grade = 'A';
    if (m.sweep_low) { conf.push(`✅ Sweep low confirme`); score += 12; grade = 'A+'; }
    if (h1_trend_up) { conf.push(`✅ H1 haussier`); score += 8; }
    if (m.rsi_bull_div) { conf.push(`📊 Divergence RSI bullish`); score += 10; grade = 'A+'; }
    setups.push({
      type: 'BUY', grade, score,
      label: `📦 ORDER BLOCK BUY · zone institutionnelle`,
      entry: price,
      sl: m.ob_bull_low - 3,
      tp1: price + 4, tp2: price + 7, tp3: price + 12,
      sl_pts: (price - (m.ob_bull_low - 3)).toFixed(1),
      tp1_pts: '4.0', tp2_pts: '7.0', tp3_pts: '12.0',
      rr: '1.0',
      confluences: conf,
      alertKey: 'BUY_OB'
    });
  }
  
  if (m.near_ob_bear && m.rsi_m5 > 50) {
    const conf = [];
    conf.push(`📦 ORDER BLOCK BEARISH @ ${m.ob_bear_low?.toFixed(2)}-${m.ob_bear_high?.toFixed(2)}`);
    conf.push(`✅ Zone de vente institutionnelle`);
    if (rsi_m5_70) conf.push(`✅ RSI M5 ${m.rsi_m5.toFixed(1)} overbought`);
    if (m.is_pin_bear) conf.push(`✅ Pin bar bearish`);
    let score = 70;
    let grade = 'A';
    if (m.sweep_high) { conf.push(`✅ Sweep high confirme`); score += 12; grade = 'A+'; }
    if (h1_trend_down) { conf.push(`✅ H1 baissier`); score += 8; }
    if (m.rsi_bear_div) { conf.push(`📊 Divergence RSI bearish`); score += 10; grade = 'A+'; }
    setups.push({
      type: 'SHORT', grade, score,
      label: `📦 ORDER BLOCK SHORT · zone institutionnelle`,
      entry: price,
      sl: m.ob_bear_high + 3,
      tp1: price - 4, tp2: price - 7, tp3: price - 12,
      sl_pts: (m.ob_bear_high + 3 - price).toFixed(1),
      tp1_pts: '4.0', tp2_pts: '7.0', tp3_pts: '12.0',
      rr: '1.0',
      confluences: conf,
      alertKey: 'SHORT_OB'
    });
  }
  
  // ============================================================
  // V5.0 · FVG (Fair Value Gap) SETUPS
  // ============================================================
  
  if (m.in_fvg_bull) {
    const conf = [];
    conf.push(`🪞 FVG BULLISH · prix dans gap @ ${m.fvg_bull_bot?.toFixed(2)}-${m.fvg_bull_top?.toFixed(2)}`);
    conf.push(`✅ Inefficiency · zone à respecter`);
    let score = 65;
    let grade = 'B';
    if (h1_trend_up) { conf.push(`✅ H1 haussier`); score += 10; grade = 'A'; }
    if (rsi_m5_30) { conf.push(`✅ RSI M5 ${m.rsi_m5.toFixed(1)} oversold`); score += 8; }
    if (m.is_pin_bull) { conf.push(`✅ Pin bar bullish`); score += 5; }
    setups.push({
      type: 'BUY', grade, score,
      label: `🪞 FVG BUY · gap inefficiency`,
      entry: price,
      sl: m.fvg_bull_bot - 3,
      tp1: price + 3, tp2: price + 5, tp3: price + 8,
      sl_pts: (price - (m.fvg_bull_bot - 3)).toFixed(1),
      tp1_pts: '3.0', tp2_pts: '5.0', tp3_pts: '8.0',
      rr: '0.8',
      confluences: conf,
      alertKey: 'BUY_FVG'
    });
  }
  
  if (m.in_fvg_bear) {
    const conf = [];
    conf.push(`🪞 FVG BEARISH · prix dans gap @ ${m.fvg_bear_bot?.toFixed(2)}-${m.fvg_bear_top?.toFixed(2)}`);
    let score = 65;
    let grade = 'B';
    if (h1_trend_down) { conf.push(`✅ H1 baissier`); score += 10; grade = 'A'; }
    if (rsi_m5_70) { conf.push(`✅ RSI M5 ${m.rsi_m5.toFixed(1)} overbought`); score += 8; }
    if (m.is_pin_bear) { conf.push(`✅ Pin bar bearish`); score += 5; }
    setups.push({
      type: 'SHORT', grade, score,
      label: `🪞 FVG SHORT · gap inefficiency`,
      entry: price,
      sl: m.fvg_bear_top + 3,
      tp1: price - 3, tp2: price - 5, tp3: price - 8,
      sl_pts: (m.fvg_bear_top + 3 - price).toFixed(1),
      tp1_pts: '3.0', tp2_pts: '5.0', tp3_pts: '8.0',
      rr: '0.8',
      confluences: conf,
      alertKey: 'SHORT_FVG'
    });
  }
  
  // ============================================================
  // V5.0 · DIVERGENCE SETUPS (very powerful when standalone)
  // ============================================================
  
  if (m.rsi_bull_div && rsi_m5_30) {
    const conf = [];
    conf.push(`📊 DIVERGENCE RSI BULLISH · prix LL + RSI HL`);
    conf.push(`✅ RSI M5 ${m.rsi_m5.toFixed(1)} oversold`);
    let score = 75;
    let grade = 'A+';
    if (m.sweep_low) { conf.push(`✅ Sweep low`); score += 8; grade = 'A++'; }
    if (m.is_pin_bull) { conf.push(`✅ Pin bar bullish`); score += 5; }
    if (h1_trend_up) { conf.push(`✅ H1 haussier`); score += 5; }
    setups.push({
      type: 'BUY', grade, score,
      label: `📊 RSI DIVERGENCE BUY · reversal signal`,
      entry: price,
      sl: price - 5,
      tp1: price + 5, tp2: price + 8, tp3: price + 12,
      sl_pts: '5.0', tp1_pts: '5.0', tp2_pts: '8.0', tp3_pts: '12.0',
      rr: '1.0',
      confluences: conf,
      alertKey: 'BUY_DIV'
    });
  }
  
  if (m.rsi_bear_div && rsi_m5_70) {
    const conf = [];
    conf.push(`📊 DIVERGENCE RSI BEARISH · prix HH + RSI LH`);
    conf.push(`✅ RSI M5 ${m.rsi_m5.toFixed(1)} overbought`);
    let score = 75;
    let grade = 'A+';
    if (m.sweep_high) { conf.push(`✅ Sweep high`); score += 8; grade = 'A++'; }
    if (m.is_pin_bear) { conf.push(`✅ Pin bar bearish`); score += 5; }
    if (h1_trend_down) { conf.push(`✅ H1 baissier`); score += 5; }
    setups.push({
      type: 'SHORT', grade, score,
      label: `📊 RSI DIVERGENCE SHORT · reversal signal`,
      entry: price,
      sl: price + 5,
      tp1: price - 5, tp2: price - 8, tp3: price - 12,
      sl_pts: '5.0', tp1_pts: '5.0', tp2_pts: '8.0', tp3_pts: '12.0',
      rr: '1.0',
      confluences: conf,
      alertKey: 'SHORT_DIV'
    });
  }
  
  // ============================================================
  // V5.0 · VWAP SETUPS (institutional trading)
  // ============================================================
  
  // VWAP rejection: prix bouncing off VWAP
  if (m.vwap > 0) {
    const distFromVwap = Math.abs(price - m.vwap);
    if (distFromVwap <= 1.5) {
      // Price near VWAP - look for direction
      if (m.above_vwap && rsi_m5_30) {
        // Pull-back to VWAP from above + oversold = BUY (continuation up)
        const conf = [];
        conf.push(`📍 VWAP pullback @ ${m.vwap.toFixed(2)}`);
        conf.push(`✅ Prix tient VWAP · continuation haussière`);
        conf.push(`✅ RSI M5 ${m.rsi_m5.toFixed(1)} oversold`);
        let score = 65;
        let grade = 'A';
        if (h1_trend_up) { conf.push(`✅ H1 haussier`); score += 10; grade = 'A+'; }
        setups.push({
          type: 'BUY', grade, score,
          label: `📍 VWAP PULLBACK BUY · institutional level`,
          entry: price,
          sl: m.vwap - 3,
          tp1: price + 4, tp2: price + 7, tp3: price + 10,
          sl_pts: (price - (m.vwap - 3)).toFixed(1),
          tp1_pts: '4.0', tp2_pts: '7.0', tp3_pts: '10.0',
          rr: '0.8',
          confluences: conf,
          alertKey: 'BUY_VWAP'
        });
      }
      if (!m.above_vwap && rsi_m5_70) {
        const conf = [];
        conf.push(`📍 VWAP rejection @ ${m.vwap.toFixed(2)}`);
        conf.push(`✅ Prix sous VWAP · continuation baissière`);
        conf.push(`✅ RSI M5 ${m.rsi_m5.toFixed(1)} overbought`);
        let score = 65;
        let grade = 'A';
        if (h1_trend_down) { conf.push(`✅ H1 baissier`); score += 10; grade = 'A+'; }
        setups.push({
          type: 'SHORT', grade, score,
          label: `📍 VWAP REJECTION SHORT · institutional level`,
          entry: price,
          sl: m.vwap + 3,
          tp1: price - 4, tp2: price - 7, tp3: price - 10,
          sl_pts: (m.vwap + 3 - price).toFixed(1),
          tp1_pts: '4.0', tp2_pts: '7.0', tp3_pts: '10.0',
          rr: '0.8',
          confluences: conf,
          alertKey: 'SHORT_VWAP'
        });
      }
    }
  }
  
  // ============================================================
  // V5.0 · BB SQUEEZE BREAKOUT
  // ============================================================
  
  if (m.bb_squeeze_m5 && m.volume_spike) {
    const conf = [];
    conf.push(`🎯 BB SQUEEZE M5 · volatilité minimale (${m.bb_m5_width?.toFixed(2)}%)`);
    conf.push(`📊 VOLUME SPIKE · breakout en cours`);
    conf.push(`✅ Setup avant explosion directionnelle`);
    let direction = 'BUY';
    if (price > m.bb_m5_mid) direction = 'BUY';
    else direction = 'SHORT';
    
    let score = 65;
    let grade = 'B';
    if (h1_trend_up && direction === 'BUY') { score += 10; grade = 'A'; conf.push(`✅ H1 trend confirme`); }
    if (h1_trend_down && direction === 'SHORT') { score += 10; grade = 'A'; conf.push(`✅ H1 trend confirme`); }
    
    setups.push({
      type: direction, grade, score,
      label: `🎯 BB SQUEEZE BREAKOUT · volatilité explosée`,
      entry: price,
      sl: direction === 'BUY' ? price - 5 : price + 5,
      tp1: direction === 'BUY' ? price + 5 : price - 5,
      tp2: direction === 'BUY' ? price + 8 : price - 8,
      tp3: direction === 'BUY' ? price + 12 : price - 12,
      sl_pts: '5.0', tp1_pts: '5.0', tp2_pts: '8.0', tp3_pts: '12.0',
      rr: '1.0',
      confluences: conf,
      alertKey: `${direction}_BB_SQUEEZE`
    });
  }
  
  // ============================================================
  // V5.0 · THREE SOLDIERS / THREE CROWS (continuation forte)
  // ============================================================
  
  if (m.three_soldiers && h1_trend_up && rsi_m5_30) {
    const conf = [];
    conf.push(`⚔️ THREE WHITE SOLDIERS · 3 bougies bull consécutives`);
    conf.push(`✅ Continuation haussière forte`);
    if (h1_trend_up) conf.push(`✅ H1 haussier · alignment parfait`);
    let score = 70;
    let grade = 'A';
    if (m.macd_bull_cross) { conf.push(`✅ MACD bull cross`); score += 8; }
    setups.push({
      type: 'BUY', grade, score,
      label: `⚔️ THREE SOLDIERS BUY · continuation`,
      entry: price,
      sl: price - 5,
      tp1: price + 5, tp2: price + 8, tp3: price + 12,
      sl_pts: '5.0', tp1_pts: '5.0', tp2_pts: '8.0', tp3_pts: '12.0',
      rr: '1.0',
      confluences: conf,
      alertKey: 'BUY_3SOLDIERS'
    });
  }
  
  if (m.three_crows && h1_trend_down && rsi_m5_70) {
    const conf = [];
    conf.push(`⚔️ THREE BLACK CROWS · 3 bougies bear consécutives`);
    conf.push(`✅ Continuation baissière forte`);
    if (h1_trend_down) conf.push(`✅ H1 baissier · alignment parfait`);
    let score = 70;
    let grade = 'A';
    if (m.macd_bear_cross) { conf.push(`✅ MACD bear cross`); score += 8; }
    setups.push({
      type: 'SHORT', grade, score,
      label: `⚔️ THREE CROWS SHORT · continuation`,
      entry: price,
      sl: price + 5,
      tp1: price - 5, tp2: price - 8, tp3: price - 12,
      sl_pts: '5.0', tp1_pts: '5.0', tp2_pts: '8.0', tp3_pts: '12.0',
      rr: '1.0',
      confluences: conf,
      alertKey: 'SHORT_3CROWS'
    });
  }
  
  // ============================================================
  // V5.0 · GENERAL CONFLUENCE BOOSTERS (apply to all setups)
  // ============================================================
  
  setups.forEach(s => {
    // VWAP alignment boost
    if (m.vwap > 0) {
      if (s.type === 'BUY' && m.above_vwap) {
        s.score += 5;
        s.confluences.push(`📍 Au-dessus VWAP (${m.vwap.toFixed(2)}) · biais haussier`);
      }
      if (s.type === 'SHORT' && !m.above_vwap) {
        s.score += 5;
        s.confluences.push(`📍 Sous VWAP (${m.vwap.toFixed(2)}) · biais baissier`);
      }
    }
    // Stochastic alignment
    if (s.type === 'BUY' && m.stoch_m5 <= 20) {
      s.score += 4;
      s.confluences.push(`📈 Stoch M5 ${m.stoch_m5?.toFixed(0)} oversold`);
    }
    if (s.type === 'SHORT' && m.stoch_m5 >= 80) {
      s.score += 4;
      s.confluences.push(`📉 Stoch M5 ${m.stoch_m5?.toFixed(0)} overbought`);
    }
    // MACD alignment
    if (s.type === 'BUY' && m.macd_bull_cross) {
      s.score += 6;
      s.confluences.push(`📈 MACD bull cross M5`);
    }
    if (s.type === 'SHORT' && m.macd_bear_cross) {
      s.score += 6;
      s.confluences.push(`📉 MACD bear cross M5`);
    }
    // FVG conflicts
    if (s.type === 'BUY' && m.in_fvg_bear) {
      s.score -= 8;
      s.confluences.push(`⚠️ Prix dans FVG bear (résistance technique)`);
    }
    if (s.type === 'SHORT' && m.in_fvg_bull) {
      s.score -= 8;
      s.confluences.push(`⚠️ Prix dans FVG bull (support technique)`);
    }
    // Inside bar / Outside bar
    if (m.outside_bar) {
      s.score += 5;
      s.confluences.push(`📦 Outside Bar · engulfing`);
    }
  });
  
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

// ============ V5.1 · PRE-EVENT BRIEFING ============
// Notifies 1h before high impact events with full context

let preEventBriefingsSent = new Set();

async function checkPreEventBriefings() {
  if (!bot || !TELEGRAM_CHAT_ID) return;
  const now = new Date();
  const calendar = cache.calendar || [];
  
  for (const event of calendar) {
    if (!event.warn || !event.rawDate) continue;
    
    const eventDate = new Date(event.rawDate);
    const minutesUntil = (eventDate - now) / 60000;
    
    // 1h briefing
    if (minutesUntil > 55 && minutesUntil <= 65) {
      const key = `${event.event}_1h`;
      if (!preEventBriefingsSent.has(key)) {
        preEventBriefingsSent.add(key);
        await send1HourBriefing(event);
      }
    }
    // 30 min final warning
    if (minutesUntil > 25 && minutesUntil <= 35) {
      const key = `${event.event}_30m`;
      if (!preEventBriefingsSent.has(key)) {
        preEventBriefingsSent.add(key);
        await send30MinWarning(event);
      }
    }
  }
  
  // Cleanup old keys
  if (preEventBriefingsSent.size > 200) {
    const arr = Array.from(preEventBriefingsSent);
    preEventBriefingsSent.clear();
    arr.slice(-100).forEach(k => preEventBriefingsSent.add(k));
  }
}

async function send1HourBriefing(event) {
  if (!bot) return;
  let msg = `📰 *KAO V2 · BRIEFING 1H AVANT*\n\n`;
  msg += `⏰ Dans 1h : *${event.event}*\n`;
  msg += `🌍 ${event.country}\n`;
  msg += `📅 ${event.time} · Impact ${event.impact?.toUpperCase()}\n\n`;
  
  const goldExpectation = predictGoldImpact(event);
  msg += `*Impact attendu sur Gold :*\n${goldExpectation}\n\n`;
  
  msg += `*Plan d'action :*\n`;
  msg += `  ⏱️ T-30min : warning final + protection enclenchée\n`;
  msg += `  ⏱️ T-15min : *News Guard ACTIF* · alertes setups SUSPENDUES\n`;
  msg += `  ⏱️ T+15min : Mode prudent · seuls A++ alertés\n`;
  msg += `  ⏱️ T+45min : Reprise normale\n\n`;
  msg += `💡 Si tu as une position ouverte, considère sécuriser ou fermer.`;
  
  try { await bot.sendMessage(TELEGRAM_CHAT_ID, msg, { parse_mode: 'Markdown' }); } catch (e) {}
}

async function send30MinWarning(event) {
  if (!bot) return;
  let msg = `⚠️🚨 *KAO V2 · WARNING T-30MIN*\n\n`;
  msg += `🔴 *${event.event}* dans 30 min\n`;
  msg += `🌍 ${event.country} · ${event.time}\n\n`;
  msg += `*ACTIONS IMMÉDIATES :*\n`;
  msg += `  ❌ N'ouvre PAS de nouveau trade\n`;
  msg += `  🛡️ Vérifie tes SL sur positions ouvertes\n`;
  msg += `  ⚠️ Spread va s'élargir dans 15 min\n`;
  msg += `  💡 Considère fermer 5 min avant\n\n`;
  msg += `_News Guard activé dans 15 min_`;
  
  try { await bot.sendMessage(TELEGRAM_CHAT_ID, msg, { parse_mode: 'Markdown' }); } catch (e) {}
}

function predictGoldImpact(event) {
  const e = (event.event || '').toLowerCase();
  const country = event.country;
  
  // Specific event predictions
  if (e.includes('rate decision') || e.includes('fomc') || e.includes('fed funds')) {
    return `📊 Décision taux directeur · IMPACT MAJEUR\n  Hawkish (rate hike) → 📉 Gold bearish\n  Dovish (rate cut/pause) → 📈 Gold bullish`;
  }
  if (e.includes('cpi') || e.includes('core cpi')) {
    return `📊 Inflation key data\n  Higher than forecast → 📈 Gold bullish (inflation hedge)\n  Lower than forecast → 📉 Gold bearish`;
  }
  if (e.includes('nfp') || e.includes('non-farm') || e.includes('unemployment')) {
    return `📊 Emploi US\n  Strong jobs → 📉 Gold bearish (Fed plus hawkish)\n  Weak jobs → 📈 Gold bullish (Fed plus dovish)`;
  }
  if (e.includes('powell') || e.includes('lagarde') || e.includes('ueda')) {
    return `🎤 Discours banquier central · volatilité extrême\n  Surveille chaque mot · réaction immédiate`;
  }
  if (e.includes('gdp')) {
    return `📊 PIB\n  Strong → 📉 Gold (économie saine, moins de safe haven)\n  Weak → 📈 Gold (récession = refuge)`;
  }
  if (e.includes('pmi')) {
    return `📊 PMI ${country}\n  >50 expansion → généralement bearish Gold\n  <50 contraction → bullish Gold`;
  }
  if (e.includes('opec')) {
    return `🛢️ Production pétrole\n  Cut → oil up → inflation up → mixed Gold\n  Hike → oil down → bearish Gold`;
  }
  if (e.includes('politburo') || e.includes('china') || country === 'CNY') {
    return `🌏 Chine (1er importateur Gold)\n  Stimulus → 📈 Gold bullish (demande boost)\n  Tightening → 📉 Gold bearish`;
  }
  return `📊 Event ${event.impact} impact ${country}\n  Surveille la réaction USD/Gold immédiatement`;
}

// ============ V5.1 · BREAKING NEWS DETECTOR ============
// Detects high-impact news in real-time and alerts

let alertedNewsIds = new Set();

const breakingKeywords = {
  // Geopolitical extreme
  critical: [
    'breaking', 'urgent', 'just in', 'alert',
    'invasion', 'attack', 'strike', 'missile', 'bomb',
    'ceasefire', 'peace deal', 'agreement reached',
    'sanction', 'embargo', 'tariff', 'trade war',
    'crisis', 'collapse', 'crash', 'plunge',
    'shock', 'unexpected'
  ],
  // Central banks
  cb: [
    'fed', 'powell', 'fomc', 'rate cut', 'rate hike',
    'dovish', 'hawkish', 'pivot', 'pause',
    'ecb', 'lagarde', 'boe', 'bailey',
    'boj', 'ueda', 'yen intervention',
    'pboc', 'china central bank', 'rrr cut'
  ],
  // Politics
  political: [
    'trump', 'biden', 'xi jinping', 'putin',
    'politburo', 'congress', 'senate',
    'election', 'impeachment',
    'shutdown', 'default'
  ],
  // Markets shock
  marketShock: [
    'all-time high', 'record', 'all-time low',
    'circuit breaker', 'halt trading',
    'flash crash', 'liquidity crisis'
  ]
};

function classifyBreakingNews(text) {
  const t = text.toLowerCase();
  let score = 0;
  let categories = [];
  
  for (const [cat, keywords] of Object.entries(breakingKeywords)) {
    for (const kw of keywords) {
      if (t.includes(kw)) {
        score += cat === 'critical' ? 25 : cat === 'cb' ? 20 : cat === 'political' ? 15 : 30;
        categories.push(cat);
      }
    }
  }
  
  return { score: Math.min(100, score), categories: [...new Set(categories)] };
}

async function checkBreakingNews() {
  if (!bot || !TELEGRAM_CHAT_ID) return;
  const news = cache.news || [];
  
  for (const item of news.slice(0, 10)) {  // Top 10 freshest
    const itemKey = (item.link || item.title || '').substring(0, 100);
    if (alertedNewsIds.has(itemKey)) continue;
    
    // Only news < 30 min old
    const ageMin = (Date.now() - new Date(item.time)) / 60000;
    if (ageMin > 30 || ageMin < 0) continue;
    
    const text = (item.title + ' ' + (item.desc || '')).substring(0, 500);
    const breaking = classifyBreakingNews(text);
    
    if (breaking.score >= 50 && item.impact === 'high') {
      alertedNewsIds.add(itemKey);
      await sendBreakingNewsAlert(item, breaking);
    }
  }
  
  if (alertedNewsIds.size > 200) {
    const arr = Array.from(alertedNewsIds);
    alertedNewsIds.clear();
    arr.slice(-100).forEach(k => alertedNewsIds.add(k));
  }
}

async function sendBreakingNewsAlert(news, breaking) {
  if (!bot) return;
  const goldImpact = news.signal === 'bull' ? '📈🟢 Bullish Gold' : 
                     news.signal === 'bear' ? '📉🔴 Bearish Gold' : 
                     '🟡 Direction mixte';
  
  let msg = `🚨📰 *KAO V2 · BREAKING NEWS*\n\n`;
  msg += `*${news.title}*\n\n`;
  msg += `📰 Source : ${news.source}\n`;
  msg += `⏰ ${Math.round((Date.now() - new Date(news.time)) / 60000)}min\n`;
  msg += `🔥 Score impact : ${breaking.score}/100\n`;
  if (breaking.categories.length) msg += `🏷️ ${breaking.categories.join(', ')}\n`;
  msg += `💰 ${goldImpact}\n\n`;
  
  if (news.desc) msg += `_"${news.desc.substring(0, 250)}${news.desc.length > 250 ? '...' : ''}"_\n\n`;
  
  msg += `*Recommendation :*\n`;
  if (news.signal === 'bull') msg += `  ⚠️ Possible spike Gold haussier · prudence shorts\n`;
  else if (news.signal === 'bear') msg += `  ⚠️ Possible chute Gold · prudence longs\n`;
  msg += `  🛡️ Vérifie tes SL\n`;
  msg += `  ⏱️ Volatilité 15-30 min`;
  
  try { await bot.sendMessage(TELEGRAM_CHAT_ID, msg, { parse_mode: 'Markdown' }); } catch (e) {}
}

// ============ V5.1 · ABNORMAL MOVEMENT DETECTOR ============
// Detects rapid price moves (pump/dump) and alerts with possible cause

let priceHistory = [];  // {time, price}
let lastAbnormalAlert = 0;

function recordPriceForAnomaly(price) {
  const now = Date.now();
  priceHistory.push({ time: now, price });
  // Keep only last 10 minutes
  priceHistory = priceHistory.filter(p => now - p.time < 600000);
}

async function detectAbnormalMovement() {
  if (priceHistory.length < 10) return;
  if (!bot || !TELEGRAM_CHAT_ID) return;
  
  const now = Date.now();
  if (now - lastAbnormalAlert < 5 * 60 * 1000) return;  // Cooldown 5 min
  
  // Find price 5 minutes ago
  const fiveMinAgo = now - 5 * 60 * 1000;
  const oldPrice = priceHistory.find(p => p.time >= fiveMinAgo);
  if (!oldPrice) return;
  
  const currentPrice = priceHistory[priceHistory.length - 1].price;
  const movement = currentPrice - oldPrice.price;
  const movementAbs = Math.abs(movement);
  
  // Threshold: $10+ in 5 min on Gold = abnormal
  if (movementAbs >= 10) {
    lastAbnormalAlert = now;
    await sendAbnormalMovementAlert(oldPrice.price, currentPrice, movement);
  }
}

async function sendAbnormalMovementAlert(oldPrice, newPrice, movement) {
  if (!bot) return;
  const direction = movement > 0 ? '📈⬆️ PUMP' : '📉⬇️ DUMP';
  const emoji = movement > 0 ? '🚀' : '💥';
  
  let msg = `${emoji} *KAO V2 · MOUVEMENT ANORMAL*\n\n`;
  msg += `${direction} Gold a bougé *${movement > 0 ? '+' : ''}$${movement.toFixed(2)}* en 5 min\n`;
  msg += `📊 ${oldPrice.toFixed(2)} → *${newPrice.toFixed(2)}*\n\n`;
  
  // Try to find the cause in recent news
  const recentNews = (cache.news || []).filter(n => {
    const ageMin = (Date.now() - new Date(n.time)) / 60000;
    return ageMin >= 0 && ageMin <= 15;  // Last 15 min
  });
  
  if (recentNews.length > 0) {
    msg += `*Cause possible (news récentes) :*\n`;
    recentNews.slice(0, 3).forEach(n => {
      msg += `  📰 ${n.source} : ${n.title.substring(0, 100)}\n`;
    });
    msg += `\n`;
  }
  
  // Check Trump posts
  const recentTrump = (cache.trump || []).filter(t => {
    const ageMin = (Date.now() - new Date(t.time)) / 60000;
    return ageMin >= 0 && ageMin <= 15;
  });
  if (recentTrump.length > 0) {
    msg += `🇺🇸 *Posts Trump récents :*\n`;
    recentTrump.slice(0, 2).forEach(t => {
      msg += `  ${t.text.substring(0, 100)}\n`;
    });
    msg += `\n`;
  }
  
  msg += `💡 *Action :*\n`;
  msg += `  ⚠️ Pas de trade pendant 10 min\n`;
  msg += `  🛡️ Vérifie tes positions ouvertes\n`;
  msg += `  📊 Attends que la volatilité retombe`;
  
  try { await bot.sendMessage(TELEGRAM_CHAT_ID, msg, { parse_mode: 'Markdown' }); } catch (e) {}
}

// ============ END V5.1 ============

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

// ============ V5.0 · DISCIPLINE TRACKER ============
// Detects bad trading habits and warns BEFORE damage is done

const disciplineState = {
  recentTrades: {},  // account → array of recent trades
  violations: {},    // account → daily violations count
  lastResetDate: null
};

function resetDailyDisciplineIfNeeded() {
  const today = new Date().toDateString();
  if (disciplineState.lastResetDate !== today) {
    disciplineState.violations = {};
    disciplineState.lastResetDate = today;
  }
}

async function checkDisciplineOnNewTrade(trade) {
  resetDailyDisciplineIfNeeded();
  if (!disciplineState.recentTrades[trade.account]) {
    disciplineState.recentTrades[trade.account] = [];
  }
  if (!disciplineState.violations[trade.account]) {
    disciplineState.violations[trade.account] = 0;
  }
  
  const violations = [];
  const accountInfo = cache.accounts[trade.account] || {};
  const profile = detectAccountProfile(accountInfo.balance);
  
  // 1. NO STOP LOSS
  if (!trade.sl || trade.sl === 0 || trade.sl_pts === 0) {
    violations.push({
      type: 'NO_SL',
      severity: 'CRITICAL',
      msg: '🚨 TRADE SANS STOP LOSS · risque illimité'
    });
  }
  
  // 2. LOT INHABITUEL (>2x le lot moyen récent ou >max profil)
  let avgLot = 0.5;
  if (pool) {
    try {
      const r = await pool.query(
        `SELECT AVG(volume) as avg_vol FROM trades 
         WHERE account = $1 AND status = 'closed' 
         AND closed_at > NOW() - INTERVAL '7 days'`,
        [String(trade.account)]
      );
      if (r.rows[0]?.avg_vol) avgLot = parseFloat(r.rows[0].avg_vol);
    } catch (e) {}
  }
  if (trade.volume > avgLot * 2 && trade.volume > 0.10) {
    violations.push({
      type: 'BIG_LOT',
      severity: 'HIGH',
      msg: `⚠️ Lot ${trade.volume} (${(trade.volume/avgLot).toFixed(1)}x ton lot moyen ${avgLot.toFixed(2)})`
    });
  }
  
  // Lot vs profile max
  if (profile) {
    const maxRecommended = profile.type.includes('100K') ? 0.60
                         : profile.type.includes('50K') ? 0.40
                         : profile.type.includes('20K') ? 0.16
                         : profile.type.includes('10K') ? 0.08 : 999;
    if (trade.volume > maxRecommended) {
      violations.push({
        type: 'OVER_LOT_PROFILE',
        severity: 'HIGH',
        msg: `⚠️ Lot ${trade.volume} dépasse max conseillé ${maxRecommended} pour ${profile.type}`
      });
    }
  }
  
  // 3. REVENGE TRADE (entry < 5 min après une perte)
  const recent = disciplineState.recentTrades[trade.account];
  const lastClosed = recent.filter(t => t.status === 'closed').slice(-1)[0];
  if (lastClosed && lastClosed.net_profit < 0) {
    const minsSince = (Date.now() - new Date(lastClosed.closed_at).getTime()) / 60000;
    if (minsSince < 5) {
      violations.push({
        type: 'REVENGE',
        severity: 'CRITICAL',
        msg: `🚨 REVENGE TRADE · entry ${minsSince.toFixed(0)}min après une perte de $${lastClosed.net_profit.toFixed(0)}`
      });
    }
  }
  
  // 4. OVER-TRADING (>5 trades sur la journée)
  let todayCount = 1;
  if (pool) {
    try {
      const r = await pool.query(
        `SELECT COUNT(*) as cnt FROM trades 
         WHERE account = $1 
         AND DATE(opened_at) = CURRENT_DATE`,
        [String(trade.account)]
      );
      todayCount = parseInt(r.rows[0].cnt) || 1;
    } catch (e) {}
  }
  if (todayCount > 5) {
    violations.push({
      type: 'OVERTRADING',
      severity: 'HIGH',
      msg: `⚠️ ${todayCount}ème trade aujourd'hui · over-trading possible`
    });
  }
  
  // 5. 3 LOSING TRADES IN A ROW
  if (pool) {
    try {
      const r = await pool.query(
        `SELECT net_profit FROM trades 
         WHERE account = $1 AND status = 'closed' 
         ORDER BY closed_at DESC LIMIT 3`,
        [String(trade.account)]
      );
      const last3 = r.rows.map(x => parseFloat(x.net_profit) || 0);
      if (last3.length === 3 && last3.every(p => p < 0)) {
        violations.push({
          type: 'LOSING_STREAK',
          severity: 'CRITICAL',
          msg: `🚨 3 pertes consécutives ($${last3.map(p => p.toFixed(0)).join(', $')}) · ARRÊTE-TOI`
        });
      }
    } catch (e) {}
  }
  
  // 6. Trade pendant news guard (just info)
  if (newsGuardState.status === 'PRE_NEWS' || newsGuardState.status === 'DURING_NEWS') {
    violations.push({
      type: 'NEWS_TRADE',
      severity: 'HIGH',
      msg: `⚠️ Trade pendant ${newsGuardState.status} · spread élargi`
    });
  }
  
  if (violations.length > 0) {
    disciplineState.violations[trade.account] += violations.length;
    await sendDisciplineAlert(trade, violations);
  }
  
  // Add to recent
  disciplineState.recentTrades[trade.account].push({
    ...trade, status: 'open', opened_at: new Date()
  });
  if (disciplineState.recentTrades[trade.account].length > 20) {
    disciplineState.recentTrades[trade.account].shift();
  }
  
  return violations;
}

function recordClosedTradeForDiscipline(trade) {
  if (!disciplineState.recentTrades[trade.account]) return;
  const recent = disciplineState.recentTrades[trade.account];
  const idx = recent.findIndex(t => t.ticket === trade.ticket);
  if (idx >= 0) {
    recent[idx].status = 'closed';
    recent[idx].closed_at = new Date();
    recent[idx].net_profit = trade.net_profit;
  }
}

async function sendDisciplineAlert(trade, violations) {
  if (!bot || !TELEGRAM_CHAT_ID) return;
  const hasCritical = violations.some(v => v.severity === 'CRITICAL');
  const emoji = hasCritical ? '🚨🛑' : '⚠️';
  
  let msg = `${emoji} *KAO V2 · DISCIPLINE ALERT*\n\n`;
  msg += `Trade détecté : *${trade.direction} ${trade.volume} ${trade.symbol}* @ ${trade.entry}\n\n`;
  msg += `*Violations détectées :*\n`;
  violations.forEach(v => msg += `  ${v.msg}\n`);
  msg += `\n`;
  
  if (hasCritical) {
    msg += `🛑 *ACTION RECOMMANDÉE :*\n`;
    msg += `  ❌ Considère fermer ce trade\n`;
    msg += `  ❌ Prends une pause de 30 min minimum\n`;
    msg += `  ✅ Reviens avec calme et plan clair\n`;
  } else {
    msg += `💡 *Conseil :*\n`;
    msg += `  ⚠️ Surveille bien ce trade\n`;
    msg += `  ⚠️ Respecte ton plan original\n`;
  }
  
  try { await bot.sendMessage(TELEGRAM_CHAT_ID, msg, { parse_mode: 'Markdown' }); } catch (e) {}
}

// ============ V5.0 · STATS BY SETUP ============
// Track which setups actually win

async function getStatsBySetup(account = null) {
  if (!pool) return null;
  try {
    let q = `
      SELECT 
        verdict,
        COUNT(*) as total,
        SUM(CASE WHEN net_profit > 0 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN net_profit < 0 THEN 1 ELSE 0 END) as losses,
        AVG(net_profit) as avg_pnl,
        SUM(net_profit) as total_pnl,
        MAX(net_profit) as best,
        MIN(net_profit) as worst
      FROM trades 
      WHERE status = 'closed' AND verdict IS NOT NULL
    `;
    const params = [];
    if (account) {
      q += ` AND account = $1`;
      params.push(String(account));
    }
    q += ` GROUP BY verdict ORDER BY total_pnl DESC`;
    const r = await pool.query(q, params);
    
    const byVerdict = r.rows.map(row => ({
      verdict: row.verdict,
      total: parseInt(row.total),
      wins: parseInt(row.wins),
      losses: parseInt(row.losses),
      win_rate: row.total > 0 ? Math.round((row.wins / row.total) * 100) : 0,
      avg_pnl: parseFloat(row.avg_pnl) || 0,
      total_pnl: parseFloat(row.total_pnl) || 0,
      best: parseFloat(row.best) || 0,
      worst: parseFloat(row.worst) || 0
    }));
    
    return { byVerdict };
  } catch (e) {
    console.error('getStatsBySetup error:', e.message);
    return null;
  }
}

// ============ V5.0 · HEATMAP HEURES/JOURS ============

async function getHeatmap(account = null) {
  if (!pool) return null;
  try {
    let q = `
      SELECT 
        EXTRACT(DOW FROM closed_at) as day_of_week,
        EXTRACT(HOUR FROM closed_at) as hour,
        COUNT(*) as trades,
        SUM(CASE WHEN net_profit > 0 THEN 1 ELSE 0 END) as wins,
        SUM(net_profit) as total_pnl
      FROM trades
      WHERE status = 'closed'
    `;
    const params = [];
    if (account) {
      q += ` AND account = $1`;
      params.push(String(account));
    }
    q += ` GROUP BY day_of_week, hour ORDER BY day_of_week, hour`;
    const r = await pool.query(q, params);
    
    return r.rows.map(row => ({
      day: parseInt(row.day_of_week),  // 0=Sunday, 1=Monday...
      hour: parseInt(row.hour),
      trades: parseInt(row.trades),
      wins: parseInt(row.wins),
      win_rate: row.trades > 0 ? Math.round((row.wins / row.trades) * 100) : 0,
      pnl: parseFloat(row.total_pnl) || 0
    }));
  } catch (e) {
    console.error('getHeatmap error:', e.message);
    return null;
  }
}

// ============ V5.0 · P&L EQUITY CURVE ============

async function getEquityCurve(account = null, days = 30) {
  if (!pool) return null;
  try {
    let q = `
      SELECT 
        DATE(closed_at) as day,
        SUM(net_profit) as pnl,
        COUNT(*) as trades
      FROM trades
      WHERE status = 'closed' AND closed_at > NOW() - INTERVAL '${days} days'
    `;
    const params = [];
    if (account) {
      q += ` AND account = $1`;
      params.push(String(account));
    }
    q += ` GROUP BY DATE(closed_at) ORDER BY day ASC`;
    const r = await pool.query(q, params);
    
    let cumPnL = 0;
    return r.rows.map(row => {
      const dayPnL = parseFloat(row.pnl) || 0;
      cumPnL += dayPnL;
      return {
        date: row.day,
        day_pnl: dayPnL,
        cumulative_pnl: cumPnL,
        trades: parseInt(row.trades)
      };
    });
  } catch (e) {
    console.error('getEquityCurve error:', e.message);
    return null;
  }
}

// ============ V5.0 · DAILY DEBRIEF ============

async function sendDailyDebrief() {
  if (!bot || !TELEGRAM_CHAT_ID) return;
  if (!pool) return;
  
  try {
    // Stats du jour pour tous les comptes
    const r = await pool.query(`
      SELECT 
        account,
        COUNT(*) as total,
        SUM(CASE WHEN net_profit > 0 THEN 1 ELSE 0 END) as wins,
        SUM(net_profit) as pnl
      FROM trades
      WHERE status = 'closed' AND DATE(closed_at) = CURRENT_DATE
      GROUP BY account
    `);
    
    if (r.rows.length === 0) {
      // Pas de trades aujourd'hui
      const msg = `🌙 *KAO V2 · DAILY DEBRIEF*\n\n📅 Aucun trade aujourd'hui.\n💡 Discipline > FOMO. Demain est un autre jour.`;
      await bot.sendMessage(TELEGRAM_CHAT_ID, msg, { parse_mode: 'Markdown' });
      return;
    }
    
    let msg = `🌙 *KAO V2 · DAILY DEBRIEF*\n\n`;
    msg += `📅 ${new Date().toLocaleDateString('fr-FR')}\n\n`;
    
    for (const row of r.rows) {
      const accountInfo = cache.accounts[row.account] || {};
      const profile = detectAccountProfile(accountInfo.balance);
      const total = parseInt(row.total);
      const wins = parseInt(row.wins);
      const pnl = parseFloat(row.pnl) || 0;
      const wr = total > 0 ? Math.round((wins / total) * 100) : 0;
      
      msg += `*${profile?.type || row.account}*\n`;
      msg += `  Trades : ${total} (${wins}W / ${total - wins}L)\n`;
      msg += `  Win rate : ${wr}%\n`;
      msg += `  P&L : ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}\n`;
      
      if (profile) {
        const targetPct = Math.round((pnl / profile.daily_target) * 100);
        const consistencyPct = Math.round((pnl / profile.max_best_day) * 100);
        msg += `  Target : ${targetPct}% / Plafond : ${consistencyPct}%\n`;
        if (pnl > profile.max_best_day) {
          msg += `  🚨 *PLAFOND DÉPASSÉ* · risque consistency\n`;
        }
      }
      
      // Violations
      const violations = disciplineState.violations[row.account] || 0;
      if (violations > 0) msg += `  ⚠️ ${violations} violation(s) discipline\n`;
      msg += `\n`;
    }
    
    // Best/Worst trade
    const bw = await pool.query(`
      SELECT symbol, direction, net_profit, verdict
      FROM trades
      WHERE status = 'closed' AND DATE(closed_at) = CURRENT_DATE
      ORDER BY net_profit DESC LIMIT 1
    `);
    const ww = await pool.query(`
      SELECT symbol, direction, net_profit, verdict
      FROM trades
      WHERE status = 'closed' AND DATE(closed_at) = CURRENT_DATE
      ORDER BY net_profit ASC LIMIT 1
    `);
    
    if (bw.rows[0]) {
      const t = bw.rows[0];
      msg += `🏆 Best : ${t.direction} ${t.symbol} +$${parseFloat(t.net_profit).toFixed(2)} (${t.verdict || 'manual'})\n`;
    }
    if (ww.rows[0] && ww.rows[0].net_profit < 0) {
      const t = ww.rows[0];
      msg += `❌ Worst : ${t.direction} ${t.symbol} $${parseFloat(t.net_profit).toFixed(2)} (${t.verdict || 'manual'})\n`;
    }
    
    msg += `\n💡 _Reviens demain avec discipline et patience._`;
    
    await bot.sendMessage(TELEGRAM_CHAT_ID, msg, { parse_mode: 'Markdown' });
  } catch (e) {
    console.error('Daily debrief error:', e.message);
  }
}

// ============ V5.0 · WEEKLY DEBRIEF ============

async function sendWeeklyDebrief() {
  if (!bot || !TELEGRAM_CHAT_ID) return;
  if (!pool) return;
  
  try {
    const r = await pool.query(`
      SELECT 
        account,
        COUNT(*) as total,
        SUM(CASE WHEN net_profit > 0 THEN 1 ELSE 0 END) as wins,
        SUM(net_profit) as pnl
      FROM trades
      WHERE status = 'closed' AND closed_at > NOW() - INTERVAL '7 days'
      GROUP BY account
    `);
    
    if (r.rows.length === 0) return;
    
    let msg = `📊 *KAO V2 · WEEKLY DEBRIEF*\n\n`;
    msg += `📅 7 derniers jours\n\n`;
    
    let totalPnL = 0;
    for (const row of r.rows) {
      const accountInfo = cache.accounts[row.account] || {};
      const profile = detectAccountProfile(accountInfo.balance);
      const pnl = parseFloat(row.pnl) || 0;
      const wr = row.total > 0 ? Math.round((row.wins / row.total) * 100) : 0;
      totalPnL += pnl;
      
      msg += `*${profile?.type || row.account}*\n`;
      msg += `  ${row.total} trades · WR ${wr}% · ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}\n\n`;
    }
    
    msg += `💰 *Total semaine : ${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(2)}*\n\n`;
    
    // Top 3 setups
    const stats = await getStatsBySetup();
    if (stats?.byVerdict.length) {
      msg += `🏆 *Top setups :*\n`;
      stats.byVerdict.slice(0, 3).forEach(s => {
        msg += `  ${s.verdict} : ${s.total}× · WR ${s.win_rate}% · $${s.total_pnl.toFixed(2)}\n`;
      });
      msg += `\n`;
      const worst = stats.byVerdict.slice(-1)[0];
      if (worst && worst.total_pnl < 0) {
        msg += `⚠️ *Setup à éviter :* ${worst.verdict} ($${worst.total_pnl.toFixed(2)})\n`;
      }
    }
    
    msg += `\n💡 _Bonne semaine à venir. Reste discipliné._`;
    
    await bot.sendMessage(TELEGRAM_CHAT_ID, msg, { parse_mode: 'Markdown' });
  } catch (e) {
    console.error('Weekly debrief error:', e.message);
  }
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
// V5.0: Daily debrief at 22:00 Paris time (= 21:00 UTC in winter, 20:00 UTC in summer)
cron.schedule('0 21 * * *', () => { try { sendDailyDebrief(); } catch(e) {} });
// V5.0: Weekly debrief Sunday 21:00 Paris
cron.schedule('0 21 * * 0', () => { try { sendWeeklyDebrief(); } catch(e) {} });
// V5.1: Pre-event briefings (1h and 30min before events)
cron.schedule('* * * * *', () => { try { checkPreEventBriefings(); } catch(e) {} });
// V5.1: Breaking news detector every minute
cron.schedule('* * * * *', () => { try { checkBreakingNews(); } catch(e) {} });

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
    discipline: { violations: disciplineState.violations, lastResetDate: disciplineState.lastResetDate },
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

// V5.0: Stats by setup endpoint
app.get('/api/stats/setups/:account?', async (req, res) => {
  const stats = await getStatsBySetup(req.params.account);
  res.json(stats || { error: 'DB not available' });
});

// V5.0: Heatmap endpoint
app.get('/api/heatmap/:account?', async (req, res) => {
  const heatmap = await getHeatmap(req.params.account);
  res.json(heatmap || { error: 'DB not available' });
});

// V5.0: Equity curve endpoint
app.get('/api/equity/:account?', async (req, res) => {
  const days = parseInt(req.query.days) || 30;
  const curve = await getEquityCurve(req.params.account, days);
  res.json(curve || { error: 'DB not available' });
});

// V5.0: Force daily debrief (test)
app.get('/api/debrief/daily', async (req, res) => {
  await sendDailyDebrief();
  res.json({ ok: true });
});
app.get('/api/debrief/weekly', async (req, res) => {
  await sendWeeklyDebrief();
  res.json({ ok: true });
});

// v4.9: Manual cleanup endpoint - mark all 'open' trades as closed_unknown
// Use this if you need to force a clean state from dashboard
app.get('/api/trade/cleanup', async (req, res) => {
  if (!pool) return res.json({ error: 'DB not available' });
  try {
    const r = await pool.query(
      `UPDATE trades SET status='cleaned', closed_at=NOW(), net_profit=0
       WHERE status='open' RETURNING ticket, symbol`
    );
    cache.trades = [];
    res.json({ ok: true, cleaned: r.rows.length, trades: r.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// v3: Receive live broker price from EA
app.post('/api/price', checkAuth, (req, res) => {
  const { symbol, bid, ask, mid } = req.body;
  cache.brokerPrice = mid || bid;
  cache.brokerPriceTime = Date.now();
  cache.brokerSymbol = symbol;
  // V5.1: Track for abnormal movement detection
  try {
    recordPriceForAnomaly(cache.brokerPrice);
    detectAbnormalMovement().catch(() => {});
  } catch (e) {}
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
  // V5.0: Discipline check
  try { await checkDisciplineOnNewTrade(trade); } catch (e) { console.error('Discipline:', e.message); }
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
  // V5.0: Update discipline tracker
  try { recordClosedTradeForDiscipline(trade); } catch (e) {}
  // CONSISTENCY CHECK
  const alert = await checkConsistencyAlert(trade.account);
  if (alert) await sendConsistencyAlert(trade.account, alert);
  res.json({ ok: true });
});

// v4.9: Snapshot reconciliation endpoint
// EA sends list of currently OPEN positions
// Server detects "ghost trades" (in DB as open but not in MT5) and marks them as closed
app.post('/api/trade/snapshot', checkAuth, async (req, res) => {
  const { account, open_tickets, count } = req.body;
  console.log(`📸 Snapshot from ${account}: ${count} positions open in MT5`);
  
  if (!account || !Array.isArray(open_tickets)) {
    return res.status(400).json({ error: 'Invalid snapshot' });
  }
  
  const openTicketsSet = new Set(open_tickets.map(t => String(t)));
  
  // Find ghost trades: in DB as 'open' for this account, but ticket not in current MT5 open list
  let ghostsFound = [];
  if (pool) {
    try {
      const r = await pool.query(
        `SELECT * FROM trades WHERE account = $1 AND status = 'open'`,
        [String(account)]
      );
      ghostsFound = r.rows.filter(t => !openTicketsSet.has(String(t.ticket)));
      
      if (ghostsFound.length > 0) {
        console.log(`👻 Found ${ghostsFound.length} ghost trade(s) to clean up`);
        
        for (const ghost of ghostsFound) {
          // Mark as closed_unknown (PC was off, exact P&L unknown)
          // EA's reconciliation should have already sent the actual close
          // If we still see it here = was closed but never reported
          await pool.query(
            `UPDATE trades SET status='cleaned', closed_at=NOW(),
             net_profit=0, profit=0, commission=0, swap=0
             WHERE ticket=$1 AND status='open'`,
            [ghost.ticket]
          );
          console.log(`  ✓ Closed ghost ticket ${ghost.ticket} (${ghost.symbol})`);
        }
      }
    } catch (e) {
      console.error('Snapshot DB error:', e.message);
    }
  }
  
  // Also clean cache
  if (ghostsFound.length > 0) {
    const ghostTickets = new Set(ghostsFound.map(g => g.ticket));
    cache.trades = cache.trades.filter(t => !ghostTickets.has(t.ticket));
  }
  
  // Notify Telegram if ghost trades were found
  if (ghostsFound.length > 0 && bot && TELEGRAM_CHAT_ID) {
    let msg = `🔄 *KAO V2 · RECONCILIATION*\n\n`;
    msg += `${ghostsFound.length} trade(s) fantôme(s) nettoyé(s)\n`;
    msg += `_Probablement fermés pendant que ton PC était éteint._\n`;
    msg += `_Vérifie ton historique broker pour les vrais P&L._`;
    try { await bot.sendMessage(TELEGRAM_CHAT_ID, msg, { parse_mode: 'Markdown' }); } catch (e) {}
  }
  
  res.json({ 
    ok: true, 
    open_in_mt5: count, 
    ghosts_cleaned: ghostsFound.length 
  });
});

app.get('/api/telegram/test', async (req, res) => {
  if (!bot) return res.json({ ok: false, error: 'Bot not configured' });
  try {
    await bot.sendMessage(TELEGRAM_CHAT_ID, '✅ *Kao V2 v3* · Test OK · DB active', { parse_mode: 'Markdown' });
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ============ V6.0 · SAAS AUTHENTICATION ============
const JWT_SECRET = process.env.JWT_SECRET || (AUTH_TOKEN + '_jwt_secret');
const crypto = require('crypto');

function generateAuthToken() {
  return crypto.randomBytes(32).toString('hex');
}

function authMiddleware(req, res, next) {
  const token = req.cookies?.kao_jwt || req.headers['authorization']?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    req.userEmail = decoded.email;
    next();
  } catch (e) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// Register
app.post('/api/auth/register', async (req, res) => {
  if (!pool) return res.status(500).json({ error: 'DB not available' });
  const { email, password, username } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password too short (min 6)' });
  
  try {
    const exists = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (exists.rows.length) return res.status(409).json({ error: 'Email already registered' });
    
    const hash = await bcrypt.hash(password, 10);
    const userToken = generateAuthToken();
    
    const result = await pool.query(
      `INSERT INTO users (email, password_hash, username, auth_token) VALUES ($1, $2, $3, $4) RETURNING id, email, username, auth_token`,
      [email.toLowerCase(), hash, username || email.split('@')[0], userToken]
    );
    
    const user = result.rows[0];
    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
    res.cookie('kao_jwt', token, { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000 });
    res.json({ ok: true, user: { id: user.id, email: user.email, username: user.username, auth_token: user.auth_token } });
  } catch (e) {
    console.error('Register:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  if (!pool) return res.status(500).json({ error: 'DB not available' });
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  
  try {
    const r = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    if (!r.rows.length) return res.status(401).json({ error: 'Invalid credentials' });
    const user = r.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });
    
    await pool.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);
    
    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
    res.cookie('kao_jwt', token, { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000 });
    res.json({ ok: true, user: { id: user.id, email: user.email, username: user.username, auth_token: user.auth_token } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Logout
app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('kao_jwt');
  res.json({ ok: true });
});

// Current user
app.get('/api/auth/me', authMiddleware, async (req, res) => {
  if (!pool) return res.status(500).json({ error: 'DB not available' });
  try {
    const r = await pool.query('SELECT id, email, username, auth_token, telegram_token, telegram_chat_id FROM users WHERE id = $1', [req.userId]);
    if (!r.rows.length) return res.status(404).json({ error: 'User not found' });
    res.json({ user: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Update user settings
app.post('/api/auth/settings', authMiddleware, async (req, res) => {
  if (!pool) return res.status(500).json({ error: 'DB not available' });
  const { telegram_token, telegram_chat_id, username } = req.body;
  try {
    await pool.query(
      `UPDATE users SET telegram_token = COALESCE($1, telegram_token), telegram_chat_id = COALESCE($2, telegram_chat_id), username = COALESCE($3, username) WHERE id = $4`,
      [telegram_token, telegram_chat_id, username, req.userId]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// User custom levels
app.get('/api/user/levels', authMiddleware, async (req, res) => {
  if (!pool) return res.status(500).json({ error: 'DB not available' });
  try {
    const r = await pool.query('SELECT * FROM user_setups WHERE user_id = $1', [req.userId]);
    res.json({ levels: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/user/levels', authMiddleware, async (req, res) => {
  if (!pool) return res.status(500).json({ error: 'DB not available' });
  const { level_name, level_value, level_type } = req.body;
  try {
    await pool.query(
      `INSERT INTO user_setups (user_id, level_name, level_value, level_type) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, level_name) DO UPDATE SET level_value = $3, level_type = $4`,
      [req.userId, level_name, level_value, level_type]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/user/levels/:name', authMiddleware, async (req, res) => {
  if (!pool) return res.status(500).json({ error: 'DB not available' });
  try {
    await pool.query('DELETE FROM user_setups WHERE user_id = $1 AND level_name = $2', [req.userId, req.params.name]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// User trades (linked by auth_token from EA)
app.post('/api/user/trade/new', async (req, res) => {
  if (!pool) return res.status(500).json({ error: 'DB not available' });
  const userToken = req.headers['x-auth-token'];
  if (!userToken) return res.status(401).json({ error: 'No token' });
  try {
    const u = await pool.query('SELECT id FROM users WHERE auth_token = $1', [userToken]);
    if (!u.rows.length) return res.status(401).json({ error: 'Invalid user token' });
    const userId = u.rows[0].id;
    const t = req.body;
    await pool.query(
      `INSERT INTO user_trades (user_id, ticket, account, symbol, direction, volume, entry, sl, tp, sl_pts, tp_pts, opened_at, status) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'open')
       ON CONFLICT (user_id, ticket) DO NOTHING`,
      [userId, t.ticket, t.account, t.symbol, t.direction, t.volume, t.entry, t.sl, t.tp, t.sl_pts, t.tp_pts, t.time || new Date()]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/user/trade/close', async (req, res) => {
  if (!pool) return res.status(500).json({ error: 'DB not available' });
  const userToken = req.headers['x-auth-token'];
  if (!userToken) return res.status(401).json({ error: 'No token' });
  try {
    const u = await pool.query('SELECT id FROM users WHERE auth_token = $1', [userToken]);
    if (!u.rows.length) return res.status(401).json({ error: 'Invalid user token' });
    const userId = u.rows[0].id;
    const t = req.body;
    await pool.query(
      `UPDATE user_trades SET status='closed', closed_at=$1, price_close=$2, profit=$3, commission=$4, swap=$5, net_profit=$6 
       WHERE user_id = $7 AND ticket = $8`,
      [t.time || new Date(), t.price_close, t.profit, t.commission, t.swap, t.net_profit, userId, t.ticket]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/user/trades', authMiddleware, async (req, res) => {
  if (!pool) return res.status(500).json({ error: 'DB not available' });
  try {
    const open = await pool.query("SELECT * FROM user_trades WHERE user_id = $1 AND status = 'open' ORDER BY opened_at DESC", [req.userId]);
    const closed = await pool.query("SELECT * FROM user_trades WHERE user_id = $1 AND status = 'closed' ORDER BY closed_at DESC LIMIT 50", [req.userId]);
    res.json({ open: open.rows, closed: closed.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// SaaS routes
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'register.html')));
app.get('/app', (req, res) => res.redirect('/app/dashboard'));
app.get('/app/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'app_dashboard.html')));
app.get('/app/setup', (req, res) => res.sendFile(path.join(__dirname, 'app_setup.html')));

app.listen(PORT, () => {
  console.log(`🚀 Kao V2 v3 on ${PORT} · DB: ${pool ? 'ON' : 'OFF'}`);
});
