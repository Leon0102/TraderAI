// TraderAI - Main Entry Point
// Vietnamese Stock Market Dashboard with Real-time Data & Investment Suggestions

import './style.css';
import { fetchMarketOverview, fetchTopStocks, fetchStockBars, fetchMultipleFinancials } from './api/stockApi';
import { renderMarketCards } from './components/marketOverview';
import { initStockTable, renderStockTable } from './components/stockTable';
import { initChart, updateChartData } from './components/stockChart';
import { renderShortTermSuggestions, renderLongTermSuggestions } from './components/suggestions';
import { analyzeShortTerm } from './analysis/technicalAnalysis';
import { rankForLongTerm } from './analysis/fundamentalAnalysis';

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
    const stocks = await fetchTopStocks();
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

    const bars = await fetchStockBars(ticker, res, 120);
    updateChartData(bars);
  } catch (e) {
    console.error('Chart error:', e);
  }
}

async function loadSuggestions() {
  try {
    const tickers = ['FPT', 'VNM', 'VIC', 'HPG', 'MWG', 'TCB', 'VHM', 'MSN', 'VCB', 'ACB', 'SSI', 'VPB', 'STB', 'GAS', 'PLX'];

    // Short-term: Technical Analysis
    const shortTermSignals = await Promise.all(
      tickers.map(async (ticker) => {
        const bars = await fetchStockBars(ticker, 'D', 60);
        return analyzeShortTerm(ticker, bars);
      })
    );
    renderShortTermSuggestions(shortTermSignals);

    // Long-term: Fundamental Analysis
    const financials = await fetchMultipleFinancials(tickers);
    const longTermSignals = rankForLongTerm(financials);
    renderLongTermSuggestions(longTermSignals);
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
  ]);
}

// ===========================
// Initialization
// ===========================

async function init() {
  const loadingOverlay = document.getElementById('loadingOverlay');

  // Init components
  initStockTable();
  initChart();

  // Setup chart controls
  const chartSelect = document.getElementById('chartSymbol') as HTMLSelectElement;
  chartSelect?.addEventListener('change', () => {
    loadChart(chartSelect.value);
  });

  // Resolution tabs
  document.querySelectorAll('.res-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.res-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const res = (tab as HTMLElement).dataset.res || 'D';
      loadChart(undefined, res);
    });
  });

  // Tab change event for stock table
  document.addEventListener('tabChange', () => {
    renderStockTable(stocksData);
  });

  // Header scroll effect
  window.addEventListener('scroll', () => {
    const header = document.getElementById('header');
    if (header) {
      header.classList.toggle('scrolled', window.scrollY > 50);
    }
  });

  // Nav active state
  const navLinks = document.querySelectorAll('.nav-link');
  navLinks.forEach(link => {
    link.addEventListener('click', () => {
      navLinks.forEach(l => l.classList.remove('active'));
      link.classList.add('active');
    });
  });

  // Load all data
  try {
    await Promise.all([
      loadMarketOverview(),
      loadStockTable(),
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

  // Auto-refresh every 30 seconds
  refreshInterval = window.setInterval(() => {
    refreshAll();
  }, 30000);
}

// Start app
document.addEventListener('DOMContentLoaded', init);

// Cleanup
window.addEventListener('beforeunload', () => {
  if (refreshInterval) clearInterval(refreshInterval);
});
