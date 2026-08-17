// Suggestions Component - Enhanced v2
// Renders investment suggestion cards with market context, confidence levels,
// investment type classification, and improved combined scoring

import type { TechnicalSignal } from '../analysis/technicalAnalysis';
import type { FundamentalSignal } from '../analysis/fundamentalAnalysis';
import type { MarketContext } from '../analysis/marketAnalysis';
import type { NewsSignal } from '../analysis/newsAnalysis';
import { getMarketWeights } from '../analysis/marketAnalysis';
import { openStockDetail } from './stockDetail';
import { addToWatchlist, isInWatchlist } from './watchlist';

let currentMarketContext: MarketContext | null = null;
let newsSignals: Map<string, NewsSignal> = new Map();

export function setMarketContext(ctx: MarketContext) {
  currentMarketContext = ctx;
}

export function setNewsSignals(signals: Map<string, NewsSignal>) {
  newsSignals = signals;
}

export function renderShortTermSuggestions(signals: TechnicalSignal[]) {
  const container = document.getElementById('shortTermCards');
  if (!container) return;

  const sorted = [...signals].sort((a, b) => {
    const order = { BUY: 0, HOLD: 1, SELL: 2 };
    if (order[a.signal] !== order[b.signal]) return order[a.signal] - order[b.signal];
    return b.strength - a.strength;
  });

  const marketBadge = currentMarketContext
    ? `<div class="market-context-badge">${currentMarketContext.regimeEmoji} ${currentMarketContext.regimeLabel}</div>`
    : '';

  container.innerHTML = marketBadge + sorted.slice(0, 6).map(signal => {
    const signalClass = signal.signal === 'BUY' ? 'signal-buy' :
                        signal.signal === 'SELL' ? 'signal-sell' : 'signal-hold';
    const signalText = signal.signal === 'BUY' ? '🟢 MUA' :
                       signal.signal === 'SELL' ? '🔴 BÁN' : '🟡 GIỮ';
    const riskClass = `risk-${signal.risk.toLowerCase()}`;
    const riskText = signal.risk === 'LOW' ? 'Thấp' : signal.risk === 'MEDIUM' ? 'TB' : 'Cao';
    const watched = isInWatchlist(signal.ticker);

    const consensus = signal.metrics['Consensus'] || 0;
    const rrRatio = signal.metrics['R/R'] || 0;
    const confidenceClass = consensus >= 70 ? 'confidence-high' : consensus >= 50 ? 'confidence-mid' : 'confidence-low';

    // Determine trade type based on ADX and pattern
    const adx = signal.metrics['ADX'] || 0;
    const tradeType = adx > 25 ? 'Swing Trade (3-5 ngày)' : 'Position Trade (2-4 tuần)';

    const metricsHtml = Object.entries(signal.metrics)
      .filter(([k]) => !['Consensus', 'R/R'].includes(k))
      .map(([key, value]) => `<span class="metric-tag">${key}: ${typeof value === 'number' ? value.toFixed(1) : value}</span>`)
      .join('');

    const reasonsHtml = signal.reasons.slice(0, 4)
      .map(r => `• ${r}`)
      .join('<br>');

    return `
      <div class="suggestion-card ${signalClass}-accent" data-ticker="${signal.ticker}">
        <div class="suggestion-card-header">
          <div class="suggestion-card-left">
            <span class="suggestion-card-symbol">${signal.ticker}</span>
            <span class="risk-badge ${riskClass}">${riskText}</span>
          </div>
          <div class="suggestion-card-right">
            <button class="watch-btn ${watched ? 'watched' : ''}" data-watch="${signal.ticker}">${watched ? '★' : '☆'}</button>
            <span class="suggestion-card-signal ${signalClass}">${signalText}</span>
          </div>
        </div>

        <div class="strength-meter">
          <div class="strength-meter-bar">
            <div class="strength-meter-fill" style="width: ${signal.strength}%; background: ${signal.strength > 60 ? 'var(--green)' : signal.strength < 40 ? 'var(--red)' : 'var(--yellow)'};"></div>
          </div>
          <span class="strength-meter-value">${signal.strength}<small>/100</small></span>
          <span class="confidence-badge ${confidenceClass}" title="Mức đồng thuận các chỉ báo">${consensus}% đồng thuận</span>
        </div>

        <div class="trade-type-badge">${tradeType}</div>
        <div class="suggestion-card-reason">${reasonsHtml}</div>
        <div class="suggestion-card-metrics">${metricsHtml}</div>

        <div class="suggestion-card-levels">
          <div class="level-mini">
            <span class="level-label">Hỗ trợ</span>
            <span class="level-value support-text">${signal.supportLevel}</span>
          </div>
          <div class="level-mini">
            <span class="level-label">Kháng cự</span>
            <span class="level-value resist-text">${signal.resistanceLevel}</span>
          </div>
          <div class="level-mini">
            <span class="level-label">Mục tiêu</span>
            <span class="level-value target-text">${signal.targetPrice}</span>
          </div>
          <div class="level-mini">
            <span class="level-label">Cắt lỗ</span>
            <span class="level-value stoploss-text">${signal.stopLoss}</span>
          </div>
          <div class="level-mini">
            <span class="level-label">R/R</span>
            <span class="level-value ${rrRatio >= 2 ? 'target-text' : rrRatio >= 1 ? '' : 'stoploss-text'}">${rrRatio > 0 ? rrRatio + ':1' : '—'}</span>
          </div>
        </div>

        ${signal.pattern ? `<div class="suggestion-card-pattern">${signal.pattern}</div>` : ''}
      </div>
    `;
  }).join('');

  attachCardHandlers(container);
}

export function renderLongTermSuggestions(signals: FundamentalSignal[]) {
  const container = document.getElementById('longTermCards');
  if (!container) return;

  const sorted = [...signals].sort((a, b) => b.score - a.score);

  container.innerHTML = sorted.slice(0, 6).map(signal => {
    const signalClass = signal.signal === 'BUY' ? 'signal-buy' :
                        signal.signal === 'SELL' ? 'signal-sell' : 'signal-hold';
    const signalText = signal.signal === 'BUY' ? '🟢 ĐẦU TƯ' :
                       signal.signal === 'SELL' ? '🔴 TRÁNH' : '🟡 THEO DÕI';
    const watched = isInWatchlist(signal.ticker);
    const bd = signal.scoreBreakdown;

    const investTypeEmoji = signal.investmentType === 'VALUE' ? '💎' :
                            signal.investmentType === 'GROWTH' ? '🚀' :
                            signal.investmentType === 'DIVIDEND' ? '💰' : '⚖️';
    const investTypeText = signal.investmentType === 'VALUE' ? 'Value Play' :
                           signal.investmentType === 'GROWTH' ? 'Growth Play' :
                           signal.investmentType === 'DIVIDEND' ? 'Dividend Play' : 'Balanced';

    const metricsHtml = Object.entries(signal.metrics)
      .map(([key, value]) => `<span class="metric-tag">${key}: ${value}</span>`)
      .join('');

    const reasonsHtml = signal.reasons.slice(0, 4)
      .map(r => `• ${r}`)
      .join('<br>');

    return `
      <div class="suggestion-card ${signalClass}-accent" data-ticker="${signal.ticker}">
        <div class="suggestion-card-header">
          <div class="suggestion-card-left">
            <span class="suggestion-card-symbol">${signal.ticker}</span>
            <span class="cap-badge">${signal.capSize === 'Large' ? '🏛️' : signal.capSize === 'Mid' ? '🏢' : '🏠'}</span>
            <span class="invest-type-badge">${investTypeEmoji} ${investTypeText}</span>
          </div>
          <div class="suggestion-card-right">
            <button class="watch-btn ${watched ? 'watched' : ''}" data-watch="${signal.ticker}">${watched ? '★' : '☆'}</button>
            <span class="suggestion-card-signal ${signalClass}">${signalText}</span>
          </div>
        </div>

        <div class="strength-meter">
          <div class="strength-meter-bar">
            <div class="strength-meter-fill" style="width: ${signal.score}%; background: ${signal.score > 60 ? 'var(--green)' : signal.score < 40 ? 'var(--red)' : 'var(--yellow)'};"></div>
          </div>
          <span class="strength-meter-value">${signal.score}<small>/100</small></span>
        </div>

        <div class="holding-period-badge">📅 ${signal.holdingPeriod}</div>
        <div class="suggestion-card-reason">${reasonsHtml}</div>
        <div class="suggestion-card-metrics">${metricsHtml}</div>

        <div class="score-breakdown-mini">
          <div class="sb-row"><span>Định giá</span><div class="sb-bar"><div style="width:${bd.valuation * 5}%; background:#6366f1"></div></div><span class="sb-val">${bd.valuation}/20</span></div>
          <div class="sb-row"><span>Sinh lời</span><div class="sb-bar"><div style="width:${bd.profitability * 5}%; background:#10b981"></div></div><span class="sb-val">${bd.profitability}/20</span></div>
          <div class="sb-row"><span>Tăng trưởng</span><div class="sb-bar"><div style="width:${bd.growth * 5}%; background:#f59e0b"></div></div><span class="sb-val">${bd.growth}/20</span></div>
          <div class="sb-row"><span>Chất lượng</span><div class="sb-bar"><div style="width:${bd.quality * 5}%; background:#ec4899"></div></div><span class="sb-val">${bd.quality}/20</span></div>
          <div class="sb-row"><span>Tài chính</span><div class="sb-bar"><div style="width:${bd.financialHealth * 5}%; background:#14b8a6"></div></div><span class="sb-val">${bd.financialHealth}/20</span></div>
        </div>

        ${signal.intrinsicValue ? `<div class="suggestion-card-intrinsic">${signal.intrinsicValue}</div>` : ''}
      </div>
    `;
  }).join('');

  attachCardHandlers(container);
}

export function renderCombinedSuggestions(techSignals: TechnicalSignal[], fundSignals: FundamentalSignal[]) {
  const container = document.getElementById('combinedCards');
  if (!container) return;

  const weights = currentMarketContext ? getMarketWeights(currentMarketContext) : { techWeight: 0.4, fundWeight: 0.6, riskPenalty: 0 };

  const combined = techSignals.map(tech => {
    const fund = fundSignals.find(f => f.ticker === tech.ticker);
    const news = newsSignals.get(tech.ticker);
    const newsBoost = news ? news.impactModifier * 0.3 : 0;
    const rawScore = Math.round(tech.strength * weights.techWeight + (fund?.score ?? 50) * weights.fundWeight + newsBoost);
    const combinedScore = Math.max(0, Math.min(100, rawScore - weights.riskPenalty));
    return { ticker: tech.ticker, techSignal: tech, fundSignal: fund, newsSignal: news, combinedScore };
  }).sort((a, b) => b.combinedScore - a.combinedScore);

  const marketBadge = currentMarketContext
    ? `<div class="market-context-badge combined-market-badge">
         ${currentMarketContext.regimeEmoji} ${currentMarketContext.regimeLabel}
         <span class="market-health-mini">Sức khỏe: ${currentMarketContext.healthScore}/100</span>
         <span class="market-weights-mini">Tỷ trọng: KT ${Math.round(weights.techWeight * 100)}% / CB ${Math.round(weights.fundWeight * 100)}%</span>
       </div>`
    : '';

  container.innerHTML = marketBadge + combined.slice(0, 6).map(item => {
    const s = item.combinedScore;
    const signal = s >= 65 ? 'BUY' : s <= 35 ? 'SELL' : 'HOLD';
    const signalClass = signal === 'BUY' ? 'signal-buy' : signal === 'SELL' ? 'signal-sell' : 'signal-hold';
    const signalText = signal === 'BUY' ? '🟢 KHUYẾN NGHỊ MUA' : signal === 'SELL' ? '🔴 KHUYẾN NGHỊ BÁN' : '🟡 THEO DÕI';

    const consensus = item.techSignal.metrics['Consensus'] || 0;
    const investType = item.fundSignal?.investmentType || 'BALANCED';
    const investEmoji = investType === 'VALUE' ? '💎' : investType === 'GROWTH' ? '🚀' : investType === 'DIVIDEND' ? '💰' : '⚖️';

    // News sentiment badge
    const ns = item.newsSignal;
    const newsBadge = ns
      ? `<span class="news-mini-badge ${ns.sentimentScore > 15 ? 'news-badge-pos' : ns.sentimentScore < -15 ? 'news-badge-neg' : 'news-badge-neu'}" title="Sentiment: ${ns.sentimentScore}, ${ns.momentum}">${ns.sentimentScore > 15 ? '🟢↑' : ns.sentimentScore < -15 ? '🔴↓' : '🟡→'} ${ns.sentimentScore > 0 ? '+' : ''}${ns.sentimentScore}</span>`
      : '';

    // Detailed recommendation text
    let recommendation = '';
    if (signal === 'BUY') {
      if (item.techSignal.signal === 'BUY' && item.fundSignal?.signal === 'BUY') {
        recommendation = `✅ Cả kỹ thuật & cơ bản đều tích cực. Entry: ${item.techSignal.supportLevel} - ${item.techSignal.stopLoss > 0 ? 'SL: ' + item.techSignal.stopLoss : ''}`;
      } else if (item.fundSignal?.signal === 'BUY') {
        recommendation = `📊 Cơ bản mạnh (${investEmoji}). Chờ tín hiệu kỹ thuật xác nhận để vào lệnh`;
      } else {
        recommendation = `⚡ Kỹ thuật tích cực. Mục tiêu ngắn hạn: ${item.techSignal.targetPrice}`;
      }
    } else if (signal === 'SELL') {
      recommendation = '⚠️ Không nên mở vị thế mới. Xem xét cắt lỗ nếu đang nắm giữ';
    } else {
      recommendation = '👀 Theo dõi và chờ tín hiệu rõ ràng hơn';
    }

    return `
      <div class="suggestion-card combined-card ${signalClass}-accent" data-ticker="${item.ticker}">
        <div class="suggestion-card-header">
          <span class="suggestion-card-symbol">${item.ticker}</span>
          <span class="invest-type-badge">${investEmoji}</span>
          ${newsBadge}
          <span class="suggestion-card-signal ${signalClass}">${signalText}</span>
        </div>
        <div class="combined-scores">
          <div class="cs-item">
            <span class="cs-label">Kỹ thuật</span>
            <div class="cs-circle" style="--score: ${item.techSignal.strength}">${item.techSignal.strength}%</div>
          </div>
          <div class="cs-item">
            <span class="cs-label">Cơ bản</span>
            <div class="cs-circle" style="--score: ${item.fundSignal?.score ?? 50}">${item.fundSignal?.score ?? '—'}</div>
          </div>
          <div class="cs-item">
            <span class="cs-label">Đồng thuận</span>
            <div class="cs-circle" style="--score: ${consensus}">${consensus}%</div>
          </div>
          ${ns ? `<div class="cs-item">
            <span class="cs-label">Tin tức</span>
            <div class="cs-circle" style="--score: ${Math.max(0, Math.min(100, 50 + ns.sentimentScore))}">${ns.sentimentScore > 0 ? '+' : ''}${ns.sentimentScore}</div>
          </div>` : ''}
          <div class="cs-item cs-total">
            <span class="cs-label">Tổng</span>
            <div class="cs-circle cs-main" style="--score: ${s}">${s}</div>
          </div>
        </div>
        <div class="combined-recommendation">${recommendation}</div>
        <div style="margin-top: 8px;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <div style="flex: 1; height: 5px; background: rgba(255,255,255,0.1); border-radius: 2px; overflow: hidden;">
              <div style="height: 100%; width: ${s}%; background: ${s > 60 ? 'var(--green)' : s < 40 ? 'var(--red)' : 'var(--yellow)'}; border-radius: 2px; transition: width 0.5s ease;"></div>
            </div>
            <span style="font-size: 0.8rem; color: var(--text-muted); min-width: 45px; font-weight: 600;">${s}/100</span>
          </div>
        </div>
      </div>
    `;
  }).join('');

  container.querySelectorAll('.suggestion-card').forEach(card => {
    card.addEventListener('click', () => {
      const ticker = (card as HTMLElement).dataset.ticker;
      if (ticker) openStockDetail(ticker);
    });
  });
}

function attachCardHandlers(container: HTMLElement) {
  container.querySelectorAll('.suggestion-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.watch-btn')) return;
      const ticker = (card as HTMLElement).dataset.ticker;
      if (ticker) openStockDetail(ticker);
    });
  });

  container.querySelectorAll('.watch-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const ticker = (btn as HTMLElement).dataset.watch!;
      addToWatchlist(ticker);
      (btn as HTMLElement).textContent = '★';
      (btn as HTMLElement).classList.add('watched');
    });
  });
}
