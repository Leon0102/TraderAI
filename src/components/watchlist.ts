// Watchlist Component
// Persists watched tickers in localStorage

import { fetchStockBars, fetchFinancialData } from '../api/stockApi';
import { analyzeShortTerm } from '../analysis/technicalAnalysis';

const STORAGE_KEY = 'traderai_watchlist';

function getWatchlist(): string[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  } catch { return []; }
}

function saveWatchlist(list: string[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

export function addToWatchlist(ticker: string) {
  const list = getWatchlist();
  if (!list.includes(ticker)) {
    list.push(ticker);
    saveWatchlist(list);
    renderWatchlist();
  }
}

export function removeFromWatchlist(ticker: string) {
  const list = getWatchlist().filter(t => t !== ticker);
  saveWatchlist(list);
  renderWatchlist();
}

export function isInWatchlist(ticker: string): boolean {
  return getWatchlist().includes(ticker);
}

export async function renderWatchlist() {
  const container = document.getElementById('watchlistCards');
  const section = document.getElementById('watchlistSection');
  if (!container) return;

  const list = getWatchlist();

  if (list.length === 0) {
    if (section) section.style.display = 'none';
    return;
  }

  if (section) section.style.display = 'block';

  container.innerHTML = list.map(ticker => `
    <div class="watchlist-card" data-ticker="${ticker}">
      <div class="wl-header">
        <span class="wl-ticker">${ticker}</span>
        <button class="wl-remove" data-remove="${ticker}">✕</button>
      </div>
      <div class="wl-loading">
        <div class="spinner tiny"></div>
      </div>
    </div>
  `).join('');

  // Load data for each card
  list.forEach(async (ticker) => {
    try {
      const bars = await fetchStockBars(ticker, 'D', 30);
      const card = container.querySelector(`[data-ticker="${ticker}"]`);
      if (!card || bars.length === 0) return;

      const last = bars[bars.length - 1];
      const prev = bars.length > 1 ? bars[bars.length - 2] : last;
      const change = last.close - prev.close;
      const pct = prev.close > 0 ? (change / prev.close * 100) : 0;
      const signal = analyzeShortTerm(ticker, bars);

      const loadingEl = card.querySelector('.wl-loading');
      if (loadingEl) {
        loadingEl.outerHTML = `
          <div class="wl-price ${change >= 0 ? 'positive' : 'negative'}">
            <span class="wl-current">${last.close.toFixed(2)}</span>
            <span class="wl-change">${change >= 0 ? '+' : ''}${pct.toFixed(2)}%</span>
          </div>
          <div class="wl-signal ${signal.signal === 'BUY' ? 'signal-buy' : signal.signal === 'SELL' ? 'signal-sell' : 'signal-hold'}">
            ${signal.signal === 'BUY' ? '🟢' : signal.signal === 'SELL' ? '🔴' : '🟡'} ${signal.strength}%
          </div>
          <div class="wl-mini-chart">
            ${renderSparkline(bars)}
          </div>
        `;
      }
    } catch {}
  });

  // Remove handlers
  container.querySelectorAll('.wl-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const ticker = (btn as HTMLElement).dataset.remove;
      if (ticker) removeFromWatchlist(ticker);
    });
  });

  // Click to open detail
  container.querySelectorAll('.watchlist-card').forEach(card => {
    card.addEventListener('click', () => {
      const ticker = (card as HTMLElement).dataset.ticker;
      if (ticker) {
        import('./stockDetail').then(m => m.openStockDetail(ticker));
      }
    });
  });
}

function renderSparkline(bars: any[]): string {
  if (bars.length < 2) return '';
  const closes = bars.slice(-20).map((b: any) => b.close);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const range = max - min || 1;
  const h = 30;
  const w = 100;
  const step = w / (closes.length - 1);

  const points = closes.map((c: number, i: number) =>
    `${i * step},${h - ((c - min) / range) * h}`
  ).join(' ');

  const lastColor = closes[closes.length - 1] >= closes[0] ? '#10b981' : '#ef4444';

  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <polyline fill="none" stroke="${lastColor}" stroke-width="1.5" points="${points}"/>
  </svg>`;
}
