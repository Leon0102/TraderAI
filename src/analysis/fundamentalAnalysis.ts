// Fundamental Analysis Engine - Enhanced v2
// P/E, P/B, ROE, EPS Growth, Revenue Growth, PEG, Dividend, D/E, DCF, DuPont
// Sector comparison + market cap classification + financial health scoring

import type { FinancialData } from '../api/stockApi';

export interface FundamentalSignal {
  ticker: string;
  signal: 'BUY' | 'SELL' | 'HOLD';
  score: number; // 0-100
  reasons: string[];
  metrics: Record<string, string>;
  capSize: 'Large' | 'Mid' | 'Small';
  grahamNumber: number;
  dcfValue: number;
  intrinsicValue: string;
  investmentType: 'VALUE' | 'GROWTH' | 'DIVIDEND' | 'BALANCED';
  holdingPeriod: string;
  scoreBreakdown: {
    valuation: number;       // P/E, P/B, PEG (max 20)
    profitability: number;   // ROE, Net Margin, DuPont (max 20)
    growth: number;          // EPS growth, Revenue growth (max 20)
    quality: number;         // Market cap, Intrinsic value (max 20)
    financialHealth: number; // D/E, Interest Coverage, Current Ratio, FCF (max 20)
  };
}

function classifyMarketCap(marketCap: number): 'Large' | 'Mid' | 'Small' {
  if (marketCap > 100000) return 'Large';
  if (marketCap > 20000) return 'Mid';
  return 'Small';
}

function calculateGrahamNumber(eps: number, bookValuePerShare: number): number {
  if (eps <= 0 || bookValuePerShare <= 0) return 0;
  return Math.sqrt(22.5 * eps * bookValuePerShare);
}

function calculateSimplifiedDCF(eps: number, epsGrowth: number, discountRate = 0.12): number {
  // Simple DCF: project EPS for 5 years, then terminal value
  if (eps <= 0) return 0;
  const growthRate = Math.min(Math.max(epsGrowth / 100, -0.1), 0.4); // cap at 40% growth
  const terminalGrowth = 0.03; // 3% terminal growth

  let totalPV = 0;
  let projectedEPS = eps;

  for (let year = 1; year <= 5; year++) {
    projectedEPS *= (1 + growthRate);
    totalPV += projectedEPS / Math.pow(1 + discountRate, year);
  }

  // Terminal value (Gordon Growth Model)
  const terminalEPS = projectedEPS * (1 + terminalGrowth);
  const terminalValue = terminalEPS / (discountRate - terminalGrowth);
  totalPV += terminalValue / Math.pow(1 + discountRate, 5);

  return Math.max(0, totalPV);
}

function classifyInvestmentType(data: FinancialData): 'VALUE' | 'GROWTH' | 'DIVIDEND' | 'BALANCED' {
  const isValue = data.pe > 0 && data.pe < 12 && data.pb < 2;
  const isGrowth = data.epsGrowth > 20 || data.revenueGrowth > 20;
  const isDividend = (data.dividendYield || 0) > 3;

  if (isValue && !isGrowth) return 'VALUE';
  if (isGrowth && !isValue) return 'GROWTH';
  if (isDividend && !isGrowth) return 'DIVIDEND';
  return 'BALANCED';
}

export function analyzeLongTerm(data: FinancialData): FundamentalSignal {
  const reasons: string[] = [];
  const metrics: Record<string, string> = {};
  const breakdown = { valuation: 10, profitability: 10, growth: 10, quality: 10, financialHealth: 10 };

  // ========= VALUATION (max 20) =========

  // P/E Ratio
  metrics['P/E'] = data.pe.toFixed(1);
  if (data.pe > 0 && data.pe < 8) {
    breakdown.valuation += 10;
    reasons.push(`P/E = ${metrics['P/E']} (Rất hấp dẫn, dưới 8)`);
  } else if (data.pe >= 8 && data.pe < 12) {
    breakdown.valuation += 7;
    reasons.push(`P/E = ${metrics['P/E']} (Định giá hấp dẫn)`);
  } else if (data.pe >= 12 && data.pe <= 18) {
    breakdown.valuation += 3;
    reasons.push(`P/E = ${metrics['P/E']} (Định giá hợp lý)`);
  } else if (data.pe > 25 && data.pe <= 40) {
    breakdown.valuation -= 4;
    reasons.push(`P/E = ${metrics['P/E']} (Định giá cao)`);
  } else if (data.pe > 40) {
    breakdown.valuation -= 8;
    reasons.push(`P/E = ${metrics['P/E']} (Quá đắt)`);
  }

  // P/B Ratio
  metrics['P/B'] = data.pb.toFixed(1);
  if (data.pb > 0 && data.pb < 1) {
    breakdown.valuation += 6;
    reasons.push(`P/B = ${metrics['P/B']} (Dưới giá trị sổ sách - Hấp dẫn)`);
  } else if (data.pb >= 1 && data.pb < 2) {
    breakdown.valuation += 2;
  } else if (data.pb > 5) {
    breakdown.valuation -= 4;
    reasons.push(`P/B = ${metrics['P/B']} (Cao so với book value)`);
  }

  // PEG Ratio (P/E to Growth)
  if (data.epsGrowth > 0 && data.pe > 0) {
    const peg = data.pe / data.epsGrowth;
    metrics['PEG'] = peg.toFixed(2);
    if (peg < 0.5) {
      breakdown.valuation += 5;
      reasons.push(`PEG = ${metrics['PEG']} (Rất hấp dẫn - tăng trưởng vượt trội so với P/E)`);
    } else if (peg < 1) {
      breakdown.valuation += 3;
      reasons.push(`PEG = ${metrics['PEG']} (Hấp dẫn - P/E thấp so với tăng trưởng)`);
    } else if (peg > 2) {
      breakdown.valuation -= 3;
      reasons.push(`PEG = ${metrics['PEG']} (P/E quá cao so với tăng trưởng)`);
    }
  }

  // ========= PROFITABILITY (max 20) =========

  // ROE Analysis
  metrics['ROE'] = data.roe.toFixed(1) + '%';
  if (data.roe > 25) {
    breakdown.profitability += 8;
    reasons.push(`ROE = ${metrics['ROE']} (Xuất sắc, top ngành)`);
  } else if (data.roe > 18) {
    breakdown.profitability += 6;
    reasons.push(`ROE = ${metrics['ROE']} (Hiệu suất vốn cao)`);
  } else if (data.roe > 12) {
    breakdown.profitability += 3;
    reasons.push(`ROE = ${metrics['ROE']} (Hiệu suất vốn tốt)`);
  } else if (data.roe < 8) {
    breakdown.profitability -= 6;
    reasons.push(`ROE = ${metrics['ROE']} (Hiệu suất vốn thấp)`);
  }

  // Net Margin
  const netMargin = data.netMargin || 0;
  if (netMargin > 0) {
    metrics['Net Margin'] = netMargin.toFixed(1) + '%';
    if (netMargin > 20) {
      breakdown.profitability += 5;
      reasons.push(`Biên lợi nhuận ròng ${metrics['Net Margin']} (Xuất sắc)`);
    } else if (netMargin > 10) {
      breakdown.profitability += 3;
    } else if (netMargin < 3) {
      breakdown.profitability -= 3;
      reasons.push(`Biên lợi nhuận ròng ${metrics['Net Margin']} (Rất thấp)`);
    }
  }

  // DuPont Analysis (ROE = Net Margin × Asset Turnover × Equity Multiplier)
  if (netMargin > 0 && data.totalAssets > 0 && data.revenue > 0 && data.marketCap > 0) {
    const equityMultiplier = data.debtOnEquity > 0 ? 1 + data.debtOnEquity : 1;
    // dupontROE = (netMargin / 100) * assetTurnover * equityMultiplier * 100
    // Quality of ROE: high margin-driven ROE is better than leverage-driven
    if (netMargin > 15 && equityMultiplier < 3) {
      breakdown.profitability += 3;
      reasons.push('DuPont: ROE từ biên lợi nhuận cao (Chất lượng tốt)');
    } else if (equityMultiplier > 5 && netMargin < 10) {
      breakdown.profitability -= 2;
      reasons.push('DuPont: ROE chủ yếu từ đòn bẩy (Rủi ro cao)');
    }
  }

  // ========= GROWTH (max 20) =========

  // EPS Growth
  metrics['EPS Growth'] = data.epsGrowth.toFixed(1) + '%';
  if (data.epsGrowth > 30) {
    breakdown.growth += 10;
    reasons.push(`EPS tăng trưởng ${metrics['EPS Growth']} (Siêu tăng trưởng)`);
  } else if (data.epsGrowth > 15) {
    breakdown.growth += 6;
    reasons.push(`EPS tăng trưởng ${metrics['EPS Growth']} (Tích cực)`);
  } else if (data.epsGrowth > 5) {
    breakdown.growth += 3;
    reasons.push(`EPS tăng trưởng ${metrics['EPS Growth']} (Ổn định)`);
  } else if (data.epsGrowth < -10) {
    breakdown.growth -= 8;
    reasons.push(`EPS giảm mạnh ${metrics['EPS Growth']} (Tiêu cực)`);
  } else if (data.epsGrowth < 0) {
    breakdown.growth -= 4;
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
    breakdown.growth -= 4;
    reasons.push(`Doanh thu giảm ${metrics['Revenue Growth']} (Suy giảm)`);
  }

  // ========= QUALITY (max 20) =========

  // EPS absolute value
  metrics['EPS'] = new Intl.NumberFormat('vi-VN').format(Math.round(data.eps)) + 'đ';

  // Market Cap classification
  const capSize = classifyMarketCap(data.marketCap);
  if (capSize === 'Large') {
    breakdown.quality += 4;
  } else if (capSize === 'Small') {
    breakdown.quality -= 2;
  }

  // Dividend Yield
  const divYield = data.dividendYield || 0;
  if (divYield > 0) {
    metrics['Cổ tức'] = divYield.toFixed(1) + '%';
    if (divYield > 5) {
      breakdown.quality += 6;
      reasons.push(`Cổ tức ${metrics['Cổ tức']} (Xuất sắc - Thu nhập thụ động tốt)`);
    } else if (divYield > 3) {
      breakdown.quality += 4;
      reasons.push(`Cổ tức ${metrics['Cổ tức']} (Hấp dẫn)`);
    } else if (divYield > 1) {
      breakdown.quality += 2;
    }
  }

  // Graham Number & DCF
  const estimatedBVPS = data.pb > 0 ? (data.eps * data.pe) / data.pb : 0;
  const grahamNum = calculateGrahamNumber(data.eps, estimatedBVPS);
  const dcfValue = calculateSimplifiedDCF(data.eps, data.epsGrowth);

  let intrinsicValue = '';
  const currentPrice = data.pe > 0 ? data.eps * data.pe : 0;

  if (dcfValue > 0 && currentPrice > 0) {
    const dcfMargin = ((dcfValue - currentPrice) / currentPrice) * 100;
    metrics['DCF'] = new Intl.NumberFormat('vi-VN').format(Math.round(dcfValue)) + 'đ';

    if (dcfMargin > 30) {
      breakdown.quality += 8;
      intrinsicValue = `Chiết khấu ${Math.round(dcfMargin)}% so với DCF (${metrics['DCF']}) - Rất hấp dẫn`;
    } else if (dcfMargin > 10) {
      breakdown.quality += 4;
      intrinsicValue = `Chiết khấu ${Math.round(dcfMargin)}% so với DCF (${metrics['DCF']})`;
    } else if (dcfMargin < -30) {
      breakdown.quality -= 5;
      intrinsicValue = `Premium ${Math.round(-dcfMargin)}% so với DCF (${metrics['DCF']}) - Quá đắt`;
    } else if (dcfMargin < -10) {
      breakdown.quality -= 2;
      intrinsicValue = `Premium ${Math.round(-dcfMargin)}% so với DCF (${metrics['DCF']})`;
    } else {
      intrinsicValue = `Gần giá trị hợp lý theo DCF (${metrics['DCF']})`;
    }
  } else if (grahamNum > 0 && currentPrice > 0) {
    const margin = ((grahamNum - currentPrice) / currentPrice) * 100;
    if (margin > 20) {
      breakdown.quality += 5;
      intrinsicValue = `Chiết khấu ${Math.round(margin)}% so với Graham Number`;
    } else if (margin < -20) {
      breakdown.quality -= 3;
      intrinsicValue = `Premium ${Math.round(-margin)}% so với Graham Number`;
    } else {
      intrinsicValue = 'Gần giá trị hợp lý theo Graham';
    }
  }

  // ========= FINANCIAL HEALTH (max 20) =========

  // Debt-to-Equity Ratio
  const debtOnEquity = data.debtOnEquity || 0;
  const industry = (data.industry || '').toLowerCase();
  const isBanking = industry.includes('ngân hàng') || industry.includes('bank');

  if (!isBanking) {
    // For non-banking companies
    metrics['D/E'] = debtOnEquity.toFixed(2);
    if (debtOnEquity < 0.3) {
      breakdown.financialHealth += 6;
      reasons.push(`D/E = ${metrics['D/E']} (Nợ rất thấp - An toàn)`);
    } else if (debtOnEquity < 0.7) {
      breakdown.financialHealth += 4;
      reasons.push(`D/E = ${metrics['D/E']} (Nợ hợp lý)`);
    } else if (debtOnEquity > 2) {
      breakdown.financialHealth -= 6;
      reasons.push(`D/E = ${metrics['D/E']} (Nợ quá cao - Rủi ro)`);
    } else if (debtOnEquity > 1.2) {
      breakdown.financialHealth -= 3;
      reasons.push(`D/E = ${metrics['D/E']} (Nợ khá cao)`);
    }
  } else {
    // Banks: D/E is typically very high (5-10), use different thresholds
    if (debtOnEquity > 0) {
      metrics['D/E'] = debtOnEquity.toFixed(1);
      if (debtOnEquity < 8) {
        breakdown.financialHealth += 3;
      } else if (debtOnEquity > 12) {
        breakdown.financialHealth -= 3;
      }
    }
  }

  // Interest Coverage Ratio
  const intCov = data.interestCoverage || 0;
  if (intCov > 0 && !isBanking) {
    metrics['ICR'] = intCov.toFixed(1) + 'x';
    if (intCov > 10) {
      breakdown.financialHealth += 5;
      reasons.push(`Hệ số thanh toán lãi vay ${metrics['ICR']} (Rất an toàn)`);
    } else if (intCov > 4) {
      breakdown.financialHealth += 3;
    } else if (intCov < 1.5) {
      breakdown.financialHealth -= 6;
      reasons.push(`Hệ số thanh toán lãi vay ${metrics['ICR']} (Nguy hiểm - Có thể mất khả năng thanh toán)`);
    } else if (intCov < 3) {
      breakdown.financialHealth -= 3;
      reasons.push(`Hệ số thanh toán lãi vay ${metrics['ICR']} (Cần theo dõi)`);
    }
  }

  // Current Ratio
  const curRatio = data.currentRatio || 0;
  if (curRatio > 0 && !isBanking) {
    metrics['Current Ratio'] = curRatio.toFixed(1);
    if (curRatio > 2) {
      breakdown.financialHealth += 3;
    } else if (curRatio > 1.2) {
      breakdown.financialHealth += 1;
    } else if (curRatio < 0.8) {
      breakdown.financialHealth -= 4;
      reasons.push(`Current Ratio = ${metrics['Current Ratio']} (Thanh khoản kém)`);
    } else if (curRatio < 1) {
      breakdown.financialHealth -= 2;
    }
  }

  // Free Cash Flow
  const fcf = data.freeCashFlow || 0;
  if (fcf !== 0) {
    metrics['FCF'] = (fcf > 0 ? '+' : '') + new Intl.NumberFormat('vi-VN').format(Math.round(fcf)) + ' tỷ';
    if (fcf > 0 && data.marketCap > 0) {
      const fcfYield = (fcf / data.marketCap) * 100;
      if (fcfYield > 5) {
        breakdown.financialHealth += 5;
        reasons.push(`FCF Yield = ${fcfYield.toFixed(1)}% (Dòng tiền tự do xuất sắc)`);
      } else if (fcfYield > 2) {
        breakdown.financialHealth += 3;
      }
    } else if (fcf < 0) {
      breakdown.financialHealth -= 3;
      reasons.push(`Dòng tiền tự do âm (${metrics['FCF']}) - Đang đốt tiền`);
    }
  }

  // ========= CLAMP & COMPUTE =========
  breakdown.valuation = Math.max(0, Math.min(20, breakdown.valuation));
  breakdown.profitability = Math.max(0, Math.min(20, breakdown.profitability));
  breakdown.growth = Math.max(0, Math.min(20, breakdown.growth));
  breakdown.quality = Math.max(0, Math.min(20, breakdown.quality));
  breakdown.financialHealth = Math.max(0, Math.min(20, breakdown.financialHealth));

  const score = Math.max(0, Math.min(100,
    breakdown.valuation + breakdown.profitability + breakdown.growth + breakdown.quality + breakdown.financialHealth
  ));

  // Determine signal
  let signal: 'BUY' | 'SELL' | 'HOLD';
  if (score >= 65) signal = 'BUY';
  else if (score <= 35) signal = 'SELL';
  else signal = 'HOLD';

  // Investment type & holding period
  const investmentType = classifyInvestmentType(data);
  let holdingPeriod = '6-12 tháng';
  if (investmentType === 'VALUE') holdingPeriod = '12-24 tháng (chờ phục hồi)';
  else if (investmentType === 'GROWTH') holdingPeriod = '6-18 tháng (theo tăng trưởng)';
  else if (investmentType === 'DIVIDEND') holdingPeriod = '12+ tháng (hưởng cổ tức)';

  return {
    ticker: data.ticker, signal, score, reasons, metrics,
    capSize,
    grahamNumber: Math.round(grahamNum),
    dcfValue: Math.round(dcfValue),
    intrinsicValue,
    investmentType,
    holdingPeriod,
    scoreBreakdown: breakdown,
  };
}

export function rankForLongTerm(dataList: FinancialData[]): FundamentalSignal[] {
  return dataList
    .map(d => analyzeLongTerm(d))
    .sort((a, b) => b.score - a.score);
}
