import { describe, expect, it } from 'vitest';
import { firstPriceVnd, sizingText, type AccountSnapshot } from './accountStore';

const account: AccountSnapshot = {
  synced_at: '2026-09-30T10:00:00',
  summary: { nav: 500_000_000, cash: 50_000_000, stock_value: 450_000_000 },
  holdings: [{ ticker: 'FPT', quantity: 1000, avg_cost: 70_000, price: 63_200, market_value: 63_200_000, weight_pct: 12.6, pnl_pct: -9.7 }],
};

describe('firstPriceVnd', () => {
  it('reads Vietnamese and comma-grouped prices in VND', () => {
    expect(firstPriceVnd('28.000 - 28.500 đ')).toBe(28_000);
    expect(firstPriceVnd('62,600 - 63,500 đ')).toBe(62_600);
    expect(firstPriceVnd('28,5')).toBe(28_500);
    expect(firstPriceVnd('N/A')).toBeNull();
  });
});

describe('sizingText', () => {
  it('converts a percentage of NAV into money and round lots', () => {
    const t = sizingText('15% tổng tài sản', '60.000 - 61.000 đ', account, 'FPT');
    expect(t).toContain('75.000.000 đ');
    expect(t).toContain('1.200 cp');          // 75m / 60k = 1250 -> 1200 in lots of 100
    expect(t).toContain('đang giữ 1.000 cp');
    expect(t).toContain('vượt tiền mặt');      // 75m > 50m cash
  });
  it('stays silent without an account, a percentage or a price', () => {
    expect(sizingText('15%', '60.000 đ', null)).toBe('');
    expect(sizingText('0% (chờ tín hiệu)', '60.000 đ', account)).toBe('');
    expect(sizingText('15%', 'N/A', account)).toBe('');
  });
});
