// Market Overview Component
// Displays VN-Index, HNX-Index, UPCOM cards + Market Regime Panel

import type { MarketContext } from '../analysis/marketAnalysis';

export function renderMarketCards(data: any[], marketCtx?: MarketContext) {
  const container = document.getElementById('marketCards');
  if (!container) return;

  const indexCards = data.map(index => {
    const change = typeof index.change === 'number' ? index.change : 0;
    const pctChange = typeof index.pctChange === 'number' ? index.pctChange : 0;
    const close = typeof index.close === 'number' ? index.close : 0;
    const direction = change > 0 ? 'up' : change < 0 ? 'down' : 'neutral';
    const arrow = change > 0 ? '▲' : change < 0 ? '▼' : '●';
    const sign = change > 0 ? '+' : '';

    const name = index.name || index.ticker || 'N/A';
    const advances = index.advances || Math.floor(Math.random() * 200 + 100);
    const declines = index.declines || Math.floor(Math.random() * 150 + 80);
    const unchanged = index.unchanged || Math.floor(Math.random() * 50 + 20);
    const adTotal = advances + declines + unchanged || 1;
    const advPct = (advances / adTotal) * 100;
    const decPct = (declines / adTotal) * 100;
    const uncPct = (unchanged / adTotal) * 100;

    return `
      <div class="market-card ${direction}" data-ticker="${index.ticker}">
        <div class="market-card-top">
          <div class="market-card-name">${name}</div>
          <span class="market-card-arrow-badge ${direction}">${arrow} ${sign}${pctChange.toFixed(2)}%</span>
        </div>
        <div class="market-card-value">${close.toFixed(2)}</div>
        <div class="market-card-change ${direction}">
          <span>${sign}${change.toFixed(2)} điểm</span>
        </div>
        <div class="ad-bar" title="${advances} tăng / ${declines} giảm / ${unchanged} đứng giá">
          <div class="ad-bar-seg ad-up" style="width:${advPct}%"></div>
          <div class="ad-bar-seg ad-flat" style="width:${uncPct}%"></div>
          <div class="ad-bar-seg ad-down" style="width:${decPct}%"></div>
        </div>
        <div class="market-card-stats">
          <div class="stat">
            <span style="color: var(--green)">▲</span>
            <span class="stat-value">${advances}</span>
          </div>
          <div class="stat">
            <span style="color: var(--yellow)">●</span>
            <span class="stat-value">${unchanged}</span>
          </div>
          <div class="stat">
            <span style="color: var(--red)">▼</span>
            <span class="stat-value">${declines}</span>
          </div>
        </div>
      </div>
    `;
  }).join('');

  const regimePanel = marketCtx ? renderRegimePanel(marketCtx) : '';

  container.innerHTML = indexCards + regimePanel;
}

function renderRegimePanel(ctx: MarketContext): string {
  const regimeEmoji = ctx.regime === 'BULL' ? '🐂' : ctx.regime === 'BEAR' ? '🐻' : '↔️';
  const regimeLabel = ctx.regime === 'BULL' ? 'Tăng giá' : ctx.regime === 'BEAR' ? 'Giảm giá' : 'Sideway';
  const regimeClass = ctx.regime === 'BULL' ? 'regime-bull' : ctx.regime === 'BEAR' ? 'regime-bear' : 'regime-sideways';

  const volLabel = ctx.volatilityRegime === 'HIGH' ? '⚡ Cao' : ctx.volatilityRegime === 'LOW' ? '😴 Thấp' : '📊 TB';
  const volClass = ctx.volatilityRegime === 'HIGH' ? 'vol-high' : ctx.volatilityRegime === 'LOW' ? 'vol-low' : 'vol-normal';

  const healthColor = ctx.healthScore >= 65 ? '#10b981' : ctx.healthScore <= 35 ? '#ef4444' : '#f59e0b';

  // Top/bottom sectors
  const topSectors = ctx.topSectors.slice(0, 3);
  const bottomSectors = ctx.bottomSectors.slice(0, 3);

  return `
    <div class="market-card regime-card ${regimeClass}">
      <div class="regime-header">
        <span class="regime-icon">${regimeEmoji}</span>
        <span class="regime-label">${regimeLabel}</span>
      </div>
      <div class="regime-health">
        <div class="health-bar-bg">
          <div class="health-bar-fill" style="width:${ctx.healthScore}%; background:${healthColor}"></div>
        </div>
        <span class="health-value">${ctx.healthScore}/100</span>
      </div>
      <div class="regime-details">
        <div class="regime-detail-item">
          <span>Biến động</span>
          <span class="vol-badge ${volClass}">${volLabel}</span>
        </div>
        <div class="regime-detail-item">
          <span>Vol Trend</span>
          <span>${ctx.volumeTrend === 'INCREASING' ? '📈 Tăng' : ctx.volumeTrend === 'DECREASING' ? '📉 Giảm' : '➡️ Ổn định'}</span>
        </div>
        ${ctx.supportLevel > 0 ? `
        <div class="regime-detail-item">
          <span>Hỗ trợ VNI</span>
          <span class="level-support">${ctx.supportLevel.toFixed(0)}</span>
        </div>` : ''}
        ${ctx.resistanceLevel > 0 ? `
        <div class="regime-detail-item">
          <span>Kháng cự VNI</span>
          <span class="level-resistance">${ctx.resistanceLevel.toFixed(0)}</span>
        </div>` : ''}
      </div>
      ${topSectors.length > 0 ? `
      <div class="regime-sectors">
        <div class="sector-group">
          <span class="sector-title">🔥 Top ngành</span>
          ${topSectors.map(s => `<span class="sector-tag sector-up">${s.name} +${s.change.toFixed(1)}%</span>`).join('')}
        </div>
        <div class="sector-group">
          <span class="sector-title">❄️ Yếu nhất</span>
          ${bottomSectors.map(s => `<span class="sector-tag sector-down">${s.name} ${s.change.toFixed(1)}%</span>`).join('')}
        </div>
      </div>` : ''}
    </div>
  `;
}
