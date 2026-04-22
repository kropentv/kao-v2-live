/**
 * KAO V2 LIVE SERVER v2 - with trade observation
 */
const express = require('express');
const path = require('path');
app.use(express.static(path.join(__dirname)));
const cors = require('cors');
const fetch = require('node-fetch');
const Parser = require('rss-parser');
const cron = require('node-cron');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(cors());
app.use(express.json());

const parser = new Parser({ timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0 KaoV2' } });

const PORT = process.env.PORT || 3000;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'kaov2secret';

const LEVELS = {
  major_resistance: 4900, resistance: 4889, kijun_h1: 4850,
  friday_close: 4834, support: 4790, intermediate_support: 4760, critical_pivot: 4744
};

let bot = null;
if (TELEGRAM_TOKEN) {
  try { bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false }); console.log('✅ Telegram OK'); }
  catch (e) { console.log('⚠️ Telegram:', e.message); }
}

let cache = {
  prices: {}, news: [], trump: [], calendar: [], matrix: {},
  trades: [], closedTrades: [], advices: [], accounts: {},
  lastUpdate: null
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

// ============ TRADE ADVISORY ENGINE ============
function analyzeTrade(trade, accountInfo) {
  const sentiment = cache.matrix?.sentiment || 'NEUTRAL';
  const fedBias = cache.matrix?.fedBias || 'NEUTRAL';
  const usdStrength = cache.matrix?.usdStrength || 'NEUTRAL';
  
  const advice = {
    trade_ticket: trade.ticket, timestamp: new Date().toISOString(),
    score: 50, verdict: 'NEUTRAL',
    warnings: [], positives: [], context_notes: [], suggested_action: ''
  };

  const isBuy = trade.direction === 'BUY';
  const isSell = trade.direction === 'SELL';
  const entry = trade.entry;
  
  // LEVEL ANALYSIS
  if (isSell) {
    if (Math.abs(entry - LEVELS.kijun_h1) < 3) {
      advice.positives.push(`✅ Entry proche Kijun H1 (${LEVELS.kijun_h1}) · zone short prioritaire`);
      advice.score += 15;
    } else if (Math.abs(entry - LEVELS.resistance) < 3) {
      advice.positives.push(`✅ Entry sur résistance ${LEVELS.resistance}`);
      advice.score += 15;
    } else if (entry > LEVELS.major_resistance) {
      advice.warnings.push(`🚨 SHORT au-dessus du mur ${LEVELS.major_resistance} · RISQUE ÉLEVÉ`);
      advice.score -= 30;
    } else if (entry < LEVELS.support) {
      advice.warnings.push(`⚠️ SHORT sous support ${LEVELS.support} · tu vends le bas`);
      advice.score -= 25;
    } else if (entry > LEVELS.support && entry < LEVELS.kijun_h1) {
      advice.context_notes.push(`ℹ️ Entry en milieu de range · zone neutre`);
      advice.score -= 10;
    }
  }
  if (isBuy) {
    if (Math.abs(entry - LEVELS.support) < 3) {
      advice.positives.push(`✅ Entry proche support ${LEVELS.support}`);
      advice.score += 15;
    } else if (Math.abs(entry - LEVELS.intermediate_support) < 3) {
      advice.positives.push(`✅ Entry sur support ${LEVELS.intermediate_support}`);
      advice.score += 15;
    } else if (entry < LEVELS.critical_pivot) {
      advice.warnings.push(`🚨 BUY sous pivot critique ${LEVELS.critical_pivot}`);
      advice.score -= 30;
    } else if (entry > LEVELS.kijun_h1) {
      advice.warnings.push(`⚠️ BUY au-dessus Kijun ${LEVELS.kijun_h1} · tu achètes le haut`);
      advice.score -= 25;
    }
  }

  // SENTIMENT ALIGNMENT
  if (sentiment === 'BULLISH' && isBuy) { advice.positives.push(`✅ Aligné sentiment macro BULLISH`); advice.score += 10; }
  else if (sentiment === 'BULLISH' && isSell) { advice.warnings.push(`⚠️ SHORT contre sentiment BULLISH`); advice.score -= 15; }
  else if (sentiment === 'BEARISH' && isSell) { advice.positives.push(`✅ Aligné sentiment BEARISH`); advice.score += 10; }
  else if (sentiment === 'BEARISH' && isBuy) { advice.warnings.push(`⚠️ BUY contre sentiment BEARISH`); advice.score -= 15; }

  // FED / USD
  if (fedBias === 'DOVISH' && isBuy) { advice.positives.push(`✅ Fed DOVISH soutient BUY`); advice.score += 8; }
  if (fedBias === 'HAWKISH' && isBuy) { advice.warnings.push(`⚠️ Fed HAWKISH`); advice.score -= 8; }
  if (usdStrength === 'WEAK' && isBuy) { advice.positives.push(`✅ USD faible bullish Gold`); advice.score += 5; }

  // RISK MANAGEMENT
  if (trade.sl_pts === 0) { advice.warnings.push(`🚨 AUCUN SL · risque illimité`); advice.score -= 40; }
  else if (trade.sl_pts > 20) { advice.warnings.push(`⚠️ SL large (${trade.sl_pts.toFixed(1)} pts)`); advice.score -= 10; }
  else if (trade.sl_pts < 3) { advice.warnings.push(`⚠️ SL très serré (${trade.sl_pts.toFixed(1)} pts)`); advice.score -= 5; }

  if (trade.sl_pts > 0 && trade.tp_pts > 0) {
    const rr = trade.tp_pts / trade.sl_pts;
    if (rr >= 1.5) { advice.positives.push(`✅ R:R ${rr.toFixed(2)} · sain`); advice.score += 8; }
    else if (rr < 1) { advice.warnings.push(`⚠️ R:R ${rr.toFixed(2)} · SL > TP`); advice.score -= 15; }
  }

  // LOT SIZE
  const isFTM = accountInfo?.balance && accountInfo.balance < 80000;
  const isEE = accountInfo?.balance && accountInfo.balance >= 80000;
  if (isFTM && trade.volume > 0.40) { advice.warnings.push(`⚠️ Lot ${trade.volume} trop gros pour 50K`); advice.score -= 15; }
  if (isEE && trade.volume > 0.60) { advice.warnings.push(`⚠️ Lot ${trade.volume} élevé pour 100K`); advice.score -= 10; }

  // TIMING
  const hour = new Date().getHours();
  if (hour >= 9 && hour < 11) { advice.positives.push(`✅ Session Londres · optimal`); advice.score += 5; }
  else if (hour >= 14 && hour < 17) { advice.positives.push(`✅ Session NY · volatilité`); advice.score += 5; }
  else if (hour >= 11 && hour < 14) { advice.context_notes.push(`ℹ️ Midi · marché souvent plat`); advice.score -= 5; }
  else if (hour >= 22 || hour < 7) { advice.warnings.push(`⚠️ Session Asie · volume faible`); advice.score -= 10; }

  // NEWS
  const upcoming = cache.calendar?.filter(c => c.warn).length || 0;
  if (upcoming > 0) { advice.warnings.push(`⚠️ ${upcoming} news HIGH aujourd'hui`); advice.score -= 5; }

  // FINAL
  advice.score = Math.max(0, Math.min(100, advice.score));
  if (advice.score >= 70) advice.verdict = 'GOOD';
  else if (advice.score >= 50) advice.verdict = 'ACCEPTABLE';
  else if (advice.score >= 30) advice.verdict = 'CAUTION';
  else advice.verdict = 'BAD';

  if (advice.verdict === 'GOOD') advice.suggested_action = 'Setup solide · maintenir avec discipline';
  else if (advice.verdict === 'ACCEPTABLE') advice.suggested_action = 'Setup correct · surveiller la réaction';
  else if (advice.verdict === 'CAUTION') advice.suggested_action = 'Attention · réduire lot ou serrer SL';
  else advice.suggested_action = 'Setup risqué · envisager sortie anticipée';

  return advice;
}

async function sendTradeAdviceTelegram(trade, advice) {
  if (!bot || !TELEGRAM_CHAT_ID) return;
  const emoji = { 'GOOD':'🟢✅','ACCEPTABLE':'🟡','CAUTION':'🟠⚠️','BAD':'🔴🚨' }[advice.verdict];
  let msg = `${emoji} *KAO V2 · NEW TRADE OBSERVED*\n\n`;
  msg += `📊 *${trade.direction} ${trade.volume} ${trade.symbol}* @ ${trade.entry}\n`;
  if (trade.sl > 0) msg += `🛡 SL: ${trade.sl} (${trade.sl_pts.toFixed(1)} pts)\n`;
  else msg += `🚨 *NO SL SET*\n`;
  if (trade.tp > 0) msg += `🎯 TP: ${trade.tp} (${trade.tp_pts.toFixed(1)} pts)\n`;
  msg += `\n*VERDICT: ${advice.verdict}* · Score ${advice.score}/100\n\n`;
  if (advice.positives.length) msg += `*Points forts:*\n${advice.positives.map(p => `  ${p}`).join('\n')}\n\n`;
  if (advice.warnings.length) msg += `*Alertes:*\n${advice.warnings.map(w => `  ${w}`).join('\n')}\n\n`;
  msg += `💡 *Conseil:* ${advice.suggested_action}\n\n`;
  msg += `_Observation only · Kao V2 ne touche pas tes trades_`;
  try { await bot.sendMessage(TELEGRAM_CHAT_ID, msg, { parse_mode: 'Markdown', disable_web_page_preview: true }); }
  catch (e) { console.log('TG:', e.message); }
}

async function sendClosedTradeTelegram(trade) {
  if (!bot || !TELEGRAM_CHAT_ID) return;
  const emoji = trade.net_profit >= 0 ? '💰✅' : '❌📉';
  let msg = `${emoji} *KAO V2 · TRADE CLOSED*\n\n`;
  msg += `📊 ${trade.symbol} · ${trade.volume} lot\n`;
  msg += `💵 *P&L: ${trade.net_profit >= 0 ? '+' : ''}${trade.net_profit.toFixed(2)} USD*\n`;
  try { await bot.sendMessage(TELEGRAM_CHAT_ID, msg, { parse_mode: 'Markdown' }); }
  catch (e) { console.log('TG:', e.message); }
}

// Fetch functions (prices, news, trump, calendar) - identical to v1
async function fetchPrices() {
  const symbols = { 'XAUUSD':'GC=F','DXY':'DX-Y.NYB','US10Y':'^TNX','VIX':'^VIX','WTI':'CL=F' };
  const prices = {};
  for (const [key, symbol] of Object.entries(symbols)) {
    try {
      const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1m&range=1d`);
      const data = await res.json();
      const q = data?.chart?.result?.[0];
      if (q) {
        const price = q.meta.regularMarketPrice;
        const prev = q.meta.chartPreviousClose;
        prices[key] = { price, change: parseFloat(((price - prev) / prev * 100).toFixed(2)) };
      }
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
          const s = analyzeSentiment(text);
          const i = classifyImpact(text);
          const ac = classifyCategory(text);
          all.push({
            source: source.name, title: item.title,
            desc: (item.contentSnippet || '').substring(0, 200),
            link: item.link, time: item.pubDate || item.isoDate,
            impact: i, category: ac !== 'other' ? ac : category,
            signal: s,
            signalTitle: s === 'bull' ? 'Bullish Gold' : s === 'bear' ? 'Bearish Gold' : 'Neutre',
            signalText: goldImpactText(s, ac),
            correlation: correlationToPlan(s, i)
          });
        });
      } catch (e) {}
    }
  }
  all.sort((a, b) => new Date(b.time) - new Date(a.time));
  cache.news = all.slice(0, 25);
}

async function fetchTrump() {
  try {
    const feed = await parser.parseURL('https://trumpstruth.org/feed');
    cache.trump = feed.items.slice(0, 10).map(item => {
      const text = item.contentSnippet || item.title || '';
      const s = analyzeSentiment(text);
      return { platform: 'TRUTH SOCIAL', time: item.pubDate, text: text.substring(0, 400),
               link: item.link, impact: s, analysis: goldImpactText(s, 'trump') };
    });
  } catch (e) { cache.trump = []; }
}

async function fetchCalendar() {
  try {
    const res = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json');
    const data = await res.json();
    const today = new Date().toDateString();
    cache.calendar = data.filter(e => e.date && new Date(e.date).toDateString() === today)
      .map(e => ({
        time: new Date(e.date).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
        event: e.title,
        sub: `${e.country} ${e.forecast ? '· F:' + e.forecast : ''} ${e.previous ? '· P:' + e.previous : ''}`,
        impact: e.impact?.toLowerCase() || 'low',
        warn: e.impact?.toLowerCase() === 'high' && ['USD', 'EUR'].includes(e.country)
      }));
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
  cache.matrix = {
    sentiment, sentimentClass: sentiment === 'BULLISH' ? 'bull' : sentiment === 'BEARISH' ? 'bear' : 'neutral',
    fedBias, fedBiasClass: fedBias === 'DOVISH' ? 'bull' : fedBias === 'HAWKISH' ? 'bear' : 'neutral',
    usdStrength, usdStrengthClass: usdStrength === 'WEAK' ? 'bear' : usdStrength === 'STRONG' ? 'bull' : 'neutral',
    geoTension, geoTensionClass: geoTension === 'HIGH' ? 'bull' : 'neutral',
    reco
  };
}

async function refreshAll() {
  console.log('🔄 Refresh', new Date().toISOString());
  await Promise.all([fetchPrices(), fetchNews(), fetchTrump(), fetchCalendar()]);
  computeMatrix();
  cache.lastUpdate = new Date().toISOString();
}
refreshAll();
cron.schedule('*/2 * * * *', refreshAll);

function checkAuth(req, res, next) {
  if (req.headers['x-auth-token'] !== AUTH_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

app.get('/', (req, res) => res.send('Kao V2 Live Server · OK'));
app.get('/api/all', (req, res) => res.json({
  prices: cache.prices, news: cache.news, trump: cache.trump,
  calendar: cache.calendar, matrix: cache.matrix,
  trades: cache.trades, closedTrades: cache.closedTrades.slice(0, 20),
  advices: cache.advices.slice(0, 30),
  accounts: cache.accounts, lastUpdate: cache.lastUpdate
}));
app.get('/api/trades', (req, res) => res.json({ open: cache.trades, closed: cache.closedTrades.slice(0, 20) }));
app.get('/api/advices', (req, res) => res.json(cache.advices.slice(0, 30)));
app.get('/api/refresh', async (req, res) => { await refreshAll(); res.json({ ok: true }); });

// EA endpoints
app.post('/api/trade/ping', checkAuth, (req, res) => {
  const { account, broker, balance, equity, leverage } = req.body;
  cache.accounts[account] = { broker, balance, equity, leverage, lastPing: new Date().toISOString() };
  console.log(`📡 Ping from ${account} (${broker})`);
  res.json({ ok: true });
});

app.post('/api/trade/new', checkAuth, async (req, res) => {
  const trade = req.body;
  console.log(`📥 New: ${trade.direction} ${trade.volume} ${trade.symbol} @ ${trade.entry}`);
  cache.trades.unshift(trade);
  cache.trades = cache.trades.slice(0, 50);
  const accountInfo = cache.accounts[trade.account] || {};
  const advice = analyzeTrade(trade, accountInfo);
  cache.advices.unshift({ ...advice, trade });
  cache.advices = cache.advices.slice(0, 100);
  await sendTradeAdviceTelegram(trade, advice);
  res.json({ ok: true, advice });
});

app.post('/api/trade/close', checkAuth, async (req, res) => {
  const trade = req.body;
  console.log(`📤 Close: ${trade.symbol} P&L ${trade.net_profit}`);
  cache.trades = cache.trades.filter(t => t.ticket !== trade.ticket);
  cache.closedTrades.unshift(trade);
  cache.closedTrades = cache.closedTrades.slice(0, 100);
  await sendClosedTradeTelegram(trade);
  res.json({ ok: true });
});

app.get('/api/telegram/test', async (req, res) => {
  if (!bot) return res.json({ ok: false, error: 'Bot not configured' });
  try {
    await bot.sendMessage(TELEGRAM_CHAT_ID, '✅ *Kao V2* · Test OK', { parse_mode: 'Markdown' });
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.listen(PORT, () => {
  console.log(`🚀 Kao V2 on ${PORT} · Auth: ${AUTH_TOKEN}`);
});
