// TraderAI - Main Entry Point
// Vietnamese Stock Market Dashboard with Real-time Data & Investment Suggestions

import './style.css';
import { fetchMarketOverview, fetchTopStocks, fetchStockBars, fetchMultipleFinancials, fetchMarketAnalysis, fetchMarketNews, fetchMultipleTickerNews, isAnyDataMock } from './api/stockApi';
import { renderMarketCards } from './components/marketOverview';
import { initStockTable, renderStockTable } from './components/stockTable';
import { initChart, updateChartData } from './components/stockChart';
import { renderShortTermSuggestions, renderLongTermSuggestions, renderCombinedSuggestions, setMarketContext, setNewsSignals } from './components/suggestions';
import { analyzeShortTerm } from './analysis/technicalAnalysis';
import { rankForLongTerm } from './analysis/fundamentalAnalysis';
import { analyzeMarket } from './analysis/marketAnalysis';
import { analyzeNewsSentiment } from './analysis/newsAnalysis';
import { initSearchBar } from './components/searchBar';
import { renderWatchlist } from './components/watchlist';
import { renderHeatmap } from './components/heatmap';
import { renderNewsFeed } from './components/newsFeed';

// ===========================
// State
// ===========================
let currentChartSymbol = 'FPT';
let currentResolution = 'D';
let stocksData: any[] = [];
let refreshInterval: number | null = null;
// Expose market cache for potential use by other modules
export const marketDataCache: { data: any[]; ctx: ReturnType<typeof analyzeMarket> | null } = { data: [], ctx: null };

// ===========================
// Core Functions
// ===========================

async function loadMarketOverview() {
  try {
    const [data, analysisData] = await Promise.all([
      fetchMarketOverview(),
      fetchMarketAnalysis()
    ]);

    const marketCtx = analyzeMarket(data, analysisData);
    marketDataCache.data = data;
    marketDataCache.ctx = marketCtx;
    setMarketContext(marketCtx);

    renderMarketCards(data, marketCtx);
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
    updateDataSourceBadge();
  } catch (e) {
    console.error('Chart error:', e);
  }
}

// Safety net used only when the live top-stocks universe can't be fetched (e.g. backend down).
const FALLBACK_TICKERS = ['FPT', 'VNM', 'VIC', 'HPG', 'MWG', 'TCB', 'VHM', 'MSN', 'VCB', 'ACB', 'SSI', 'VPB', 'STB', 'GAS', 'PLX', 'DGC', 'PNJ', 'REE', 'MBB', 'CTG'];

async function loadSuggestions() {
  try {
    // Build the analysis universe from today's actual top-volume stocks instead of a fixed list.
    const topStocks = await fetchTopStocks(25);
    const liveTickers = [...new Set(topStocks.map((s: any) => s.ticker).filter(Boolean))] as string[];
    const tickers = liveTickers.length >= 10 ? liveTickers.slice(0, 20) : FALLBACK_TICKERS;

    // Foreign net buy/sell as a fraction of today's volume, from the top-stocks
    // price board we already fetched - an independent signal price bars can't give.
    const foreignNetRatioByTicker = new Map<string, number>();
    for (const s of topStocks) {
      if (s.ticker && typeof s.foreignNetVolume === 'number' && s.volume) {
        foreignNetRatioByTicker.set(s.ticker, s.foreignNetVolume / s.volume);
      }
    }

    // Parallel fetch for speed
    const [techSignals, financials, newsMap] = await Promise.all([
      // Tech analysis - fetch 200 bars for Ichimoku/MA Ribbon
      Promise.all(tickers.map(async (ticker) => {
        const bars = await fetchStockBars(ticker, 'D', 200);
        return analyzeShortTerm(ticker, bars, foreignNetRatioByTicker.get(ticker));
      })),
      // Fund analysis
      fetchMultipleFinancials(tickers),
      // News analysis
      fetchMultipleTickerNews(tickers),
    ]);

    const fundSignals = rankForLongTerm(financials);

    // Process news into NewsSignal map for suggestions
    const newsSignalMap = new Map<string, ReturnType<typeof analyzeNewsSentiment>>();
    for (const [ticker, data] of newsMap.entries()) {
      const signal = analyzeNewsSentiment(data.articles, data.sentiment, ticker);
      newsSignalMap.set(ticker, signal);
    }
    setNewsSignals(newsSignalMap);

    renderShortTermSuggestions(techSignals);
    renderLongTermSuggestions(fundSignals);
    renderCombinedSuggestions(techSignals, fundSignals);
  } catch (e) {
    console.error('Suggestions error:', e);
  }
}

async function loadNewsFeed() {
  try {
    const newsData = await fetchMarketNews();
    if (newsData) {
      renderNewsFeed(newsData.articles, newsData.sentiment);
    }
  } catch (e) {
    console.error('News feed error:', e);
  }
}

function updateLastTime() {
  const el = document.getElementById('lastUpdate');
  if (el) {
    const now = new Date();
    el.textContent = `Cập nhật: ${now.toLocaleTimeString('vi-VN')}`;
  }
}

function updateDataSourceBadge() {
  const badge = document.getElementById('dataSourceBadge');
  if (!badge) return;
  badge.style.display = isAnyDataMock() ? 'flex' : 'none';
}

async function refreshAll() {
  updateLastTime();
  await Promise.all([
    loadMarketOverview(),
    loadStockTable(),
    renderHeatmap(),
    renderWatchlist(),
  ]);
  updateDataSourceBadge();
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

  // Load initial data in two waves. Firing all ~7 loaders (suggestions alone
  // fans out to 20 tickers x 3 endpoints) in a single Promise.all sends 60+
  // simultaneous requests, which can transiently overwhelm the upstream data
  // source and knock some of them into a mock-data fallback. The above-fold
  // content (market, table, heatmap, watchlist, chart) goes first so it's
  // both fast and unaffected by contention from the heavier second wave.
  try {
    await Promise.all([
      loadMarketOverview(),
      loadStockTable(),
      renderHeatmap(),
      renderWatchlist(),
      loadChart(),
    ]);
  } catch (e) {
    console.error('Init error (wave 1):', e);
  }

  updateLastTime();
  updateDataSourceBadge();

  // Hide loading
  if (loadingOverlay) {
    loadingOverlay.classList.add('hidden');
    setTimeout(() => loadingOverlay.remove(), 500);
  }

  try {
    await Promise.all([
      loadSuggestions(),
      loadNewsFeed(),
    ]);
  } catch (e) {
    console.error('Init error (wave 2):', e);
  }

  updateDataSourceBadge();

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
