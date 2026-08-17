// Technical Analysis Engine - Enhanced v2
// Calculates RSI, MACD, SMA, EMA, Bollinger Bands, Stochastic, ADX
// + Fibonacci, VWAP, OBV, Ichimoku Cloud, MA Ribbon
// Detects Support/Resistance, Price Patterns (enhanced)
// Generates short-term buy/sell signals with risk assessment & market context

import type { StockBar } from '../api/stockApi';

export interface TechnicalSignal {
  ticker: string;
  signal: 'BUY' | 'SELL' | 'HOLD';
  strength: number; // 0-100
  reasons: string[];
  metrics: Record<string, number>;
  risk: 'LOW' | 'MEDIUM' | 'HIGH';
  supportLevel: number;
  resistanceLevel: number;
  targetPrice: number;
  stopLoss: number;
  pattern: string;
  fibLevels: FibonacciLevels;
  tradeType: 'SWING' | 'POSITION' | 'SCALP';
  entryZone: { low: number; high: number };
  riskRewardRatio: number;
  confidence: number; // 0-100
  trendStrength: 'STRONG' | 'MODERATE' | 'WEAK';
  volumeProfile: 'ACCUMULATION' | 'DISTRIBUTION' | 'NEUTRAL';
}

// ===========================
// Core Indicators
// ===========================

export function calculateSMA(prices: number[], period: number): number[] {
  const sma: number[] = [];
  for (let i = 0; i < prices.length; i++) {
    if (i < period - 1) {
      sma.push(NaN);
    } else {
      const sum = prices.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
      sma.push(sum / period);
    }
  }
  return sma;
}

export function calculateEMA(prices: number[], period: number): number[] {
  const ema: number[] = [];
  const multiplier = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < Math.min(period, prices.length); i++) {
    sum += prices[i];
  }
  for (let i = 0; i < prices.length; i++) {
    if (i < period - 1) {
      ema.push(NaN);
    } else if (i === period - 1) {
      ema.push(sum / period);
    } else {
      ema.push((prices[i] - ema[i - 1]) * multiplier + ema[i - 1]);
    }
  }
  return ema;
}

export function calculateRSI(prices: number[], period: number = 14): number[] {
  const rsi: number[] = [];
  const gains: number[] = [];
  const losses: number[] = [];

  for (let i = 1; i < prices.length; i++) {
    const change = prices[i] - prices[i - 1];
    gains.push(change > 0 ? change : 0);
    losses.push(change < 0 ? -change : 0);
  }

  rsi.push(NaN);
  if (gains.length < period) return prices.map(() => NaN);

  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = 0; i < gains.length; i++) {
    if (i < period - 1) {
      rsi.push(NaN);
    } else if (i === period - 1) {
      const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
      rsi.push(100 - 100 / (1 + rs));
    } else {
      avgGain = (avgGain * (period - 1) + gains[i]) / period;
      avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
      const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
      rsi.push(100 - 100 / (1 + rs));
    }
  }
  return rsi;
}

interface MACD {
  macdLine: number[];
  signalLine: number[];
  histogram: number[];
}

export function calculateMACD(prices: number[], fast = 12, slow = 26, signal = 9): MACD {
  const emaFast = calculateEMA(prices, fast);
  const emaSlow = calculateEMA(prices, slow);

  const macdLine = emaFast.map((f, i) => {
    if (isNaN(f) || isNaN(emaSlow[i])) return NaN;
    return f - emaSlow[i];
  });

  const validMacd = macdLine.filter(v => !isNaN(v));
  const signalEma = calculateEMA(validMacd, signal);

  const signalLine: number[] = [];
  let signalIdx = 0;
  for (let i = 0; i < macdLine.length; i++) {
    if (isNaN(macdLine[i])) {
      signalLine.push(NaN);
    } else {
      signalLine.push(signalIdx < signalEma.length ? signalEma[signalIdx] : NaN);
      signalIdx++;
    }
  }

  const histogram = macdLine.map((m, i) => {
    if (isNaN(m) || isNaN(signalLine[i])) return NaN;
    return m - signalLine[i];
  });

  return { macdLine, signalLine, histogram };
}

export function calculateBollingerBands(prices: number[], period = 20, stdDev = 2) {
  const sma = calculateSMA(prices, period);
  const upper: number[] = [];
  const lower: number[] = [];

  for (let i = 0; i < prices.length; i++) {
    if (isNaN(sma[i])) {
      upper.push(NaN);
      lower.push(NaN);
    } else {
      const slice = prices.slice(i - period + 1, i + 1);
      const mean = sma[i];
      const variance = slice.reduce((sum, p) => sum + (p - mean) ** 2, 0) / period;
      const sd = Math.sqrt(variance);
      upper.push(mean + stdDev * sd);
      lower.push(mean - stdDev * sd);
    }
  }
  return { middle: sma, upper, lower };
}

// ===========================
// New Indicators
// ===========================

export function calculateStochastic(highs: number[], lows: number[], closes: number[], kPeriod = 14, dPeriod = 3) {
  const kValues: number[] = [];

  for (let i = 0; i < closes.length; i++) {
    if (i < kPeriod - 1) {
      kValues.push(NaN);
    } else {
      const highSlice = highs.slice(i - kPeriod + 1, i + 1);
      const lowSlice = lows.slice(i - kPeriod + 1, i + 1);
      const highestHigh = Math.max(...highSlice);
      const lowestLow = Math.min(...lowSlice);
      const k = highestHigh === lowestLow ? 50 : ((closes[i] - lowestLow) / (highestHigh - lowestLow)) * 100;
      kValues.push(k);
    }
  }

  const dValues = calculateSMA(kValues.filter(v => !isNaN(v)), dPeriod);
  const dFull: number[] = [];
  let dIdx = 0;
  for (let i = 0; i < kValues.length; i++) {
    if (isNaN(kValues[i])) {
      dFull.push(NaN);
    } else {
      dFull.push(dIdx < dValues.length ? dValues[dIdx] : NaN);
      dIdx++;
    }
  }

  return { k: kValues, d: dFull };
}

export function calculateATR(highs: number[], lows: number[], closes: number[], period = 14): number[] {
  const tr: number[] = [highs[0] - lows[0]];

  for (let i = 1; i < closes.length; i++) {
    const hl = highs[i] - lows[i];
    const hc = Math.abs(highs[i] - closes[i - 1]);
    const lc = Math.abs(lows[i] - closes[i - 1]);
    tr.push(Math.max(hl, hc, lc));
  }

  const atr: number[] = [];
  for (let i = 0; i < tr.length; i++) {
    if (i < period - 1) {
      atr.push(NaN);
    } else if (i === period - 1) {
      atr.push(tr.slice(0, period).reduce((a, b) => a + b, 0) / period);
    } else {
      atr.push((atr[i - 1] * (period - 1) + tr[i]) / period);
    }
  }
  return atr;
}

export function calculateADX(highs: number[], lows: number[], closes: number[], period = 14): number[] {
  const plusDM: number[] = [];
  const minusDM: number[] = [];

  for (let i = 1; i < highs.length; i++) {
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  const atr = calculateATR(highs, lows, closes, period);
  const smoothPlusDM = calculateEMA(plusDM, period);
  const smoothMinusDM = calculateEMA(minusDM, period);

  const dx: number[] = [NaN];
  for (let i = 0; i < smoothPlusDM.length; i++) {
    if (isNaN(smoothPlusDM[i]) || isNaN(smoothMinusDM[i]) || isNaN(atr[i + 1]) || atr[i + 1] === 0) {
      dx.push(NaN);
    } else {
      const plusDI = (smoothPlusDM[i] / atr[i + 1]) * 100;
      const minusDI = (smoothMinusDM[i] / atr[i + 1]) * 100;
      const diSum = plusDI + minusDI;
      dx.push(diSum === 0 ? 0 : (Math.abs(plusDI - minusDI) / diSum) * 100);
    }
  }

  return calculateEMA(dx.filter(v => !isNaN(v)), period);
}

// ===========================
// Fibonacci Retracement
// ===========================

export interface FibonacciLevels {
  high: number;
  low: number;
  level236: number;
  level382: number;
  level500: number;
  level618: number;
  level786: number;
  trend: 'UP' | 'DOWN';
}

export function calculateFibonacciLevels(bars: StockBar[], lookback = 50): FibonacciLevels {
  const recent = bars.slice(-lookback);
  const highs = recent.map(b => b.high);
  const lows = recent.map(b => b.low);
  const highestHigh = Math.max(...highs);
  const lowestLow = Math.min(...lows);
  const highIdx = highs.indexOf(highestHigh);
  const lowIdx = lows.indexOf(lowestLow);

  // Determine trend: if high came before low, it's a downtrend (use retracement up)
  const isUptrend = lowIdx < highIdx;
  const diff = highestHigh - lowestLow;

  if (isUptrend) {
    return {
      high: highestHigh, low: lowestLow, trend: 'UP',
      level236: highestHigh - diff * 0.236,
      level382: highestHigh - diff * 0.382,
      level500: highestHigh - diff * 0.5,
      level618: highestHigh - diff * 0.618,
      level786: highestHigh - diff * 0.786,
    };
  } else {
    return {
      high: highestHigh, low: lowestLow, trend: 'DOWN',
      level236: lowestLow + diff * 0.236,
      level382: lowestLow + diff * 0.382,
      level500: lowestLow + diff * 0.5,
      level618: lowestLow + diff * 0.618,
      level786: lowestLow + diff * 0.786,
    };
  }
}

// ===========================
// VWAP (Volume Weighted Average Price)
// ===========================

export function calculateVWAP(bars: StockBar[]): number[] {
  const vwap: number[] = [];
  let cumulativeTPV = 0;
  let cumulativeVolume = 0;

  for (let i = 0; i < bars.length; i++) {
    const typicalPrice = (bars[i].high + bars[i].low + bars[i].close) / 3;
    cumulativeTPV += typicalPrice * bars[i].volume;
    cumulativeVolume += bars[i].volume;
    vwap.push(cumulativeVolume > 0 ? cumulativeTPV / cumulativeVolume : typicalPrice);
  }
  return vwap;
}

// ===========================
// OBV (On Balance Volume)
// ===========================

export function calculateOBV(bars: StockBar[]): number[] {
  const obv: number[] = [0];
  for (let i = 1; i < bars.length; i++) {
    if (bars[i].close > bars[i - 1].close) {
      obv.push(obv[i - 1] + bars[i].volume);
    } else if (bars[i].close < bars[i - 1].close) {
      obv.push(obv[i - 1] - bars[i].volume);
    } else {
      obv.push(obv[i - 1]);
    }
  }
  return obv;
}

export function detectOBVDivergence(closes: number[], obv: number[], lookback = 14): 'BULLISH_DIV' | 'BEARISH_DIV' | 'NONE' {
  if (closes.length < lookback) return 'NONE';
  const recentCloses = closes.slice(-lookback);
  const recentOBV = obv.slice(-lookback);

  const priceSlope = (recentCloses[recentCloses.length - 1] - recentCloses[0]) / recentCloses[0];
  const obvSlope = recentOBV[recentOBV.length - 1] - recentOBV[0];

  // Price falling but OBV rising = bullish divergence
  if (priceSlope < -0.02 && obvSlope > 0) return 'BULLISH_DIV';
  // Price rising but OBV falling = bearish divergence
  if (priceSlope > 0.02 && obvSlope < 0) return 'BEARISH_DIV';
  return 'NONE';
}

// ===========================
// Ichimoku Cloud
// ===========================

export interface IchimokuResult {
  tenkanSen: number[];  // Conversion Line (9)
  kijunSen: number[];   // Base Line (26)
  senkouSpanA: number[];// Leading Span A
  senkouSpanB: number[];// Leading Span B
  chikouSpan: number[]; // Lagging Span
}

function highLowMid(highs: number[], lows: number[], start: number, end: number): number {
  const h = highs.slice(start, end);
  const l = lows.slice(start, end);
  if (h.length === 0) return NaN;
  return (Math.max(...h) + Math.min(...l)) / 2;
}

export function calculateIchimoku(bars: StockBar[], tenkanPeriod = 9, kijunPeriod = 26, senkouBPeriod = 52): IchimokuResult {
  const highs = bars.map(b => b.high);
  const lows = bars.map(b => b.low);
  const n = bars.length;

  const tenkanSen: number[] = [];
  const kijunSen: number[] = [];
  const senkouSpanA: number[] = [];
  const senkouSpanB: number[] = [];
  const chikouSpan: number[] = [];

  for (let i = 0; i < n; i++) {
    // Tenkan-sen
    if (i >= tenkanPeriod - 1) {
      tenkanSen.push(highLowMid(highs, lows, i - tenkanPeriod + 1, i + 1));
    } else {
      tenkanSen.push(NaN);
    }

    // Kijun-sen
    if (i >= kijunPeriod - 1) {
      kijunSen.push(highLowMid(highs, lows, i - kijunPeriod + 1, i + 1));
    } else {
      kijunSen.push(NaN);
    }

    // Senkou Span A = (Tenkan + Kijun) / 2, projected 26 ahead
    const tsVal = tenkanSen[i];
    const ksVal = kijunSen[i];
    senkouSpanA.push(!isNaN(tsVal) && !isNaN(ksVal) ? (tsVal + ksVal) / 2 : NaN);

    // Senkou Span B = highest high + lowest low / 2 over 52 periods, projected 26 ahead
    if (i >= senkouBPeriod - 1) {
      senkouSpanB.push(highLowMid(highs, lows, i - senkouBPeriod + 1, i + 1));
    } else {
      senkouSpanB.push(NaN);
    }

    // Chikou Span = current close plotted 26 bars back
    chikouSpan.push(bars[i].close);
  }

  return { tenkanSen, kijunSen, senkouSpanA, senkouSpanB, chikouSpan };
}

export function analyzeIchimoku(bars: StockBar[]): { signal: number; reasons: string[] } {
  if (bars.length < 52) return { signal: 0, reasons: [] };

  const ich = calculateIchimoku(bars);
  const lastIdx = bars.length - 1;
  const price = bars[lastIdx].close;
  const tenkan = ich.tenkanSen[lastIdx];
  const kijun = ich.kijunSen[lastIdx];
  // Use current values as cloud (in practical terms, cloud is projected forward)
  const spanA = ich.senkouSpanA[lastIdx];
  const spanB = ich.senkouSpanB[lastIdx];

  let signal = 0;
  const reasons: string[] = [];

  if (isNaN(tenkan) || isNaN(kijun) || isNaN(spanA) || isNaN(spanB)) {
    return { signal: 0, reasons: [] };
  }

  const cloudTop = Math.max(spanA, spanB);
  const cloudBottom = Math.min(spanA, spanB);

  // Price above cloud = bullish
  if (price > cloudTop) {
    signal += 15;
    reasons.push('Giá trên mây Ichimoku (Bullish)');
  } else if (price < cloudBottom) {
    signal -= 15;
    reasons.push('Giá dưới mây Ichimoku (Bearish)');
  } else {
    reasons.push('Giá trong mây Ichimoku (Chưa rõ xu hướng)');
  }

  // Tenkan cross Kijun
  if (tenkan > kijun) {
    signal += 10;
    reasons.push('Tenkan-sen > Kijun-sen (Tín hiệu tăng)');
  } else if (tenkan < kijun) {
    signal -= 10;
    reasons.push('Tenkan-sen < Kijun-sen (Tín hiệu giảm)');
  }

  // Cloud color (future trend)
  if (spanA > spanB) {
    signal += 5;
  } else {
    signal -= 5;
  }

  return { signal, reasons };
}

// ===========================
// Moving Average Ribbon (EMA 8/13/21/34/55)
// ===========================

export function calculateMARibbon(prices: number[]): { emas: number[][]; aligned: 'BULLISH' | 'BEARISH' | 'MIXED'; strength: number } {
  const periods = [8, 13, 21, 34, 55];
  const emas = periods.map(p => calculateEMA(prices, p));
  const lastValues = emas.map(e => e[e.length - 1]);

  if (lastValues.some(v => isNaN(v))) {
    return { emas, aligned: 'MIXED', strength: 0 };
  }

  // Check if all EMAs are in order (8 > 13 > 21 > 34 > 55 = bullish)
  let bullishCount = 0;
  let bearishCount = 0;
  for (let i = 0; i < lastValues.length - 1; i++) {
    if (lastValues[i] > lastValues[i + 1]) bullishCount++;
    else bearishCount++;
  }

  const totalPairs = periods.length - 1;
  let aligned: 'BULLISH' | 'BEARISH' | 'MIXED';
  let strength: number;

  if (bullishCount === totalPairs) {
    aligned = 'BULLISH';
    strength = 100;
  } else if (bearishCount === totalPairs) {
    aligned = 'BEARISH';
    strength = 100;
  } else {
    aligned = 'MIXED';
    strength = Math.round(Math.max(bullishCount, bearishCount) / totalPairs * 100);
  }

  // Measure ribbon spread (wider = stronger trend)
  const spread = Math.abs(lastValues[0] - lastValues[lastValues.length - 1]) / lastValues[lastValues.length - 1] * 100;
  if (spread > 5) strength = Math.min(100, strength + 20);
  else if (spread < 1) strength = Math.max(0, strength - 20);

  return { emas, aligned, strength };
}

// ===========================
// Support & Resistance Detection
// ===========================

export function detectSupportResistance(bars: StockBar[], lookback = 20): { support: number; resistance: number; } {
  if (bars.length < lookback) {
    const last = bars[bars.length - 1];
    return { support: last.low, resistance: last.high };
  }

  const recent = bars.slice(-lookback);
  const lows = recent.map(b => b.low);
  const highs = recent.map(b => b.high);

  // Find swing lows (support) and swing highs (resistance)
  const swingLows: number[] = [];
  const swingHighs: number[] = [];

  for (let i = 2; i < recent.length - 2; i++) {
    if (lows[i] <= lows[i - 1] && lows[i] <= lows[i - 2] &&
      lows[i] <= lows[i + 1] && lows[i] <= lows[i + 2]) {
      swingLows.push(lows[i]);
    }
    if (highs[i] >= highs[i - 1] && highs[i] >= highs[i - 2] &&
      highs[i] >= highs[i + 1] && highs[i] >= highs[i + 2]) {
      swingHighs.push(highs[i]);
    }
  }

  const lastClose = bars[bars.length - 1].close;

  // Find nearest support below price
  const supports = swingLows.filter(l => l < lastClose).sort((a, b) => b - a);
  const support = supports.length > 0 ? supports[0] : Math.min(...lows);

  // Find nearest resistance above price
  const resistances = swingHighs.filter(h => h > lastClose).sort((a, b) => a - b);
  const resistance = resistances.length > 0 ? resistances[0] : Math.max(...highs);

  return { support, resistance };
}

// ===========================
// Pattern Detection
// ===========================

export function detectPattern(bars: StockBar[]): string {
  if (bars.length < 20) return 'Không đủ dữ liệu';

  const closes = bars.map(b => b.close);
  const recent = closes.slice(-20);

  // Higher Highs + Higher Lows
  const highs = bars.slice(-10).map(b => b.high);
  const lows = bars.slice(-10).map(b => b.low);

  let higherHighs = 0;
  let higherLows = 0;
  let lowerHighs = 0;
  let lowerLows = 0;

  for (let i = 1; i < highs.length; i++) {
    if (highs[i] > highs[i - 1]) higherHighs++;
    if (lows[i] > lows[i - 1]) higherLows++;
    if (highs[i] < highs[i - 1]) lowerHighs++;
    if (lows[i] < lows[i - 1]) lowerLows++;
  }

  if (higherHighs >= 5 && higherLows >= 4) return '📈 Uptrend (Higher Highs)';
  if (lowerHighs >= 5 && lowerLows >= 4) return '📉 Downtrend (Lower Lows)';

  // Double Bottom detection
  const mid = Math.floor(recent.length / 2);
  const firstHalf = recent.slice(0, mid);
  const secondHalf = recent.slice(mid);
  const firstMin = Math.min(...firstHalf);
  const secondMin = Math.min(...secondHalf);
  const midMax = Math.max(...recent.slice(mid - 3, mid + 3));

  if (Math.abs(firstMin - secondMin) / firstMin < 0.03 && midMax > firstMin * 1.03) {
    return '🔵 Double Bottom (Đáy kép - Tín hiệu đảo chiều tăng)';
  }

  // Double Top detection
  const firstMax = Math.max(...firstHalf);
  const secondMax = Math.max(...secondHalf);
  const midMin = Math.min(...recent.slice(mid - 3, mid + 3));

  if (Math.abs(firstMax - secondMax) / firstMax < 0.03 && midMin < firstMax * 0.97) {
    return '🔴 Double Top (Đỉnh kép - Tín hiệu đảo chiều giảm)';
  }

  // Head & Shoulders detection (5 segments)
  if (bars.length >= 30) {
    const seg5 = bars.slice(-30);
    const segLen = 6;
    const segments = [];
    for (let i = 0; i < 5; i++) {
      const slice = seg5.slice(i * segLen, (i + 1) * segLen);
      segments.push({
        high: Math.max(...slice.map(b => b.high)),
        low: Math.min(...slice.map(b => b.low)),
      });
    }
    // H&S: segments 0,4 are shoulders (similar highs), segment 2 is head (higher)
    const leftShoulder = segments[0].high;
    const head = segments[2].high;
    const rightShoulder = segments[4].high;
    const shoulderDiff = Math.abs(leftShoulder - rightShoulder) / leftShoulder;

    if (shoulderDiff < 0.05 && head > leftShoulder * 1.02 && head > rightShoulder * 1.02) {
      return '🔴 Head & Shoulders (Vai-Đầu-Vai - Tín hiệu giảm mạnh)';
    }
    // Inverse H&S
    const leftTrough = segments[0].low;
    const headTrough = segments[2].low;
    const rightTrough = segments[4].low;
    const troughDiff = Math.abs(leftTrough - rightTrough) / leftTrough;

    if (troughDiff < 0.05 && headTrough < leftTrough * 0.98 && headTrough < rightTrough * 0.98) {
      return '🟢 Inverse H&S (Vai-Đầu-Vai ngược - Tín hiệu tăng mạnh)';
    }
  }

  // Triangle detection (converging highs and lows)
  if (bars.length >= 20) {
    const r20 = bars.slice(-20);
    const h20 = r20.map(b => b.high);
    const l20 = r20.map(b => b.low);
    const firstRange = h20[0] - l20[0];
    const lastRange = h20[h20.length - 1] - l20[l20.length - 1];

    if (lastRange < firstRange * 0.6) {
      // Ascending triangle: flat resistance, rising lows
      const flatHighs = h20.slice(-5).every((h, i, arr) => i === 0 || Math.abs(h - arr[0]) / arr[0] < 0.02);
      if (flatHighs && lows[lows.length - 1] > lows[0]) {
        return '🟢 Ascending Triangle (Tam giác tăng - Breakout tăng)';
      }
      // Descending triangle: flat support, falling highs
      const flatLows = l20.slice(-5).every((l, i, arr) => i === 0 || Math.abs(l - arr[0]) / arr[0] < 0.02);
      if (flatLows && highs[highs.length - 1] < highs[0]) {
        return '🔴 Descending Triangle (Tam giác giảm - Breakout giảm)';
      }
      return '🟡 Symmetrical Triangle (Tam giác cân - Chờ breakout)';
    }
  }

  // Flag/Pennant after strong move
  if (bars.length >= 15) {
    const pre = bars.slice(-15, -5);
    const flag = bars.slice(-5);
    const preMove = (pre[pre.length - 1].close - pre[0].close) / pre[0].close;
    const flagRange = (Math.max(...flag.map(b => b.high)) - Math.min(...flag.map(b => b.low))) / flag[0].close;

    if (Math.abs(preMove) > 0.05 && flagRange < 0.03) {
      if (preMove > 0) return '🟢 Bull Flag (Cờ tăng - Tiếp tục tăng)';
      return '🔴 Bear Flag (Cờ giảm - Tiếp tục giảm)';
    }
  }

  // Consolidation
  const range = (Math.max(...recent) - Math.min(...recent)) / Math.min(...recent);
  if (range < 0.05) return '🟡 Sideway (Tích lũy - Chờ breakout)';

  return '➡️ Trung tính';
}

// ===========================
// Main Analysis Function (Enhanced)
// ===========================

export function analyzeShortTerm(ticker: string, bars: StockBar[], foreignNetRatio?: number): TechnicalSignal {
  if (bars.length < 30) {
    return {
      ticker, signal: 'HOLD', strength: 50,
      reasons: ['Không đủ dữ liệu phân tích'], metrics: {},
      risk: 'MEDIUM', supportLevel: 0, resistanceLevel: 0,
      targetPrice: 0, stopLoss: 0, pattern: '',
      fibLevels: { level236: 0, level382: 0, level500: 0, level618: 0, level786: 0, high: 0, low: 0, trend: 'UP' as const },
      tradeType: 'SWING', entryZone: { low: 0, high: 0 },
      riskRewardRatio: 0, confidence: 0,
      trendStrength: 'WEAK', volumeProfile: 'NEUTRAL',
    };
  }

  const closes = bars.map(b => b.close);
  const highs = bars.map(b => b.high);
  const lows = bars.map(b => b.low);
  const volumes = bars.map(b => b.volume);
  const lastPrice = closes[closes.length - 1];

  let score = 0;
  const reasons: string[] = [];
  const metrics: Record<string, number> = {};

  // RSI
  const rsi = calculateRSI(closes);
  const lastRSI = rsi[rsi.length - 1];
  metrics['RSI'] = Math.round(lastRSI * 10) / 10;
  if (lastRSI < 30) {
    score += 25;
    reasons.push(`RSI = ${metrics['RSI']} (Quá bán - Tín hiệu mua)`);
  } else if (lastRSI > 70) {
    score -= 25;
    reasons.push(`RSI = ${metrics['RSI']} (Quá mua - Tín hiệu bán)`);
  } else if (lastRSI < 45) {
    score += 10;
    reasons.push(`RSI = ${metrics['RSI']} (Vùng tích lũy)`);
  }

  // MACD
  const macd = calculateMACD(closes);
  const lastMACD = macd.macdLine[macd.macdLine.length - 1];
  const lastSignal = macd.signalLine[macd.signalLine.length - 1];
  const lastHist = macd.histogram[macd.histogram.length - 1];
  const prevHist = macd.histogram[macd.histogram.length - 2];

  if (!isNaN(lastMACD) && !isNaN(lastSignal)) {
    metrics['MACD'] = Math.round(lastMACD * 100) / 100;
    if (lastMACD > lastSignal && prevHist <= 0 && lastHist > 0) {
      score += 30; reasons.push('MACD cắt lên Signal Line (Golden Cross)');
    } else if (lastMACD < lastSignal && prevHist >= 0 && lastHist < 0) {
      score -= 30; reasons.push('MACD cắt xuống Signal Line (Death Cross)');
    } else if (lastMACD > lastSignal) {
      score += 10; reasons.push('MACD trên Signal Line (Xu hướng tăng)');
    } else {
      score -= 10; reasons.push('MACD dưới Signal Line (Xu hướng giảm)');
    }
  }

  // SMA Cross
  const sma20 = calculateSMA(closes, 20);
  const sma50 = calculateSMA(closes, 50);
  const lastSMA20 = sma20[sma20.length - 1];
  const lastSMA50 = sma50[sma50.length - 1];

  if (!isNaN(lastSMA20) && !isNaN(lastSMA50)) {
    if (lastPrice > lastSMA20 && lastSMA20 > lastSMA50) {
      score += 15; reasons.push('Giá trên SMA20 > SMA50 (Uptrend)');
    } else if (lastPrice < lastSMA20 && lastSMA20 < lastSMA50) {
      score -= 15; reasons.push('Giá dưới SMA20 < SMA50 (Downtrend)');
    }
  }

  // Bollinger Bands
  const bb = calculateBollingerBands(closes);
  const lastUpper = bb.upper[bb.upper.length - 1];
  const lastLower = bb.lower[bb.lower.length - 1];

  if (!isNaN(lastUpper) && !isNaN(lastLower)) {
    if (lastPrice <= lastLower) {
      score += 15; reasons.push('Giá chạm BB dưới (Hỗ trợ mạnh)');
    } else if (lastPrice >= lastUpper) {
      score -= 15; reasons.push('Giá chạm BB trên (Kháng cự mạnh)');
    }
  }

  // Stochastic
  const stoch = calculateStochastic(highs, lows, closes);
  const lastK = stoch.k[stoch.k.length - 1];
  const lastD = stoch.d[stoch.d.length - 1];
  if (!isNaN(lastK)) {
    metrics['Stoch %K'] = Math.round(lastK * 10) / 10;
    if (lastK < 20 && lastK > lastD) {
      score += 15; reasons.push(`Stochastic %K=${metrics['Stoch %K']} (Quá bán + tín hiệu đảo chiều)`);
    } else if (lastK > 80 && lastK < lastD) {
      score -= 15; reasons.push(`Stochastic %K=${metrics['Stoch %K']} (Quá mua + tín hiệu giảm)`);
    }
  }

  // ADX - Trend strength
  const adx = calculateADX(highs, lows, closes);
  const lastADX = adx.length > 0 ? adx[adx.length - 1] : NaN;
  if (!isNaN(lastADX)) {
    metrics['ADX'] = Math.round(lastADX * 10) / 10;
    if (lastADX > 25) {
      reasons.push(`ADX = ${metrics['ADX']} (Xu hướng mạnh)`);
    } else {
      reasons.push(`ADX = ${metrics['ADX']} (Xu hướng yếu/Sideway)`);
    }
  }

  // Volume
  const avgVolume = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const lastVolume = volumes[volumes.length - 1];
  const volumeRatio = lastVolume / avgVolume;
  metrics['Vol Ratio'] = Math.round(volumeRatio * 100) / 100;
  if (volumeRatio > 2) {
    if (closes[closes.length - 1] > closes[closes.length - 2]) {
      score += 20; reasons.push(`Volume đột biến (x${metrics['Vol Ratio']}) kèm giá tăng`);
    } else {
      score -= 10; reasons.push(`Volume đột biến (x${metrics['Vol Ratio']}) kèm giá giảm`);
    }
  }

  // Foreign net buy/sell as a % of today's traded volume (from VCI's live
  // price board). A real, independent signal - not derivable from price bars.
  if (typeof foreignNetRatio === 'number' && !isNaN(foreignNetRatio)) {
    const pct = Math.round(foreignNetRatio * 1000) / 10;
    metrics['KN Ròng %'] = pct;
    if (foreignNetRatio > 0.1) {
      score += 8; reasons.push(`Khối ngoại mua ròng mạnh (${pct}% KLGD)`);
    } else if (foreignNetRatio < -0.1) {
      score -= 8; reasons.push(`Khối ngoại bán ròng mạnh (${pct}% KLGD)`);
    }
  }

  // ======= NEW INDICATORS =======

  // Ichimoku Cloud
  const ichResult = analyzeIchimoku(bars);
  score += ichResult.signal;
  reasons.push(...ichResult.reasons);

  // OBV Divergence
  const obv = calculateOBV(bars);
  const obvDiv = detectOBVDivergence(closes, obv);
  if (obvDiv === 'BULLISH_DIV') {
    score += 15;
    reasons.push('OBV Bullish Divergence (Giá giảm nhưng dòng tiền tăng)');
  } else if (obvDiv === 'BEARISH_DIV') {
    score -= 15;
    reasons.push('OBV Bearish Divergence (Giá tăng nhưng dòng tiền giảm)');
  }

  // VWAP
  const vwap = calculateVWAP(bars);
  const lastVWAP = vwap[vwap.length - 1];
  if (!isNaN(lastVWAP)) {
    const vwapDiffPct = ((lastPrice - lastVWAP) / lastVWAP) * 100;
    metrics['VWAP'] = Math.round(lastVWAP * 100) / 100;
    if (lastPrice > lastVWAP) {
      score += 8;
      reasons.push(`Giá trên VWAP (${lastVWAP.toFixed(1)}) - Dòng tiền hỗ trợ tăng`);
    } else if (vwapDiffPct < -2) {
      score -= 8;
      reasons.push(`Giá dưới VWAP (${lastVWAP.toFixed(1)}) - Áp lực bán`);
    }
  }

  // Fibonacci Levels
  const fib = calculateFibonacciLevels(bars, 50);
  if (fib.trend === 'UP') {
    // In uptrend, bouncing off fib levels = buy signal
    if (lastPrice <= fib.level618 * 1.01 && lastPrice >= fib.level618 * 0.99) {
      score += 12;
      reasons.push(`Giá tại Fibonacci 61.8% (${fib.level618.toFixed(1)}) - Vùng hỗ trợ mạnh`);
    } else if (lastPrice <= fib.level382 * 1.01 && lastPrice >= fib.level382 * 0.99) {
      score += 8;
      reasons.push(`Giá tại Fibonacci 38.2% (${fib.level382.toFixed(1)}) - Pullback nhẹ`);
    }
  } else {
    if (lastPrice >= fib.level382 * 0.99 && lastPrice <= fib.level382 * 1.01) {
      score -= 8;
      reasons.push(`Giá tại Fibonacci 38.2% (${fib.level382.toFixed(1)}) - Kháng cự`);
    } else if (lastPrice >= fib.level618 * 0.99 && lastPrice <= fib.level618 * 1.01) {
      score -= 12;
      reasons.push(`Giá tại Fibonacci 61.8% (${fib.level618.toFixed(1)}) - Kháng cự mạnh`);
    }
  }

  // MA Ribbon
  const ribbon = calculateMARibbon(closes);
  if (ribbon.aligned === 'BULLISH' && ribbon.strength >= 80) {
    score += 12;
    reasons.push(`MA Ribbon xếp hàng tăng (Strength: ${ribbon.strength}%) - Uptrend mạnh`);
  } else if (ribbon.aligned === 'BEARISH' && ribbon.strength >= 80) {
    score -= 12;
    reasons.push(`MA Ribbon xếp hàng giảm (Strength: ${ribbon.strength}%) - Downtrend mạnh`);
  } else if (ribbon.aligned === 'MIXED') {
    reasons.push(`MA Ribbon hỗn hợp (${ribbon.strength}%) - Thị trường chưa rõ xu hướng`);
  }

  // ADX-based weight adjustment: in strong trend (ADX>25), trend indicators count more
  const isTrending = !isNaN(lastADX) && lastADX > 25;
  if (isTrending) {
    // Amplify directional signals in trending markets
    if (score > 0) score = Math.round(score * 1.15);
    else if (score < 0) score = Math.round(score * 1.15);
  }

  // Support & Resistance (use Fibonacci-enhanced levels)
  const sr = detectSupportResistance(bars);
  // Blend fibonacci with swing S/R for more accurate levels
  const fibSupport = fib.trend === 'UP' ? fib.level618 : fib.level382;
  const fibResist = fib.trend === 'UP' ? fib.level382 : fib.level618;
  const blendedSupport = (sr.support + fibSupport) / 2;
  const blendedResistance = (sr.resistance + fibResist) / 2;

  const pattern = detectPattern(bars);

  // ATR for risk assessment
  const atr = calculateATR(highs, lows, closes);
  const lastATR = atr[atr.length - 1];
  const atrPct = !isNaN(lastATR) ? (lastATR / lastPrice) * 100 : 2;
  const risk: 'LOW' | 'MEDIUM' | 'HIGH' = atrPct < 2 ? 'LOW' : atrPct < 4 ? 'MEDIUM' : 'HIGH';

  // Calculate target price and stop loss (enhanced with Fibonacci)
  const targetPrice = fib.trend === 'UP'
    ? Math.max(lastPrice + (blendedResistance - lastPrice) * 0.8, fib.level236)
    : lastPrice + (blendedResistance - lastPrice) * 0.6;
  const stopLoss = Math.max(blendedSupport, lastPrice - (isNaN(lastATR) ? lastPrice * 0.03 : lastATR * 2));

  // R/R ratio
  const rrRatio = stopLoss < lastPrice && targetPrice > lastPrice
    ? (targetPrice - lastPrice) / (lastPrice - stopLoss) : 0;

  // Consensus scoring: count how many indicators agree
  let bullishCount = 0;
  let bearishCount = 0;
  if (lastRSI < 40) bullishCount++; else if (lastRSI > 60) bearishCount++;
  if (!isNaN(lastMACD) && !isNaN(lastSignal)) { if (lastMACD > lastSignal) bullishCount++; else bearishCount++; }
  if (!isNaN(lastSMA20) && !isNaN(lastSMA50)) { if (lastPrice > lastSMA20) bullishCount++; else bearishCount++; }
  if (ichResult.signal > 0) bullishCount++; else if (ichResult.signal < 0) bearishCount++;
  if (obvDiv === 'BULLISH_DIV') bullishCount++; else if (obvDiv === 'BEARISH_DIV') bearishCount++;
  if (ribbon.aligned === 'BULLISH') bullishCount++; else if (ribbon.aligned === 'BEARISH') bearishCount++;
  if (!isNaN(lastVWAP) && lastPrice > lastVWAP) bullishCount++; else if (!isNaN(lastVWAP)) bearishCount++;

  const totalIndicators = bullishCount + bearishCount;
  const consensus = totalIndicators > 0 ? Math.max(bullishCount, bearishCount) / totalIndicators : 0.5;
  const confidenceLevel = Math.round(consensus * 100);

  // Determine signal
  let signal: 'BUY' | 'SELL' | 'HOLD';
  if (score >= 25) signal = 'BUY';
  else if (score <= -25) signal = 'SELL';
  else signal = 'HOLD';

  const strength = Math.min(100, Math.max(0, 50 + score));

  // Add consensus to metrics
  metrics['Consensus'] = confidenceLevel;
  metrics['R/R'] = Math.round(rrRatio * 10) / 10;

  // Determine trade type based on ADX
  const tradeType: 'SWING' | 'POSITION' | 'SCALP' = isTrending && lastADX > 35 ? 'POSITION' : 'SWING';

  // Trend strength
  const trendStrength: 'STRONG' | 'MODERATE' | 'WEAK' = !isNaN(lastADX) ? (lastADX > 35 ? 'STRONG' : lastADX > 20 ? 'MODERATE' : 'WEAK') : 'WEAK';

  // Volume profile
  const avgVol5 = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const avgVol20 = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const volumeProfile: 'ACCUMULATION' | 'DISTRIBUTION' | 'NEUTRAL' =
    avgVol5 > avgVol20 * 1.2 && score > 0 ? 'ACCUMULATION' :
    avgVol5 > avgVol20 * 1.2 && score < 0 ? 'DISTRIBUTION' : 'NEUTRAL';

  // Entry zone
  const entryLow = Math.min(lastPrice, blendedSupport + (lastPrice - blendedSupport) * 0.3);
  const entryHigh = lastPrice;

  return {
    ticker, signal, strength, reasons, metrics, risk,
    supportLevel: Math.round(blendedSupport * 100) / 100,
    resistanceLevel: Math.round(blendedResistance * 100) / 100,
    targetPrice: Math.round(targetPrice * 100) / 100,
    stopLoss: Math.round(stopLoss * 100) / 100,
    pattern,
    fibLevels: fib,
    tradeType,
    entryZone: { low: Math.round(entryLow * 100) / 100, high: Math.round(entryHigh * 100) / 100 },
    riskRewardRatio: Math.round(rrRatio * 10) / 10,
    confidence: confidenceLevel,
    trendStrength,
    volumeProfile,
  };
}
