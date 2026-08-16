import { describe, it, expect } from 'vitest';
import {
  calculateSMA,
  calculateEMA,
  calculateRSI,
  analyzeShortTerm,
} from './technicalAnalysis';
import type { StockBar } from '../api/stockApi';

describe('calculateSMA', () => {
  it('returns NaN before the window fills, then the rolling average', () => {
    const sma = calculateSMA([1, 2, 3, 4, 5], 3);
    expect(sma.slice(0, 2).every(Number.isNaN)).toBe(true);
    expect(sma[2]).toBeCloseTo(2); // (1+2+3)/3
    expect(sma[3]).toBeCloseTo(3); // (2+3+4)/3
    expect(sma[4]).toBeCloseTo(4); // (3+4+5)/3
  });
});

describe('calculateEMA', () => {
  it('seeds with the SMA of the first period, then reacts to new prices', () => {
    const ema = calculateEMA([1, 2, 3, 4, 5], 3);
    expect(ema[2]).toBeCloseTo(2); // seed = SMA(1,2,3)
    // EMA should move toward later, higher prices
    expect(ema[4]).toBeGreaterThan(ema[2]);
  });
});

describe('calculateRSI', () => {
  it('is high (near 100) for a strictly increasing series (no losses)', () => {
    const prices = Array.from({ length: 20 }, (_, i) => 10 + i);
    const rsi = calculateRSI(prices, 14);
    const last = rsi[rsi.length - 1];
    expect(last).toBeGreaterThan(90);
  });

  it('is low (near 0) for a strictly decreasing series (no gains)', () => {
    const prices = Array.from({ length: 20 }, (_, i) => 100 - i);
    const rsi = calculateRSI(prices, 14);
    const last = rsi[rsi.length - 1];
    expect(last).toBeLessThan(10);
  });
});

function makeBars(count: number, opts: { trend?: number; base?: number } = {}): StockBar[] {
  const { trend = 0.3, base = 50 } = opts;
  const bars: StockBar[] = [];
  for (let i = 0; i < count; i++) {
    const close = base + i * trend + Math.sin(i / 3) * 0.8;
    const open = close - 0.1;
    const high = close + 0.6;
    const low = close - 0.6;
    const date = new Date(2025, 0, 1 + i).toISOString().split('T')[0];
    bars.push({ open, high, low, close, volume: 1_000_000, tradingDate: date });
  }
  return bars;
}

describe('analyzeShortTerm', () => {
  it('returns a neutral HOLD placeholder when there is not enough history', () => {
    const bars = makeBars(10);
    const signal = analyzeShortTerm('XYZ', bars);
    expect(signal.signal).toBe('HOLD');
    expect(signal.strength).toBe(50);
    expect(signal.reasons).toContain('Không đủ dữ liệu phân tích');
  });

  it('produces a well-formed signal for a sustained uptrend', () => {
    const bars = makeBars(90, { trend: 0.4 });
    const signal = analyzeShortTerm('ABC', bars);

    expect(['BUY', 'SELL', 'HOLD']).toContain(signal.signal);
    expect(signal.strength).toBeGreaterThanOrEqual(0);
    expect(signal.strength).toBeLessThanOrEqual(100);
    expect(signal.confidence).toBeGreaterThanOrEqual(0);
    expect(signal.confidence).toBeLessThanOrEqual(100);
    // A steady, low-volatility uptrend should not be flagged as HIGH risk
    expect(signal.risk).not.toBe('HIGH');
    // Support should sit below (or at) resistance
    expect(signal.supportLevel).toBeLessThanOrEqual(signal.resistanceLevel);
  });

  it('leans bearish for a sustained downtrend', () => {
    const bars = makeBars(90, { trend: -0.4, base: 100 });
    const signal = analyzeShortTerm('DOWN', bars);
    // Should not classify a clear, steady downtrend as a BUY
    expect(signal.signal).not.toBe('BUY');
  });
});
