// TraderAI - Main Entry Point
// Vietnamese Stock Market Dashboard with Real-time Data & Investment Suggestions

import './style.css';
import { fetchMarketOverview, fetchTopStocks, fetchStockBars, fetchMultipleFinancials, fetchMarketAnalysis, fetchMarketNews, fetchMultipleTickerNews, getFeedProvenance, isAnyDataMock, partialMockFeeds, withLiveBar } from './api/stockApi';
import { renderMarketCards } from './components/marketOverview';
import { renderSessionBand } from './components/sessionBand';
import { initDailyPicks, setDailyPicks } from './components/dailyPicks';
import type { PickMeta } from './components/dailyPicks';
import { initStockTable, renderStockTable } from './components/stockTable';
import { initChart, updateChartData } from './components/stockChart';
import { renderShortTermSuggestions, renderLongTermSuggestions, renderCombinedSuggestions, setMarketContext, setNewsSignals, getCombinedSignals } from './components/suggestions';
import { setAllocatorSignals, initCapitalAllocator } from './components/capitalAllocator';
import { analyzeShortTerm } from './analysis/technicalAnalysis';
import { rankForLongTerm } from './analysis/fundamentalAnalysis';
import { analyzeMarket } from './analysis/marketAnalysis';
import { analyzeNewsSentiment } from './analysis/newsAnalysis';
import { initSearchBar } from './components/searchBar';
import { renderWatchlist } from './components/watchlist';
import { renderHeatmap } from './components/heatmap';
import { renderNewsFeed } from './components/newsFeed';
import { initAgentCouncil, openCouncilForTicker } from './components/agentCouncil';
import { renderFeedMeta } from './components/provenance';
import { setCurrentRecommendations } from './analysis/recommendation';
import { initPortfolio, setPortfolioPrices } from './components/portfolio';
import { initTcbsAccount } from './components/tcbsAccount';
import { initQuantPanel } from './components/quantPanel';
import type { TechnicalSignal } from './analysis/technicalAnalysis';
import type { FundamentalSignal } from './analysis/fundamentalAnalysis';

declare global {
  interface Window {
    openCouncilForTicker?: (ticker: string) => void;
  }
}

// ===========================
// State
// ===========================
let currentChartSymbol = 'FPT';
let currentResolution = 'D';
let stocksData: any[] = [];
let refreshInterval: number | null = null;
let marketOverviewConnected = false;
let latestTechSignals: TechnicalSignal[] = [];
let latestFundSignals: FundamentalSignal[] = [];
let latestCombined: ReturnType<typeof getCombinedSignals> = [];
// Expose market cache for potential use by other modules
export const marketDataCache: { data: any[]; ctx: ReturnType<typeof analyzeMarket> | null } = { data: [], ctx: null };

function showLoadError(id: string, message: string, retry: () => void) {
  const container = document.getElementById(id);
  if (!container) return;
  const content = `<div class="load-error" role="alert"><span>${message}</span><button type="button" class="btn-ghost">Thử lại</button></div>`;
  container.innerHTML = container.tagName === 'TBODY' ? `<tr><td colspan="9">${content}</td></tr>` : content;
  container.querySelector('button')?.addEventListener('click', retry);
}

function updateMarketStatus(connected: boolean) {
  const status = document.getElementById('marketStatus');
  if (!status) return;
  const isMock = connected && isAnyDataMock();
  status.classList.toggle('is-unavailable', !connected || isMock);
  const label = status.querySelector('span:last-child');
  if (label) label.textContent = !connected ? 'Mất kết nối' : isMock ? 'Dữ liệu mẫu' : 'Đã cập nhật';
}

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
    renderSessionBand(data, marketCtx);
    renderFeedMeta('marketProvenance', 'market', 'Chỉ số', analysisData?.source !== 'mock' ? analysisData?.vnindexHistory?.at(-1)?.tradingDate : undefined);
    marketOverviewConnected = true;
    updateLastTime();
    updateDataSourceBadge();
  } catch (e) {
    console.error('Market overview error:', e);
    marketOverviewConnected = false;
    showLoadError('marketCards', 'Không tải được chỉ số thị trường.', () => void loadMarketOverview());
    updateMarketStatus(false);
  }
}

async function loadStockTable() {
  try {
    const stocks = await fetchTopStocks(30);
    stocksData = stocks;
    renderStockTable(stocks);
    setPortfolioPrices(stocks);
    renderFeedMeta('stocksProvenance', 'stocks', 'Bảng giá');
  } catch (e) {
    console.error('Stock table error:', e);
    showLoadError('stockTableBody', 'Không tải được bảng giá.', () => void loadStockTable());
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
    renderFeedMeta('chartProvenance', `history:${ticker}`, `Lịch sử giá ${ticker}`);
    document.getElementById('chartError')?.replaceChildren();
    updateDataSourceBadge();
  } catch (e) {
    console.error('Chart error:', e);
    showLoadError('chartError', `Không tải được biểu đồ ${currentChartSymbol}.`, () => void loadChart());
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
    const liveByTicker = new Map<string, any>(topStocks.map((s: any) => [s.ticker, s]));
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
        // Same price the board shows, so the plan's levels bracket the live price
        return analyzeShortTerm(ticker, withLiveBar(bars, liveByTicker.get(ticker)), foreignNetRatioByTicker.get(ticker));
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

    const combined = getCombinedSignals(techSignals, fundSignals);
    latestTechSignals = techSignals;
    latestFundSignals = fundSignals;
    latestCombined = combined;
    setCurrentRecommendations(combined);
    renderShortTermSuggestions(techSignals, combined);
    renderLongTermSuggestions(fundSignals, combined);
    renderCombinedSuggestions(techSignals, fundSignals);
    setAllocatorSignals(combined);

    const pickMeta = new Map<string, PickMeta>(topStocks.map((s: any) => [s.ticker, {
      companyName: s.companyName,
      exchange: s.exchange,
      close: s.close,
      pctChange: s.pctChange,
      ceiling: s.ceiling,
      floor: s.floor,
      rvol: s.rvol,
    }]));
    setDailyPicks(combined, pickMeta, !isAnyDataMock());
    renderFeedMeta('picksProvenance', 'stocks', 'Bảng giá đầu vào');
    const analysisMeta = document.getElementById('suggestionsProvenance');
    if (analysisMeta) {
      const source = (key: string) => {
        const feed = getFeedProvenance(key);
        return feed ? (feed.isMock ? 'MẪU' : feed.source.toUpperCase()) : 'chưa rõ';
      };
      analysisMeta.textContent = `Phân tích ${tickers.length} mã · bảng giá ${source('stocks')} · lịch sử ${source('history')} · tài chính ${source('finance')} · tin ${source('news')} · nhận ${new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' })}${isAnyDataMock() ? ' · CÓ NGUỒN MẪU' : ''}`;
      analysisMeta.classList.toggle('is-mock', isAnyDataMock());
    }
    updateChartRecommendedOptgroup(combined);
  } catch (e) {
    console.error('Suggestions error:', e);
    showLoadError('shortTermCards', 'Chưa tải được tín hiệu phân tích.', () => void loadSuggestions());
    showLoadError('longTermCards', 'Chưa tải được tín hiệu phân tích.', () => void loadSuggestions());
    showLoadError('combinedCards', 'Chưa tải được tín hiệu phân tích.', () => void loadSuggestions());
  }
}

// Surfaces today's actual top BUY candidates at the top of the chart symbol
// picker, instead of only ever offering a fixed, generic VN30/bank list.
function updateChartRecommendedOptgroup(combined: ReturnType<typeof getCombinedSignals>) {
  const select = document.getElementById('chartSymbol') as HTMLSelectElement | null;
  if (!select) return;

  const top = combined.filter(c => c.decision === 'BUY').slice(0, 6);
  if (top.length === 0) return;

  let group = select.querySelector('optgroup[data-recommended]') as HTMLOptGroupElement | null;
  if (!group) {
    group = document.createElement('optgroup');
    group.dataset.recommended = 'true';
    group.label = '⭐ Đáng đầu tư hôm nay';
    select.insertBefore(group, select.firstChild);
  }
  group.innerHTML = top.map(c => `<option value="${c.ticker}">${c.ticker} (${c.combinedScore}/100)</option>`).join('');
}

async function loadNewsFeed() {
  try {
    const newsData = await fetchMarketNews();
    if (newsData) {
      renderNewsFeed(newsData.articles, newsData.sentiment);
      renderFeedMeta('newsProvenance', 'marketNews', 'Bản tin mới nhất');
    }
  } catch (e) {
    console.error('News feed error:', e);
    showLoadError('newsContent', 'Không tải được tin tức.', () => void loadNewsFeed());
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
  const partial = partialMockFeeds();
  const partialText = Object.entries(partial).map(([kind, tickers]) => `${({ finance: 'BCTC', history: 'giá lịch sử', news: 'tin tức' } as Record<string, string>)[kind] || kind}: ${tickers.slice(0, 5).join(', ')}${tickers.length > 5 ? ` +${tickers.length - 5}` : ''}`).join(' · ');
  if (isAnyDataMock()) {
    badge.textContent = '⚠️ DỮ LIỆU MẪU';
    badge.title = 'Một nguồn dữ liệu chính đang dùng dữ liệu mẫu/giả lập (không phải giá thị trường thực), do backend không lấy được dữ liệu thật.';
  } else if (partialText) {
    badge.textContent = `⚠️ Thiếu dữ liệu — ${partialText}`;
    badge.title = 'Giá thị trường là dữ liệu thật; chỉ các mã này không lấy được dữ liệu riêng từ nguồn, nên phần đó đang dùng dữ liệu mẫu.';
  }
  badge.style.display = isAnyDataMock() || partialText ? 'flex' : 'none';
  if (marketOverviewConnected) updateMarketStatus(true);
}

async function refreshAll() {
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
  // Init UI components
  initSearchBar();
  initStockTable();
  initChart();
  initCapitalAllocator();
  initAgentCouncil();
  initDailyPicks();
  initPortfolio();
  initTcbsAccount();
  initQuantPanel();
  // Login only exists on the deployed site (Vercel middleware), not the local dev server
  const logoutLink = document.getElementById('logoutLink');
  if (logoutLink && !['localhost', '127.0.0.1'].includes(location.hostname)) logoutLink.hidden = false;
  // Self-hosted (Docker/VPS) password gate: show logout whenever the backend says login is on.
  fetch('/api/health').then(r => (r.headers.get('content-type') || '').includes('json') ? r.json() : null)
    .then(h => { if (logoutLink && h?.auth === 'on') logoutLink.hidden = false; }).catch(() => { /* no backend */ });
  window.openCouncilForTicker = openCouncilForTicker;

  const strategyFilter = document.getElementById('strategyFilter') as HTMLSelectElement | null;
  strategyFilter?.addEventListener('change', () => {
    const value = strategyFilter.value;
    const tickers = new Set(
      value === 'swing' || value === 'position' || value === 'scalp'
        ? latestTechSignals.filter(signal => signal.tradeType.toLowerCase() === value).map(signal => signal.ticker)
        : value === 'value' || value === 'growth' || value === 'dividend'
          ? latestFundSignals.filter(signal => signal.investmentType.toLowerCase() === value).map(signal => signal.ticker)
          : value === 'buy' ? latestCombined.filter(signal => signal.decision === 'BUY').map(signal => signal.ticker) : latestCombined.map(signal => signal.ticker)
    );
    const tech = latestTechSignals.filter(signal => tickers.has(signal.ticker));
    const fund = latestFundSignals.filter(signal => tickers.has(signal.ticker));
    const combined = value === 'all' ? latestCombined : latestCombined.filter(signal => tickers.has(signal.ticker));
    renderShortTermSuggestions(tech, combined);
    renderLongTermSuggestions(fund, combined);
    renderCombinedSuggestions(tech, fund);
  });

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

  // Keep the current section visible in the navigation while scrolling.
  const navLinks = document.querySelectorAll('.nav-link');
  navLinks.forEach(link => {
    link.addEventListener('click', () => {
      navLinks.forEach(l => l.classList.remove('active'));
      link.classList.add('active');
    });
  });
  const sections = [...navLinks]
    .map(link => document.querySelector((link as HTMLAnchorElement).hash))
    .filter((section): section is Element => section !== null);
  const sectionObserver = new IntersectionObserver(entries => {
    const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (!visible) return;
    navLinks.forEach(link => {
      const active = (link as HTMLAnchorElement).hash === `#${visible.target.id}`;
      link.classList.toggle('active', active);
      if (active) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    });
  }, { rootMargin: '-20% 0px -65% 0px', threshold: 0 });
  sections.forEach(section => sectionObserver.observe(section));

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

  updateDataSourceBadge();

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
