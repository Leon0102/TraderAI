// TraderAI - Main Entry Point
// Vietnamese Stock Market Dashboard with Real-time Data & Investment Suggestions

import './style.css';
import { fetchMarketOverview, fetchTopStocks, fetchStockBars, fetchMultipleFinancials } from './api/stockApi';
import { renderMarketCards } from './components/marketOverview';
import { initStockTable, renderStockTable } from './components/stockTable';
import { initChart, updateChartData } from './components/stockChart';
import { renderShortTermSuggestions, renderLongTermSuggestions, renderCombinedSuggestions } from './components/suggestions';
import { analyzeShortTerm, type TechnicalSignal } from './analysis/technicalAnalysis';
import { rankForLongTerm, type FundamentalSignal } from './analysis/fundamentalAnalysis';
import { initSearchBar } from './components/searchBar';
import { renderWatchlist } from './components/watchlist';
import { renderHeatmap } from './components/heatmap';

// ===========================
// State
// ===========================
let currentChartSymbol = 'FPT';
let currentResolution = 'D';
let stocksData: any[] = [];
let refreshInterval: number | null = null;

// ===========================
// Core Functions
// ===========================

async function loadMarketOverview() {
  try {
    const data = await fetchMarketOverview();
    renderMarketCards(data);
  } catch (e) {
    console.error('Market overview error:', e);
  }
}

async function loadStockTable() {
  try {
    const stocks = await fetchTopStocks(30);
    stocksData = stocks;
    renderStockTable(stocks);
  } catch (e) {
    console.error('Stock table error:', e);
  }
}

async function loadChart(symbol?: string, resolution?: string) {
  try {
    const ticker = symbol || currentChartSymbol;
    const res = resolution || currentResolution;
    currentChartSymbol = ticker;
    currentResolution = res;

    // Load more bars for better indicator calculation
    const bars = await fetchStockBars(ticker, res, 200);
    updateChartData(bars);
  } catch (e) {
    console.error('Chart error:', e);
  }
}

async function loadSuggestions() {
  try {
    const tickers = ['FPT', 'VNM', 'VIC', 'HPG', 'MWG', 'TCB', 'VHM', 'MSN', 'VCB', 'ACB', 'SSI', 'VPB', 'STB', 'GAS', 'PLX', 'DGC', 'PNJ', 'REE', 'MBB', 'CTG'];

    // Parallel fetch for speed
    const [techSignals, financials] = await Promise.all([
      // Tech analysis
      Promise.all(tickers.map(async (ticker) => {
        const bars = await fetchStockBars(ticker, 'D', 90);
        return analyzeShortTerm(ticker, bars);
      })),
      // Fund analysis
      fetchMultipleFinancials(tickers)
    ]);

    const fundSignals = rankForLongTerm(financials);

    renderShortTermSuggestions(techSignals);
    renderLongTermSuggestions(fundSignals);
    renderCombinedSuggestions(techSignals, fundSignals);
  } catch (e) {
    console.error('Suggestions error:', e);
  }
}

function updateLastTime() {
  const el = document.getElementById('lastUpdate');
  if (el) {
    const now = new Date();
    el.textContent = `Cập nhật: ${now.toLocaleTimeString('vi-VN')}`;
  }
}

async function refreshAll() {
  updateLastTime();
  await Promise.all([
    loadMarketOverview(),
    loadStockTable(),
    renderHeatmap(),
    renderWatchlist(),
  ]);
}

// ===========================
// Initialization
// ===========================

async function init() {
  const loadingOverlay = document.getElementById('loadingOverlay');

  // Init UI components
  initSearchBar();
  initStockTable();
  initChart();

  // Setup suggestion tabs
  document.querySelectorAll('#suggestionTabs .tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('#suggestionTabs .tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const target = (tab as HTMLElement).dataset.tab;
      document.querySelectorAll('.suggestion-tab-content').forEach(c => {
        (c as HTMLElement).style.display = 'none';
        c.classList.remove('active');
      });
      const el = document.getElementById(`tab-${target}`);
      if (el) {
        el.style.display = 'block';
        setTimeout(() => el.classList.add('active'), 10);
      }
    });
  });

  // Setup chart controls
  const chartSelect = document.getElementById('chartSymbol') as HTMLSelectElement;
  chartSelect?.addEventListener('change', () => {
    loadChart(chartSelect.value);
  });

  document.querySelectorAll('.res-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.res-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const res = (tab as HTMLElement).dataset.res || 'D';
      loadChart(undefined, res);
    });
  });

  // Data updates
  document.addEventListener('tabChange', () => {
    renderStockTable(stocksData);
  });

  // Header scroll
  window.addEventListener('scroll', () => {
    const header = document.getElementById('header');
    if (header) {
      header.classList.toggle('scrolled', window.scrollY > 50);
    }
  });

  // Mobile nav logic is simplified for now
  const navLinks = document.querySelectorAll('.nav-link');
  navLinks.forEach(link => {
    link.addEventListener('click', () => {
      navLinks.forEach(l => l.classList.remove('active'));
      link.classList.add('active');
    });
  });

  // Load all initial data
  try {
    await Promise.all([
      loadMarketOverview(),
      loadStockTable(),
      renderHeatmap(),
      renderWatchlist(),
      loadChart(),
      loadSuggestions(),
    ]);
  } catch (e) {
    console.error('Init error:', e);
  }

  updateLastTime();

  // Hide loading
  if (loadingOverlay) {
    loadingOverlay.classList.add('hidden');
    setTimeout(() => loadingOverlay.remove(), 500);
  }

  // Auto-refresh every 60 seconds
  refreshInterval = window.setInterval(() => {
    refreshAll();
  }, 60000);
}

// Start app
document.addEventListener('DOMContentLoaded', init);

// Cleanup
window.addEventListener('beforeunload', () => {
  if (refreshInterval) clearInterval(refreshInterval);
});
