import { fetchEvaluationBars } from '../api/stockApi';
import type { StockBar } from '../api/stockApi';
import type { Snapshot, Pick } from './dailyPicks';
import { sessionPhase } from './sessionBand';

const KEY = 'traderai_verified_pick_history_v1';
const HORIZONS = [
  { sessions: 2, label: 'T+2' },
  { sessions: 5, label: '5 phiên' },
  { sessions: 20, label: '20 phiên' },
] as const;

function dayVN(date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export function readPickHistory(): Snapshot[] {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(value) ? value.filter((s: Snapshot) => s?.verified && Array.isArray(s.picks)) : [];
  } catch { return []; }
}

/** Keep the first verified snapshot of each trading day, so later refreshes cannot rewrite outcomes. */
export function recordPickSnapshot(snapshot: Snapshot) {
  if (!snapshot.verified || !snapshot.picks.length) return;
  const history = readPickHistory();
  if (history.some(item => item.tradingDay === snapshot.tradingDay)) return;
  history.push(snapshot);
  try { localStorage.setItem(KEY, JSON.stringify(history.slice(-60))); } catch { /* browser storage unavailable */ }
}

export function returnAfterSessions(pick: Pick, day: string, bars: StockBar[], sessions: number, completeThrough: string): number | null {
  if (pick.signal !== 'BUY' || pick.price <= 0) return null;
  const future = bars.filter(bar => bar.tradingDate > day && bar.tradingDate <= completeThrough && bar.close > 0)
    .sort((a, b) => a.tradingDate.localeCompare(b.tradingDate));
  const closing = future[sessions - 1]?.close;
  return closing ? (closing / pick.price - 1) * 100 : null;
}

function completeDate(): string {
  const today = dayVN();
  if (sessionPhase().label === 'Đã đóng cửa' || sessionPhase().label === 'Nghỉ cuối tuần') return today;
  return dayVN(new Date(Date.now() - 86400000));
}

function render(history: Snapshot[], barsByTicker: Map<string, StockBar[] | null>, loading: boolean) {
  const element = document.getElementById('trackRecordContent');
  if (!element) return;
  if (!history.length) {
    element.innerHTML = '<p class="track-empty">Chưa có bản chốt dùng hoàn toàn dữ liệu thật. App sẽ bắt đầu ghi từ phiên đầu tiên đủ nguồn dữ liệu.</p>';
    return;
  }
  const cutoff = completeDate();
  const buyPicks = history.flatMap(snap => snap.picks.filter(pick => pick.signal === 'BUY').map(pick => ({ snap, pick })));
  const stats = HORIZONS.map(horizon => {
    const returns = buyPicks.map(({ snap, pick }) => {
      const bars = barsByTicker.get(pick.ticker);
      return bars ? returnAfterSessions(pick, snap.tradingDay, bars, horizon.sessions, cutoff) : null;
    }).filter((value): value is number => value !== null);
    const average = returns.length ? returns.reduce((sum, value) => sum + value, 0) / returns.length : null;
    const hitRate = returns.length ? returns.filter(value => value > 0).length / returns.length * 100 : null;
    return `<div class="track-stat"><span>${horizon.label}</span><strong class="${average === null ? '' : average >= 0 ? 'price-up' : 'price-down'}">${average === null ? '—' : `${average >= 0 ? '+' : ''}${average.toFixed(2)}%`}</strong><small>${returns.length} lượt khuyến nghị đủ dữ liệu${hitRate === null ? '' : ` · ${hitRate.toFixed(0)}% tăng giá`}</small></div>`;
  }).join('');
  const recent = history.slice(-5).reverse().map(snap => {
    const picks = snap.picks.filter(pick => pick.signal === 'BUY');
    const measured = picks.map(pick => {
      const bars = barsByTicker.get(pick.ticker);
      return bars ? returnAfterSessions(pick, snap.tradingDay, bars, 2, cutoff) : null;
    }).filter((value): value is number => value !== null);
    const average = measured.length ? measured.reduce((sum, value) => sum + value, 0) / measured.length : null;
    return `<tr><td>${snap.tradingDay.split('-').reverse().join('/')}</td><td>${picks.length}</td><td>${measured.length}/${picks.length}</td><td class="${average === null ? '' : average >= 0 ? 'price-up' : 'price-down'}">${average === null ? 'Chờ dữ liệu' : `${average >= 0 ? '+' : ''}${average.toFixed(2)}%`}</td></tr>`;
  }).join('');
  element.innerHTML = `<div class="track-stats">${stats}</div>
    <div class="track-table-wrap"><table class="stock-table"><thead><tr><th>Ngày chốt</th><th>Mã MUA</th><th>Đã đo T+2</th><th>TB T+2</th></tr></thead><tbody>${recent}</tbody></table></div>
    <p class="track-method">${loading ? 'Đang cập nhật giá đóng cửa thật… · ' : ''}Chỉ theo dõi bản chốt đầu tiên mỗi ngày trên trình duyệt này. T+2, 5 và 20 phiên dùng giá đóng cửa của phiên giao dịch tương ứng; lợi nhuận giá chưa tính phí, thuế và cổ tức. Không phải kết quả giao dịch thực tế.</p>`;
}

export async function refreshTrackRecord() {
  const history = readPickHistory();
  const barsByTicker = new Map<string, StockBar[] | null>();
  render(history, barsByTicker, history.length > 0);
  if (!history.length) return;
  const tickers = [...new Set(history.flatMap(s => s.picks.filter(p => p.signal === 'BUY').map(p => p.ticker)))];
  const oldest = history[0].tradingDay;
  const start = oldest;
  for (let i = 0; i < tickers.length; i += 4) {
    await Promise.all(tickers.slice(i, i + 4).map(async ticker => {
      barsByTicker.set(ticker, await fetchEvaluationBars(ticker, start));
    }));
    render(history, barsByTicker, true);
  }
  render(history, barsByTicker, false);
}
