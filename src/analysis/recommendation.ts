import type { TechnicalSignal } from './technicalAnalysis';
import type { FundamentalSignal } from './fundamentalAnalysis';
import type { NewsSignal } from './newsAnalysis';

export type Decision = 'BUY' | 'HOLD' | 'SELL';

export interface Recommendation {
  score: number;
  decision: Decision;
  warnings: string[];
}

const currentRecommendations = new Map<string, Recommendation>();

export function setCurrentRecommendations(items: Array<{ ticker: string; combinedScore: number; decision: Decision; warnings: string[] }>) {
  currentRecommendations.clear();
  items.forEach(item => currentRecommendations.set(item.ticker, {
    score: item.combinedScore, decision: item.decision, warnings: item.warnings,
  }));
}

export function getCurrentRecommendation(ticker: string): Recommendation | undefined {
  return currentRecommendations.get(ticker);
}

/** One verdict for the board, detail, chart picker and capital allocator. */
export function scoreRecommendation(
  tech: TechnicalSignal,
  fund?: FundamentalSignal | null,
  news?: NewsSignal | null,
  weights = { techWeight: 0.4, fundWeight: 0.6, riskPenalty: 0 },
): Recommendation {
  const newsBoost = news ? news.impactModifier * 0.3 : 0;
  let score = Math.max(0, Math.min(100, Math.round(
    tech.strength * weights.techWeight + (fund?.score ?? 50) * weights.fundWeight + newsBoost - weights.riskPenalty,
  )));
  const warnings: string[] = [];
  const rsi = tech.metrics['RSI'];
  if (Number.isFinite(rsi) && rsi >= 75) warnings.push(`RSI ${rsi.toFixed(1)}: quá mua`);
  if (tech.signal === 'SELL') warnings.push('Kỹ thuật đang cho tín hiệu bán');
  if (fund?.signal === 'SELL') warnings.push('Nền tảng cơ bản yếu');
  if (!fund) warnings.push('Thiếu dữ liệu cơ bản');
  if (news && news.impactModifier <= -15) warnings.push('Tin tức bất lợi');
  if (/Double Top|Bear Flag|đảo chiều giảm|giảm giá/i.test(tech.pattern)) warnings.push('Mẫu hình giá có rủi ro giảm');
  if (tech.entryPrice <= 0 || tech.targetPrice <= tech.entryPrice || tech.stopLoss >= tech.entryPrice) {
    warnings.push('Kế hoạch giá chưa hợp lệ');
  }
  if (score >= 65 && tech.signal !== 'BUY' && tech.signal !== 'SELL') warnings.push('Kỹ thuật chưa xác nhận mua');
  if (score >= 65 && fund?.signal === 'HOLD') warnings.push('Cơ bản chưa xác nhận mua');

  // A high average cannot override a concrete contradiction or missing input.
  if (warnings.length) score = Math.min(score, 64);
  const decision: Decision = score >= 65 && tech.signal === 'BUY' && fund?.signal === 'BUY'
    ? 'BUY'
    : score <= 35 && tech.signal === 'SELL' ? 'SELL' : 'HOLD';
  return { score, decision, warnings };
}
