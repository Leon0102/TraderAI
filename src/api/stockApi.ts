// Stock API integration via vnstock backend
// Calls local FastAPI backend which uses vnstock library
// Falls back to mock data if backend is unavailable

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
}

// In dev mode, Vite proxies /api to http://localhost:8000
// In production (Vercel), /api is served by serverless functions
const API_BASE = '/api';

async function apiFetch(path: string): Promise<any> {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { 'Accept': 'application/json' },
    });
    if (res.ok) {
      return await res.json();
    }
  } catch (_e) {
    // Backend unavailable, fall through to null
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
    return data.data;
  }

  // Fallback mock data
  return generateMockBars(ticker, countBack);
}

export async function fetchTopStocks(count: number = 20): Promise<any[]> {
  const data = await apiFetch(`/stocks?count=${count}`);

  if (data && data.data && data.data.length > 0) {
    return data.data;
  }

  return getMockTopStocks(count);
}

export async function fetchMarketOverview(): Promise<any[]> {
  const data = await apiFetch('/market');

  if (data && data.data) {
    return data.data;
  }

  return getMockMarketData();
}

export async function fetchFinancialData(ticker: string): Promise<FinancialData | null> {
  const data = await apiFetch(`/finance?ticker=${ticker}`);

  if (data && data.data) {
    return data.data;
  }

  return getMockFinancialData(ticker);
}

export async function fetchMultipleFinancials(tickers: string[]): Promise<FinancialData[]> {
  const results = await Promise.all(
    tickers.map(t => fetchFinancialData(t))
  );
  return results.filter(Boolean) as FinancialData[];
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

function getMockTopStocks(count: number = 20): any[] {
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
    FPT: { ticker: 'FPT', pe: 18.5, pb: 4.2, roe: 22.5, eps: 6800, revenue: 52000, revenueGrowth: 19.5, epsGrowth: 15.2, marketCap: 160000 },
    VNM: { ticker: 'VNM', pe: 16.2, pb: 4.5, roe: 28.3, eps: 4470, revenue: 60000, revenueGrowth: 5.8, epsGrowth: 3.2, marketCap: 150000 },
    VIC: { ticker: 'VIC', pe: 52.3, pb: 3.1, roe: 6.2, eps: 810, revenue: 95000, revenueGrowth: 12.3, epsGrowth: -5.1, marketCap: 145000 },
    HPG: { ticker: 'HPG', pe: 8.5, pb: 1.5, roe: 18.2, eps: 3150, revenue: 120000, revenueGrowth: 25.3, epsGrowth: 42.1, marketCap: 115000 },
    MWG: { ticker: 'MWG', pe: 14.2, pb: 3.2, roe: 22.8, eps: 3920, revenue: 130000, revenueGrowth: 8.5, epsGrowth: 35.6, marketCap: 80000 },
    TCB: { ticker: 'TCB', pe: 7.8, pb: 1.3, roe: 17.5, eps: 4510, revenue: 28000, revenueGrowth: 18.2, epsGrowth: 22.3, marketCap: 120000 },
    VHM: { ticker: 'VHM', pe: 12.5, pb: 1.8, roe: 15.2, eps: 3000, revenue: 45000, revenueGrowth: -8.5, epsGrowth: -12.3, marketCap: 125000 },
    MSN: { ticker: 'MSN', pe: 21.3, pb: 2.8, roe: 13.5, eps: 3200, revenue: 78000, revenueGrowth: 10.8, epsGrowth: 18.5, marketCap: 95000 },
    VCB: { ticker: 'VCB', pe: 14.5, pb: 3.5, roe: 25.2, eps: 6400, revenue: 42000, revenueGrowth: 12.5, epsGrowth: 10.8, marketCap: 400000 },
    ACB: { ticker: 'ACB', pe: 6.8, pb: 1.6, roe: 24.5, eps: 3760, revenue: 18000, revenueGrowth: 15.8, epsGrowth: 20.1, marketCap: 75000 },
    SSI: { ticker: 'SSI', pe: 10.2, pb: 1.8, roe: 18.2, eps: 3180, revenue: 8500, revenueGrowth: 22.5, epsGrowth: 28.3, marketCap: 45000 },
    VPB: { ticker: 'VPB', pe: 5.5, pb: 1.1, roe: 20.5, eps: 3780, revenue: 35000, revenueGrowth: 20.3, epsGrowth: 25.8, marketCap: 95000 },
    STB: { ticker: 'STB', pe: 8.2, pb: 1.4, roe: 17.8, eps: 3840, revenue: 15000, revenueGrowth: 13.2, epsGrowth: 18.5, marketCap: 60000 },
    GAS: { ticker: 'GAS', pe: 15.8, pb: 3.2, roe: 21.5, eps: 4970, revenue: 85000, revenueGrowth: 8.2, epsGrowth: 5.8, marketCap: 150000 },
    PLX: { ticker: 'PLX', pe: 12.5, pb: 2.1, roe: 16.8, eps: 3110, revenue: 250000, revenueGrowth: 5.2, epsGrowth: 8.5, marketCap: 50000 },
  };

  return fundamentals[ticker] || {
    ticker, pe: 12 + Math.random() * 10, pb: 1.5 + Math.random() * 2,
    roe: 10 + Math.random() * 15, eps: 2000 + Math.random() * 5000,
    revenue: 20000 + Math.random() * 80000, revenueGrowth: Math.random() * 20 - 5,
    epsGrowth: Math.random() * 30 - 10, marketCap: 30000 + Math.random() * 100000,
  };
}

export type { StockBar, StockInfo, FinancialData };
