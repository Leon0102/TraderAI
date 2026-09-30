// Stock API integration - calls our /api/* backend (VCI-backed), falls
// back to mock data if the backend is unavailable.
//
// A previous version of this file also tried calling TCBS directly from
// the browser before hitting our backend, on the theory that TCBS's
// Cloudflare bot challenge only blocks datacenter IPs. That was wrong:
// Cloudflare's managed challenge requires a full page navigation to run its
// JS solve step, so a bare fetch() call gets a 403 regardless of whose IP
// it comes from (verified against production - see git history). Removed
// to avoid pointless failed requests in every user's Network tab.

interface StockBar {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  tradingDate: string;
}

interface StockInfo {
  ticker: string;
  companyName: string;
  exchange: string;
  industry: string;
}

interface FinancialData {
  ticker: string;
  pe: number;
  pb: number;
  roe: number;
  eps: number;
  revenue: number;
  revenueGrowth: number;
  epsGrowth: number;
  marketCap: number;
  // Enhanced fields
  dividendYield: number;
  debtOnEquity: number;
  netMargin: number;
  freeCashFlow: number;
  totalAssets: number;
  interestCoverage: number;
  currentRatio: number;
  industry: string;
}

interface MarketAnalysisData {
  vnindexHistory: StockBar[];
  sectors: SectorData[];
  source: string;
}

interface SectorData {
  name: string;
  change: number;
  volume: number;
  advances: number;
  declines: number;
  marketCap: number;
}

interface NewsArticle {
  title: string;
  summary: string;
  url: string;
  source: string;
  publishedAt: string;
  sentiment: number;        // -100 to +100
  sentimentLabel: 'positive' | 'negative' | 'neutral';
  eventType: string;        // EARNINGS, DIVIDEND, M&A, INSIDER, REGULATION, INDUSTRY, MARKET
  relatedTickers: string[];
}

interface SentimentSummary {
  overall: number;          // -100 to +100
  label: 'positive' | 'negative' | 'neutral';
  articleCount: number;
  positiveCount: number;
  negativeCount: number;
  neutralCount: number;
  trend: 'IMPROVING' | 'WORSENING' | 'STABLE';
  keyEvents: string[];
}

interface PriceZone {
  type: 'BUY' | 'SELL';
  price: number;
  label: string;
  reasoning: string;
  allocation: number;       // percentage 0-100
}

interface PriceScenario {
  name: 'BEST' | 'BASE' | 'WORST';
  targetPrice: number;
  probability: number;      // 0-100
  timeline: string;
  drivers: string[];
}

// In dev mode, Vite proxies /api to http://localhost:8000
// In production (Vercel), /api is served by serverless functions
const API_BASE = '/api';

// Real (non-mock) source labels returned by the backend for each endpoint.
// 'local' = computed by the backend from its own database of published statements.
const REAL_SOURCES = new Set(['tcbs', 'vnstock', 'vci', 'ssi', 'dnse', 'rss', 'tcbs+rss', 'local']);

// Tracks, per feed, whether the data currently shown is real or fallback/mock.
// Read this from the UI to warn users when the dashboard is showing demo data.
export const dataSourceStatus: Record<string, 'real' | 'mock'> = {};

export interface FeedProvenance {
  source: string;
  fetchedAt: string;
  asOf?: string;
  isMock: boolean;
}
const feedProvenance: Record<string, FeedProvenance> = {};

export function getFeedProvenance(key: string): FeedProvenance | undefined {
  return feedProvenance[key];
}

function recordSource(key: string, source: string | undefined, asOf?: string) {
  const isMock = !source || !REAL_SOURCES.has(source);
  dataSourceStatus[key] = isMock ? 'mock' : 'real';
  feedProvenance[key] = { source: isMock ? 'mock' : source, fetchedAt: new Date().toISOString(), asOf, isMock };
}

// Feeds the whole dashboard depends on. Per-ticker feeds ("finance:DMX") failing only affect that ticker.
const CORE_FEEDS = ['stocks', 'market', 'marketAnalysis', 'marketNews'];

/** True when a core feed is demo data: the dashboard as a whole is not showing real prices. */
export function isAnyDataMock(): boolean {
  return CORE_FEEDS.some(k => dataSourceStatus[k] === 'mock');
}

/** Tickers whose own history/finance/news fell back to demo data, e.g. { finance: ['DMX'] }. */
export function partialMockFeeds(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [key, status] of Object.entries(dataSourceStatus)) {
    const [kind, ticker] = key.split(':');
    if (status === 'mock' && ticker) (out[kind] ||= []).push(ticker);
  }
  return out;
}

// The page fires dozens of these concurrently on load (20+ tickers x
// history/finance/news), which can transiently overwhelm the upstream data
// source and fail a handful of requests even though the source is fine
// moments later. One retry after a short pause recovers most of those
// instead of silently falling back to mock data.
/** The deployed site sits behind a login; an expired session makes every API call 401. */
export function redirectToLoginIfUnauthorized(res: Response): void {
  if (res.status === 401 && !location.pathname.startsWith('/login')) {
    location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
  }
}

async function apiFetch(path: string, retries = 1): Promise<any> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${API_BASE}${path}`, {
        headers: { 'Accept': 'application/json' },
      });
      if (res.ok) {
        return await res.json();
      }
      if (res.status === 401) {
        redirectToLoginIfUnauthorized(res);
        return null;
      }
    } catch (_e) {
      // Backend unavailable, fall through to retry/null
    }
    if (attempt < retries) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  return null;
}

export async function fetchStockBars(
  ticker: string,
  resolution: string = 'D',
  countBack: number = 120
): Promise<StockBar[]> {
  const end = new Date().toISOString().split('T')[0];
  const daysBack = resolution === 'W' ? countBack * 7 : resolution === 'M' ? countBack * 30 : countBack;
  const startDate = new Date(Date.now() - daysBack * 86400000);
  const start = startDate.toISOString().split('T')[0];

  const data = await apiFetch(`/history?ticker=${ticker}&start=${start}&end=${end}&resolution=${resolution}`);

  if (data && data.data && data.data.length > 0) {
    recordSource('history', data.source, data.data.at(-1)?.tradingDate);
    recordSource(`history:${ticker}`, data.source, data.data.at(-1)?.tradingDate);
    return data.data;
  }

  // Fallback mock data
  recordSource('history', undefined);
  recordSource(`history:${ticker}`, undefined);
  return generateMockBars(ticker, countBack);
}

/** Evaluation must never fall back to generated prices. */
export async function fetchEvaluationBars(ticker: string, start: string): Promise<StockBar[] | null> {
  const end = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const data = await apiFetch(`/history?ticker=${encodeURIComponent(ticker)}&start=${start}&end=${end}&resolution=D`, 0);
  return data?.data?.length && REAL_SOURCES.has(data.source) ? data.data as StockBar[] : null;
}

/**
 * Daily bars lag the live board: intraday, the last bar is still yesterday's close.
 * Analysing those bars while showing the live price produces plans anchored to the
 * wrong price (target below market). Append today's session as a bar so levels,
 * indicators and the quoted price all refer to the same number.
 */
export function withLiveBar(bars: StockBar[], live?: { close?: number; high?: number; low?: number; refPrice?: number; volume?: number }): StockBar[] {
  if (!bars.length || !live?.close) return bars;
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  const last = bars[bars.length - 1];
  const liveBar: StockBar = {
    tradingDate: today,
    open: live.refPrice ? live.refPrice / 1000 : last.close,
    high: live.high || live.close,
    low: live.low || live.close,
    close: live.close,
    volume: live.volume || 0,
  };
  return last.tradingDate === today ? [...bars.slice(0, -1), liveBar] : [...bars, liveBar];
}

export async function fetchTopStocks(count: number = 20): Promise<any[]> {
  const data = await apiFetch(`/stocks?count=${count}`);

  if (data && data.data && data.data.length > 0) {
    recordSource('stocks', data.source, data.data[0]?.tradingDate);
    return data.data;
  }

  recordSource('stocks', undefined);
  return getMockTopStocks(count);
}

export interface ListedSymbol {
  ticker: string;
  name: string;
  exchange: string;
}

let symbolsPromise: Promise<ListedSymbol[]> | null = null;

/** Every listed stock (HOSE/HNX/UPCoM), fetched once per page load. Empty if the backend is unreachable. */
export function fetchSymbols(): Promise<ListedSymbol[]> {
  symbolsPromise ??= apiFetch('/stocks?action=symbols').then(data => {
    if (data?.data?.length) return data.data as ListedSymbol[];
    symbolsPromise = null; // allow a retry on the next call
    return [];
  });
  return symbolsPromise;
}

export async function fetchMarketOverview(): Promise<any[]> {
  const data = await apiFetch('/market');

  if (data && data.data) {
    recordSource('market', data.source, data.data[0]?.tradingDate);
    return data.data;
  }

  recordSource('market', undefined);
  return getMockMarketData();
}

export async function fetchFinancialData(ticker: string): Promise<FinancialData | null> {
  const data = await apiFetch(`/finance?ticker=${ticker}`);

  if (data && data.data) {
    recordSource('finance', data.source);
    recordSource(`finance:${ticker}`, data.source);
    return data.data;
  }

  recordSource('finance', undefined);
  recordSource(`finance:${ticker}`, undefined);
  return getMockFinancialData(ticker);
}

export async function fetchMarketAnalysis(): Promise<MarketAnalysisData | null> {
  const data = await apiFetch('/market?action=analysis');

  if (data && data.vnindexHistory) {
    recordSource('marketAnalysis', data.source);
    return data;
  }

  recordSource('marketAnalysis', undefined);
  return getMockMarketAnalysis();
}

export async function fetchMultipleFinancials(tickers: string[]): Promise<FinancialData[]> {
  const results = await Promise.all(
    tickers.map(t => fetchFinancialData(t))
  );
  return results.filter(Boolean) as FinancialData[];
}

export async function fetchTickerNews(ticker: string): Promise<{ articles: NewsArticle[]; sentiment: SentimentSummary }> {
  const data = await apiFetch(`/news?ticker=${encodeURIComponent(ticker)}`);
  if (data && data.articles) {
    recordSource('news', data.source, data.articles[0]?.publishedAt);
    return { articles: data.articles, sentiment: data.sentiment };
  }
  recordSource('news', undefined);
  return getMockTickerNews(ticker);
}

export async function fetchMarketNews(): Promise<{ articles: NewsArticle[]; sentiment: SentimentSummary }> {
  const data = await apiFetch('/news?action=market');
  if (data && data.articles) {
    recordSource('marketNews', data.source, data.articles[0]?.publishedAt);
    return { articles: data.articles, sentiment: data.sentiment };
  }
  recordSource('marketNews', undefined);
  return getMockTickerNews();
}

export async function fetchMultipleTickerNews(tickers: string[]): Promise<Map<string, { articles: NewsArticle[]; sentiment: SentimentSummary }>> {
  const data = await apiFetch(`/news?tickers=${tickers.join(',')}`);
  recordSource('news', data?.articles ? data.source : undefined);
  const result = new Map<string, { articles: NewsArticle[]; sentiment: SentimentSummary }>();

  const allArticles: NewsArticle[] = data?.articles || getMockAllNews();

  for (const ticker of tickers) {
    const tickerArticles = allArticles.filter(a => a.relatedTickers.includes(ticker));
    const otherArticles = allArticles.filter(a => !a.relatedTickers.includes(ticker));
    const articles = [...tickerArticles, ...otherArticles.slice(0, 3)];

    const pos = tickerArticles.filter(a => a.sentiment > 15).length;
    const neg = tickerArticles.filter(a => a.sentiment < -15).length;
    const overall = tickerArticles.length > 0
      ? Math.round(tickerArticles.reduce((s, a) => s + a.sentiment, 0) / tickerArticles.length)
      : 0;

    result.set(ticker, {
      articles,
      sentiment: {
        overall,
        label: overall > 15 ? 'positive' : overall < -15 ? 'negative' : 'neutral',
        articleCount: tickerArticles.length,
        positiveCount: pos,
        negativeCount: neg,
        neutralCount: tickerArticles.length - pos - neg,
        trend: 'STABLE',
        keyEvents: [],
      }
    });
  }
  return result;
}

// ===========================
// Mock Data Generators (used when backend is not running)
// ===========================

function generateMockBars(ticker: string, count: number): StockBar[] {
  const bars: StockBar[] = [];
  const seed = ticker.charCodeAt(0) + ticker.charCodeAt(1);
  let basePrice = 20 + (seed % 80);

  const now = new Date();

  for (let i = count; i >= 0; i--) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);

    const change = (Math.random() - 0.48) * basePrice * 0.04;
    const open = basePrice;
    const close = basePrice + change;
    const high = Math.max(open, close) + Math.random() * basePrice * 0.02;
    const low = Math.min(open, close) - Math.random() * basePrice * 0.02;
    const volume = Math.floor(500000 + Math.random() * 5000000);

    bars.push({
      open: Math.round(open * 100) / 100,
      high: Math.round(high * 100) / 100,
      low: Math.round(low * 100) / 100,
      close: Math.round(close * 100) / 100,
      volume,
      tradingDate: date.toISOString().split('T')[0],
    });

    basePrice = close;
  }

  return bars;
}

function getMockTopStocks(_count: number = 20): any[] {
  const stocks = [
    { ticker: 'FPT', companyName: 'FPT Corporation', close: 125.5, change: 2.3, pctChange: 1.87, volume: 12500000, high: 126.8, low: 123.2 },
    { ticker: 'VNM', companyName: 'Vinamilk', close: 72.5, change: -0.8, pctChange: -1.09, volume: 8900000, high: 73.5, low: 72.0 },
    { ticker: 'VIC', companyName: 'Vingroup', close: 42.3, change: 0.5, pctChange: 1.20, volume: 15600000, high: 42.8, low: 41.5 },
    { ticker: 'HPG', companyName: 'Hoa Phat', close: 26.8, change: -0.3, pctChange: -1.11, volume: 25400000, high: 27.3, low: 26.5 },
    { ticker: 'MWG', companyName: 'The Gioi Di Dong', close: 55.7, change: 1.2, pctChange: 2.20, volume: 6800000, high: 56.2, low: 54.5 },
    { ticker: 'TCB', companyName: 'Techcombank', close: 35.2, change: 0.4, pctChange: 1.15, volume: 11200000, high: 35.8, low: 34.8 },
    { ticker: 'VHM', companyName: 'Vinhomes', close: 37.5, change: -0.6, pctChange: -1.57, volume: 9800000, high: 38.5, low: 37.2 },
    { ticker: 'MSN', companyName: 'Masan Group', close: 68.3, change: 1.8, pctChange: 2.71, volume: 5400000, high: 69.0, low: 66.5 },
    { ticker: 'VCB', companyName: 'Vietcombank', close: 92.8, change: 0.3, pctChange: 0.32, volume: 3200000, high: 93.2, low: 92.0 },
    { ticker: 'ACB', companyName: 'ACB Bank', close: 25.6, change: -0.2, pctChange: -0.78, volume: 14500000, high: 26.0, low: 25.3 },
    { ticker: 'SSI', companyName: 'SSI Securities', close: 32.4, change: 0.8, pctChange: 2.53, volume: 18200000, high: 32.8, low: 31.5 },
    { ticker: 'VPB', companyName: 'VPBank', close: 20.8, change: 0.3, pctChange: 1.46, volume: 22100000, high: 21.2, low: 20.4 },
    { ticker: 'STB', companyName: 'Sacombank', close: 31.5, change: -0.5, pctChange: -1.56, volume: 16800000, high: 32.2, low: 31.2 },
    { ticker: 'GAS', companyName: 'PV Gas', close: 78.5, change: 2.1, pctChange: 2.75, volume: 4100000, high: 79.2, low: 76.4 },
    { ticker: 'PLX', companyName: 'Petrolimex', close: 38.9, change: -0.7, pctChange: -1.77, volume: 3500000, high: 39.8, low: 38.5 },
  ];

  return stocks.map(s => {
    const randChange = (Math.random() - 0.5) * 2;
    const newClose = s.close + randChange;
    const change = Math.round(randChange * 100) / 100;
    return {
      ...s,
      close: Math.round(newClose * 100) / 100,
      change,
      pctChange: Math.round((change / s.close) * 10000) / 100,
      volume: s.volume + Math.floor((Math.random() - 0.5) * 2000000),
    };
  });
}

function getMockMarketData(): any[] {
  return [
    {
      ticker: 'VNINDEX', name: 'VN-Index',
      close: 1248.5 + (Math.random() - 0.5) * 20,
      change: (Math.random() - 0.45) * 15,
      pctChange: (Math.random() - 0.45) * 1.2,
      volume: 850000000, advances: 185, declines: 130, unchanged: 35,
    },
    {
      ticker: 'HNXINDEX', name: 'HNX-Index',
      close: 228.3 + (Math.random() - 0.5) * 5,
      change: (Math.random() - 0.45) * 3,
      pctChange: (Math.random() - 0.45) * 1.5,
      volume: 120000000, advances: 82, declines: 65, unchanged: 18,
    },
    {
      ticker: 'UPINDEX', name: 'UPCOM',
      close: 92.1 + (Math.random() - 0.5) * 3,
      change: (Math.random() - 0.45) * 1.5,
      pctChange: (Math.random() - 0.45) * 1.0,
      volume: 60000000, advances: 105, declines: 85, unchanged: 42,
    },
  ];
}

function getMockFinancialData(ticker: string): FinancialData {
  const fundamentals: Record<string, FinancialData> = {
    FPT: { ticker: 'FPT', pe: 18.5, pb: 4.2, roe: 22.5, eps: 6800, revenue: 52000, revenueGrowth: 19.5, epsGrowth: 15.2, marketCap: 160000, dividendYield: 2.1, debtOnEquity: 0.45, netMargin: 12.5, freeCashFlow: 8500, totalAssets: 65000, interestCoverage: 8.5, currentRatio: 1.8, industry: 'CNTT' },
    VNM: { ticker: 'VNM', pe: 16.2, pb: 4.5, roe: 28.3, eps: 4470, revenue: 60000, revenueGrowth: 5.8, epsGrowth: 3.2, marketCap: 150000, dividendYield: 4.5, debtOnEquity: 0.25, netMargin: 18.2, freeCashFlow: 12000, totalAssets: 50000, interestCoverage: 15.2, currentRatio: 2.5, industry: 'Thực phẩm' },
    VIC: { ticker: 'VIC', pe: 52.3, pb: 3.1, roe: 6.2, eps: 810, revenue: 95000, revenueGrowth: 12.3, epsGrowth: -5.1, marketCap: 145000, dividendYield: 0, debtOnEquity: 2.8, netMargin: 3.5, freeCashFlow: -15000, totalAssets: 450000, interestCoverage: 1.8, currentRatio: 0.9, industry: 'Bất động sản' },
    HPG: { ticker: 'HPG', pe: 8.5, pb: 1.5, roe: 18.2, eps: 3150, revenue: 120000, revenueGrowth: 25.3, epsGrowth: 42.1, marketCap: 115000, dividendYield: 1.5, debtOnEquity: 0.65, netMargin: 8.5, freeCashFlow: 6000, totalAssets: 180000, interestCoverage: 5.5, currentRatio: 1.5, industry: 'Thép' },
    MWG: { ticker: 'MWG', pe: 14.2, pb: 3.2, roe: 22.8, eps: 3920, revenue: 130000, revenueGrowth: 8.5, epsGrowth: 35.6, marketCap: 80000, dividendYield: 1.0, debtOnEquity: 0.55, netMargin: 4.2, freeCashFlow: 5500, totalAssets: 75000, interestCoverage: 6.2, currentRatio: 1.3, industry: 'Bán lẻ' },
    TCB: { ticker: 'TCB', pe: 7.8, pb: 1.3, roe: 17.5, eps: 4510, revenue: 28000, revenueGrowth: 18.2, epsGrowth: 22.3, marketCap: 120000, dividendYield: 0, debtOnEquity: 5.2, netMargin: 35.0, freeCashFlow: 0, totalAssets: 680000, interestCoverage: 0, currentRatio: 0, industry: 'Ngân hàng' },
    VHM: { ticker: 'VHM', pe: 12.5, pb: 1.8, roe: 15.2, eps: 3000, revenue: 45000, revenueGrowth: -8.5, epsGrowth: -12.3, marketCap: 125000, dividendYield: 2.0, debtOnEquity: 1.2, netMargin: 22.5, freeCashFlow: -5000, totalAssets: 200000, interestCoverage: 3.5, currentRatio: 1.1, industry: 'Bất động sản' },
    MSN: { ticker: 'MSN', pe: 21.3, pb: 2.8, roe: 13.5, eps: 3200, revenue: 78000, revenueGrowth: 10.8, epsGrowth: 18.5, marketCap: 95000, dividendYield: 0.5, debtOnEquity: 1.5, netMargin: 5.8, freeCashFlow: 3000, totalAssets: 180000, interestCoverage: 2.8, currentRatio: 1.2, industry: 'Thực phẩm' },
    VCB: { ticker: 'VCB', pe: 14.5, pb: 3.5, roe: 25.2, eps: 6400, revenue: 42000, revenueGrowth: 12.5, epsGrowth: 10.8, marketCap: 400000, dividendYield: 1.2, debtOnEquity: 8.5, netMargin: 42.0, freeCashFlow: 0, totalAssets: 1800000, interestCoverage: 0, currentRatio: 0, industry: 'Ngân hàng' },
    ACB: { ticker: 'ACB', pe: 6.8, pb: 1.6, roe: 24.5, eps: 3760, revenue: 18000, revenueGrowth: 15.8, epsGrowth: 20.1, marketCap: 75000, dividendYield: 0, debtOnEquity: 7.0, netMargin: 38.0, freeCashFlow: 0, totalAssets: 650000, interestCoverage: 0, currentRatio: 0, industry: 'Ngân hàng' },
    SSI: { ticker: 'SSI', pe: 10.2, pb: 1.8, roe: 18.2, eps: 3180, revenue: 8500, revenueGrowth: 22.5, epsGrowth: 28.3, marketCap: 45000, dividendYield: 2.5, debtOnEquity: 1.8, netMargin: 22.0, freeCashFlow: 2500, totalAssets: 55000, interestCoverage: 4.5, currentRatio: 1.6, industry: 'Chứng khoán' },
    VPB: { ticker: 'VPB', pe: 5.5, pb: 1.1, roe: 20.5, eps: 3780, revenue: 35000, revenueGrowth: 20.3, epsGrowth: 25.8, marketCap: 95000, dividendYield: 0, debtOnEquity: 6.5, netMargin: 32.0, freeCashFlow: 0, totalAssets: 750000, interestCoverage: 0, currentRatio: 0, industry: 'Ngân hàng' },
    STB: { ticker: 'STB', pe: 8.2, pb: 1.4, roe: 17.8, eps: 3840, revenue: 15000, revenueGrowth: 13.2, epsGrowth: 18.5, marketCap: 60000, dividendYield: 0, debtOnEquity: 7.2, netMargin: 28.0, freeCashFlow: 0, totalAssets: 580000, interestCoverage: 0, currentRatio: 0, industry: 'Ngân hàng' },
    GAS: { ticker: 'GAS', pe: 15.8, pb: 3.2, roe: 21.5, eps: 4970, revenue: 85000, revenueGrowth: 8.2, epsGrowth: 5.8, marketCap: 150000, dividendYield: 5.0, debtOnEquity: 0.3, netMargin: 15.0, freeCashFlow: 10000, totalAssets: 95000, interestCoverage: 20.0, currentRatio: 2.2, industry: 'Dầu khí' },
    PLX: { ticker: 'PLX', pe: 12.5, pb: 2.1, roe: 16.8, eps: 3110, revenue: 250000, revenueGrowth: 5.2, epsGrowth: 8.5, marketCap: 50000, dividendYield: 3.5, debtOnEquity: 0.8, netMargin: 2.5, freeCashFlow: 3500, totalAssets: 85000, interestCoverage: 5.0, currentRatio: 1.4, industry: 'Dầu khí' },
  };

  return fundamentals[ticker] || {
    ticker, pe: 12 + Math.random() * 10, pb: 1.5 + Math.random() * 2,
    roe: 10 + Math.random() * 15, eps: 2000 + Math.random() * 5000,
    revenue: 20000 + Math.random() * 80000, revenueGrowth: Math.random() * 20 - 5,
    epsGrowth: Math.random() * 30 - 10, marketCap: 30000 + Math.random() * 100000,
    dividendYield: Math.random() * 4, debtOnEquity: Math.random() * 2,
    netMargin: 5 + Math.random() * 20, freeCashFlow: Math.random() * 10000 - 2000,
    totalAssets: 50000 + Math.random() * 200000, interestCoverage: 2 + Math.random() * 10,
    currentRatio: 0.8 + Math.random() * 2, industry: 'Khác',
  };
}

function getMockMarketAnalysis(): MarketAnalysisData {
  const bars: StockBar[] = [];
  let base = 1200;
  const now = new Date();
  for (let i = 100; i >= 0; i--) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const change = (Math.random() - 0.48) * 15;
    const o = base;
    const c = base + change;
    const h = Math.max(o, c) + Math.random() * 8;
    const lo = Math.min(o, c) - Math.random() * 8;
    bars.push({
      tradingDate: date.toISOString().split('T')[0],
      open: Math.round(o * 100) / 100,
      high: Math.round(h * 100) / 100,
      low: Math.round(lo * 100) / 100,
      close: Math.round(c * 100) / 100,
      volume: Math.floor(500000000 + Math.random() * 700000000),
    });
    base = c;
  }

  const mockSectors = [
    'Ngân hàng', 'Bất động sản', 'Chứng khoán', 'Thép',
    'Thực phẩm', 'Dầu khí', 'CNTT', 'Bán lẻ',
    'Điện', 'Xây dựng', 'Hóa chất', 'Dệt may'
  ];

  return {
    vnindexHistory: bars,
    sectors: mockSectors.map(s => ({
      name: s,
      change: Math.round((Math.random() * 6 - 3) * 100) / 100,
      volume: Math.floor(Math.random() * 200000000),
      advances: Math.floor(Math.random() * 20 + 3),
      declines: Math.floor(Math.random() * 15 + 3),
      marketCap: Math.floor(Math.random() * 500000 + 50000),
    })),
    source: 'mock',
  };
}

function getMockAllNews(): NewsArticle[] {
  const now = Date.now();
  return [
    { title: 'VN-Index vượt mốc 1.260 điểm, thanh khoản đạt kỷ lục', summary: 'Thị trường chứng khoán phiên hôm nay ghi nhận đà tăng mạnh.', url: '#', source: 'CafeF', publishedAt: new Date(now - 3600000).toISOString(), sentiment: 65, sentimentLabel: 'positive', eventType: 'MARKET', relatedTickers: [] },
    { title: 'FPT báo lãi ròng quý 4 tăng 22% so với cùng kỳ', summary: 'Lợi nhuận ròng đạt 2.100 tỷ đồng nhờ mảng CNTT.', url: '#', source: 'VnExpress', publishedAt: new Date(now - 7200000).toISOString(), sentiment: 72, sentimentLabel: 'positive', eventType: 'EARNINGS', relatedTickers: ['FPT'] },
    { title: 'Khối ngoại bán ròng hơn 500 tỷ đồng trên HOSE', summary: 'Tập trung bán nhóm ngân hàng và bất động sản.', url: '#', source: 'CafeF', publishedAt: new Date(now - 10800000).toISOString(), sentiment: -45, sentimentLabel: 'negative', eventType: 'MARKET', relatedTickers: ['VCB', 'TCB', 'VIC'] },
    { title: 'HPG: Sản lượng thép tháng 3 tăng mạnh 35%', summary: 'Hòa Phát ghi nhận sản lượng kỷ lục, xuất khẩu tăng.', url: '#', source: 'VnExpress', publishedAt: new Date(now - 14400000).toISOString(), sentiment: 58, sentimentLabel: 'positive', eventType: 'EARNINGS', relatedTickers: ['HPG'] },
    { title: 'Vingroup ký hợp đồng hợp tác chiến lược với đối tác Nhật', summary: 'Hợp tác trong lĩnh vực công nghệ và xe điện.', url: '#', source: 'CafeF', publishedAt: new Date(now - 18000000).toISOString(), sentiment: 48, sentimentLabel: 'positive', eventType: 'M&A', relatedTickers: ['VIC'] },
    { title: 'NHNN giữ nguyên lãi suất, hỗ trợ tăng trưởng', summary: 'Ngân hàng Nhà nước ổn định lãi suất điều hành.', url: '#', source: 'VnExpress', publishedAt: new Date(now - 21600000).toISOString(), sentiment: 35, sentimentLabel: 'positive', eventType: 'REGULATION', relatedTickers: ['VCB', 'TCB', 'ACB', 'VPB', 'MBB'] },
    { title: 'MWG: Bách Hóa Xanh lần đầu có lãi', summary: 'Doanh thu chuỗi tăng 25%, vượt kỳ vọng thị trường.', url: '#', source: 'CafeF', publishedAt: new Date(now - 25200000).toISOString(), sentiment: 68, sentimentLabel: 'positive', eventType: 'EARNINGS', relatedTickers: ['MWG'] },
    { title: 'Cảnh báo rủi ro nhóm BĐS: áp lực trái phiếu đáo hạn', summary: 'Dòng tiền yếu tại nhiều doanh nghiệp bất động sản.', url: '#', source: 'VnExpress', publishedAt: new Date(now - 28800000).toISOString(), sentiment: -52, sentimentLabel: 'negative', eventType: 'INDUSTRY', relatedTickers: ['VIC', 'VHM'] },
    { title: 'VNM chia cổ tức tiền mặt 2.000 đồng/cp', summary: 'Ngày chốt danh sách cổ đông ngày 15/4.', url: '#', source: 'CafeF', publishedAt: new Date(now - 32400000).toISOString(), sentiment: 55, sentimentLabel: 'positive', eventType: 'DIVIDEND', relatedTickers: ['VNM'] },
    { title: 'SSI dẫn đầu thanh khoản, dòng tiền đổ vào chứng khoán', summary: 'Thanh khoản SSI đạt hơn 1.800 tỷ đồng.', url: '#', source: 'VnExpress', publishedAt: new Date(now - 36000000).toISOString(), sentiment: 42, sentimentLabel: 'positive', eventType: 'MARKET', relatedTickers: ['SSI'] },
    { title: 'PV Gas đặt mục tiêu lợi nhuận tăng 15%', summary: 'ĐHĐCĐ thông qua kế hoạch kinh doanh tích cực.', url: '#', source: 'CafeF', publishedAt: new Date(now - 39600000).toISOString(), sentiment: 50, sentimentLabel: 'positive', eventType: 'EARNINGS', relatedTickers: ['GAS'] },
    { title: 'Petrolimex cảnh báo lợi nhuận Q1 giảm do giá dầu', summary: 'Chi phí vận hành tăng và biến động giá dầu thế giới.', url: '#', source: 'VnExpress', publishedAt: new Date(now - 43200000).toISOString(), sentiment: -38, sentimentLabel: 'negative', eventType: 'EARNINGS', relatedTickers: ['PLX'] },
    { title: 'ACB: Tín dụng tăng trưởng tốt, NIM cải thiện', summary: 'Biên lãi thuần ngân hàng mở rộng nhờ cơ cấu danh mục.', url: '#', source: 'CafeF', publishedAt: new Date(now - 46800000).toISOString(), sentiment: 45, sentimentLabel: 'positive', eventType: 'EARNINGS', relatedTickers: ['ACB'] },
    { title: 'MSN: Masan thoái vốn mảng thịt, tập trung bán lẻ', summary: 'Chiến lược tái cơ cấu tập trung vào WinMart.', url: '#', source: 'VnExpress', publishedAt: new Date(now - 50400000).toISOString(), sentiment: 15, sentimentLabel: 'neutral', eventType: 'M&A', relatedTickers: ['MSN'] },
    { title: 'STB hoàn tất xử lý nợ xấu, ROE cải thiện', summary: 'Sacombank hoàn thành giai đoạn tái cơ cấu.', url: '#', source: 'CafeF', publishedAt: new Date(now - 54000000).toISOString(), sentiment: 45, sentimentLabel: 'positive', eventType: 'EARNINGS', relatedTickers: ['STB'] },
  ];
}

function getMockTickerNews(ticker?: string): { articles: NewsArticle[]; sentiment: SentimentSummary } {
  const allNews = getMockAllNews();
  let articles: NewsArticle[];

  if (ticker) {
    const tickerNews = allNews.filter(a => a.relatedTickers.includes(ticker));
    const otherNews = allNews.filter(a => !a.relatedTickers.includes(ticker));
    articles = [...tickerNews, ...otherNews].slice(0, 10);
  } else {
    articles = allNews.slice(0, 10);
  }

  const relevant = ticker ? articles.filter(a => a.relatedTickers.includes(ticker)) : articles;
  const pos = relevant.filter(a => a.sentiment > 15).length;
  const neg = relevant.filter(a => a.sentiment < -15).length;
  const overall = relevant.length > 0
    ? Math.round(relevant.reduce((s, a) => s + a.sentiment, 0) / relevant.length)
    : 0;

  return {
    articles,
    sentiment: {
      overall,
      label: overall > 15 ? 'positive' : overall < -15 ? 'negative' : 'neutral',
      articleCount: relevant.length,
      positiveCount: pos,
      negativeCount: neg,
      neutralCount: relevant.length - pos - neg,
      trend: 'STABLE',
      keyEvents: [...new Set(relevant.map(a => a.eventType).filter(e => e !== 'MARKET'))],
    }
  };
}

export interface AgentCouncilVerdict {
  action: 'MUA' | 'BÁN' | 'QUAN SÁT';
  entry_zone: string;
  target_price: string;
  stop_loss: string;
  sizing: string;
  risk_level: string;
  summary: string;
}

export interface CorporateEvent {
  type: string;
  title: string;
  date: string;
  source?: string;
}

export interface AgentCouncilContext {
  ticker: string;
  company_name?: string;
  exchange?: string;
  price_limit_pct?: number;
  ceiling?: number | null;
  floor?: number | null;
  price: number;
  change_5d?: number | null;
  rsi?: number | null;
  pe?: number | null;
  pb?: number | null;
  roe?: number | null;
  dividend_yield?: number | null;
  corporate_events?: CorporateEvent[];
  foreign_flow?: string;
  market_context?: string;
  news_sentiment?: { score: number; label: string; trend: string; key_events: string[] };
  last_date?: string;
}

export type AgentRole = 'technical' | 'fundamental' | 'sentiment' | 'bull' | 'bear' | 'portfolio_manager';

export interface AgentCouncilResult {
  ticker: string;
  timestamp: string;
  mode: 'llm' | 'heuristic';
  context: AgentCouncilContext;
  reports: Partial<Record<Exclude<AgentRole, 'portfolio_manager'>, string>>;
  engines: Partial<Record<AgentRole, string>>;
  verdict: {
    raw: string;
    structured: AgentCouncilVerdict;
  };
  warnings: string[];
}

export type AgentCouncilEvent =
  | { type: 'status'; message: string }
  | { type: 'context'; data: AgentCouncilContext }
  | { type: 'mode'; mode: 'llm' | 'heuristic'; provider: string | null; model: string | null }
  | { type: 'agent_start'; agent: AgentRole; name: string }
  | { type: 'agent_done'; agent: AgentRole; name: string; content: string; engine: string }
  | { type: 'final_verdict'; agent: 'portfolio_manager'; content: string; engine: string; structured: AgentCouncilVerdict }
  | { type: 'warning' | 'error'; message: string };

export interface AgentCouncilRequest {
  ticker: string;
  provider?: string;
  apiKey?: string;
  model?: string;
}

async function agentErrorMessage(resp: Response): Promise<string> {
  redirectToLoginIfUnauthorized(resp);
  try {
    const body = await resp.json();
    if (body?.detail) return typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail);
  } catch { /* not JSON */ }
  return `Agent Council error: HTTP ${resp.status}`;
}

export async function fetchAgentCouncilAnalysis(req: AgentCouncilRequest): Promise<AgentCouncilResult> {
  const resp = await fetch('/api/agents/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!resp.ok) throw new Error(await agentErrorMessage(resp));
  return resp.json();
}

/**
 * Stream council events over a POST request (SSE framing). POST keeps the API key
 * out of the URL, which EventSource cannot do.
 */
export async function streamAgentCouncil(
  req: AgentCouncilRequest,
  onEvent: (event: AgentCouncilEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const resp = await fetch('/api/agents/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(req),
    signal,
  });
  if (!resp.ok || !resp.body) throw new Error(await agentErrorMessage(resp));

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const data = frame
        .split('\n')
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart())
        .join('\n');
      if (!data) continue;
      if (data === '[DONE]') return;
      onEvent(JSON.parse(data) as AgentCouncilEvent);
    }
  }
}

export type { StockBar, StockInfo, FinancialData, MarketAnalysisData, SectorData, NewsArticle, SentimentSummary, PriceZone, PriceScenario };
