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
    const advances = index.advances || 0;
    const declines = index.declines || 0;
    const unchanged = index.unchanged || 0;
    const hasBreadth = advances + declines + unchanged > 0;
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
        ${hasBreadth ? `
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
        </div>` : ''}
      </div>
    `;
  }).join('');

  const regimePanel = marketCtx ? renderRegimePanel(marketCtx) : '';

  container.innerHTML = indexCards + regimePanel;
}

// Small live-data strip under the hero title, so the landing view reads as
// "here's today's market" rather than pure marketing copy above the fold.
function renderRegimePanel(ctx: MarketContext): string {
  const regimeLabel = ctx.regime === 'BULL' ? 'Tăng giá' : ctx.regime === 'BEAR' ? 'Giảm giá' : 'Sideway';
  const regimeClass = ctx.regime === 'BULL' ? 'regime-bull' : ctx.regime === 'BEAR' ? 'regime-bear' : 'regime-sideways';

  const volLabel = ctx.volatilityRegime === 'HIGH' ? 'Cao' : ctx.volatilityRegime === 'LOW' ? 'Thấp' : 'Trung bình';
  const volClass = ctx.volatilityRegime === 'HIGH' ? 'vol-high' : ctx.volatilityRegime === 'LOW' ? 'vol-low' : 'vol-normal';

  const healthColor = ctx.healthScore >= 65 ? 'var(--up)' : ctx.healthScore <= 35 ? 'var(--down)' : 'var(--ref)';

  // Top/bottom sectors
  const topSectors = ctx.topSectors.slice(0, 3);
  const bottomSectors = ctx.bottomSectors.slice(0, 3);

  return `
    <div class="market-card regime-card ${regimeClass}">
      <div class="regime-header">
        <span class="regime-eyebrow">Bối cảnh</span>
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
          <span>Xu hướng KL</span>
          <span>${ctx.volumeTrend === 'INCREASING' ? 'Tăng' : ctx.volumeTrend === 'DECREASING' ? 'Giảm' : 'Ổn định'}</span>
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
          <span class="sector-title">Dẫn dắt</span>
          ${topSectors.map(s => `<span class="sector-tag sector-up">${s.name} +${s.change.toFixed(1)}%</span>`).join('')}
        </div>
        <div class="sector-group">
          <span class="sector-title">Yếu nhất</span>
          ${bottomSectors.map(s => `<span class="sector-tag sector-down">${s.name} ${s.change.toFixed(1)}%</span>`).join('')}
        </div>
      </div>` : ''}
    </div>
  `;
}
