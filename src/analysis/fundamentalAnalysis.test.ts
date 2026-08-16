import { describe, it, expect } from 'vitest';
import { analyzeLongTerm } from './fundamentalAnalysis';
import type { FinancialData } from '../api/stockApi';

function baseFinancials(overrides: Partial<FinancialData>): FinancialData {
  return {
    ticker: 'TST',
    pe: 15,
    pb: 2,
    roe: 15,
    eps: 3000,
    revenue: 10000,
    revenueGrowth: 8,
    epsGrowth: 8,
    marketCap: 50000,
    dividendYield: 0,
    debtOnEquity: 0.5,
    netMargin: 10,
    freeCashFlow: 0,
    totalAssets: 20000,
    interestCoverage: 5,
    currentRatio: 1.5,
    industry: 'Khác',
    ...overrides,
  };
}

describe('analyzeLongTerm', () => {
  it('scores a cheap, profitable, low-debt stock as BUY', () => {
    const data = baseFinancials({
      pe: 7,
      pb: 0.8,
      roe: 28,
      eps: 5000,
      revenue: 50000,
      revenueGrowth: 15,
      epsGrowth: 10,
      marketCap: 150000,
      dividendYield: 6,
      debtOnEquity: 0.2,
      netMargin: 25,
      freeCashFlow: 5000,
      totalAssets: 100000,
      interestCoverage: 15,
      currentRatio: 2.5,
    });

    const signal = analyzeLongTerm(data);

    expect(signal.score).toBeGreaterThanOrEqual(65);
    expect(signal.signal).toBe('BUY');
    expect(signal.investmentType).toBe('VALUE');
    expect(signal.capSize).toBe('Large');
  });

  it('scores an expensive, unprofitable, over-leveraged stock as SELL', () => {
    const data = baseFinancials({
      pe: 45,
      pb: 6,
      roe: 5,
      eps: 1000,
      revenue: 0, // unknown / not disclosed
      revenueGrowth: -10,
      epsGrowth: -15,
      marketCap: 5000,
      dividendYield: 0,
      debtOnEquity: 3,
      netMargin: 1,
      freeCashFlow: -200,
      totalAssets: 1000,
      interestCoverage: 1,
      currentRatio: 0.5,
    });

    const signal = analyzeLongTerm(data);

    expect(signal.score).toBeLessThanOrEqual(35);
    expect(signal.signal).toBe('SELL');
    expect(signal.capSize).toBe('Small');
  });

  it('clamps every score breakdown component to the 0-20 range', () => {
    const extreme = baseFinancials({
      pe: 200, pb: 50, roe: -50, epsGrowth: -90, revenueGrowth: -90,
      debtOnEquity: 20, interestCoverage: 0.1, currentRatio: 0.1, freeCashFlow: -999999,
    });
    const signal = analyzeLongTerm(extreme);
    for (const value of Object.values(signal.scoreBreakdown)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(20);
    }
    expect(signal.score).toBeGreaterThanOrEqual(0);
    expect(signal.score).toBeLessThanOrEqual(100);
  });
});
