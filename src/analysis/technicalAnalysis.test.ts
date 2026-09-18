import { describe, expect, it } from 'vitest';
import { analyzeShortTerm } from './technicalAnalysis';
import type { StockBar } from '../api/stockApi';

/** Synthetic daily bars: `shape` returns the close for each session. */
function bars(count: number, shape: (i: number) => number): StockBar[] {
  return Array.from({ length: count }, (_, i) => {
    const close = shape(i);
    return {
      tradingDate: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
      open: close * 0.995,
      high: close * 1.01,
      low: close * 0.99,
      close,
      volume: 1_000_000,
    };
  });
}

describe('analyzeShortTerm trade plan', () => {
  it('keeps target above and stop below price when the stock breaks out', () => {
    // Flat base, then a sharp breakout: price ends far above recent resistance.
    const signal = analyzeShortTerm('BRK', bars(220, i => (i < 200 ? 50 + Math.sin(i / 3) : 50 + (i - 199) * 1.2)));
    expect(signal.targetPrice).toBeGreaterThan(signal.entryPrice);
    expect(signal.stopLoss).toBeLessThan(signal.entryPrice);
    expect(signal.targetPrice).toBeGreaterThan(signal.stopLoss);
  });

  it('keeps the plan coherent in a sustained downtrend too', () => {
    const signal = analyzeShortTerm('DWN', bars(220, i => 100 - i * 0.3));
    const last = 100 - 219 * 0.3;
    expect(signal.stopLoss).toBeLessThan(last);
    expect(signal.targetPrice).toBeGreaterThan(last);
  });

  it('reports no plan when there is not enough history', () => {
    const signal = analyzeShortTerm('NEW', bars(5, () => 20));
    expect(signal.targetPrice).toBe(0);
    expect(signal.stopLoss).toBe(0);
  });
});

describe('reward vs risk', () => {
  it('never quotes a plan that risks more than it targets', () => {
    for (const shape of [
      (i: number) => 50 + Math.sin(i / 4) * 2,        // choppy range
      (i: number) => 30 + i * 0.15,                   // steady uptrend
      (i: number) => 80 - i * 0.2,                    // downtrend
      (i: number) => (i < 200 ? 20 : 20 + (i - 199)), // breakout
    ]) {
      const s = analyzeShortTerm('X', bars(220, shape));
      const risk = s.entryPrice - s.stopLoss;
      const reward = s.targetPrice - s.entryPrice;
      expect(reward / risk).toBeGreaterThanOrEqual(1);
    }
  });
});
