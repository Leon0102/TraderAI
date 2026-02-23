// Stock Chart Component
// Renders candlestick chart using lightweight-charts (TradingView)

import { createChart, ColorType, CandlestickSeries, HistogramSeries } from 'lightweight-charts';
import type { StockBar } from '../api/stockApi';

let chart: ReturnType<typeof createChart> | null = null;
let candlestickSeries: any = null;
let volumeSeries: any = null;

export function initChart() {
  const container = document.getElementById('chartContainer');
  if (!container) return;

  // Clear existing
  container.innerHTML = '';

  chart = createChart(container, {
    layout: {
      background: { type: ColorType.Solid, color: '#1a2236' },
      textColor: '#9ca3af',
      fontFamily: 'Inter, sans-serif',
      fontSize: 12,
    },
    grid: {
      vertLines: { color: 'rgba(255, 255, 255, 0.04)' },
      horzLines: { color: 'rgba(255, 255, 255, 0.04)' },
    },
    crosshair: {
      mode: 0,
      vertLine: {
        color: 'rgba(99, 102, 241, 0.3)',
        width: 1,
        style: 2,
      },
      horzLine: {
        color: 'rgba(99, 102, 241, 0.3)',
        width: 1,
        style: 2,
      },
    },
    rightPriceScale: {
      borderColor: 'rgba(255, 255, 255, 0.1)',
    },
    timeScale: {
      borderColor: 'rgba(255, 255, 255, 0.1)',
      timeVisible: true,
      secondsVisible: false,
    },
    width: container.clientWidth,
    height: container.clientHeight || 500,
  });

  candlestickSeries = chart.addSeries(CandlestickSeries, {
    upColor: '#10b981',
    downColor: '#ef4444',
    borderDownColor: '#ef4444',
    borderUpColor: '#10b981',
    wickDownColor: '#ef4444',
    wickUpColor: '#10b981',
  });

  volumeSeries = chart.addSeries(HistogramSeries, {
    priceFormat: { type: 'volume' },
    priceScaleId: '',
  });

  volumeSeries.priceScale().applyOptions({
    scaleMargins: { top: 0.8, bottom: 0 },
  });

  // Responsive
  const resizeObserver = new ResizeObserver(entries => {
    for (const entry of entries) {
      const { width, height } = entry.contentRect;
      chart?.applyOptions({ width, height });
    }
  });
  resizeObserver.observe(container);
}

export function updateChartData(bars: StockBar[]) {
  if (!candlestickSeries || !volumeSeries || bars.length === 0) return;

  const candleData = bars.map(bar => ({
    time: bar.tradingDate as any, // yyyy-MM-dd string
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
  }));

  const volumeData = bars.map(bar => ({
    time: bar.tradingDate as any,
    value: bar.volume,
    color: bar.close >= bar.open
      ? 'rgba(16, 185, 129, 0.3)'
      : 'rgba(239, 68, 68, 0.3)',
  }));

  candlestickSeries.setData(candleData);
  volumeSeries.setData(volumeData);

  chart?.timeScale().fitContent();
}
