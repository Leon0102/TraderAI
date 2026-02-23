// Suggestions Component - Enhanced
// Renders investment suggestion cards with support/resistance,
// risk levels, target prices, and combined scoring tab

import type { TechnicalSignal } from '../analysis/technicalAnalysis';
import type { FundamentalSignal } from '../analysis/fundamentalAnalysis';
import { openStockDetail } from './stockDetail';
import { addToWatchlist, isInWatchlist } from './watchlist';

export function renderShortTermSuggestions(signals: TechnicalSignal[]) {
  const container = document.getElementById('shortTermCards');
  if (!container) return;

  const sorted = [...signals].sort((a, b) => {
    const order = { BUY: 0, HOLD: 1, SELL: 2 };
    if (order[a.signal] !== order[b.signal]) return order[a.signal] - order[b.signal];
    return b.strength - a.strength;
  });

  container.innerHTML = sorted.slice(0, 5).map(signal => {
    const signalClass = signal.signal === 'BUY' ? 'signal-buy' :
                        signal.signal === 'SELL' ? 'signal-sell' : 'signal-hold';
    const signalText = signal.signal === 'BUY' ? '🟢 MUA' :
                       signal.signal === 'SELL' ? '🔴 BÁN' : '🟡 GIỮ';
    const riskClass = `risk-${signal.risk.toLowerCase()}`;
    const riskText = signal.risk === 'LOW' ? 'Thấp' : signal.risk === 'MEDIUM' ? 'TB' : 'Cao';
    const watched = isInWatchlist(signal.ticker);

    const metricsHtml = Object.entries(signal.metrics)
      .map(([key, value]) => `<span class="metric-tag">${key}: ${typeof value === 'number' ? value.toFixed(1) : value}</span>`)
      .join('');

    const reasonsHtml = signal.reasons.slice(0, 3)
      .map(r => `• ${r}`)
      .join('<br>');

    return `
      <div class="suggestion-card" data-ticker="${signal.ticker}">
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
        <div class="suggestion-card-reason">${reasonsHtml}</div>
        <div class="suggestion-card-metrics">${metricsHtml}</div>

        <!-- S/R + Target -->
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
        </div>

        ${signal.pattern ? `<div class="suggestion-card-pattern">${signal.pattern}</div>` : ''}

        <div style="margin-top: 8px;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <div style="flex: 1; height: 4px; background: rgba(255,255,255,0.1); border-radius: 2px; overflow: hidden;">
              <div style="height: 100%; width: ${signal.strength}%; background: ${signal.strength > 60 ? 'var(--green)' : signal.strength < 40 ? 'var(--red)' : 'var(--yellow)'}; border-radius: 2px; transition: width 0.5s ease;"></div>
            </div>
            <span style="font-size: 0.75rem; color: var(--text-muted); min-width: 35px;">${signal.strength}%</span>
          </div>
        </div>
      </div>
    `;
  }).join('');

  // Event handlers
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

export function renderLongTermSuggestions(signals: FundamentalSignal[]) {
  const container = document.getElementById('longTermCards');
  if (!container) return;

  const sorted = [...signals].sort((a, b) => b.score - a.score);

  container.innerHTML = sorted.slice(0, 5).map(signal => {
    const signalClass = signal.signal === 'BUY' ? 'signal-buy' :
                        signal.signal === 'SELL' ? 'signal-sell' : 'signal-hold';
    const signalText = signal.signal === 'BUY' ? '🟢 ĐẦU TƯ' :
                       signal.signal === 'SELL' ? '🔴 TRÁNH' : '🟡 THEO DÕI';
    const watched = isInWatchlist(signal.ticker);
    const bd = signal.scoreBreakdown;

    const metricsHtml = Object.entries(signal.metrics)
      .map(([key, value]) => `<span class="metric-tag">${key}: ${value}</span>`)
      .join('');

    const reasonsHtml = signal.reasons.slice(0, 3)
      .map(r => `• ${r}`)
      .join('<br>');

    return `
      <div class="suggestion-card" data-ticker="${signal.ticker}">
        <div class="suggestion-card-header">
          <div class="suggestion-card-left">
            <span class="suggestion-card-symbol">${signal.ticker}</span>
            <span class="cap-badge">${signal.capSize === 'Large' ? '🏛️' : signal.capSize === 'Mid' ? '🏢' : '🏠'}</span>
          </div>
          <div class="suggestion-card-right">
            <button class="watch-btn ${watched ? 'watched' : ''}" data-watch="${signal.ticker}">${watched ? '★' : '☆'}</button>
            <span class="suggestion-card-signal ${signalClass}">${signalText}</span>
          </div>
        </div>
        <div class="suggestion-card-reason">${reasonsHtml}</div>
        <div class="suggestion-card-metrics">${metricsHtml}</div>

        <!-- Score Breakdown Mini Bars -->
        <div class="score-breakdown-mini">
          <div class="sb-row"><span>Giá trị</span><div class="sb-bar"><div style="width:${bd.valuation * 4}%; background:#6366f1"></div></div></div>
          <div class="sb-row"><span>Sinh lời</span><div class="sb-bar"><div style="width:${bd.profitability * 4}%; background:#10b981"></div></div></div>
          <div class="sb-row"><span>Tăng trưởng</span><div class="sb-bar"><div style="width:${bd.growth * 4}%; background:#f59e0b"></div></div></div>
          <div class="sb-row"><span>Chất lượng</span><div class="sb-bar"><div style="width:${bd.quality * 4}%; background:#ec4899"></div></div></div>
        </div>

        ${signal.intrinsicValue ? `<div class="suggestion-card-intrinsic">${signal.intrinsicValue}</div>` : ''}

        <div style="margin-top: 8px;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <div style="flex: 1; height: 4px; background: rgba(255,255,255,0.1); border-radius: 2px; overflow: hidden;">
              <div style="height: 100%; width: ${signal.score}%; background: ${signal.score > 60 ? 'var(--green)' : signal.score < 40 ? 'var(--red)' : 'var(--yellow)'}; border-radius: 2px; transition: width 0.5s ease;"></div>
            </div>
            <span style="font-size: 0.75rem; color: var(--text-muted); min-width: 35px;">${signal.score}/100</span>
          </div>
        </div>
      </div>
    `;
  }).join('');

  // Event handlers
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

export function renderCombinedSuggestions(techSignals: TechnicalSignal[], fundSignals: FundamentalSignal[]) {
  const container = document.getElementById('combinedCards');
  if (!container) return;

  // Match by ticker and compute combined score
  const combined = techSignals.map(tech => {
    const fund = fundSignals.find(f => f.ticker === tech.ticker);
    const combinedScore = Math.round(tech.strength * 0.4 + (fund?.score ?? 50) * 0.6);
    return { ticker: tech.ticker, techSignal: tech, fundSignal: fund, combinedScore };
  }).sort((a, b) => b.combinedScore - a.combinedScore);

  container.innerHTML = combined.slice(0, 5).map(item => {
    const s = item.combinedScore;
    const signal = s >= 65 ? 'BUY' : s <= 35 ? 'SELL' : 'HOLD';
    const signalClass = signal === 'BUY' ? 'signal-buy' : signal === 'SELL' ? 'signal-sell' : 'signal-hold';
    const signalText = signal === 'BUY' ? '🟢 KHUYẾN NGHỊ MUA' : signal === 'SELL' ? '🔴 KHUYẾN NGHỊ BÁN' : '🟡 THEO DÕI';

    return `
      <div class="suggestion-card combined-card" data-ticker="${item.ticker}">
        <div class="suggestion-card-header">
          <span class="suggestion-card-symbol">${item.ticker}</span>
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
          <div class="cs-item cs-total">
            <span class="cs-label">Tổng</span>
            <div class="cs-circle cs-main" style="--score: ${s}">${s}</div>
          </div>
        </div>
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
