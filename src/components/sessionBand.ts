// Session band - the trading day's state, plus the three indices in one strip.
// Vietnamese exchanges run a fixed daily schedule; showing where we are in it
// tells the reader whether the numbers below are live or last session's close.

import type { MarketContext } from '../analysis/marketAnalysis';

type PhaseKind = 'live' | 'break' | 'closed';

export interface SessionPhase {
  label: string;
  clock: string;
  kind: PhaseKind;
}

const WEEKDAY = ['Chủ nhật', 'Thứ hai', 'Thứ ba', 'Thứ tư', 'Thứ năm', 'Thứ sáu', 'Thứ bảy'];

/** Minutes since midnight, in the exchange's own timezone (Asia/Ho_Chi_Minh, UTC+7). */
function exchangeNow(now: Date): { minutes: number; weekday: number; hhmm: string } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  const hour = Number(get('hour'));
  const minute = Number(get('minute'));
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return {
    minutes: hour * 60 + minute,
    weekday,
    hhmm: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
  };
}

const at = (h: number, m: number) => h * 60 + m;

export function sessionPhase(now: Date = new Date()): SessionPhase {
  const { minutes, weekday } = exchangeNow(now);

  if (weekday === 0 || weekday === 6) {
    return { label: 'Nghỉ cuối tuần', clock: 'Mở lại thứ hai 09:00', kind: 'closed' };
  }
  if (minutes < at(9, 0)) return { label: 'Chưa mở cửa', clock: 'ATO mở lúc 09:00', kind: 'closed' };
  if (minutes < at(9, 15)) return { label: 'Phiên ATO', clock: '09:00 – 09:15', kind: 'live' };
  if (minutes < at(11, 30)) return { label: 'Khớp lệnh liên tục', clock: '09:15 – 11:30', kind: 'live' };
  if (minutes < at(13, 0)) return { label: 'Nghỉ trưa', clock: 'Mở lại 13:00', kind: 'break' };
  if (minutes < at(14, 30)) return { label: 'Khớp lệnh liên tục', clock: '13:00 – 14:30', kind: 'live' };
  if (minutes < at(14, 45)) return { label: 'Phiên ATC', clock: '14:30 – 14:45', kind: 'live' };
  if (minutes < at(15, 0)) return { label: 'Giao dịch thỏa thuận', clock: '14:45 – 15:00', kind: 'break' };
  return { label: 'Đã đóng cửa', clock: 'Mở lại 09:00 phiên sau', kind: 'closed' };
}

function fmtDate(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh',
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).formatToParts(now);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return `${WEEKDAY[weekday] ?? ''} · ${get('day')}/${get('month')}/${get('year')}`;
}

export function renderSessionBand(indices: any[], ctx?: MarketContext | null) {
  const dateEl = document.getElementById('sessionDate');
  const phaseEl = document.getElementById('sessionPhase');
  const indicesEl = document.getElementById('sessionIndices');
  const now = new Date();

  if (dateEl) dateEl.textContent = fmtDate(now);

  if (phaseEl) {
    const phase = sessionPhase(now);
    phaseEl.className = `session-phase ${phase.kind === 'live' ? 'is-live' : phase.kind === 'break' ? 'is-break' : ''}`;
    phaseEl.innerHTML = `
      <span class="phase-dot"></span>
      <span>${phase.label}</span>
      <span class="session-clock">${phase.clock}</span>
    `;
  }

  if (!indicesEl) return;
  const rows = (indices || []).filter(i => typeof i?.close === 'number');
  if (rows.length === 0) return;

  indicesEl.innerHTML = rows.map(index => {
    const change = typeof index.change === 'number' ? index.change : 0;
    const pct = typeof index.pctChange === 'number' ? index.pctChange : 0;
    const dir = change > 0 ? 'up' : change < 0 ? 'down' : 'flat';
    const sign = change > 0 ? '+' : '';
    const up = index.advances || 0;
    const down = index.declines || 0;
    const flat = index.unchanged || 0;
    const total = up + down + flat;
    const breadth = total > 0 ? `
      <div class="session-breadth" role="img" aria-label="${up} mã tăng, ${flat} mã đứng giá, ${down} mã giảm">
        <span class="b-up" style="flex:${up}"></span>
        <span class="b-flat" style="flex:${flat}"></span>
        <span class="b-down" style="flex:${down}"></span>
      </div>
      <div class="session-breadth-legend">${up}&#9650; · ${flat}&#9679; · ${down}&#9660;</div>` : '';

    return `
      <div class="session-index ${dir}">
        <div class="session-index-name">${index.name || index.ticker}</div>
        <div class="session-index-row">
          <span class="session-index-value">${index.close.toFixed(2)}</span>
          <span class="session-index-delta">${sign}${change.toFixed(2)} · ${sign}${pct.toFixed(2)}%</span>
        </div>
        ${breadth}
      </div>
    `;
  }).join('') + (ctx ? `
      <div class="session-index">
        <div class="session-index-name">Trạng thái</div>
        <div class="session-index-row">
          <span class="session-index-value" style="font-size:1.05rem">${ctx.regimeLabel}</span>
        </div>
        <div class="session-breadth-legend">Sức khỏe ${ctx.healthScore}/100 · biến động ${
          ctx.volatilityRegime === 'HIGH' ? 'cao' : ctx.volatilityRegime === 'LOW' ? 'thấp' : 'trung bình'
        }</div>
      </div>` : '');
}
