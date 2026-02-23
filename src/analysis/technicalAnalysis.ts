// Technical Analysis Engine - Enhanced
// Calculates RSI, MACD, SMA, EMA, Bollinger Bands, Stochastic, ADX
// Detects Support/Resistance, Price Patterns
// Generates short-term buy/sell signals with risk assessment

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
    return '🔵 Double Bottom (Đáy kép)';
  }

  // Double Top detection
  const firstMax = Math.max(...firstHalf);
  const secondMax = Math.max(...secondHalf);
  const midMin = Math.min(...recent.slice(mid - 3, mid + 3));

  if (Math.abs(firstMax - secondMax) / firstMax < 0.03 && midMin < firstMax * 0.97) {
    return '🔴 Double Top (Đỉnh kép)';
  }

  // Consolidation
  const range = (Math.max(...recent) - Math.min(...recent)) / Math.min(...recent);
  if (range < 0.05) return '🟡 Sideway (Tích lũy)';

  return '➡️ Trung tính';
}

// ===========================
// Main Analysis Function (Enhanced)
// ===========================

export function analyzeShortTerm(ticker: string, bars: StockBar[]): TechnicalSignal {
  if (bars.length < 30) {
    return {
      ticker, signal: 'HOLD', strength: 50,
      reasons: ['Không đủ dữ liệu phân tích'], metrics: {},
      risk: 'MEDIUM', supportLevel: 0, resistanceLevel: 0,
      targetPrice: 0, stopLoss: 0, pattern: '',
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

  // Support & Resistance
  const sr = detectSupportResistance(bars);
  const pattern = detectPattern(bars);

  // ATR for risk assessment
  const atr = calculateATR(highs, lows, closes);
  const lastATR = atr[atr.length - 1];
  const atrPct = !isNaN(lastATR) ? (lastATR / lastPrice) * 100 : 2;
  const risk: 'LOW' | 'MEDIUM' | 'HIGH' = atrPct < 2 ? 'LOW' : atrPct < 4 ? 'MEDIUM' : 'HIGH';

  // Calculate target price and stop loss
  const targetPrice = lastPrice + (sr.resistance - lastPrice) * 0.8;
  const stopLoss = Math.max(sr.support, lastPrice - lastATR * 2);

  // Determine signal
  let signal: 'BUY' | 'SELL' | 'HOLD';
  if (score >= 25) signal = 'BUY';
  else if (score <= -25) signal = 'SELL';
  else signal = 'HOLD';

  const strength = Math.min(100, Math.max(0, 50 + score));

  return {
    ticker, signal, strength, reasons, metrics, risk,
    supportLevel: Math.round(sr.support * 100) / 100,
    resistanceLevel: Math.round(sr.resistance * 100) / 100,
    targetPrice: Math.round(targetPrice * 100) / 100,
    stopLoss: Math.round(stopLoss * 100) / 100,
    pattern,
  };
}
