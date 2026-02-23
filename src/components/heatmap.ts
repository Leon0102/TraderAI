// Market Heatmap Component
// VN30 treemap showing percentage change with proportional boxes

import { fetchTopStocks } from '../api/stockApi';

export async function renderHeatmap() {
  const container = document.getElementById('heatmapGrid');
  if (!container) return;

  try {
    const stocks = await fetchTopStocks(30);
    if (!stocks || stocks.length === 0) {
      container.innerHTML = '<p class="text-muted">Không có dữ liệu</p>';
      return;
    }

    // Sort by volume descending for size calculation
    const sorted = [...stocks].sort((a, b) => b.volume - a.volume);
    const maxVol = sorted[0].volume;

    container.innerHTML = sorted.map((stock, idx) => {
      const pct = stock.pctChange;
      const intensity = Math.min(Math.abs(pct) / 3, 1); // normalize to 0-1

      let bgColor: string;
      if (pct > 0) {
        const g = Math.round(100 + intensity * 80);
        bgColor = `rgba(16, ${g}, 80, ${0.3 + intensity * 0.5})`;
      } else if (pct < 0) {
        const r = Math.round(180 + intensity * 75);
        bgColor = `rgba(${r}, 40, 40, ${0.3 + intensity * 0.5})`;
      } else {
        bgColor = 'rgba(100, 100, 100, 0.3)';
      }

      // Size class based on volume rank
      const sizeClass = idx < 5 ? 'hm-xl' : idx < 12 ? 'hm-lg' : idx < 20 ? 'hm-md' : 'hm-sm';

      return `
        <div class="heatmap-cell ${sizeClass}" style="background: ${bgColor}" data-ticker="${stock.ticker}">
          <span class="hm-ticker">${stock.ticker}</span>
          <span class="hm-pct ${pct >= 0 ? 'positive' : 'negative'}">${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%</span>
          <span class="hm-price">${stock.close.toFixed(2)}</span>
        </div>
      `;
    }).join('');

    // Click handler to open detail
    container.querySelectorAll('.heatmap-cell').forEach(cell => {
      cell.addEventListener('click', () => {
        const ticker = (cell as HTMLElement).dataset.ticker;
        if (ticker) {
          import('./stockDetail').then(m => m.openStockDetail(ticker));
        }
      });
    });
  } catch (err) {
    container.innerHTML = '<p class="text-muted">Lỗi tải heatmap</p>';
  }
}
