// Direct browser -> TCBS calls.
//
// TCBS's public API blocks requests from datacenter IPs (Cloudflare bot
// challenge), which is exactly where our own /api/* serverless functions run
// (Vercel). A real user's browser, on a residential/mobile IP, is much more
// likely to get through. So we try calling TCBS directly from the browser
// first, and only fall back to our backend (which itself falls back to mock
// data) if the direct call fails for any reason — CORS, network, timeout,
// or TCBS blocking that IP too.
//
// This mirrors the normalization logic in api/market.py, api/stocks.py,
// api/finance.py and api/history.py so callers get the same shape either way.

import type { StockBar, FinancialData, MarketAnalysisData, SectorData } from './stockApi';

const TCBS_BASE = 'https://apipubaws.tcbs.com.vn';
const DIRECT_TIMEOUT_MS = 6000;

async function tcbsFetch(path: string): Promise<any | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DIRECT_TIMEOUT_MS);
  try {
    const res = await fetch(`${TCBS_BASE}${path}`, {
      headers: { 'Accept': 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (_e) {
    // CORS error, network failure, timeout, or TCBS blocking this IP too.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchMarketOverviewDirect(): Promise<any[] | null> {
  const data = await tcbsFetch('/stock-insight/v1/stock/second-tc-price?tickers=VNINDEX,HNXINDEX,UPINDEX');
  if (!data || !data.data) return null;

  const nameMap: Record<string, string> = { VNINDEX: 'VN-Index', HNXINDEX: 'HNX-Index', UPINDEX: 'UPCOM' };
  const results = data.data.map((item: any) => {
    const ticker = item.ticker || '';
    const close = item.close ?? item.price ?? 0;
    const ref = item.reference ?? item.ref ?? close;
    const change = ref ? close - ref : 0;
    const pct = ref ? (change / ref) * 100 : 0;
    return {
      ticker, name: nameMap[ticker] || ticker,
      close: round2(close), change: round2(change), pctChange: round2(pct),
      volume: item.volume || 0, advances: item.advances || 0,
      declines: item.declines || 0, unchanged: item.unchanged || 0,
    };
  });
  return results.length > 0 ? results : null;
}

export async function fetchTopStocksDirect(count: number): Promise<any[] | null> {
  const data = await tcbsFetch(`/stock-insight/v1/stock/top-stock?exchange=HOSE&type=volume&count=${count}`);
  if (!data || !data.data) return null;

  const results = data.data.map((item: any) => {
    const close = item.close ?? item.price ?? 0;
    const ref = item.reference ?? item.ref ?? close;
    const change = ref ? close - ref : 0;
    const pct = ref ? (change / ref) * 100 : 0;
    return {
      ticker: item.ticker || '', companyName: item.companyName || '',
      close: round2(close), change: round2(change), pctChange: round2(pct),
      volume: item.volume || 0, high: item.high ?? close, low: item.low ?? close,
    };
  });
  return results.length > 0 ? results : null;
}

export async function fetchFinancialDataDirect(ticker: string): Promise<FinancialData | null> {
  const data = await tcbsFetch(`/tcanalysis/v1/ticker/${ticker}/overview`);
  if (!data) return null;

  const scaleIfFraction = (v: number, threshold = 1) => (typeof v === 'number' && v > 0 && v < threshold ? v * 100 : v);

  return {
    ticker: data.ticker || ticker,
    pe: data.pe || 0,
    pb: data.pb || 0,
    roe: round2(scaleIfFraction(data.roe || 0)),
    eps: data.eps || 0,
    revenue: data.revenue || 0,
    revenueGrowth: round2(Math.abs(data.revenueGrowth || 0) < 5 ? (data.revenueGrowth || 0) * 100 : (data.revenueGrowth || 0)),
    epsGrowth: round2(Math.abs(data.epsGrowth || 0) < 5 ? (data.epsGrowth || 0) * 100 : (data.epsGrowth || 0)),
    marketCap: data.marketCap || 0,
    dividendYield: data.dividendYield ?? data.dividend ?? 0,
    debtOnEquity: data.debtOnEquity ?? data.debtToEquity ?? 0,
    netMargin: round2(scaleIfFraction(data.netMargin || 0)),
    freeCashFlow: data.freeCashFlow ?? data.fcf ?? 0,
    totalAssets: data.totalAssets ?? data.asset ?? 0,
    interestCoverage: data.interestCoverage || 0,
    currentRatio: data.currentRatio || 0,
    industry: data.industry ?? data.industryEn ?? '',
  };
}

export async function fetchStockBarsDirect(ticker: string, start: string, end: string): Promise<StockBar[] | null> {
  const fromTs = Math.floor(new Date(start).getTime() / 1000);
  const toTs = Math.floor(new Date(end).getTime() / 1000);
  const data = await tcbsFetch(
    `/stock-insight/v1/stock/bars-long-term?ticker=${ticker}&type=stock&resolution=D&from=${fromTs}&to=${toTs}`
  );
  if (!data || !data.data) return null;

  const bars: StockBar[] = data.data.map((bar: any) => ({
    tradingDate: bar.tradingDate || '',
    open: bar.open || 0, high: bar.high || 0, low: bar.low || 0, close: bar.close || 0,
    volume: bar.volume || 0,
  }));
  return bars.length > 0 ? bars : null;
}

export async function fetchMarketAnalysisDirect(): Promise<MarketAnalysisData | null> {
  const toTs = Math.floor(Date.now() / 1000);
  const fromTs = toTs - 150 * 86400;

  const [histData, sectorData] = await Promise.all([
    tcbsFetch(`/stock-insight/v1/stock/bars-long-term?ticker=VNINDEX&type=index&resolution=D&from=${fromTs}&to=${toTs}`),
    tcbsFetch('/stock-insight/v2/stock/industry-summary'),
  ]);

  const vnindexHistory: StockBar[] = (histData?.data || []).map((bar: any) => ({
    tradingDate: bar.tradingDate || '',
    open: bar.open || 0, high: bar.high || 0, low: bar.low || 0, close: bar.close || 0,
    volume: bar.volume || 0,
  }));
  if (vnindexHistory.length === 0) return null;

  const rawSectors = Array.isArray(sectorData) ? sectorData : (sectorData?.data || []);
  const sectors: SectorData[] = rawSectors.map((item: any) => ({
    name: item.industry ?? item.name ?? '',
    change: item.change ?? item.changePercent ?? 0,
    volume: item.volume || 0,
    advances: item.advances || 0,
    declines: item.declines || 0,
    marketCap: item.marketCap || 0,
  }));

  return { vnindexHistory, sectors, source: 'tcbs' };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
