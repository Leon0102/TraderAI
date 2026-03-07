// Market Analysis Engine
// Detects market regime (Bull/Bear/Sideways), calculates market health score
// Provides context for investment decisions

import type { MarketAnalysisData, SectorData } from '../api/stockApi';
import { calculateSMA, calculateATR, calculateRSI } from './technicalAnalysis';

export type MarketRegime = 'BULL' | 'BEAR' | 'SIDEWAYS';

export interface MarketContext {
  regime: MarketRegime;
  regimeLabel: string;
  regimeEmoji: string;
  healthScore: number;       // 0-100
  confidence: number;        // 0-100
  vnindexTrend: string;
  vnindexSMA50: number;
  vnindexSMA200: number;
  vnindexRSI: number;
  breadthRatio: number;      // A/D ratio
  volatilityRegime: 'LOW' | 'NORMAL' | 'HIGH';
  volumeTrend: 'INCREASING' | 'DECREASING' | 'STABLE';
  supportLevel: number;
  resistanceLevel: number;
  topSectors: SectorData[];
  bottomSectors: SectorData[];
  reasons: string[];
}

export function analyzeMarket(
  marketData: any[],  // VN-Index, HNX, UPCOM overview data
  analysisData: MarketAnalysisData | null
): MarketContext {
  const reasons: string[] = [];
  let healthScore = 50;
  let confidence = 50;

  // Default values
  let vnindexSMA50 = 0;
  let vnindexSMA200 = 0;
  let vnindexRSI = 50;
  let breadthRatio = 1;
  let volatilityRegime: 'LOW' | 'NORMAL' | 'HIGH' = 'NORMAL';
  let volumeTrend: 'INCREASING' | 'DECREASING' | 'STABLE' = 'STABLE';
  let supportLevel = 0;
  let resistanceLevel = 0;
  let topSectors: SectorData[] = [];
  let bottomSectors: SectorData[] = [];

  // === Market Breadth from overview data ===
  const vnIndex = marketData.find(d => d.ticker === 'VNINDEX');
  if (vnIndex) {
    const advances = vnIndex.advances || 0;
    const declines = vnIndex.declines || 0;
    breadthRatio = declines > 0 ? advances / declines : 2;

    if (breadthRatio > 1.5) {
      healthScore += 12;
      reasons.push(`Breadth tốt: ${advances} tăng / ${declines} giảm (AD=${breadthRatio.toFixed(2)})`);
    } else if (breadthRatio < 0.7) {
      healthScore -= 12;
      reasons.push(`Breadth xấu: ${advances} tăng / ${declines} giảm (AD=${breadthRatio.toFixed(2)})`);
    } else {
      reasons.push(`Breadth trung bình: AD=${breadthRatio.toFixed(2)}`);
    }

    // Daily change
    if (vnIndex.pctChange > 0.5) {
      healthScore += 5;
    } else if (vnIndex.pctChange < -0.5) {
      healthScore -= 5;
    }
  }

  // === VN-Index Technical Analysis ===
  if (analysisData && analysisData.vnindexHistory && analysisData.vnindexHistory.length >= 50) {
    const bars = analysisData.vnindexHistory;
    const closes = bars.map(b => b.close);
    const highs = bars.map(b => b.high);
    const lows = bars.map(b => b.low);
    const lastPrice = closes[closes.length - 1];

    // SMA 50 & 200
    const sma50 = calculateSMA(closes, 50);
    const sma200 = closes.length >= 200 ? calculateSMA(closes, 200) : calculateSMA(closes, Math.min(closes.length, 100));
    vnindexSMA50 = sma50[sma50.length - 1];
    vnindexSMA200 = sma200[sma200.length - 1];

    // Trend analysis
    if (!isNaN(vnindexSMA50)) {
      if (lastPrice > vnindexSMA50) {
        healthScore += 10;
        reasons.push(`VN-Index (${lastPrice.toFixed(0)}) trên SMA50 (${vnindexSMA50.toFixed(0)}) - Xu hướng tăng`);
      } else {
        healthScore -= 10;
        reasons.push(`VN-Index (${lastPrice.toFixed(0)}) dưới SMA50 (${vnindexSMA50.toFixed(0)}) - Xu hướng giảm`);
      }
    }

    if (!isNaN(vnindexSMA200)) {
      if (lastPrice > vnindexSMA200) {
        healthScore += 8;
        reasons.push(`VN-Index trên SMA200 (${vnindexSMA200.toFixed(0)}) - Xu hướng dài hạn tăng`);
      } else {
        healthScore -= 8;
        reasons.push(`VN-Index dưới SMA200 (${vnindexSMA200.toFixed(0)}) - Xu hướng dài hạn giảm`);
      }
    }

    // Golden/Death Cross
    if (!isNaN(vnindexSMA50) && !isNaN(vnindexSMA200)) {
      if (vnindexSMA50 > vnindexSMA200) {
        healthScore += 5;
        reasons.push('SMA50 > SMA200 (Golden Cross - Tín hiệu tăng dài hạn)');
      } else {
        healthScore -= 5;
        reasons.push('SMA50 < SMA200 (Death Cross - Tín hiệu giảm dài hạn)');
      }
    }

    // RSI
    const rsi = calculateRSI(closes);
    vnindexRSI = rsi[rsi.length - 1];
    if (!isNaN(vnindexRSI)) {
      if (vnindexRSI > 70) {
        healthScore -= 5;
        reasons.push(`VN-Index RSI = ${vnindexRSI.toFixed(0)} (Quá mua - Rủi ro điều chỉnh)`);
      } else if (vnindexRSI < 30) {
        healthScore += 5;
        reasons.push(`VN-Index RSI = ${vnindexRSI.toFixed(0)} (Quá bán - Cơ hội mua vào)`);
      }
    }

    // Volatility Regime (ATR-based)
    const atr = calculateATR(highs, lows, closes);
    const lastATR = atr[atr.length - 1];
    if (!isNaN(lastATR) && lastPrice > 0) {
      const atrPct = (lastATR / lastPrice) * 100;
      if (atrPct < 1) {
        volatilityRegime = 'LOW';
        reasons.push(`Biến động thấp (ATR=${atrPct.toFixed(1)}%) - Thị trường ổn định`);
      } else if (atrPct > 2.5) {
        volatilityRegime = 'HIGH';
        healthScore -= 5;
        reasons.push(`Biến động cao (ATR=${atrPct.toFixed(1)}%) - Thị trường bất ổn`);
      } else {
        volatilityRegime = 'NORMAL';
      }
    }

    // Volume Trend
    const volumes = bars.map(b => b.volume);
    if (volumes.length >= 20) {
      const recentAvgVol = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
      const olderAvgVol = volumes.slice(-20, -5).reduce((a, b) => a + b, 0) / 15;
      if (olderAvgVol > 0) {
        const volRatio = recentAvgVol / olderAvgVol;
        if (volRatio > 1.3) {
          volumeTrend = 'INCREASING';
          reasons.push(`Volume tăng ${((volRatio - 1) * 100).toFixed(0)}% so với trung bình`);
        } else if (volRatio < 0.7) {
          volumeTrend = 'DECREASING';
          reasons.push(`Volume giảm ${((1 - volRatio) * 100).toFixed(0)}% so với trung bình`);
        } else {
          volumeTrend = 'STABLE';
        }
      }
    }

    // Support/Resistance for VN-Index
    const recentBars = bars.slice(-20);
    const recentLows = recentBars.map(b => b.low);
    const recentHighs = recentBars.map(b => b.high);
    supportLevel = Math.min(...recentLows);
    resistanceLevel = Math.max(...recentHighs);

    confidence += 20; // more confidence with historical data
  }

  // === Sector Analysis ===
  if (analysisData && analysisData.sectors && analysisData.sectors.length > 0) {
    const sorted = [...analysisData.sectors].sort((a, b) => b.change - a.change);
    topSectors = sorted.slice(0, 3);
    bottomSectors = sorted.slice(-3).reverse();

    const positiveCount = sorted.filter(s => s.change > 0).length;
    const ratio = positiveCount / sorted.length;
    if (ratio > 0.65) {
      healthScore += 8;
      reasons.push(`${Math.round(ratio * 100)}% ngành tăng - Thị trường tích cực toàn diện`);
    } else if (ratio < 0.35) {
      healthScore -= 8;
      reasons.push(`Chỉ ${Math.round(ratio * 100)}% ngành tăng - Thị trường tiêu cực`);
    }

    confidence += 10;
  }

  // === Determine Market Regime ===
  healthScore = Math.max(0, Math.min(100, healthScore));
  confidence = Math.max(0, Math.min(100, confidence));

  let regime: MarketRegime;
  let regimeLabel: string;
  let regimeEmoji: string;
  let vnindexTrend: string;

  if (healthScore >= 65) {
    regime = 'BULL';
    regimeLabel = 'Thị trường Tăng';
    regimeEmoji = '🐂';
    vnindexTrend = 'Xu hướng tăng';
  } else if (healthScore <= 35) {
    regime = 'BEAR';
    regimeLabel = 'Thị trường Giảm';
    regimeEmoji = '🐻';
    vnindexTrend = 'Xu hướng giảm';
  } else {
    regime = 'SIDEWAYS';
    regimeLabel = 'Thị trường Đi ngang';
    regimeEmoji = '🦀';
    vnindexTrend = 'Đi ngang / Tích lũy';
  }

  return {
    regime, regimeLabel, regimeEmoji,
    healthScore, confidence,
    vnindexTrend,
    vnindexSMA50: Math.round(vnindexSMA50 * 100) / 100,
    vnindexSMA200: Math.round(vnindexSMA200 * 100) / 100,
    vnindexRSI: Math.round(vnindexRSI * 10) / 10,
    breadthRatio: Math.round(breadthRatio * 100) / 100,
    volatilityRegime,
    volumeTrend,
    supportLevel: Math.round(supportLevel * 100) / 100,
    resistanceLevel: Math.round(resistanceLevel * 100) / 100,
    topSectors,
    bottomSectors,
    reasons,
  };
}

// Adjust recommendation weights based on market context
export function getMarketWeights(ctx: MarketContext): { techWeight: number; fundWeight: number; riskPenalty: number } {
  let techWeight = 0.4;
  let fundWeight = 0.6;
  let riskPenalty = 0;

  if (ctx.regime === 'BULL') {
    techWeight = 0.50;
    fundWeight = 0.50;
  } else if (ctx.regime === 'BEAR') {
    techWeight = 0.35;
    fundWeight = 0.65;
    riskPenalty = 10; // harder to get BUY signal in bear markets
  } else {
    techWeight = 0.30;
    fundWeight = 0.70;
    riskPenalty = 5;
  }

  if (ctx.volatilityRegime === 'HIGH') {
    riskPenalty += 8;
  }

  return { techWeight, fundWeight, riskPenalty };
}
