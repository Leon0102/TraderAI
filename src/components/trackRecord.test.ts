import { describe, expect, it } from 'vitest';
import { returnAfterSessions } from './trackRecord';
import type { Pick } from './dailyPicks';
import type { StockBar } from '../api/stockApi';

const pick = { ticker: 'FPT', signal: 'BUY', price: 100 } as Pick;
const bars = [
  ['2026-09-18', 100], ['2026-09-21', 103], ['2026-09-22', 105],
  ['2026-09-23', 110], ['2026-09-24', 108], ['2026-09-25', 115],
].map(([tradingDate, close]) => ({ tradingDate, close } as StockBar));

describe('prospective return measurement', () => {
  it('counts trading sessions and waits for a completed future close', () => {
    expect(returnAfterSessions(pick, '2026-09-18', bars, 2, '2026-09-21')).toBeNull();
    expect(returnAfterSessions(pick, '2026-09-18', bars, 2, '2026-09-22')).toBeCloseTo(5);
    expect(returnAfterSessions(pick, '2026-09-18', bars, 5, '2026-09-25')).toBeCloseTo(15);
  });

  it('excludes watch-only picks from measured BUY outcomes', () => {
    expect(returnAfterSessions({ ...pick, signal: 'HOLD' }, '2026-09-18', bars, 2, '2026-09-25')).toBeNull();
  });
});
