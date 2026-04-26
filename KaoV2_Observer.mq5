//+------------------------------------------------------------------+
//|                                         KaoV2_Observer.mq5  v4   |
//|          OBSERVER + SMART LEVELS ENGINE · Multi-Timeframe        |
//|                                                                   |
//|  Sends to server every 15s:                                      |
//|   - RSI M1, M5, M15, H1                                          |
//|   - EMA 50, EMA 200 (H1 trend filter)                            |
//|   - Recent highs/lows M5 (double top/bottom detection)           |
//|   - Live bid/ask broker price                                    |
//|   - Rejection candle info                                        |
//|                                                                   |
//|  STILL 100% READ-ONLY · No trading permissions used              |
//+------------------------------------------------------------------+
#property copyright "Kao V2 · Observer · v4.8 · Volume + Trump"
#property version   "4.80"
#property strict

input string  ServerURL     = "https://kao-v2-live-production-73ab.up.railway.app";
input string  AuthToken     = "kaov2secret";
input int     CheckInterval = 3;    // Trade scan interval
input int     MarketInterval = 15;  // Market data send interval (sec)
input bool    NotifyNew     = true;
input bool    NotifyClose   = true;
input bool    Verbose       = false;

ulong  tracked_tickets[];
datetime last_market_send = 0;
string  gold_symbol = "";  // Resolved broker gold symbol

//+------------------------------------------------------------------+
//| Resolve broker's gold symbol                                     |
//+------------------------------------------------------------------+
string ResolveGoldSymbol() {
   string candidates[] = {"XAUUSD", "XAUUSD.", "XAUUSD#", "GOLD", "XAU/USD", "XAUUSDx", "XAUUSDm", "XAUUSDpro"};
   for (int i = 0; i < ArraySize(candidates); i++) {
      if (SymbolSelect(candidates[i], true)) {
         MqlTick tick;
         if (SymbolInfoTick(candidates[i], tick) && tick.bid > 1000) {
            return candidates[i];
         }
      }
   }
   // Try chart symbol as last resort
   string chart_sym = Symbol();
   if (StringFind(chart_sym, "XAU") >= 0 || StringFind(chart_sym, "GOLD") >= 0) {
      return chart_sym;
   }
   return "";
}

//+------------------------------------------------------------------+
//| Init                                                              |
//+------------------------------------------------------------------+
int OnInit() {
   Print("=== KAO V2 OBSERVER v4 · SMART LEVELS ACTIVE ===");
   Print("Server: ", ServerURL);
   Print("Mode: READ-ONLY");
   
   gold_symbol = ResolveGoldSymbol();
   if (gold_symbol == "") {
      Print("⚠️ Gold symbol not found. Market data won't be sent.");
   } else {
      Print("Gold symbol resolved: ", gold_symbol);
   }
   
   SendPing();
   ScanPositions();
   SendMarketData();
   
   EventSetTimer(CheckInterval);
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason) {
   EventKillTimer();
   Print("=== KAO V2 OBSERVER STOPPED ===");
}

//+------------------------------------------------------------------+
//| Timer loop                                                        |
//+------------------------------------------------------------------+
void OnTimer() {
   ScanPositions();
   CheckClosedTrades();
   SendPrice();
   
   // Send full market analysis every MarketInterval seconds
   if (TimeCurrent() - last_market_send >= MarketInterval) {
      SendMarketData();
      last_market_send = TimeCurrent();
   }
}

//+------------------------------------------------------------------+
//| SendMarketData · multi-timeframe RSI + EMA + Pivots + Sweeps     |
//+------------------------------------------------------------------+
void SendMarketData() {
   if (gold_symbol == "") return;
   
   // === RSI multi-timeframes ===
   double rsi_m1 = GetRSI(gold_symbol, PERIOD_M1, 14, 0);
   double rsi_m5 = GetRSI(gold_symbol, PERIOD_M5, 14, 0);
   double rsi_m15 = GetRSI(gold_symbol, PERIOD_M15, 14, 0);
   double rsi_h1 = GetRSI(gold_symbol, PERIOD_H1, 14, 0);
   
   // === EMA H1 (trend filter) ===
   double ema50_h1 = GetEMA(gold_symbol, PERIOD_H1, 50, 0);
   double ema200_h1 = GetEMA(gold_symbol, PERIOD_H1, 200, 0);
   double ema50_m15 = GetEMA(gold_symbol, PERIOD_M15, 50, 0);
   
   // === Price ===
   MqlTick tick;
   if (!SymbolInfoTick(gold_symbol, tick)) return;
   double bid = tick.bid;
   double ask = tick.ask;
   double mid = (bid + ask) / 2.0;
   
   // === Day levels (PDH/PDL/PDC + Today's H/L) ===
   // D1 bar 0 = today, bar 1 = yesterday
   double pdh = iHigh(gold_symbol, PERIOD_D1, 1);    // Previous Day High
   double pdl = iLow(gold_symbol, PERIOD_D1, 1);     // Previous Day Low
   double pdc = iClose(gold_symbol, PERIOD_D1, 1);   // Previous Day Close
   double today_open = iOpen(gold_symbol, PERIOD_D1, 0);
   double today_high = iHigh(gold_symbol, PERIOD_D1, 0);
   double today_low = iLow(gold_symbol, PERIOD_D1, 0);
   
   // === Asia/London/NY session ranges ===
   // Approximate: scan last 24h M5 bars by hour
   double asia_high = 0, asia_low = 999999;
   double ldn_high = 0, ldn_low = 999999;
   for (int i = 1; i < 288; i++) {  // 288 = 24h * 12 bars/h
      datetime bar_time = iTime(gold_symbol, PERIOD_M5, i);
      if (bar_time == 0) break;
      MqlDateTime dt;
      TimeToStruct(bar_time, dt);
      int h = dt.hour;
      double bh = iHigh(gold_symbol, PERIOD_M5, i);
      double bl = iLow(gold_symbol, PERIOD_M5, i);
      // Asia: 0-7 UTC
      if (h >= 0 && h < 7) {
         if (bh > asia_high) asia_high = bh;
         if (bl < asia_low) asia_low = bl;
      }
      // London: 7-13 UTC
      else if (h >= 7 && h < 13) {
         if (bh > ldn_high) ldn_high = bh;
         if (bl < ldn_low) ldn_low = bl;
      }
   }
   if (asia_low > 99999) asia_low = 0;
   if (ldn_low > 99999) ldn_low = 0;
   
   // === ATR M15 (volatility measure) ===
   double atr_m15 = GetATR(gold_symbol, PERIOD_M15, 14);
   
   // === VOLUME (tick volume - only thing available for Forex/Gold) ===
   long vol_m5_0 = iVolume(gold_symbol, PERIOD_M5, 1);  // Last closed M5
   long vol_m5_1 = iVolume(gold_symbol, PERIOD_M5, 2);
   long vol_m5_2 = iVolume(gold_symbol, PERIOD_M5, 3);
   long vol_m1_0 = iVolume(gold_symbol, PERIOD_M1, 1);
   long vol_m15_0 = iVolume(gold_symbol, PERIOD_M15, 1);
   
   // Average volume M5 last 20 candles for spike detection
   long vol_m5_avg = 0;
   long vol_m5_max = 0;
   for (int i = 1; i <= 20; i++) {
      long v = iVolume(gold_symbol, PERIOD_M5, i);
      vol_m5_avg += v;
      if (v > vol_m5_max) vol_m5_max = v;
   }
   vol_m5_avg = vol_m5_avg / 20;
   
   // Volume spike detection (current >> average)
   bool volume_spike_m5 = (vol_m5_avg > 0) && (vol_m5_0 > vol_m5_avg * 2);
   bool volume_huge_m5 = (vol_m5_avg > 0) && (vol_m5_0 > vol_m5_avg * 3);
   double volume_ratio = (vol_m5_avg > 0) ? ((double)vol_m5_0 / vol_m5_avg) : 1.0;
   
   // === Pivots ===
   double pivots_high[5], pivots_low[5];
   int n_high = 0, n_low = 0;
   FindPivots(gold_symbol, PERIOD_M5, 80, pivots_high, n_high, pivots_low, n_low);
   
   double pivots_high_m15[5], pivots_low_m15[5];
   int n_high_m15 = 0, n_low_m15 = 0;
   FindPivots(gold_symbol, PERIOD_M15, 60, pivots_high_m15, n_high_m15, pivots_low_m15, n_low_m15);
   
   double pivots_high_h1[5], pivots_low_h1[5];
   int n_high_h1 = 0, n_low_h1 = 0;
   FindPivots(gold_symbol, PERIOD_H1, 40, pivots_high_h1, n_high_h1, pivots_low_h1, n_low_h1);
   
   // === Last 3 closed M5 candles (sweep + BOS detection) ===
   double m5_open_0 = iOpen(gold_symbol, PERIOD_M5, 1);
   double m5_close_0 = iClose(gold_symbol, PERIOD_M5, 1);
   double m5_high_0 = iHigh(gold_symbol, PERIOD_M5, 1);
   double m5_low_0 = iLow(gold_symbol, PERIOD_M5, 1);
   double m5_high_1 = iHigh(gold_symbol, PERIOD_M5, 2);
   double m5_low_1 = iLow(gold_symbol, PERIOD_M5, 2);
   double m5_high_2 = iHigh(gold_symbol, PERIOD_M5, 3);
   double m5_low_2 = iLow(gold_symbol, PERIOD_M5, 3);
   double m5_close_1 = iClose(gold_symbol, PERIOD_M5, 2);
   double m5_close_2 = iClose(gold_symbol, PERIOD_M5, 3);
   
   double m5_body = MathAbs(m5_close_0 - m5_open_0);
   double m5_upper_wick = m5_high_0 - MathMax(m5_open_0, m5_close_0);
   double m5_lower_wick = MathMin(m5_open_0, m5_close_0) - m5_low_0;
   double m5_candle_range = m5_high_0 - m5_low_0;
   
   bool is_pin_bear = (m5_upper_wick > m5_body * 2.0) && m5_body > 0;
   bool is_pin_bull = (m5_lower_wick > m5_body * 2.0) && m5_body > 0;
   
   // === Marubozu Candle (full-body candle) ===
   // (Note: previously named "pitchfork" but Marubozu is the correct term)
   // Body fills 75%+ of range, body ≥ 3 pts, minimal wick on close side
   bool marubozu_bull = false;
   bool marubozu_bear = false;
   if (m5_body >= 3) {
      double body_ratio = m5_candle_range > 0 ? (m5_body / m5_candle_range) : 0;
      if (body_ratio >= 0.75) {
         if (m5_close_0 > m5_open_0 && m5_upper_wick < m5_body * 0.3) marubozu_bull = true;
         if (m5_close_0 < m5_open_0 && m5_lower_wick < m5_body * 0.3) marubozu_bear = true;
      }
   }
   
   // === Marubozu REVERSAL (Engulfing-style) ===
   // Previous candle was bearish (m5_close_1 < m5_open_1) AND big body
   // Current candle is bullish marubozu that engulfs prev body = STRONG BULL REVERSAL
   double m5_open_1 = iOpen(gold_symbol, PERIOD_M5, 2);
   double m5_body_1 = MathAbs(m5_close_1 - m5_open_1);
   bool prev_was_bearish = m5_close_1 < m5_open_1;
   bool prev_was_bullish = m5_close_1 > m5_open_1;
   
   bool marubozu_reversal_bull = false;  // Marubozu bull AFTER bearish candle = reversal
   bool marubozu_reversal_bear = false;  // Marubozu bear AFTER bullish candle = reversal
   if (marubozu_bull && prev_was_bearish && m5_body_1 >= 2 && m5_close_0 > m5_open_1) {
      marubozu_reversal_bull = true;  // Engulfing bull pattern
   }
   if (marubozu_bear && prev_was_bullish && m5_body_1 >= 2 && m5_close_0 < m5_open_1) {
      marubozu_reversal_bear = true;  // Engulfing bear pattern
   }
   
   // === Marubozu CONTINUATION (2 same-direction in a row) ===
   bool marubozu_continuation_bull = false;
   bool marubozu_continuation_bear = false;
   if (marubozu_bull && prev_was_bullish && m5_body_1 >= 2.5) marubozu_continuation_bull = true;
   if (marubozu_bear && prev_was_bearish && m5_body_1 >= 2.5) marubozu_continuation_bear = true;
   
   // === John Wick Candle detection (very long candle, strong directional move) ===
   // Body > 4 pts AND body > 70% of range (strong directional)
   bool john_wick_bull = false;
   bool john_wick_bear = false;
   if (m5_candle_range > 0 && m5_body >= 4 && (m5_body / m5_candle_range) >= 0.65) {
      if (m5_close_0 > m5_open_0) john_wick_bull = true;
      else john_wick_bear = true;
   }
   // Even bigger: M5 candle range > ATR * 1.5 = strong impulse
   bool huge_impulse_bull = atr_m15 > 0 && m5_candle_range > atr_m15 * 1.3 && m5_close_0 > m5_open_0;
   bool huge_impulse_bear = atr_m15 > 0 && m5_candle_range > atr_m15 * 1.3 && m5_close_0 < m5_open_0;
   
   // === Liquidity Sweep detection ===
   bool sweep_high = false;
   double sweep_high_level = 0;
   if (n_high >= 1) {
      if (m5_high_0 > pivots_high[0] && m5_close_0 < pivots_high[0]) {
         sweep_high = true;
         sweep_high_level = pivots_high[0];
      }
   }
   if (!sweep_high && m5_high_1 > 0) {
      if (m5_high_0 > m5_high_1 + 0.5 && m5_close_0 < m5_high_1) {
         sweep_high = true;
         sweep_high_level = m5_high_1;
      }
   }
   
   bool sweep_low = false;
   double sweep_low_level = 0;
   if (n_low >= 1) {
      if (m5_low_0 < pivots_low[0] && m5_close_0 > pivots_low[0]) {
         sweep_low = true;
         sweep_low_level = pivots_low[0];
      }
   }
   if (!sweep_low && m5_low_1 > 0) {
      if (m5_low_0 < m5_low_1 - 0.5 && m5_close_0 > m5_low_1) {
         sweep_low = true;
         sweep_low_level = m5_low_1;
      }
   }
   
   // === BOS (Break of Structure) detection M15 ===
   // CORRECTED: Requires candle CLOSE beyond level, not just wick
   // Bullish BOS: M15 candle CLOSED above last M15 swing high
   // Bearish BOS: M15 candle CLOSED below last M15 swing low
   bool bos_bullish = false;
   bool bos_bearish = false;
   double bos_level = 0;
   double m15_close_1 = iClose(gold_symbol, PERIOD_M15, 1);  // Last closed M15 candle
   if (n_high_m15 >= 1) {
      // Body close (not wick) above the previous swing high
      if (m15_close_1 > pivots_high_m15[0] + 0.5) {
         bos_bullish = true;
         bos_level = pivots_high_m15[0];
      }
   }
   if (n_low_m15 >= 1) {
      if (m15_close_1 < pivots_low_m15[0] - 0.5) {
         bos_bearish = true;
         bos_level = pivots_low_m15[0];
      }
   }
   
   // === CHoCH (Change of Character) - REVERSAL signal ===
   // CHoCH = break against the prior trend (= start of reversal)
   // Bullish CHoCH: was downtrend (prev pivots_low < pivots_low[1]), now broke a swing high
   // Bearish CHoCH: was uptrend, now broke a swing low
   bool choch_bullish = false;
   bool choch_bearish = false;
   double choch_level = 0;
   if (bos_bullish && n_low_m15 >= 2) {
      // If previous lows were descending (downtrend), then bull break = CHoCH
      if (pivots_low_m15[0] < pivots_low_m15[1]) {
         choch_bullish = true;
         choch_level = pivots_high_m15[0];
      }
   }
   if (bos_bearish && n_high_m15 >= 2) {
      if (pivots_high_m15[0] > pivots_high_m15[1]) {
         choch_bearish = true;
         choch_level = pivots_low_m15[0];
      }
   }
   
   // === Build JSON ===
   string json = "{";
   json += "\"event\":\"market_data\",";
   json += StringFormat("\"symbol\":\"%s\",", gold_symbol);
   json += StringFormat("\"bid\":%.2f,\"ask\":%.2f,\"mid\":%.2f,", bid, ask, mid);
   json += StringFormat("\"rsi_m1\":%.2f,\"rsi_m5\":%.2f,\"rsi_m15\":%.2f,\"rsi_h1\":%.2f,",
                        rsi_m1, rsi_m5, rsi_m15, rsi_h1);
   json += StringFormat("\"ema50_h1\":%.2f,\"ema200_h1\":%.2f,\"ema50_m15\":%.2f,",
                        ema50_h1, ema200_h1, ema50_m15);
   json += StringFormat("\"atr_m15\":%.2f,", atr_m15);
   json += StringFormat("\"volume_m5\":%I64d,\"volume_m5_avg\":%I64d,\"volume_m5_max\":%I64d,\"volume_ratio\":%.2f,",
                        vol_m5_0, vol_m5_avg, vol_m5_max, volume_ratio);
   json += StringFormat("\"volume_spike\":%s,\"volume_huge\":%s,",
                        volume_spike_m5 ? "true" : "false", volume_huge_m5 ? "true" : "false");
   json += StringFormat("\"volume_m1\":%I64d,\"volume_m15\":%I64d,", vol_m1_0, vol_m15_0);
   
   // Day levels
   json += StringFormat("\"pdh\":%.2f,\"pdl\":%.2f,\"pdc\":%.2f,", pdh, pdl, pdc);
   json += StringFormat("\"today_open\":%.2f,\"today_high\":%.2f,\"today_low\":%.2f,",
                        today_open, today_high, today_low);
   json += StringFormat("\"asia_high\":%.2f,\"asia_low\":%.2f,\"ldn_high\":%.2f,\"ldn_low\":%.2f,",
                        asia_high, asia_low, ldn_high, ldn_low);
   
   json += StringFormat("\"is_pin_bear\":%s,\"is_pin_bull\":%s,",
                        is_pin_bear ? "true" : "false", is_pin_bull ? "true" : "false");
   json += StringFormat("\"m5_upper_wick\":%.2f,\"m5_lower_wick\":%.2f,\"m5_body\":%.2f,\"m5_range\":%.2f,",
                        m5_upper_wick, m5_lower_wick, m5_body, m5_candle_range);
   json += StringFormat("\"john_wick_bull\":%s,\"john_wick_bear\":%s,",
                        john_wick_bull ? "true" : "false", john_wick_bear ? "true" : "false");
   json += StringFormat("\"marubozu_bull\":%s,\"marubozu_bear\":%s,",
                        marubozu_bull ? "true" : "false", marubozu_bear ? "true" : "false");
   json += StringFormat("\"marubozu_reversal_bull\":%s,\"marubozu_reversal_bear\":%s,",
                        marubozu_reversal_bull ? "true" : "false", marubozu_reversal_bear ? "true" : "false");
   json += StringFormat("\"marubozu_continuation_bull\":%s,\"marubozu_continuation_bear\":%s,",
                        marubozu_continuation_bull ? "true" : "false", marubozu_continuation_bear ? "true" : "false");
   json += StringFormat("\"huge_impulse_bull\":%s,\"huge_impulse_bear\":%s,",
                        huge_impulse_bull ? "true" : "false", huge_impulse_bear ? "true" : "false");
   json += StringFormat("\"sweep_high\":%s,\"sweep_high_level\":%.2f,",
                        sweep_high ? "true" : "false", sweep_high_level);
   json += StringFormat("\"sweep_low\":%s,\"sweep_low_level\":%.2f,",
                        sweep_low ? "true" : "false", sweep_low_level);
   json += StringFormat("\"bos_bullish\":%s,\"bos_bearish\":%s,\"bos_level\":%.2f,",
                        bos_bullish ? "true" : "false", bos_bearish ? "true" : "false", bos_level);
   json += StringFormat("\"choch_bullish\":%s,\"choch_bearish\":%s,\"choch_level\":%.2f,",
                        choch_bullish ? "true" : "false", choch_bearish ? "true" : "false", choch_level);
   
   // Pivots arrays
   json += "\"pivots_high\":[";
   for (int i = 0; i < n_high; i++) { if (i > 0) json += ","; json += StringFormat("%.2f", pivots_high[i]); }
   json += "],\"pivots_low\":[";
   for (int i = 0; i < n_low; i++) { if (i > 0) json += ","; json += StringFormat("%.2f", pivots_low[i]); }
   json += "],\"pivots_high_m15\":[";
   for (int i = 0; i < n_high_m15; i++) { if (i > 0) json += ","; json += StringFormat("%.2f", pivots_high_m15[i]); }
   json += "],\"pivots_low_m15\":[";
   for (int i = 0; i < n_low_m15; i++) { if (i > 0) json += ","; json += StringFormat("%.2f", pivots_low_m15[i]); }
   json += "],\"pivots_high_h1\":[";
   for (int i = 0; i < n_high_h1; i++) { if (i > 0) json += ","; json += StringFormat("%.2f", pivots_high_h1[i]); }
   json += "],\"pivots_low_h1\":[";
   for (int i = 0; i < n_low_h1; i++) { if (i > 0) json += ","; json += StringFormat("%.2f", pivots_low_h1[i]); }
   json += "],";
   
   json += StringFormat("\"account\":\"%I64d\"", AccountInfoInteger(ACCOUNT_LOGIN));
   json += "}";
   
   SendToServer(json, "/api/market");
   
   if (Verbose) {
      Print(StringFormat("📊 %.2f | RSI %.0f/%.0f/%.0f/%.0f | PDH=%.2f PDL=%.2f | Sweep=%s/%s BOS=%s/%s | JW=%s/%s | Maru=%s/%s Rev=%s/%s",
            mid, rsi_m1, rsi_m5, rsi_m15, rsi_h1, pdh, pdl,
            sweep_high ? "Y" : "N", sweep_low ? "Y" : "N",
            bos_bullish ? "Y" : "N", bos_bearish ? "Y" : "N",
            john_wick_bull ? "Y" : "N", john_wick_bear ? "Y" : "N",
            marubozu_bull ? "Y" : "N", marubozu_bear ? "Y" : "N",
            marubozu_reversal_bull ? "Y" : "N", marubozu_reversal_bear ? "Y" : "N"));
   }
}

//+------------------------------------------------------------------+
//| Get ATR                                                           |
//+------------------------------------------------------------------+
double GetATR(string symbol, ENUM_TIMEFRAMES tf, int period) {
   int handle = iATR(symbol, tf, period);
   if (handle == INVALID_HANDLE) return 0;
   double buf[];
   ArraySetAsSeries(buf, true);
   int copied = CopyBuffer(handle, 0, 0, 1, buf);
   IndicatorRelease(handle);
   if (copied <= 0) return 0;
   return buf[0];
}

//+------------------------------------------------------------------+
//| Get RSI value for given timeframe and shift                      |
//+------------------------------------------------------------------+
double GetRSI(string symbol, ENUM_TIMEFRAMES tf, int period, int shift) {
   int handle = iRSI(symbol, tf, period, PRICE_CLOSE);
   if (handle == INVALID_HANDLE) return 0;
   double buf[];
   ArraySetAsSeries(buf, true);
   int copied = CopyBuffer(handle, 0, shift, 1, buf);
   IndicatorRelease(handle);
   if (copied <= 0) return 0;
   return buf[0];
}

//+------------------------------------------------------------------+
//| Get EMA value                                                     |
//+------------------------------------------------------------------+
double GetEMA(string symbol, ENUM_TIMEFRAMES tf, int period, int shift) {
   int handle = iMA(symbol, tf, period, 0, MODE_EMA, PRICE_CLOSE);
   if (handle == INVALID_HANDLE) return 0;
   double buf[];
   ArraySetAsSeries(buf, true);
   int copied = CopyBuffer(handle, 0, shift, 1, buf);
   IndicatorRelease(handle);
   if (copied <= 0) return 0;
   return buf[0];
}

//+------------------------------------------------------------------+
//| Find recent swing highs and lows (for double top/bottom)         |
//+------------------------------------------------------------------+
void FindPivots(string symbol, ENUM_TIMEFRAMES tf, int bars, double &highs[], int &n_high, double &lows[], int &n_low) {
   n_high = 0;
   n_low = 0;
   int left_right = 3;  // 3 bars left + 3 bars right = pivot
   
   for (int i = left_right + 1; i < bars - left_right && n_high < 5 && n_low < 5; i++) {
      double h = iHigh(symbol, tf, i);
      double l = iLow(symbol, tf, i);
      bool is_swing_high = true;
      bool is_swing_low = true;
      
      for (int j = 1; j <= left_right; j++) {
         if (iHigh(symbol, tf, i - j) > h || iHigh(symbol, tf, i + j) > h) is_swing_high = false;
         if (iLow(symbol, tf, i - j) < l || iLow(symbol, tf, i + j) < l) is_swing_low = false;
      }
      
      if (is_swing_high && n_high < 5) {
         highs[n_high++] = h;
      }
      if (is_swing_low && n_low < 5) {
         lows[n_low++] = l;
      }
   }
}

//+------------------------------------------------------------------+
//| Send live price (lightweight, every 3s)                          |
//+------------------------------------------------------------------+
void SendPrice() {
   if (gold_symbol == "") return;
   MqlTick tick;
   if (!SymbolInfoTick(gold_symbol, tick)) return;
   
   string json = StringFormat(
      "{\"event\":\"price\",\"symbol\":\"%s\",\"bid\":%.2f,\"ask\":%.2f,\"mid\":%.2f,\"account\":\"%I64d\"}",
      gold_symbol, tick.bid, tick.ask, (tick.bid + tick.ask) / 2.0,
      AccountInfoInteger(ACCOUNT_LOGIN)
   );
   SendToServer(json, "/api/price");
}

//+------------------------------------------------------------------+
//| Trade observation (unchanged from v3)                             |
//+------------------------------------------------------------------+
void ScanPositions() {
   int total = PositionsTotal();
   for (int i = 0; i < total; i++) {
      ulong ticket = PositionGetTicket(i);
      if (ticket == 0 || IsTracked(ticket)) continue;
      if (PositionSelectByTicket(ticket)) {
         string symbol = PositionGetString(POSITION_SYMBOL);
         double volume = PositionGetDouble(POSITION_VOLUME);
         double price_open = PositionGetDouble(POSITION_PRICE_OPEN);
         double sl = PositionGetDouble(POSITION_SL);
         double tp = PositionGetDouble(POSITION_TP);
         long type = PositionGetInteger(POSITION_TYPE);
         datetime time_open = (datetime)PositionGetInteger(POSITION_TIME);
         string direction = (type == POSITION_TYPE_BUY) ? "BUY" : "SELL";
         double sl_pts = (sl > 0) ? MathAbs(price_open - sl) : 0;
         double tp_pts = (tp > 0) ? MathAbs(tp - price_open) : 0;
         
         string json = StringFormat(
            "{\"event\":\"new_trade\",\"ticket\":%I64u,\"symbol\":\"%s\",\"direction\":\"%s\","
            "\"volume\":%.2f,\"entry\":%.2f,\"sl\":%.2f,\"tp\":%.2f,"
            "\"sl_pts\":%.2f,\"tp_pts\":%.2f,\"time\":\"%s\",\"account\":\"%I64d\"}",
            ticket, symbol, direction, volume, price_open, sl, tp,
            sl_pts, tp_pts, TimeToString(time_open, TIME_DATE|TIME_SECONDS),
            AccountInfoInteger(ACCOUNT_LOGIN)
         );
         SendToServer(json, "/api/trade/new");
         AddTracked(ticket);
      }
   }
}

void CheckClosedTrades() {
   datetime from = TimeCurrent() - 3600;
   HistorySelect(from, TimeCurrent());
   int total = HistoryDealsTotal();
   for (int i = total - 1; i >= 0; i--) {
      ulong deal_ticket = HistoryDealGetTicket(i);
      if (deal_ticket == 0) continue;
      long entry = HistoryDealGetInteger(deal_ticket, DEAL_ENTRY);
      if (entry != DEAL_ENTRY_OUT) continue;
      ulong position_id = HistoryDealGetInteger(deal_ticket, DEAL_POSITION_ID);
      if (!IsTracked(position_id) || IsClosedNotified(position_id)) continue;
      
      string symbol = HistoryDealGetString(deal_ticket, DEAL_SYMBOL);
      double volume = HistoryDealGetDouble(deal_ticket, DEAL_VOLUME);
      double price_close = HistoryDealGetDouble(deal_ticket, DEAL_PRICE);
      double profit = HistoryDealGetDouble(deal_ticket, DEAL_PROFIT);
      double commission = HistoryDealGetDouble(deal_ticket, DEAL_COMMISSION);
      double swap = HistoryDealGetDouble(deal_ticket, DEAL_SWAP);
      datetime time_close = (datetime)HistoryDealGetInteger(deal_ticket, DEAL_TIME);
      double net_profit = profit + commission + swap;
      
      string json = StringFormat(
         "{\"event\":\"closed_trade\",\"ticket\":%I64u,\"symbol\":\"%s\","
         "\"volume\":%.2f,\"price_close\":%.2f,\"profit\":%.2f,\"commission\":%.2f,"
         "\"swap\":%.2f,\"net_profit\":%.2f,\"time\":\"%s\",\"account\":\"%I64d\"}",
         position_id, symbol, volume, price_close, profit, commission, swap,
         net_profit, TimeToString(time_close, TIME_DATE|TIME_SECONDS),
         AccountInfoInteger(ACCOUNT_LOGIN)
      );
      SendToServer(json, "/api/trade/close");
      MarkClosedNotified(position_id);
   }
}

void SendPing() {
   string json = StringFormat(
      "{\"event\":\"ping\",\"account\":\"%I64d\",\"broker\":\"%s\",\"balance\":%.2f,\"equity\":%.2f,\"leverage\":%I64d}",
      AccountInfoInteger(ACCOUNT_LOGIN),
      AccountInfoString(ACCOUNT_COMPANY),
      AccountInfoDouble(ACCOUNT_BALANCE),
      AccountInfoDouble(ACCOUNT_EQUITY),
      AccountInfoInteger(ACCOUNT_LEVERAGE)
   );
   SendToServer(json, "/api/trade/ping");
}

void SendToServer(string json_payload, string endpoint) {
   string url = ServerURL + endpoint;
   char post[], result[];
   string headers_out = "";
   string headers_in = "Content-Type: application/json\r\nX-Auth-Token: " + AuthToken + "\r\n";
   StringToCharArray(json_payload, post, 0, StringLen(json_payload));
   int timeout = 5000;
   int res = WebRequest("POST", url, headers_in, timeout, post, result, headers_out);
   if (res == -1 && Verbose) {
      Print("WebRequest error ", GetLastError());
   }
}

bool IsTracked(ulong ticket) {
   for (int i = 0; i < ArraySize(tracked_tickets); i++) {
      if (tracked_tickets[i] == ticket) return true;
   }
   return false;
}
void AddTracked(ulong ticket) {
   int size = ArraySize(tracked_tickets);
   ArrayResize(tracked_tickets, size + 1);
   tracked_tickets[size] = ticket;
}
bool IsClosedNotified(ulong ticket) {
   int count = 0;
   for (int i = 0; i < ArraySize(tracked_tickets); i++) {
      if (tracked_tickets[i] == ticket) count++;
   }
   return count >= 2;
}
void MarkClosedNotified(ulong ticket) {
   int size = ArraySize(tracked_tickets);
   ArrayResize(tracked_tickets, size + 1);
   tracked_tickets[size] = ticket;
}

void OnTick() {}
