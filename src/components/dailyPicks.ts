// Daily picks - ten stocks worth watching, fixed once per session.
//
// The ranking runs over every liquid stock on HOSE + HNX (see api/stocks.py) and
// combines the technical, fundamental and news scores the suggestion engine
// already produces. It is deliberately frozen for the trading day: a list that
// silently reshuffles on every page load is useless to follow through a session.

import type { CombinedSignal } from './suggestions';
import { sessionPhase } from './sessionBand';
import { openStockDetail } from './stockDetail';

const SNAPSHOT_KEY = 'traderai_daily_picks_v2'; // v2: trade-plan levels were clamped
const PICK_COUNT = 10;

export interface PickMeta {
  companyName?: string;
  exchange?: string;
  close?: number;
  pctChange?: number;
  ceiling?: number;
  floor?: number;
  rvol?: number;
}

interface Pick {
  ticker: string;
  name: string;
  exchange: string;
  price: number;
  pctChange: number;
  priceState: 'up' | 'down' | 'flat' | 'ceiling' | 'floor';
  score: number;
  signal: 'BUY' | 'SELL' | 'HOLD';
  why: string;
  entry: number;
  target: number;
  stop: number;
  rvol: number;
}

interface Snapshot {
  tradingDay: string;
  stampedAt: string;
  picks: Pick[];
}

let latestSignals: CombinedSignal[] = [];
let latestMeta = new Map<string, PickMeta>();

/** The exchange's calendar day, so a snapshot taken at 09:16 survives until the next session. */
function tradingDay(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function readSnapshot(): Snapshot | null {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return null;
    const snap = JSON.parse(raw) as Snapshot;
    return snap?.tradingDay === tradingDay() && Array.isArray(snap.picks) && snap.picks.length > 0 ? snap : null;
  } catch {
    return null;
  }
}

function writeSnapshot(snap: Snapshot) {
  try {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snap));
  } catch { /* private mode - the list still renders, it just won't persist */ }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function priceState(price: number, pct: number, meta: PickMeta): Pick['priceState'] {
  // Ceiling/floor get their own colours on Vietnamese boards (tím / xanh lơ)
  const vnd = price * 1000;
  if (meta.ceiling && Math.abs(vnd - meta.ceiling) < 5) return 'ceiling';
  if (meta.floor && Math.abs(vnd - meta.floor) < 5) return 'floor';
  return pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
}

/** One line a reader can act on: the strongest technical reason plus the standout number. */
function buildWhy(signal: CombinedSignal, meta: PickMeta): string {
  const bits: string[] = [];
  const topReason = signal.techSignal.reasons[0];
  if (topReason) bits.push(topReason.replace(/\s*\([^)]*\)\s*$/, ''));

  const rvol = meta.rvol ?? 0;
  if (rvol >= 1.5) bits.push(`khối lượng ${rvol.toFixed(1)}x trung bình 20 phiên`);

  const fund = signal.fundSignal;
  if (fund?.metrics) {
    const pe = fund.metrics['P/E'];
    const roe = fund.metrics['ROE'];
    if (roe && pe) bits.push(`ROE ${roe}, P/E ${pe}`);
  }
  const news = signal.newsSignal;
  if (news && Math.abs(news.impactModifier) >= 10) {
    bits.push(news.impactModifier > 0 ? 'tin tức hỗ trợ' : 'tin tức bất lợi');
  }
  return bits.slice(0, 3).join(' · ') || 'Chưa có tín hiệu nổi bật';
}

function buildPicks(signals: CombinedSignal[], meta: Map<string, PickMeta>): Pick[] {
  // A "mã tiềm năng" list with SELL verdicts on it contradicts itself; keep the
  // ranking but drop outright sells, falling back only if too few remain.
  const eligible = signals.filter(s => s.techSignal.signal !== 'SELL');
  const sells = signals.filter(s => s.techSignal.signal === 'SELL');
  const pool = [...eligible, ...sells];
  return pool.slice(0, PICK_COUNT).map(s => {
    const m = meta.get(s.ticker) ?? {};
    const price = m.close ?? s.techSignal.entryPrice ?? 0;
    const pct = m.pctChange ?? 0;
    return {
      ticker: s.ticker,
      name: m.companyName ?? '',
      exchange: m.exchange ?? '',
      price,
      pctChange: pct,
      priceState: priceState(price, pct, m),
      score: s.combinedScore,
      signal: s.techSignal.signal,
      why: buildWhy(s, m),
      entry: s.techSignal.entryPrice || s.techSignal.supportLevel,
      target: s.techSignal.targetPrice,
      stop: s.techSignal.stopLoss,
      rvol: m.rvol ?? 0,
    };
  });
}

function stampLabel(snap: Snapshot): string {
  const stamped = new Date(snap.stampedAt);
  const time = new Intl.DateTimeFormat('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    hour: '2-digit',
    minute: '2-digit',
  }).format(stamped);
  return `Chốt lúc ${time}`;
}

function render(snap: Snapshot) {
  const board = document.getElementById('picksBoard');
  const stamp = document.getElementById('picksStamp');
  if (!board) return;

  if (stamp) stamp.textContent = stampLabel(snap);

  const num = (v: number) => (v > 0 ? v.toFixed(2) : '—');
  board.innerHTML = `
    <div class="picks-head">
      <span>#</span>
      <span>Mã</span>
      <span style="text-align:right">Giá</span>
      <span>Điểm</span>
      <span>Vì sao đáng chú ý</span>
      <span>Kế hoạch</span>
      <span></span>
    </div>
    ${snap.picks.map((p, i) => {
      const signalClass = p.signal === 'BUY' ? 'buy' : p.signal === 'SELL' ? 'sell' : 'hold';
      const signalText = p.signal === 'BUY' ? 'MUA' : p.signal === 'SELL' ? 'BÁN' : 'QUAN SÁT';
      const sign = p.pctChange > 0 ? '+' : '';
      return `
      <div class="pick-row is-${signalClass}" data-ticker="${escapeHtml(p.ticker)}">
        <span class="pick-rank">${String(i + 1).padStart(2, '0')}</span>
        <div class="pick-id">
          <div>
            <span class="pick-ticker">${escapeHtml(p.ticker)}</span>
            ${p.exchange ? `<span class="pick-exchange">${escapeHtml(p.exchange)}</span>` : ''}
          </div>
          ${p.name ? `<div class="pick-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</div>` : ''}
        </div>
        <div class="pick-price ${p.priceState}">
          <span class="pick-price-value">${num(p.price)}</span>
          <span class="pick-price-delta">${sign}${p.pctChange.toFixed(2)}%</span>
        </div>
        <div class="pick-score">
          <span class="pick-score-value">${p.score}<small>/100</small></span>
          <span class="pick-score-bar"><i style="width:${Math.max(4, Math.min(100, p.score))}%"></i></span>
        </div>
        <p class="pick-why">${escapeHtml(p.why)}</p>
        <div class="pick-plan">
          <span>Gom quanh ${num(p.entry)}</span>
          <span class="plan-target">Mục tiêu ${num(p.target)}</span>
          <span class="plan-stop">Cắt lỗ ${num(p.stop)}</span>
        </div>
        <div class="pick-actions">
          <span class="pick-signal ${signalClass}">${signalText}</span>
          <button class="pick-council" data-council="${escapeHtml(p.ticker)}" type="button">Hội đồng AI</button>
        </div>
      </div>`;
    }).join('')}
  `;

  board.querySelectorAll<HTMLButtonElement>('[data-council]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      window.openCouncilForTicker?.(btn.dataset.council!);
    });
  });
  board.querySelectorAll<HTMLElement>('.pick-row').forEach(row => {
    row.addEventListener('click', () => openStockDetail(row.dataset.ticker!));
  });
}

/** Called once the suggestion engine has scored today's universe. */
export function setDailyPicks(signals: CombinedSignal[], meta: Map<string, PickMeta>) {
  latestSignals = signals;
  latestMeta = meta;

  const existing = readSnapshot();
  if (existing) {
    render(existing);
    return;
  }
  freezeNow();
}

function freezeNow() {
  if (latestSignals.length === 0) return;
  const snap: Snapshot = {
    tradingDay: tradingDay(),
    stampedAt: new Date().toISOString(),
    picks: buildPicks(latestSignals, latestMeta),
  };
  writeSnapshot(snap);
  render(snap);
}

export function initDailyPicks() {
  const refresh = document.getElementById('picksRefresh');
  refresh?.addEventListener('click', () => {
    if (latestSignals.length === 0) return;
    freezeNow();
    const stamp = document.getElementById('picksStamp');
    if (stamp) stamp.textContent += ' · vừa cập nhật';
  });

  const board = document.getElementById('picksBoard');
  const phase = sessionPhase();
  if (board && phase.kind === 'closed') {
    const note = document.createElement('p');
    note.className = 'picks-footnote';
    note.textContent = 'Thị trường đang đóng cửa — danh sách dựa trên dữ liệu phiên gần nhất.';
    board.after(note);
  }
}
