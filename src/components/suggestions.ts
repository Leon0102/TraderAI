// Suggestions Component
// Renders investment suggestion cards for short-term and long-term

import type { TechnicalSignal } from '../analysis/technicalAnalysis';
import type { FundamentalSignal } from '../analysis/fundamentalAnalysis';

export function renderShortTermSuggestions(signals: TechnicalSignal[]) {
  const container = document.getElementById('shortTermCards');
  if (!container) return;

  // Sort by strength, show BUY first, then HOLD, then SELL
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

    const metricsHtml = Object.entries(signal.metrics)
      .map(([key, value]) => `<span class="metric-tag">${key}: ${value}</span>`)
      .join('');

    const reasonsHtml = signal.reasons.slice(0, 3)
      .map(r => `• ${r}`)
      .join('<br>');

    return `
      <div class="suggestion-card" data-ticker="${signal.ticker}">
        <div class="suggestion-card-header">
          <span class="suggestion-card-symbol">${signal.ticker}</span>
          <span class="suggestion-card-signal ${signalClass}">${signalText}</span>
        </div>
        <div class="suggestion-card-reason">${reasonsHtml}</div>
        <div class="suggestion-card-metrics">${metricsHtml}</div>
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
}

export function renderLongTermSuggestions(signals: FundamentalSignal[]) {
  const container = document.getElementById('longTermCards');
  if (!container) return;

  // Sort by score descending
  const sorted = [...signals].sort((a, b) => b.score - a.score);

  container.innerHTML = sorted.slice(0, 5).map(signal => {
    const signalClass = signal.signal === 'BUY' ? 'signal-buy' :
                        signal.signal === 'SELL' ? 'signal-sell' : 'signal-hold';
    const signalText = signal.signal === 'BUY' ? '🟢 ĐẦU TƯ' :
                       signal.signal === 'SELL' ? '🔴 TRÁNH' : '🟡 THEO DÕI';

    const metricsHtml = Object.entries(signal.metrics)
      .map(([key, value]) => `<span class="metric-tag">${key}: ${value}</span>`)
      .join('');

    const reasonsHtml = signal.reasons.slice(0, 3)
      .map(r => `• ${r}`)
      .join('<br>');

    return `
      <div class="suggestion-card" data-ticker="${signal.ticker}">
        <div class="suggestion-card-header">
          <span class="suggestion-card-symbol">${signal.ticker}</span>
          <span class="suggestion-card-signal ${signalClass}">${signalText}</span>
        </div>
        <div class="suggestion-card-reason">${reasonsHtml}</div>
        <div class="suggestion-card-metrics">${metricsHtml}</div>
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
}
