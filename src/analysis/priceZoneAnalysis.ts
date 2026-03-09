// Price Zone Analysis Engine
// Calculates DCA buy zones, partial sell zones, and 3 price scenarios
// Uses Fibonacci levels, Bollinger Bands, S/R, ATR, and news sentiment adjustments

import type { StockBar, PriceZone, PriceScenario } from '../api/stockApi';
import type { TechnicalSignal } from './technicalAnalysis';
import type { FundamentalSignal } from './fundamentalAnalysis';
import type { NewsSignal } from './newsAnalysis';
import { calculateSMA, calculateBollingerBands, calculateATR } from './technicalAnalysis';

export interface PriceZoneResult {
  buyZones: PriceZone[];
  sellZones: PriceZone[];
  scenarios: PriceScenario[];
  currentPrice: number;
  fairValue: number;          // weighted intrinsic value estimate
  upside: number;             // % upside to fair value
  downside: number;           // % downside to stop loss
}

/**
 * Calculate DCA buy zones adjusted by technical levels, fundamentals, and news sentiment.
 */
export function calculateBuyZones(
  tech: TechnicalSignal,
  fund: FundamentalSignal | null,
  news: NewsSignal | null,
  bars: StockBar[]
): PriceZone[] {
  if (bars.length < 20) return [];

  const closes = bars.map(b => b.close);
  const currentPrice = closes[closes.length - 1];
  const sma50 = calculateSMA(closes, 50);
  const sma200 = calculateSMA(closes, 200);
  const lastSMA50 = sma50.length > 0 ? sma50[sma50.length - 1] : currentPrice;
  const lastSMA200 = sma200.length > 0 ? sma200[sma200.length - 1] : currentPrice;

  // Fibonacci levels from technical signal
  const fib = tech.fibLevels;

  // News sentiment adjustment: positive news → tighter buy zones (closer to current price)
  // Negative news → wider zones (further down)
  const sentimentShift = news ? news.sentimentScore * 0.001 : 0; // ±0.1 max

  const zones: PriceZone[] = [];

  // Zone 1: "Mua ngay" — near current price when signals are favorable
  if (tech.signal === 'BUY' || (fund && fund.signal === 'BUY')) {
    const entryPrice = Math.min(currentPrice, tech.entryZone.high);
    zones.push({
      type: 'BUY',
      price: Math.round(entryPrice * (1 + sentimentShift) * 100) / 100,
      label: '🟢 Mua ngay',
      reasoning: `Vùng giá hiện tại. ${tech.signal === 'BUY' ? 'Kỹ thuật: tín hiệu MUA' : ''}${fund?.signal === 'BUY' ? '. Cơ bản: đáng đầu tư' : ''}`,
      allocation: 50,
    });
  }

  // Zone 2: "DCA lần 1" — Fibonacci 38.2% or SMA50
  const dca1Base = fib.trend === 'UP'
    ? Math.min(fib.level382, lastSMA50)
    : Math.max(fib.level382, lastSMA50);
  const dca1Price = Math.round(dca1Base * (1 + sentimentShift * 0.5) * 100) / 100;

  if (dca1Price < currentPrice * 0.98) {
    zones.push({
      type: 'BUY',
      price: dca1Price,
      label: '🟡 DCA lần 1',
      reasoning: `Fibonacci 38.2% (${fib.level382.toFixed(1)}) kết hợp SMA50 (${lastSMA50.toFixed(1)}). Vùng pullback khỏe.`,
      allocation: 30,
    });
  }

  // Zone 3: "DCA lần 2" — Fibonacci 61.8% or SMA200
  const dca2Base = fib.trend === 'UP'
    ? Math.min(fib.level618, lastSMA200)
    : Math.max(fib.level618, lastSMA200);
  const dca2Price = Math.round(dca2Base * (1 + sentimentShift * 0.3) * 100) / 100;

  if (dca2Price < currentPrice * 0.95) {
    zones.push({
      type: 'BUY',
      price: dca2Price,
      label: '🔵 DCA lần 2',
      reasoning: `Fibonacci 61.8% (${fib.level618.toFixed(1)}) kết hợp SMA200 (${lastSMA200.toFixed(1)}). Vùng hỗ trợ mạnh.`,
      allocation: 20,
    });
  }

  // If no buy zones created, provide a basic one
  if (zones.length === 0) {
    zones.push({
      type: 'BUY',
      price: Math.round(tech.supportLevel * 100) / 100,
      label: '🟡 Mua tại hỗ trợ',
      reasoning: `Vùng hỗ trợ kỹ thuật (${tech.supportLevel.toFixed(1)}).`,
      allocation: 50,
    });
  }

  return zones;
}

/**
 * Calculate sell zones: partial take-profit + trailing stop.
 */
export function calculateSellZones(
  tech: TechnicalSignal,
  fund: FundamentalSignal | null,
  news: NewsSignal | null,
  bars: StockBar[]
): PriceZone[] {
  if (bars.length < 20) return [];

  const closes = bars.map(b => b.close);
  const highs = bars.map(b => b.high);
  const lows = bars.map(b => b.low);
  const currentPrice = closes[closes.length - 1];

  // ATR for trailing stop
  const atr = calculateATR(highs, lows, closes);
  const lastATR = atr.length > 0 ? atr[atr.length - 1] : currentPrice * 0.03;

  // Fibonacci extensions for upside targets
  const fib = tech.fibLevels;
  const fibRange = fib.high - fib.low;

  // News adjustment: positive news → higher targets, negative → lower
  const sentimentMul = news ? 1 + news.sentimentScore * 0.001 : 1;

  const zones: PriceZone[] = [];

  // Zone 1: "Chốt lời 50%" — first resistance or Fibonacci 1.272 extension
  const target1Base = Math.max(
    tech.resistanceLevel,
    fib.trend === 'UP' ? fib.high + fibRange * 0.272 : fib.level236
  );
  const target1 = Math.round(target1Base * sentimentMul * 100) / 100;

  if (target1 > currentPrice * 1.02) {
    zones.push({
      type: 'SELL',
      price: target1,
      label: '🟡 Chốt lời 50%',
      reasoning: `Kháng cự (${tech.resistanceLevel.toFixed(1)}) + Fibonacci extension. Bán 50% vị thế, bảo toàn vốn.`,
      allocation: 50,
    });
  }

  // Zone 2: "Chốt lời hết" — second resistance or target price
  const target2Base = Math.max(
    tech.targetPrice,
    fib.trend === 'UP' ? fib.high + fibRange * 0.618 : fib.level382
  );
  const target2 = Math.round(target2Base * sentimentMul * 100) / 100;

  if (target2 > currentPrice * 1.05) {
    zones.push({
      type: 'SELL',
      price: target2,
      label: '🔴 Chốt lời 100%',
      reasoning: `Mục tiêu giá (${tech.targetPrice.toFixed(1)}) + Fibonacci 1.618 extension. Đóng toàn bộ vị thế.`,
      allocation: 100,
    });
  }

  // Zone 3: "Trailing Stop" — ATR-based
  const trailingDistance = isNaN(lastATR) ? currentPrice * 0.05 : lastATR * 2;
  const trailingPrice = Math.round((currentPrice - trailingDistance) * 100) / 100;

  zones.push({
    type: 'SELL',
    price: trailingPrice,
    label: '⚠️ Trailing Stop',
    reasoning: `ATR × 2 = ${trailingDistance.toFixed(1)}. Dịch lên theo giá nếu cổ phiếu tăng.`,
    allocation: 100,
  });

  // DCF-based sell zone if available
  if (fund && fund.dcfValue > 0 && fund.dcfValue > currentPrice * 1.1) {
    zones.push({
      type: 'SELL',
      price: Math.round(fund.dcfValue * 100) / 100,
      label: '💎 Giá trị nội tại (DCF)',
      reasoning: `Giá trị hợp lý theo DCF: ${fund.dcfValue.toFixed(0)}. Xem xét chốt khi giá tiệm cận.`,
      allocation: 50,
    });
  }

  return zones;
}

/**
 * Generate 3 price scenarios: Best, Base, Worst.
 * Uses Bollinger Bands (±2σ), fundamental valuation, and news sentiment.
 */
export function generatePriceScenarios(
  tech: TechnicalSignal,
  fund: FundamentalSignal | null,
  news: NewsSignal | null,
  bars: StockBar[]
): PriceScenario[] {
  if (bars.length < 30) return [];

  const closes = bars.map(b => b.close);
  const currentPrice = closes[closes.length - 1];

  // Bollinger Bands for volatility envelope
  const bb = calculateBollingerBands(closes, 20, 2);
  const lastUpper = bb.upper[bb.upper.length - 1] || currentPrice * 1.05;
  const lastLower = bb.lower[bb.lower.length - 1] || currentPrice * 0.95;

  // Trend direction
  const isBullish = tech.signal === 'BUY' || tech.strength > 55;
  const isBearish = tech.signal === 'SELL' || tech.strength < 45;

  // Sentiment boost
  const sentimentBoost = news ? news.sentimentScore * 0.001 : 0;

  // === BEST CASE ===
  const bestTarget = Math.max(
    lastUpper * (1 + Math.abs(sentimentBoost)),
    tech.targetPrice,
    currentPrice * 1.15
  );
  const bestDrivers: string[] = [];
  if (isBullish) bestDrivers.push('Xu hướng kỹ thuật tăng');
  if (fund && fund.score > 60) bestDrivers.push('Nền tảng cơ bản vững');
  if (news && news.sentimentScore > 20) bestDrivers.push('Tin tức tích cực hỗ trợ');
  if (fund && fund.investmentType === 'GROWTH') bestDrivers.push('Tăng trưởng EPS/doanh thu mạnh');
  if (tech.volumeProfile === 'ACCUMULATION') bestDrivers.push('Dòng tiền tích lũy mạnh');
  if (bestDrivers.length === 0) bestDrivers.push('Thị trường thuận lợi, thanh khoản tốt');

  // === BASE CASE ===
  const trendBias = isBullish ? 0.02 : isBearish ? -0.02 : 0;
  const baseTarget = Math.round(currentPrice * (1 + trendBias + sentimentBoost * 0.5) * 100) / 100;
  const baseDrivers: string[] = [];
  baseDrivers.push('Dự kiến dao động quanh vùng giá hiện tại');
  if (fund) baseDrivers.push(`P/E hiện tại: ${fund.metrics['P/E'] || 'N/A'}`);
  if (tech.trendStrength === 'MODERATE') baseDrivers.push('Xu hướng trung bình, cần thêm xác nhận');
  if (news && news.momentum === 'STABLE') baseDrivers.push('Tin tức ổn định, không có catalyst mới');

  // === WORST CASE ===
  const worstTarget = Math.min(
    lastLower * (1 - Math.abs(sentimentBoost)),
    tech.stopLoss,
    currentPrice * 0.85
  );
  const worstDrivers: string[] = [];
  if (isBearish) worstDrivers.push('Xu hướng kỹ thuật giảm');
  if (fund && fund.score < 40) worstDrivers.push('Cơ bản yếu');
  if (news && news.sentimentScore < -20) worstDrivers.push('Tin tức tiêu cực');
  if (tech.risk === 'HIGH') worstDrivers.push('Biến động giá cao (ATR lớn)');
  if (tech.volumeProfile === 'DISTRIBUTION') worstDrivers.push('Dòng tiền phân phối');
  if (worstDrivers.length === 0) worstDrivers.push('Rủi ro thị trường chung, tin xấu bất ngờ');

  // Probability estimation
  let bestProb = 20, baseProb = 55, worstProb = 25;
  if (isBullish) { bestProb = 30; baseProb = 50; worstProb = 20; }
  if (isBearish) { bestProb = 15; baseProb = 45; worstProb = 40; }
  if (news && news.sentimentScore > 30) { bestProb += 5; worstProb -= 5; }
  if (news && news.sentimentScore < -30) { bestProb -= 5; worstProb += 5; }

  // Timeline based on trade type
  const timeline = tech.tradeType === 'POSITION' ? '2-4 tuần' : '3-7 ngày';

  return [
    {
      name: 'BEST',
      targetPrice: Math.round(bestTarget * 100) / 100,
      probability: bestProb,
      timeline,
      drivers: bestDrivers,
    },
    {
      name: 'BASE',
      targetPrice: baseTarget,
      probability: baseProb,
      timeline,
      drivers: baseDrivers,
    },
    {
      name: 'WORST',
      targetPrice: Math.round(worstTarget * 100) / 100,
      probability: worstProb,
      timeline,
      drivers: worstDrivers,
    },
  ];
}

/**
 * Full price zone analysis combining buy zones, sell zones, and price scenarios.
 */
export function analyzePriceZones(
  tech: TechnicalSignal,
  fund: FundamentalSignal | null,
  news: NewsSignal | null,
  bars: StockBar[]
): PriceZoneResult {
  const currentPrice = bars.length > 0 ? bars[bars.length - 1].close : 0;

  const buyZones = calculateBuyZones(tech, fund, news, bars);
  const sellZones = calculateSellZones(tech, fund, news, bars);
  const scenarios = generatePriceScenarios(tech, fund, news, bars);

  // Fair value: weighted average of DCF and Graham Number
  let fairValue = currentPrice;
  if (fund) {
    const dcf = fund.dcfValue > 0 ? fund.dcfValue : 0;
    const graham = fund.grahamNumber > 0 ? fund.grahamNumber : 0;
    if (dcf > 0 && graham > 0) fairValue = dcf * 0.6 + graham * 0.4;
    else if (dcf > 0) fairValue = dcf;
    else if (graham > 0) fairValue = graham;
  }

  const upside = currentPrice > 0 ? Math.round((fairValue - currentPrice) / currentPrice * 100) : 0;
  const stopLoss = tech.stopLoss > 0 ? tech.stopLoss : currentPrice * 0.95;
  const downside = currentPrice > 0 ? Math.round((currentPrice - stopLoss) / currentPrice * 100) : 0;

  return {
    buyZones,
    sellZones,
    scenarios,
    currentPrice,
    fairValue: Math.round(fairValue * 100) / 100,
    upside,
    downside,
  };
}
