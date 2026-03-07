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
  _ticker: string,
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

  // Risk/Reward from metrics
  const rrRatio = tech.metrics['R/R'] || 0;
  const consensus = tech.metrics['Consensus'] || 0;

  // Breakdown
  const breakdown = fund?.scoreBreakdown ?? { valuation: 10, profitability: 10, growth: 10, quality: 10, financialHealth: 10 };

  // Investment type
  const investType = fund?.investmentType || 'BALANCED';
  const investTypeEmoji = investType === 'VALUE' ? '💎 Value Play' :
                          investType === 'GROWTH' ? '🚀 Growth Play' :
                          investType === 'DIVIDEND' ? '💰 Dividend Play' : '⚖️ Balanced';

  // Overall AI recommendation
  let aiRecommendation = '';
  if (combinedScore >= 75) {
    aiRecommendation = '✅ AI đánh giá rất tích cực. Cổ phiếu có tiềm năng tăng trưởng cao với nền tảng cơ bản vững chắc.';
  } else if (combinedScore >= 65) {
    aiRecommendation = '🟢 AI đánh giá tích cực. Cổ phiếu đáng cân nhắc đầu tư, lưu ý quản trị rủi ro.';
  } else if (combinedScore >= 50) {
    aiRecommendation = '🟡 AI đánh giá trung tính. Cần thêm tín hiệu xác nhận trước khi quyết định.';
  } else if (combinedScore >= 35) {
    aiRecommendation = '🟠 AI đánh giá thận trọng. Rủi ro đang cao hơn cơ hội, nên chờ thêm.';
  } else {
    aiRecommendation = '🔴 AI đánh giá tiêu cực. Nên tránh mở vị thế mới, cân nhắc cắt lỗ nếu đang nắm giữ.';
  }

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

    <!-- AI Recommendation Banner -->
    <div class="detail-ai-recommendation ${combinedScore >= 65 ? 'ai-positive' : combinedScore <= 35 ? 'ai-negative' : 'ai-neutral'}">
      <div class="ai-rec-text">${aiRecommendation}</div>
      ${fund ? `<div class="ai-rec-meta">${investTypeEmoji} | ${fund.holdingPeriod} | Đồng thuận: ${consensus}%</div>` : ''}
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
          <div class="score-bar"><div style="width:${breakdown.valuation * 5}%; background: #6366f1"></div></div>
          <span>${breakdown.valuation}/20</span>
        </div>
        <div class="score-bar-item">
          <span>Sinh lời</span>
          <div class="score-bar"><div style="width:${breakdown.profitability * 5}%; background: #10b981"></div></div>
          <span>${breakdown.profitability}/20</span>
        </div>
        <div class="score-bar-item">
          <span>Tăng trưởng</span>
          <div class="score-bar"><div style="width:${breakdown.growth * 5}%; background: #f59e0b"></div></div>
          <span>${breakdown.growth}/20</span>
        </div>
        <div class="score-bar-item">
          <span>Chất lượng</span>
          <div class="score-bar"><div style="width:${breakdown.quality * 5}%; background: #ec4899"></div></div>
          <span>${breakdown.quality}/20</span>
        </div>
        <div class="score-bar-item">
          <span>Sức khỏe TC</span>
          <div class="score-bar"><div style="width:${breakdown.financialHealth * 5}%; background: #14b8a6"></div></div>
          <span>${breakdown.financialHealth}/20</span>
        </div>
      </div>
    </div>

    <!-- Two Columns: Technical + Fundamental -->
    <div class="detail-columns">
      <!-- Technical Analysis -->
      <div class="detail-col">
        <h3>⚡ Phân tích Kỹ thuật (Ngắn hạn)</h3>
        <div class="detail-signal ${tech.signal === 'BUY' ? 'signal-buy' : tech.signal === 'SELL' ? 'signal-sell' : 'signal-hold'}">
          ${tech.signal === 'BUY' ? '🟢 MUA' : tech.signal === 'SELL' ? '🔴 BÁN' : '🟡 GIỮ'}
          <span class="signal-strength">${tech.strength}%</span>
        </div>
        <div class="detail-metrics-grid">
          ${Object.entries(tech.metrics)
            .filter(([k]) => !['Consensus', 'R/R'].includes(k))
            .map(([k, v]) => `
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
          &nbsp;|&nbsp; R/R: <strong>${rrRatio > 0 ? rrRatio + ':1' : '—'}</strong>
          &nbsp;|&nbsp; Đồng thuận: <strong>${consensus}%</strong>
        </div>
      </div>

      <!-- Fundamental Analysis -->
      <div class="detail-col">
        <h3>🏆 Phân tích Cơ bản (Dài hạn)</h3>
        ${fund ? `
          <div class="detail-signal ${fund.signal === 'BUY' ? 'signal-buy' : fund.signal === 'SELL' ? 'signal-sell' : 'signal-hold'}">
            ${fund.signal === 'BUY' ? '🟢 ĐẦU TƯ' : fund.signal === 'SELL' ? '🔴 TRÁNH' : '🟡 THEO DÕI'}
            <span class="signal-strength">${fund.score}/100</span>
          </div>
          <div class="detail-info-row">
            <span>Loại đầu tư:</span>
            <strong>${investTypeEmoji}</strong>
          </div>
          <div class="detail-info-row">
            <span>Thời gian nắm giữ:</span>
            <strong>📅 ${fund.holdingPeriod}</strong>
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
          ${fund.dcfValue > 0 ? `
          <div class="detail-info-row">
            <span>Giá trị nội tại (DCF):</span>
            <strong>${new Intl.NumberFormat('vi-VN').format(fund.dcfValue)}đ</strong>
          </div>` : ''}
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
      <h3>📋 Chi tiết phân tích AI</h3>
      <div class="reasons-list">
        ${tech.reasons.map(r => `<div class="reason-item tech-reason">⚡ ${r}</div>`).join('')}
        ${fund ? fund.reasons.map(r => `<div class="reason-item fund-reason">🏆 ${r}</div>`).join('') : ''}
      </div>
    </div>
  `;
}
