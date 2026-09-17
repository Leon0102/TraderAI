// Search Bar Component
// Autocomplete search for stock tickers

import { openStockDetail } from './stockDetail';
import { addToWatchlist } from './watchlist';
import { fetchSymbols } from '../api/stockApi';
import type { ListedSymbol } from '../api/stockApi';

// Offline fallback only — the live list of every listed stock replaces it once loaded.
const FALLBACK_TICKERS = [
  'FPT', 'VNM', 'VIC', 'HPG', 'MWG', 'TCB', 'VHM', 'MSN', 'VCB', 'ACB',
  'SSI', 'VPB', 'STB', 'GAS', 'PLX', 'SAB', 'REE', 'DGC', 'PNJ', 'KDC',
  'BVH', 'HDB', 'MBB', 'TPB', 'VRE', 'NVL', 'PDR', 'DXG', 'KBC', 'IJC',
  'CTG', 'BID', 'SHB', 'LPB', 'EIB', 'OCB', 'MSB', 'VIB', 'BAF', 'HAG',
  'POW', 'PPC', 'BCG', 'GEX', 'PC1', 'PHR', 'SZC', 'TLG', 'DCM', 'DPM',
];

let symbols: ListedSymbol[] = FALLBACK_TICKERS.map(ticker => ({ ticker, name: '', exchange: '' }));

function stripAccents(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toUpperCase();
}

function escapeAttr(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Exact ticker first, then tickers starting with the query, then company-name matches. */
function findMatches(query: string): ListedSymbol[] {
  const q = stripAccents(query);
  const scored: [number, ListedSymbol][] = [];
  for (const s of symbols) {
    const rank = s.ticker === q ? 0
      : s.ticker.startsWith(q) ? 1
      : s.ticker.includes(q) ? 2
      : q.length >= 2 && stripAccents(s.name).includes(q) ? 3
      : -1;
    if (rank >= 0) scored.push([rank, s]);
  }
  return scored.sort((a, b) => a[0] - b[0] || a[1].ticker.localeCompare(b[1].ticker)).slice(0, 8).map(([, s]) => s);
}

export function initSearchBar() {
  const input = document.getElementById('searchInput') as HTMLInputElement;
  const results = document.getElementById('searchResults');
  if (!input || !results) return;

  fetchSymbols().then(list => {
    if (list.length) symbols = list;
  });

  input.addEventListener('input', () => {
    const query = input.value.toUpperCase().trim();
    if (query.length === 0) {
      results.classList.remove('visible');
      return;
    }

    const matches = findMatches(query);

    if (matches.length === 0) {
      results.innerHTML = '<div class="search-empty">Không tìm thấy mã CK</div>';
    } else {
      results.innerHTML = matches.map(({ ticker, name, exchange }) => `
        <div class="search-item" data-ticker="${ticker}">
          <span class="search-ticker">${ticker}</span>
          ${name ? `<span class="search-name" title="${escapeAttr(name)}">${escapeAttr(name)}${exchange ? ` · ${exchange}` : ''}</span>` : ''}
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
