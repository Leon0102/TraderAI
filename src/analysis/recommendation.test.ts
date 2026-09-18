import { describe, expect, it } from 'vitest';
import { scoreRecommendation } from './recommendation';
import type { TechnicalSignal } from './technicalAnalysis';
import type { FundamentalSignal } from './fundamentalAnalysis';

const technical = (overrides: Partial<TechnicalSignal> = {}) => ({
  ticker: 'FPT', signal: 'BUY', strength: 82, metrics: { RSI: 56 },
  entryPrice: 70, targetPrice: 76, stopLoss: 67, pattern: '', ...overrides,
}) as TechnicalSignal;
const fundamental = (overrides: Partial<FundamentalSignal> = {}) => ({
  ticker: 'FPT', signal: 'BUY', score: 78, ...overrides,
}) as FundamentalSignal;

describe('shared recommendation', () => {
  it('allows BUY when independent signals agree and the plan is valid', () => {
    expect(scoreRecommendation(technical(), fundamental())).toMatchObject({ decision: 'BUY', warnings: [] });
  });

  it('does not promote an overbought stock to BUY even with a high average', () => {
    const result = scoreRecommendation(technical({ metrics: { RSI: 89.6 }, strength: 100 }), fundamental({ score: 100 }));
    expect(result.decision).toBe('HOLD');
    expect(result.score).toBeLessThan(65);
    expect(result.warnings).toContain('RSI 89.6: quá mua');
  });

  it('does not treat a bearish technical signal or missing fundamentals as BUY', () => {
    expect(scoreRecommendation(technical({ signal: 'SELL', strength: 90 }), fundamental({ score: 95 })).decision).toBe('HOLD');
    expect(scoreRecommendation(technical({ strength: 100 }), null).decision).toBe('HOLD');
  });
});
