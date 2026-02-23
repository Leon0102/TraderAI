// Fundamental Analysis Engine
// Evaluates P/E, P/B, ROE, EPS Growth for long-term investment

import type { FinancialData } from '../api/stockApi';

export interface FundamentalSignal {
  ticker: string;
  signal: 'BUY' | 'SELL' | 'HOLD';
  score: number; // 0-100
  reasons: string[];
  metrics: Record<string, string>;
}

export function analyzeLongTerm(data: FinancialData): FundamentalSignal {
  let score = 50; // Start neutral
  const reasons: string[] = [];
  const metrics: Record<string, string> = {};

  // P/E Ratio Analysis
  metrics['P/E'] = data.pe.toFixed(1);
  if (data.pe > 0 && data.pe < 10) {
    score += 15;
    reasons.push(`P/E = ${metrics['P/E']} (Định giá hấp dẫn)`);
  } else if (data.pe >= 10 && data.pe <= 18) {
    score += 8;
    reasons.push(`P/E = ${metrics['P/E']} (Định giá hợp lý)`);
  } else if (data.pe > 25) {
    score -= 10;
    reasons.push(`P/E = ${metrics['P/E']} (Định giá cao)`);
  } else if (data.pe > 40) {
    score -= 20;
    reasons.push(`P/E = ${metrics['P/E']} (Quá đắt)`);
  }

  // ROE Analysis
  metrics['ROE'] = data.roe.toFixed(1) + '%';
  if (data.roe > 20) {
    score += 15;
    reasons.push(`ROE = ${metrics['ROE']} (Hiệu suất vốn xuất sắc)`);
  } else if (data.roe > 15) {
    score += 8;
    reasons.push(`ROE = ${metrics['ROE']} (Hiệu suất vốn tốt)`);
  } else if (data.roe < 8) {
    score -= 10;
    reasons.push(`ROE = ${metrics['ROE']} (Hiệu suất vốn thấp)`);
  }

  // EPS Growth
  metrics['EPS Growth'] = data.epsGrowth.toFixed(1) + '%';
  if (data.epsGrowth > 20) {
    score += 15;
    reasons.push(`EPS tăng trưởng ${metrics['EPS Growth']} (Rất tích cực)`);
  } else if (data.epsGrowth > 10) {
    score += 8;
    reasons.push(`EPS tăng trưởng ${metrics['EPS Growth']} (Tích cực)`);
  } else if (data.epsGrowth < 0) {
    score -= 15;
    reasons.push(`EPS giảm ${metrics['EPS Growth']} (Tiêu cực)`);
  }

  // Revenue Growth
  metrics['Revenue Growth'] = data.revenueGrowth.toFixed(1) + '%';
  if (data.revenueGrowth > 15) {
    score += 12;
    reasons.push(`Doanh thu tăng ${metrics['Revenue Growth']} (Tăng trưởng mạnh)`);
  } else if (data.revenueGrowth > 5) {
    score += 5;
    reasons.push(`Doanh thu tăng ${metrics['Revenue Growth']} (Ổn định)`);
  } else if (data.revenueGrowth < 0) {
    score -= 10;
    reasons.push(`Doanh thu giảm ${metrics['Revenue Growth']} (Suy giảm)`);
  }

  // P/B Ratio
  metrics['P/B'] = data.pb.toFixed(1);
  if (data.pb > 0 && data.pb < 1.5) {
    score += 10;
    reasons.push(`P/B = ${metrics['P/B']} (Dưới giá trị sổ sách)`);
  } else if (data.pb > 5) {
    score -= 5;
    reasons.push(`P/B = ${metrics['P/B']} (Cao so với book value)`);
  }

  // EPS absolute value
  metrics['EPS'] = new Intl.NumberFormat('vi-VN').format(Math.round(data.eps)) + 'đ';

  // Clamp score
  score = Math.max(0, Math.min(100, score));

  // Determine signal
  let signal: 'BUY' | 'SELL' | 'HOLD';
  if (score >= 65) signal = 'BUY';
  else if (score <= 35) signal = 'SELL';
  else signal = 'HOLD';

  return { ticker: data.ticker, signal, score, reasons, metrics };
}

export function rankForLongTerm(dataList: FinancialData[]): FundamentalSignal[] {
  return dataList
    .map(d => analyzeLongTerm(d))
    .sort((a, b) => b.score - a.score);
}
