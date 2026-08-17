// Stock Table Component
// Displays top stocks by volume, gainers, losers

let currentTab = 'top-volume';

export function initStockTable() {
  const tabs = document.getElementById('tableTabs');
  if (!tabs) return;

  tabs.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.classList.contains('tab')) {
      tabs.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      target.classList.add('active');
      currentTab = target.dataset.tab || 'top-volume';
      // Re-render with current data
      const event = new CustomEvent('tabChange', { detail: currentTab });
      document.dispatchEvent(event);
    }
  });
}

export function renderStockTable(stocks: any[]) {
  const tbody = document.getElementById('stockTableBody');
  if (!tbody) return;

  let sorted = [...stocks];

  switch (currentTab) {
    case 'top-gainers':
      sorted = sorted.filter(s => s.pctChange > 0).sort((a, b) => b.pctChange - a.pctChange);
      break;
    case 'top-losers':
      sorted = sorted.filter(s => s.pctChange < 0).sort((a, b) => a.pctChange - b.pctChange);
      break;
    case 'top-rvol':
      sorted = sorted.sort((a, b) => (b.rvol ?? 0) - (a.rvol ?? 0));
      break;
    case 'top-volume':
    default:
      sorted = sorted.sort((a, b) => b.volume - a.volume);
      break;
  }

  const rows = sorted.slice(0, 15).map(stock => {
    const change = stock.change || 0;
    const pctChange = stock.pctChange || 0;
    const direction = change > 0 ? 'price-up' : change < 0 ? 'price-down' : 'price-neutral';
    const sign = change > 0 ? '+' : '';
    const volume = stock.volume ? (stock.volume / 1000).toFixed(0) : '0';
    const rvol = typeof stock.rvol === 'number' ? stock.rvol : null;
    const rvolClass = rvol === null ? '' : rvol >= 1.5 ? 'price-up' : rvol < 0.5 ? '' : '';
    const rvolText = rvol === null ? '—' : `${rvol}x`;
    const foreignNet = typeof stock.foreignNetVolume === 'number' ? stock.foreignNetVolume : null;
    const foreignClass = foreignNet === null ? '' : foreignNet > 0 ? 'price-up' : foreignNet < 0 ? 'price-down' : '';
    const foreignText = foreignNet === null ? '—' : `${foreignNet > 0 ? '+' : ''}${Number((foreignNet / 1000).toFixed(0)).toLocaleString('vi-VN')}`;

    return `
      <tr class="stock-row" data-ticker="${stock.ticker}">
        <td><span class="stock-symbol">${stock.ticker}</span></td>
        <td class="${direction}">${formatPrice(stock.close)}</td>
        <td class="${direction}">${sign}${formatPrice(change)}</td>
        <td class="${direction}">${sign}${pctChange.toFixed(2)}%</td>
        <td>${Number(volume).toLocaleString('vi-VN')}</td>
        <td class="${rvolClass}" title="Khối lượng so với TB 20 phiên">${rvolText}</td>
        <td class="${foreignClass}" title="Khối ngoại mua/bán ròng (nghìn CP)">${foreignText}</td>
        <td>${formatPrice(stock.high)}</td>
        <td>${formatPrice(stock.low)}</td>
      </tr>
    `;
  }).join('');

  tbody.innerHTML = rows;

  // Add click handler for stock rows
  tbody.querySelectorAll('.stock-row').forEach(row => {
    row.addEventListener('click', () => {
      const ticker = (row as HTMLElement).dataset.ticker;
      if (ticker) {
        const select = document.getElementById('chartSymbol') as HTMLSelectElement;
        if (select) {
          // Add if not exists
          let optionExists = false;
          for (const opt of Array.from(select.options)) {
            if (opt.value === ticker) {
              optionExists = true;
              break;
            }
          }
          if (!optionExists) {
            const option = document.createElement('option');
            option.value = ticker;
            option.text = ticker;
            select.add(option);
          }
          select.value = ticker;
          select.dispatchEvent(new Event('change'));
          document.getElementById('chart')?.scrollIntoView({ behavior: 'smooth' });
        }
      }
    });
  });
}

function formatPrice(price: number): string {
  if (typeof price !== 'number' || isNaN(price)) return '0';
  return price.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
