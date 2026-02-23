// Technical Analysis Engine
// Calculates RSI, MACD, SMA, EMA, Bollinger Bands
// Generates short-term buy/sell signals

import type { StockBar } from '../api/stockApi';

export interface TechnicalSignal {
  ticker: string;
  signal: 'BUY' | 'SELL' | 'HOLD';
  strength: number; // 0-100
  reasons: string[];
  metrics: Record<string, number>;
}

function calculateSMA(prices: number[], period: number): number[] {
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

function calculateEMA(prices: number[], period: number): number[] {
  const ema: number[] = [];
  const multiplier = 2 / (period + 1);

  // First EMA is SMA
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

function calculateRSI(prices: number[], period: number = 14): number[] {
  const rsi: number[] = [];
  const gains: number[] = [];
  const losses: number[] = [];

  for (let i = 1; i < prices.length; i++) {
    const change = prices[i] - prices[i - 1];
    gains.push(change > 0 ? change : 0);
    losses.push(change < 0 ? -change : 0);
  }

  rsi.push(NaN); // first element has no RSI

  if (gains.length < period) {
    return prices.map(() => NaN);
  }

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

function calculateMACD(prices: number[], fast: number = 12, slow: number = 26, signal: number = 9): MACD {
  const emaFast = calculateEMA(prices, fast);
  const emaSlow = calculateEMA(prices, slow);

  const macdLine = emaFast.map((f, i) => {
    if (isNaN(f) || isNaN(emaSlow[i])) return NaN;
    return f - emaSlow[i];
  });

  const validMacd = macdLine.filter(v => !isNaN(v));
  const signalEma = calculateEMA(validMacd, signal);

  // Pad signalLine to match macdLine length
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

function calculateBollingerBands(prices: number[], period: number = 20, stdDev: number = 2) {
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

export function analyzeShortTerm(ticker: string, bars: StockBar[]): TechnicalSignal {
  if (bars.length < 30) {
    return { ticker, signal: 'HOLD', strength: 50, reasons: ['Không đủ dữ liệu phân tích'], metrics: {} };
  }

  const closes = bars.map(b => b.close);
  const volumes = bars.map(b => b.volume);
  const lastPrice = closes[closes.length - 1];

  // Calculate indicators
  const rsi = calculateRSI(closes);
  const lastRSI = rsi[rsi.length - 1];

  const macd = calculateMACD(closes);
  const lastMACD = macd.macdLine[macd.macdLine.length - 1];
  const lastSignal = macd.signalLine[macd.signalLine.length - 1];
  const lastHistogram = macd.histogram[macd.histogram.length - 1];
  const prevHistogram = macd.histogram[macd.histogram.length - 2];

  const sma20 = calculateSMA(closes, 20);
  const sma50 = calculateSMA(closes, 50);
  const lastSMA20 = sma20[sma20.length - 1];
  const lastSMA50 = sma50[sma50.length - 1];

  const bb = calculateBollingerBands(closes);
  const lastUpper = bb.upper[bb.upper.length - 1];
  const lastLower = bb.lower[bb.lower.length - 1];

  // Volume analysis
  const avgVolume = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const lastVolume = volumes[volumes.length - 1];
  const volumeRatio = lastVolume / avgVolume;

  // Score: positive = bullish, negative = bearish
  let score = 0;
  const reasons: string[] = [];
  const metrics: Record<string, number> = {};

  // RSI
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
  if (!isNaN(lastMACD) && !isNaN(lastSignal)) {
    metrics['MACD'] = Math.round(lastMACD * 100) / 100;
    if (lastMACD > lastSignal && prevHistogram <= 0 && lastHistogram > 0) {
      score += 30;
      reasons.push('MACD cắt lên Signal Line (Golden Cross)');
    } else if (lastMACD < lastSignal && prevHistogram >= 0 && lastHistogram < 0) {
      score -= 30;
      reasons.push('MACD cắt xuống Signal Line (Death Cross)');
    } else if (lastMACD > lastSignal) {
      score += 10;
      reasons.push('MACD trên Signal Line (Xu hướng tăng)');
    } else {
      score -= 10;
      reasons.push('MACD dưới Signal Line (Xu hướng giảm)');
    }
  }

  // SMA Cross
  if (!isNaN(lastSMA20) && !isNaN(lastSMA50)) {
    if (lastPrice > lastSMA20 && lastSMA20 > lastSMA50) {
      score += 15;
      reasons.push('Giá trên SMA20 > SMA50 (Uptrend)');
    } else if (lastPrice < lastSMA20 && lastSMA20 < lastSMA50) {
      score -= 15;
      reasons.push('Giá dưới SMA20 < SMA50 (Downtrend)');
    }
  }

  // Bollinger Bands
  if (!isNaN(lastUpper) && !isNaN(lastLower)) {
    if (lastPrice <= lastLower) {
      score += 15;
      reasons.push('Giá chạm BB dưới (Hỗ trợ mạnh)');
    } else if (lastPrice >= lastUpper) {
      score -= 15;
      reasons.push('Giá chạm BB trên (Kháng cự mạnh)');
    }
  }

  // Volume
  metrics['Vol Ratio'] = Math.round(volumeRatio * 100) / 100;
  if (volumeRatio > 2) {
    if (closes[closes.length - 1] > closes[closes.length - 2]) {
      score += 20;
      reasons.push(`Volume đột biến (x${metrics['Vol Ratio']}) kèm giá tăng`);
    } else {
      score -= 10;
      reasons.push(`Volume đột biến (x${metrics['Vol Ratio']}) kèm giá giảm`);
    }
  }

  // Determine signal
  let signal: 'BUY' | 'SELL' | 'HOLD';
  if (score >= 25) signal = 'BUY';
  else if (score <= -25) signal = 'SELL';
  else signal = 'HOLD';

  const strength = Math.min(100, Math.max(0, 50 + score));

  return { ticker, signal, strength, reasons, metrics };
}

export { calculateSMA, calculateEMA, calculateRSI, calculateMACD, calculateBollingerBands };
