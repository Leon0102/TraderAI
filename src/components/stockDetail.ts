// Stock Detail Panel Component
// Shows detailed analysis when clicking on a stock ticker

import type { TechnicalSignal } from '../analysis/technicalAnalysis';
import type { FundamentalSignal } from '../analysis/fundamentalAnalysis';
import { analyzeShortTerm } from '../analysis/technicalAnalysis';
import { analyzeLongTerm } from '../analysis/fundamentalAnalysis';
import { fetchStockBars, fetchFinancialData } from '../api/stockApi';

let isOpen = false;

export function openStockDetail(ticker: string) {
  if (isOpen) closeStockDetail();

  const overlay = document.createElement('div');
  overlay.className = 'detail-overlay';
  overlay.id = 'detailOverlay';
  overlay.innerHTML = `
    <div class="detail-panel">
      <div class="detail-header">
        <h2 class="detail-ticker">${ticker}</h2>
        <button class="detail-close" id="detailClose">✕</button>
      </div>
      <div class="detail-body" id="detailBody">
        <div class="detail-loading">
          <div class="spinner small"></div>
          <p>Đang phân tích ${ticker}...</p>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  isOpen = true;

  // Close handlers
  document.getElementById('detailClose')?.addEventListener('click', closeStockDetail);
  overlay.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).classList.contains('detail-overlay')) closeStockDetail();
  });
  document.addEventListener('keydown', handleEsc);

  // Load data
  loadDetailData(ticker);
}

function handleEsc(e: KeyboardEvent) {
  if (e.key === 'Escape') closeStockDetail();
}

export function closeStockDetail() {
  const overlay = document.getElementById('detailOverlay');
  if (overlay) {
    overlay.classList.add('closing');
    setTimeout(() => overlay.remove(), 300);
  }
  isOpen = false;
  document.removeEventListener('keydown', handleEsc);
}

async function loadDetailData(ticker: string) {
  const body = document.getElementById('detailBody');
  if (!body) return;

  try {
    const [bars, financials] = await Promise.all([
      fetchStockBars(ticker, 'D', 90),
      fetchFinancialData(ticker),
    ]);

    const technical = analyzeShortTerm(ticker, bars);
    const fundamental = financials ? analyzeLongTerm(financials) : null;

    body.innerHTML = renderDetailContent(ticker, technical, fundamental, bars);
  } catch (err) {
    body.innerHTML = `<div class="detail-error">Không thể tải dữ liệu cho ${ticker}</div>`;
  }
}

function renderDetailContent(
  ticker: string,
  tech: TechnicalSignal,
  fund: FundamentalSignal | null,
  bars: any[]
): string {
  const lastBar = bars[bars.length - 1];
  const prevBar = bars.length > 1 ? bars[bars.length - 2] : lastBar;
  const change = lastBar.close - prevBar.close;
  const pctChange = prevBar.close > 0 ? (change / prevBar.close * 100) : 0;
  const changeClass = change >= 0 ? 'positive' : 'negative';

  // Combined score
  const techScore = tech.strength;
  const fundScore = fund?.score ?? 50;
  const combinedScore = Math.round(techScore * 0.4 + fundScore * 0.6);

  // Risk/Reward
  const riskReward = tech.stopLoss > 0 && tech.targetPrice > lastBar.close
    ? ((tech.targetPrice - lastBar.close) / (lastBar.close - tech.stopLoss)).toFixed(1)
    : '—';

  // Radar chart CSS values
  const breakdown = fund?.scoreBreakdown ?? { valuation: 12, profitability: 12, growth: 12, quality: 12 };

  return `
    <!-- Price Header -->
    <div class="detail-price-header">
      <div class="detail-price-main">
        <span class="detail-current-price">${lastBar.close.toFixed(2)}</span>
        <span class="detail-change ${changeClass}">
          ${change >= 0 ? '+' : ''}${change.toFixed(2)} (${pctChange >= 0 ? '+' : ''}${pctChange.toFixed(2)}%)
        </span>
      </div>
      <div class="detail-price-info">
        <span>Cao: <strong>${lastBar.high.toFixed(2)}</strong></span>
        <span>Thấp: <strong>${lastBar.low.toFixed(2)}</strong></span>
        <span>KL: <strong>${(lastBar.volume / 1000).toFixed(0)}K</strong></span>
      </div>
    </div>

    <!-- Combined Score -->
    <div class="detail-combined-score">
      <div class="score-circle ${combinedScore >= 65 ? 'score-good' : combinedScore <= 35 ? 'score-bad' : 'score-neutral'}">
        <svg viewBox="0 0 100 100">
          <circle cx="50" cy="50" r="45" fill="none" stroke="rgba(255,255,255,0.1)" stroke-width="8"/>
          <circle cx="50" cy="50" r="45" fill="none" stroke="${combinedScore >= 65 ? '#10b981' : combinedScore <= 35 ? '#ef4444' : '#f59e0b'}"
            stroke-width="8" stroke-dasharray="${combinedScore * 2.83} 283" stroke-linecap="round"
            transform="rotate(-90 50 50)" style="transition: stroke-dasharray 1s ease"/>
        </svg>
        <div class="score-value">${combinedScore}</div>
        <div class="score-label">Tổng hợp</div>
      </div>
      <div class="score-details">
        <div class="score-bar-item">
          <span>Định giá</span>
          <div class="score-bar"><div style="width:${breakdown.valuation * 4}%; background: #6366f1"></div></div>
          <span>${breakdown.valuation}/25</span>
        </div>
        <div class="score-bar-item">
          <span>Sinh lời</span>
          <div class="score-bar"><div style="width:${breakdown.profitability * 4}%; background: #10b981"></div></div>
          <span>${breakdown.profitability}/25</span>
        </div>
        <div class="score-bar-item">
          <span>Tăng trưởng</span>
          <div class="score-bar"><div style="width:${breakdown.growth * 4}%; background: #f59e0b"></div></div>
          <span>${breakdown.growth}/25</span>
        </div>
        <div class="score-bar-item">
          <span>Chất lượng</span>
          <div class="score-bar"><div style="width:${breakdown.quality * 4}%; background: #ec4899"></div></div>
          <span>${breakdown.quality}/25</span>
        </div>
      </div>
    </div>

    <!-- Two Columns: Technical + Fundamental -->
    <div class="detail-columns">
      <!-- Technical Analysis -->
      <div class="detail-col">
        <h3>⚡ Phân tích Kỹ thuật</h3>
        <div class="detail-signal ${tech.signal === 'BUY' ? 'signal-buy' : tech.signal === 'SELL' ? 'signal-sell' : 'signal-hold'}">
          ${tech.signal === 'BUY' ? '🟢 MUA' : tech.signal === 'SELL' ? '🔴 BÁN' : '🟡 GIỮ'}
          <span class="signal-strength">${tech.strength}%</span>
        </div>
        <div class="detail-metrics-grid">
          ${Object.entries(tech.metrics).map(([k, v]) => `
            <div class="detail-metric">
              <span class="metric-label">${k}</span>
              <span class="metric-value">${typeof v === 'number' ? v.toFixed(1) : v}</span>
            </div>
          `).join('')}
        </div>
        <div class="detail-pattern">
          <span class="pattern-label">Pattern:</span> ${tech.pattern}
        </div>
        <div class="detail-levels">
          <div class="level-item support">
            <span>Hỗ trợ</span>
            <strong>${tech.supportLevel}</strong>
          </div>
          <div class="level-item resistance">
            <span>Kháng cự</span>
            <strong>${tech.resistanceLevel}</strong>
          </div>
          <div class="level-item target">
            <span>Mục tiêu</span>
            <strong>${tech.targetPrice}</strong>
          </div>
          <div class="level-item stoploss">
            <span>Cắt lỗ</span>
            <strong>${tech.stopLoss}</strong>
          </div>
        </div>
        <div class="detail-risk">
          Rủi ro: <span class="risk-badge risk-${tech.risk.toLowerCase()}">${tech.risk === 'LOW' ? 'Thấp' : tech.risk === 'MEDIUM' ? 'Trung bình' : 'Cao'}</span>
          &nbsp;|&nbsp; R/R: <strong>${riskReward}</strong>
        </div>
      </div>

      <!-- Fundamental Analysis -->
      <div class="detail-col">
        <h3>🏆 Phân tích Cơ bản</h3>
        ${fund ? `
          <div class="detail-signal ${fund.signal === 'BUY' ? 'signal-buy' : fund.signal === 'SELL' ? 'signal-sell' : 'signal-hold'}">
            ${fund.signal === 'BUY' ? '🟢 ĐẦU TƯ' : fund.signal === 'SELL' ? '🔴 TRÁNH' : '🟡 THEO DÕI'}
            <span class="signal-strength">${fund.score}/100</span>
          </div>
          <div class="detail-metrics-grid">
            ${Object.entries(fund.metrics).map(([k, v]) => `
              <div class="detail-metric">
                <span class="metric-label">${k}</span>
                <span class="metric-value">${v}</span>
              </div>
            `).join('')}
          </div>
          <div class="detail-info-row">
            <span>Vốn hóa:</span>
            <strong>${fund.capSize === 'Large' ? '🏛️ Large Cap' : fund.capSize === 'Mid' ? '🏢 Mid Cap' : '🏠 Small Cap'}</strong>
          </div>
          ${fund.grahamNumber > 0 ? `
          <div class="detail-info-row">
            <span>Graham Number:</span>
            <strong>${new Intl.NumberFormat('vi-VN').format(fund.grahamNumber)}đ</strong>
          </div>` : ''}
          ${fund.intrinsicValue ? `
          <div class="detail-intrinsic">${fund.intrinsicValue}</div>` : ''}
        ` : `<p class="text-muted">Không có dữ liệu tài chính</p>`}
      </div>
    </div>

    <!-- Reasons -->
    <div class="detail-reasons">
      <h3>📋 Chi tiết phân tích</h3>
      <div class="reasons-list">
        ${tech.reasons.map(r => `<div class="reason-item tech-reason">⚡ ${r}</div>`).join('')}
        ${fund ? fund.reasons.map(r => `<div class="reason-item fund-reason">🏆 ${r}</div>`).join('') : ''}
      </div>
    </div>
  `;
}
