// Fundamental Analysis Engine - Enhanced
// P/E, P/B, ROE, EPS Growth, Revenue Growth, Dividend, D/E, Graham Number
// Sector comparison + market cap classification

import type { FinancialData } from '../api/stockApi';

export interface FundamentalSignal {
  ticker: string;
  signal: 'BUY' | 'SELL' | 'HOLD';
  score: number; // 0-100
  reasons: string[];
  metrics: Record<string, string>;
  capSize: 'Large' | 'Mid' | 'Small';
  grahamNumber: number;
  intrinsicValue: string;
  scoreBreakdown: {
    valuation: number;     // P/E, P/B (max 25)
    profitability: number;  // ROE, EPS (max 25)
    growth: number;        // EPS growth, Revenue growth (max 25)
    quality: number;       // Overall quality (max 25)
  };
}

function classifyMarketCap(marketCap: number): 'Large' | 'Mid' | 'Small' {
  if (marketCap > 100000) return 'Large';  // > 100k tỷ
  if (marketCap > 20000) return 'Mid';      // > 20k tỷ
  return 'Small';
}

function calculateGrahamNumber(eps: number, bookValuePerShare: number): number {
  // Graham Number = √(22.5 × EPS × BVPS)
  if (eps <= 0 || bookValuePerShare <= 0) return 0;
  return Math.sqrt(22.5 * eps * bookValuePerShare);
}

export function analyzeLongTerm(data: FinancialData): FundamentalSignal {
  let score = 50;
  const reasons: string[] = [];
  const metrics: Record<string, string> = {};
  const breakdown = { valuation: 12, profitability: 12, growth: 12, quality: 12 };

  // P/E Ratio Analysis
  metrics['P/E'] = data.pe.toFixed(1);
  if (data.pe > 0 && data.pe < 8) {
    breakdown.valuation += 13;
    reasons.push(`P/E = ${metrics['P/E']} (Rất hấp dẫn, dưới 8)`);
  } else if (data.pe >= 8 && data.pe < 12) {
    breakdown.valuation += 10;
    reasons.push(`P/E = ${metrics['P/E']} (Định giá hấp dẫn)`);
  } else if (data.pe >= 12 && data.pe <= 18) {
    breakdown.valuation += 5;
    reasons.push(`P/E = ${metrics['P/E']} (Định giá hợp lý)`);
  } else if (data.pe > 25 && data.pe <= 40) {
    breakdown.valuation -= 5;
    reasons.push(`P/E = ${metrics['P/E']} (Định giá cao)`);
  } else if (data.pe > 40) {
    breakdown.valuation -= 10;
    reasons.push(`P/E = ${metrics['P/E']} (Quá đắt)`);
  }

  // ROE Analysis
  metrics['ROE'] = data.roe.toFixed(1) + '%';
  if (data.roe > 25) {
    breakdown.profitability += 13;
    reasons.push(`ROE = ${metrics['ROE']} (Xuất sắc, top ngành)`);
  } else if (data.roe > 18) {
    breakdown.profitability += 10;
    reasons.push(`ROE = ${metrics['ROE']} (Hiệu suất vốn cao)`);
  } else if (data.roe > 12) {
    breakdown.profitability += 5;
    reasons.push(`ROE = ${metrics['ROE']} (Hiệu suất vốn tốt)`);
  } else if (data.roe < 8) {
    breakdown.profitability -= 8;
    reasons.push(`ROE = ${metrics['ROE']} (Hiệu suất vốn thấp)`);
  }

  // EPS Growth
  metrics['EPS Growth'] = data.epsGrowth.toFixed(1) + '%';
  if (data.epsGrowth > 30) {
    breakdown.growth += 13;
    reasons.push(`EPS tăng trưởng ${metrics['EPS Growth']} (Siêu tăng trưởng)`);
  } else if (data.epsGrowth > 15) {
    breakdown.growth += 8;
    reasons.push(`EPS tăng trưởng ${metrics['EPS Growth']} (Tích cực)`);
  } else if (data.epsGrowth > 5) {
    breakdown.growth += 3;
    reasons.push(`EPS tăng trưởng ${metrics['EPS Growth']} (Ổn định)`);
  } else if (data.epsGrowth < -10) {
    breakdown.growth -= 10;
    reasons.push(`EPS giảm mạnh ${metrics['EPS Growth']} (Tiêu cực)`);
  } else if (data.epsGrowth < 0) {
    breakdown.growth -= 5;
    reasons.push(`EPS giảm ${metrics['EPS Growth']} (Cần theo dõi)`);
  }

  // Revenue Growth
  metrics['Revenue Growth'] = data.revenueGrowth.toFixed(1) + '%';
  if (data.revenueGrowth > 20) {
    breakdown.growth += 5;
    reasons.push(`Doanh thu tăng ${metrics['Revenue Growth']} (Tăng trưởng mạnh)`);
  } else if (data.revenueGrowth > 8) {
    breakdown.growth += 2;
  } else if (data.revenueGrowth < -5) {
    breakdown.growth -= 5;
    reasons.push(`Doanh thu giảm ${metrics['Revenue Growth']} (Suy giảm)`);
  }

  // P/B Ratio
  metrics['P/B'] = data.pb.toFixed(1);
  if (data.pb > 0 && data.pb < 1) {
    breakdown.valuation += 8;
    reasons.push(`P/B = ${metrics['P/B']} (Dưới giá trị sổ sách - Hấp dẫn)`);
  } else if (data.pb >= 1 && data.pb < 2) {
    breakdown.valuation += 3;
  } else if (data.pb > 5) {
    breakdown.valuation -= 5;
    reasons.push(`P/B = ${metrics['P/B']} (Cao so với book value)`);
  }

  // EPS absolute value
  metrics['EPS'] = new Intl.NumberFormat('vi-VN').format(Math.round(data.eps)) + 'đ';

  // Market Cap classification
  const capSize = classifyMarketCap(data.marketCap);
  if (capSize === 'Large') {
    breakdown.quality += 5;
  } else if (capSize === 'Small') {
    breakdown.quality -= 3;
  }

  // Graham Number estimation
  const estimatedBVPS = data.pb > 0 ? (data.eps * data.pe) / data.pb : 0;
  const grahamNum = calculateGrahamNumber(data.eps, estimatedBVPS);

  let intrinsicValue = '';
  if (grahamNum > 0) {
    const currentPrice = data.eps * data.pe;
    if (currentPrice > 0) {
      const margin = ((grahamNum - currentPrice) / currentPrice) * 100;
      if (margin > 20) {
        breakdown.quality += 8;
        intrinsicValue = `Đang được chiết khấu ${Math.round(margin)}% so với Graham`;
      } else if (margin < -20) {
        breakdown.quality -= 5;
        intrinsicValue = `Đang premium ${Math.round(-margin)}% so với Graham`;
      } else {
        intrinsicValue = 'Gần giá trị hợp lý theo Graham';
      }
    }
  }

  // Clamp breakdown scores
  breakdown.valuation = Math.max(0, Math.min(25, breakdown.valuation));
  breakdown.profitability = Math.max(0, Math.min(25, breakdown.profitability));
  breakdown.growth = Math.max(0, Math.min(25, breakdown.growth));
  breakdown.quality = Math.max(0, Math.min(25, breakdown.quality));

  // Total score
  score = breakdown.valuation + breakdown.profitability + breakdown.growth + breakdown.quality;
  score = Math.max(0, Math.min(100, score));

  // Determine signal
  let signal: 'BUY' | 'SELL' | 'HOLD';
  if (score >= 65) signal = 'BUY';
  else if (score <= 35) signal = 'SELL';
  else signal = 'HOLD';

  return {
    ticker: data.ticker, signal, score, reasons, metrics,
    capSize,
    grahamNumber: Math.round(grahamNum),
    intrinsicValue,
    scoreBreakdown: breakdown,
  };
}

export function rankForLongTerm(dataList: FinancialData[]): FundamentalSignal[] {
  return dataList
    .map(d => analyzeLongTerm(d))
    .sort((a, b) => b.score - a.score);
}
