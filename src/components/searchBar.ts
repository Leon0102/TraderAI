// Search Bar Component
// Autocomplete search for stock tickers

import { openStockDetail } from './stockDetail';
import { addToWatchlist } from './watchlist';

const TICKERS = [
  'FPT', 'VNM', 'VIC', 'HPG', 'MWG', 'TCB', 'VHM', 'MSN', 'VCB', 'ACB',
  'SSI', 'VPB', 'STB', 'GAS', 'PLX', 'SAB', 'REE', 'DGC', 'PNJ', 'KDC',
  'BVH', 'HDB', 'MBB', 'TPB', 'VRE', 'NVL', 'PDR', 'DXG', 'KBC', 'IJC',
  'CTG', 'BID', 'SHB', 'LPB', 'EIB', 'OCB', 'MSB', 'VIB', 'BAF', 'HAG',
  'POW', 'PPC', 'BCG', 'GEX', 'PC1', 'PHR', 'SZC', 'TLG', 'DCM', 'DPM',
];

export function initSearchBar() {
  const input = document.getElementById('searchInput') as HTMLInputElement;
  const results = document.getElementById('searchResults');
  if (!input || !results) return;

  input.addEventListener('input', () => {
    const query = input.value.toUpperCase().trim();
    if (query.length === 0) {
      results.classList.remove('visible');
      return;
    }

    const matches = TICKERS.filter(t => t.includes(query)).slice(0, 8);

    if (matches.length === 0) {
      results.innerHTML = '<div class="search-empty">Không tìm thấy mã CK</div>';
    } else {
      results.innerHTML = matches.map(ticker => `
        <div class="search-item" data-ticker="${ticker}">
          <span class="search-ticker">${ticker}</span>
          <div class="search-actions">
            <button class="search-view" data-view="${ticker}" title="Xem chi tiết">📊</button>
            <button class="search-watch" data-watch="${ticker}" title="Thêm watchlist">⭐</button>
          </div>
        </div>
      `).join('');

      // Click handlers
      results.querySelectorAll('.search-view').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const t = (btn as HTMLElement).dataset.view!;
          openStockDetail(t);
          input.value = '';
          results.classList.remove('visible');
        });
      });

      results.querySelectorAll('.search-watch').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const t = (btn as HTMLElement).dataset.watch!;
          addToWatchlist(t);
          (btn as HTMLElement).textContent = '✅';
        });
      });

      results.querySelectorAll('.search-item').forEach(item => {
        item.addEventListener('click', () => {
          const t = (item as HTMLElement).dataset.ticker!;
          openStockDetail(t);
          input.value = '';
          results.classList.remove('visible');
        });
      });
    }

    results.classList.add('visible');
  });

  // Close on outside click
  document.addEventListener('click', (e) => {
    if (!(e.target as HTMLElement).closest('.search-wrapper')) {
      results.classList.remove('visible');
    }
  });

  // Keyboard shortcut: / to focus search
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== input) {
      e.preventDefault();
      input.focus();
    }
  });
}
