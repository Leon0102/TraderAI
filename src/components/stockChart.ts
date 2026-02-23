// Stock Chart Component - Enhanced with Technical Indicator Overlays
// Renders candlestick chart using lightweight-charts (TradingView)
// Supports SMA, Bollinger Bands overlays + RSI sub-panel

import { createChart, ColorType, CandlestickSeries, HistogramSeries, LineSeries } from 'lightweight-charts';
import type { StockBar } from '../api/stockApi';
import { calculateSMA, calculateBollingerBands, calculateRSI } from '../analysis/technicalAnalysis';

let chart: ReturnType<typeof createChart> | null = null;
let candlestickSeries: any = null;
let volumeSeries: any = null;
let sma20Series: any = null;
let sma50Series: any = null;
let bbUpperSeries: any = null;
let bbLowerSeries: any = null;
let bbMiddleSeries: any = null;

// RSI chart
let rsiChart: ReturnType<typeof createChart> | null = null;
let rsiSeries: any = null;
let rsiOverboughtLine: any = null;
let rsiOversoldLine: any = null;

// Indicator toggles
let showSMA = true;
let showBB = false;
let showRSI = true;

export function initChart() {
  const container = document.getElementById('chartContainer');
  if (!container) return;

  container.innerHTML = '';

  // Main candlestick chart
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
      vertLine: { color: 'rgba(99, 102, 241, 0.3)', width: 1, style: 2 },
      horzLine: { color: 'rgba(99, 102, 241, 0.3)', width: 1, style: 2 },
    },
    rightPriceScale: { borderColor: 'rgba(255, 255, 255, 0.1)' },
    timeScale: {
      borderColor: 'rgba(255, 255, 255, 0.1)',
      timeVisible: true,
      secondsVisible: false,
    },
    width: container.clientWidth,
    height: (container.clientHeight || 500) * 0.7,
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
  volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });

  // SMA lines
  sma20Series = chart.addSeries(LineSeries, {
    color: '#f59e0b',
    lineWidth: 1,
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false,
  });

  sma50Series = chart.addSeries(LineSeries, {
    color: '#8b5cf6',
    lineWidth: 1,
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false,
  });

  // Bollinger Bands
  bbUpperSeries = chart.addSeries(LineSeries, {
    color: 'rgba(59, 130, 246, 0.5)',
    lineWidth: 1,
    lineStyle: 2,
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false,
  });

  bbMiddleSeries = chart.addSeries(LineSeries, {
    color: 'rgba(59, 130, 246, 0.3)',
    lineWidth: 1,
    lineStyle: 1,
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false,
  });

  bbLowerSeries = chart.addSeries(LineSeries, {
    color: 'rgba(59, 130, 246, 0.5)',
    lineWidth: 1,
    lineStyle: 2,
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false,
  });

  // RSI sub-chart
  const rsiContainer = document.getElementById('rsiContainer');
  if (rsiContainer) {
    rsiContainer.innerHTML = '';
    rsiChart = createChart(rsiContainer, {
      layout: {
        background: { type: ColorType.Solid, color: '#1a2236' },
        textColor: '#9ca3af',
        fontFamily: 'Inter, sans-serif',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(255, 255, 255, 0.03)' },
        horzLines: { color: 'rgba(255, 255, 255, 0.03)' },
      },
      rightPriceScale: {
        borderColor: 'rgba(255, 255, 255, 0.1)',
        scaleMargins: { top: 0.1, bottom: 0.1 },
      },
      timeScale: {
        borderColor: 'rgba(255, 255, 255, 0.1)',
        timeVisible: true,
        secondsVisible: false,
      },
      crosshair: {
        mode: 0,
        vertLine: { color: 'rgba(99, 102, 241, 0.3)', width: 1, style: 2 },
        horzLine: { color: 'rgba(99, 102, 241, 0.3)', width: 1, style: 2 },
      },
      width: rsiContainer.clientWidth,
      height: rsiContainer.clientHeight || 120,
    });

    rsiSeries = rsiChart.addSeries(LineSeries, {
      color: '#a78bfa',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerVisible: true,
    });

    // Overbought line (70)
    rsiOverboughtLine = rsiChart.addSeries(LineSeries, {
      color: 'rgba(239, 68, 68, 0.4)',
      lineWidth: 1,
      lineStyle: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });

    // Oversold line (30)
    rsiOversoldLine = rsiChart.addSeries(LineSeries, {
      color: 'rgba(16, 185, 129, 0.4)',
      lineWidth: 1,
      lineStyle: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
  }

  // Responsive
  const resizeObserver = new ResizeObserver(entries => {
    for (const entry of entries) {
      const { width } = entry.contentRect;
      chart?.applyOptions({ width, height: (entry.contentRect.height || 500) * 0.7 });
    }
  });
  resizeObserver.observe(container);

  if (rsiContainer) {
    const rsiResizeObserver = new ResizeObserver(entries => {
      for (const entry of entries) {
        rsiChart?.applyOptions({ width: entry.contentRect.width, height: entry.contentRect.height || 120 });
      }
    });
    rsiResizeObserver.observe(rsiContainer);
  }

  // Sync time scales
  if (chart && rsiChart) {
    chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (range) rsiChart?.timeScale().setVisibleLogicalRange(range);
    });
    rsiChart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (range) chart?.timeScale().setVisibleLogicalRange(range);
    });
  }

  // Setup indicator toggle buttons
  setupIndicatorToggles();
}

function setupIndicatorToggles() {
  document.getElementById('toggleSMA')?.addEventListener('click', (e) => {
    showSMA = !showSMA;
    (e.target as HTMLElement).classList.toggle('active', showSMA);
    updateIndicatorVisibility();
  });

  document.getElementById('toggleBB')?.addEventListener('click', (e) => {
    showBB = !showBB;
    (e.target as HTMLElement).classList.toggle('active', showBB);
    updateIndicatorVisibility();
  });

  document.getElementById('toggleRSI')?.addEventListener('click', (e) => {
    showRSI = !showRSI;
    (e.target as HTMLElement).classList.toggle('active', showRSI);
    const rsiWrapper = document.getElementById('rsiWrapper');
    if (rsiWrapper) rsiWrapper.style.display = showRSI ? 'block' : 'none';
  });

  // Set initial active states
  document.getElementById('toggleSMA')?.classList.add('active');
  document.getElementById('toggleRSI')?.classList.add('active');
}

function updateIndicatorVisibility() {
  // SMA visibility
  if (sma20Series) {
    sma20Series.applyOptions({ visible: showSMA });
    sma50Series.applyOptions({ visible: showSMA });
  }
  // BB visibility
  if (bbUpperSeries) {
    bbUpperSeries.applyOptions({ visible: showBB });
    bbMiddleSeries.applyOptions({ visible: showBB });
    bbLowerSeries.applyOptions({ visible: showBB });
  }
}

export function updateChartData(bars: StockBar[]) {
  if (!candlestickSeries || !volumeSeries || bars.length === 0) return;

  const closes = bars.map(b => b.close);

  // Candle data
  const candleData = bars.map(bar => ({
    time: bar.tradingDate as any,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
  }));

  // Volume
  const volumeData = bars.map(bar => ({
    time: bar.tradingDate as any,
    value: bar.volume,
    color: bar.close >= bar.open ? 'rgba(16, 185, 129, 0.3)' : 'rgba(239, 68, 68, 0.3)',
  }));

  candlestickSeries.setData(candleData);
  volumeSeries.setData(volumeData);

  // SMA 20 & 50
  const sma20 = calculateSMA(closes, 20);
  const sma50 = calculateSMA(closes, 50);

  sma20Series?.setData(
    bars.map((bar, i) => ({ time: bar.tradingDate as any, value: sma20[i] }))
      .filter(d => !isNaN(d.value))
  );

  sma50Series?.setData(
    bars.map((bar, i) => ({ time: bar.tradingDate as any, value: sma50[i] }))
      .filter(d => !isNaN(d.value))
  );

  // Bollinger Bands
  const bb = calculateBollingerBands(closes);
  bbUpperSeries?.setData(
    bars.map((bar, i) => ({ time: bar.tradingDate as any, value: bb.upper[i] }))
      .filter(d => !isNaN(d.value))
  );
  bbMiddleSeries?.setData(
    bars.map((bar, i) => ({ time: bar.tradingDate as any, value: bb.middle[i] }))
      .filter(d => !isNaN(d.value))
  );
  bbLowerSeries?.setData(
    bars.map((bar, i) => ({ time: bar.tradingDate as any, value: bb.lower[i] }))
      .filter(d => !isNaN(d.value))
  );

  // RSI
  const rsi = calculateRSI(closes);
  if (rsiSeries) {
    rsiSeries.setData(
      bars.map((bar, i) => ({ time: bar.tradingDate as any, value: rsi[i] }))
        .filter(d => !isNaN(d.value))
    );

    // Draw overbought/oversold lines
    const validBars = bars.filter((_, i) => !isNaN(rsi[i]));
    if (validBars.length > 0) {
      rsiOverboughtLine?.setData(
        validBars.map(bar => ({ time: bar.tradingDate as any, value: 70 }))
      );
      rsiOversoldLine?.setData(
        validBars.map(bar => ({ time: bar.tradingDate as any, value: 30 }))
      );
    }

    rsiChart?.timeScale().fitContent();
  }

  // Apply visibility settings
  updateIndicatorVisibility();
  chart?.timeScale().fitContent();
}
