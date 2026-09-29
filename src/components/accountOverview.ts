// Account tabs + the overview tab: real NAV curve (TWR vs VN-Index, drawdown), allocation donut,
// margin status, T+2 cash calendar, rule violations and the market regime.
import { createChart, ColorType, LineSeries, HistogramSeries } from 'lightweight-charts';

type Holding = { ticker: string; market_value: number; weight_pct: number };
type Margin = { account: string; rtt_pct: number; debt: number; due: number; overdue: number; status: string | null; maintenance_pct: number | null; liquidation_pct: number | null; drop_to_call_pct?: number; drop_to_liquidation_pct?: number };
type CashEvent = { date: string | null; ticker: string | null; kind: string; amount: number | null; quantity: number | null };
export type OverviewAnalysis = { synced_at: string; summary: { nav: number; cash: number; debt?: number }; holdings: Holding[]; margin?: Margin[]; cash_calendar?: CashEvent[] };
type NavPoint = { date: string; nav: number; flow: number; flow_estimated: boolean; twr_pct: number; drawdown_pct: number; vnindex_pct: number | null };
type Nav = { points: NavPoint[]; stats: null | { since: string; days_tracked: number; calendar_days: number; twr_pct: number; vnindex_pct: number | null; excess_pct: number | null; twr_annual_pct: number | null; max_drawdown_pct: number; current_drawdown_pct: number; net_flows: number; nav_now: number } };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;
const esc = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] || char));
const vnd = (value: number) => Math.round(value).toLocaleString('vi-VN');
const pct = (v: number | null | undefined, d = 2) => (v == null ? '—' : `<span class="${v >= 0 ? 'positive' : 'negative'}">${v >= 0 ? '+' : ''}${v.toFixed(d)}%</span>`);
const TAB_KEY = 'traderai_account_tab';
const DONUT_COLORS = ['#6E8FD6', '#16C784', '#F2C744', '#C86BFF', '#2FD7E8', '#FF6B78', '#3BD79B', '#8E9CB4', '#E9A23B', '#5AA9E6'];

let overviewKey = '';
let navChart: ReturnType<typeof createChart> | null = null;

// ---------- tabs ----------

export function setAccountTab(tab: string) {
  const panel = $('tcbsPanel');
  if (!panel) return;
  panel.dataset.accActive = tab;
  panel.querySelectorAll<HTMLElement>('[data-tab-btn]').forEach(b => {
    const on = b.dataset.tabBtn === tab;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  });
  try { localStorage.setItem(TAB_KEY, tab); } catch { /* storage unavailable */ }
  if (tab === 'overview') navChart?.timeScale().fitContent();
}

export function initAccountTabs() {
  const nav = $('accTabs');
  if (!nav) return;
  nav.hidden = false;
  nav.querySelectorAll<HTMLElement>('[data-tab-btn]').forEach(b => b.addEventListener('click', () => setAccountTab(b.dataset.tabBtn!)));
  let saved = 'overview';
  try { saved = localStorage.getItem(TAB_KEY) || 'overview'; } catch { /* storage unavailable */ }
  setAccountTab(saved);
}

// ---------- pieces ----------

function donut(holdings: Holding[], cash: number, nav: number): string {
  const parts = [...holdings.map(h => ({ label: h.ticker, value: h.market_value })), ...(cash > 0 ? [{ label: 'Tiền mặt', value: cash }] : [])];
  const total = parts.reduce((s, p) => s + p.value, 0);
  if (!total) return '';
  let angle = -Math.PI / 2;
  const r = 60, cx = 70, cy = 70, stroke = 22;
  const arcs = parts.map((p, i) => {
    const sweep = (p.value / total) * Math.PI * 2;
    const a0 = angle, a1 = angle + sweep;
    angle = a1;
    const large = sweep > Math.PI ? 1 : 0;
    const color = p.label === 'Tiền mặt' ? '#69758A' : DONUT_COLORS[i % DONUT_COLORS.length];
    if (sweep >= Math.PI * 2 - 1e-6) return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}"/>`;
    return `<path d="M ${cx + r * Math.cos(a0)} ${cy + r * Math.sin(a0)} A ${r} ${r} 0 ${large} 1 ${cx + r * Math.cos(a1)} ${cy + r * Math.sin(a1)}" fill="none" stroke="${color}" stroke-width="${stroke}"><title>${esc(p.label)} ${(p.value / total * 100).toFixed(1)}%</title></path>`;
  }).join('');
  const legend = parts.map((p, i) => `<li><i style="background:${p.label === 'Tiền mặt' ? '#69758A' : DONUT_COLORS[i % DONUT_COLORS.length]}"></i>${esc(p.label)}<b>${(p.value / total * 100).toFixed(1)}%</b></li>`).join('');
  return `<div class="donut-wrap"><svg viewBox="0 0 140 140" class="donut" role="img" aria-label="Phân bổ tài sản">${arcs}<text x="70" y="66" text-anchor="middle" class="donut-label">NAV</text><text x="70" y="84" text-anchor="middle" class="donut-value">${(nav / 1e6).toLocaleString('vi-VN', { maximumFractionDigits: 1 })}tr</text></svg><ul class="donut-legend">${legend}</ul></div>`;
}

function marginCard(m: Margin[]): string {
  if (!m.length) return '';
  return m.map(x => `<div class="acc-card ${x.drop_to_call_pct != null && x.drop_to_call_pct < 15 ? 'danger' : ''}">
    <strong>Margin ${esc(x.account)}</strong> <span class="plan-action ${x.status === 'An toàn' ? 'info' : 'medium'}">${esc(x.status || '—')}</span>
    <dl><div><dt>Rtt</dt><dd>${x.rtt_pct}%</dd></div><div><dt>Dư nợ (gốc + lãi + phí)</dt><dd>${vnd(x.debt)} đ</dd></div>
    ${x.overdue ? `<div><dt>Quá hạn</dt><dd class="negative">${vnd(x.overdue)} đ</dd></div>` : ''}
    <div><dt>Giảm thêm tới ngưỡng call (${x.maintenance_pct ?? '—'}%)</dt><dd>${x.drop_to_call_pct != null ? `${x.drop_to_call_pct}%` : '—'}</dd></div>
    <div><dt>Giảm thêm tới ngưỡng giải chấp (${x.liquidation_pct ?? '—'}%)</dt><dd>${x.drop_to_liquidation_pct != null ? `${x.drop_to_liquidation_pct}%` : '—'}</dd></div></dl>
    <p class="form-hint">Giả định cả danh mục ký quỹ giảm đều; mã có tỷ lệ cho vay khác nhau sẽ lệch.</p></div>`).join('');
}

function cashCalendar(events: CashEvent[]): string {
  if (!events.length) return '';
  return `<div class="acc-card"><strong>Dòng tiền & hàng về (T+2)</strong><ul class="event-list">${events.map(e => `<li><span class="event-date">${esc(e.date || 'đang chờ')}</span><span class="plan-action ${e.kind.startsWith('Tiền') || e.kind.startsWith('Cổ tức') ? 'info' : ''}">${esc(e.kind)}</span><span>${e.ticker ? `<b>${esc(e.ticker)}</b> ` : ''}${e.quantity ? `${vnd(e.quantity)} cp` : ''}${e.amount ? ` · ${vnd(e.amount)} đ` : ''}</span></li>`).join('')}</ul><p class="form-hint">Chưa tính ngày nghỉ lễ.</p></div>`;
}

function drawNavChart(el: HTMLElement, points: NavPoint[]) {
  navChart?.remove();
  navChart = createChart(el, {
    layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#9AA6B8', attributionLogo: false },
    grid: { vertLines: { color: 'rgba(255,255,255,0.04)' }, horzLines: { color: 'rgba(255,255,255,0.04)' } },
    rightPriceScale: { borderVisible: false },
    timeScale: { borderVisible: false },
    height: 260,
    autoSize: true,
  });
  const fmt = { type: 'custom' as const, formatter: (v: number) => `${v.toFixed(1)}%` };
  const twr = navChart.addSeries(LineSeries, { color: '#16C784', lineWidth: 2, title: 'Danh mục (TWR)', priceFormat: fmt });
  twr.setData(points.map(p => ({ time: p.date, value: p.twr_pct })));
  const idx = points.filter(p => p.vnindex_pct != null);
  if (idx.length) {
    const vn = navChart.addSeries(LineSeries, { color: '#8E9CB4', lineWidth: 1, lineStyle: 2, title: 'VN-Index', priceFormat: fmt });
    vn.setData(idx.map(p => ({ time: p.date, value: p.vnindex_pct as number })));
  }
  const dd = navChart.addSeries(HistogramSeries, { color: 'rgba(255,71,87,0.45)', priceScaleId: 'dd', title: 'Drawdown', priceFormat: fmt });
  dd.priceScale().applyOptions({ scaleMargins: { top: 0.75, bottom: 0 } });
  dd.setData(points.map(p => ({ time: p.date, value: p.drawdown_pct })));
  navChart.timeScale().fitContent();
}

async function saveFlow(date: string, amount: number | null) {
  await fetch('/api/account/nav/flow', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date, amount }) });
  overviewKey = '';
  loadNav();
}

async function loadNav() {
  const box = $('accNav');
  if (!box) return;
  try {
    const nav = (await (await fetch('/api/account/nav')).json()) as Nav;
    if (!nav.stats || nav.points.length < 2) {
      box.innerHTML = `<p class="form-hint">Lịch sử NAV bắt đầu từ lần đồng bộ đầu tiên${nav.stats ? ` (${esc(nav.stats.since)})` : ''}. Cần ít nhất 2 ngày để vẽ đường cong vốn — đồng bộ mỗi ngày (hoặc bật tự đồng bộ ở tab Công cụ).</p>`;
      return;
    }
    const s = nav.stats;
    const flows = nav.points.filter(p => p.flow !== 0);
    box.innerHTML = `
      <div class="portfolio-summary tcbs-summary">
        <div><span>Lợi nhuận thật (TWR) từ ${esc(s.since)}</span><strong>${pct(s.twr_pct)}</strong><small>${s.twr_annual_pct != null ? `~${s.twr_annual_pct}%/năm` : `${s.calendar_days} ngày`}</small></div>
        <div><span>VN-Index cùng kỳ</span><strong>${pct(s.vnindex_pct)}</strong><small>chênh lệch ${pct(s.excess_pct)}</small></div>
        <div><span>Sụt giảm lớn nhất</span><strong>${pct(s.max_drawdown_pct)}</strong><small>hiện tại ${pct(s.current_drawdown_pct)}</small></div>
        <div><span>Nạp/rút ròng (ước tính)</span><strong>${vnd(s.net_flows)} đ</strong><small>${s.days_tracked} ngày có dữ liệu</small></div>
      </div>
      <div id="accNavChart" class="nav-chart"></div>
      ${flows.length ? `<details class="flow-edit"><summary>Nạp/rút đã nhận diện (${flows.length}) — sửa nếu sai</summary><table class="portfolio-table"><tbody>${flows.map(f => `<tr><td>${esc(f.date)}</td><td>${vnd(f.flow)} đ${f.flow_estimated ? ' <small>(tự nhận diện)</small>' : ''}</td><td><button class="table-action" data-flow-zero="${esc(f.date)}">Không phải nạp/rút</button></td></tr>`).join('')}</tbody></table></details>` : ''}
      <p class="form-hint">TWR loại bỏ ảnh hưởng của tiền nạp/rút, nên so được trực tiếp với VN-Index. Nạp/rút được ước tính từ phần thay đổi NAV mà giá cổ phiếu không giải thích được.</p>`;
    drawNavChart($('accNavChart')!, nav.points);
    box.querySelectorAll<HTMLElement>('[data-flow-zero]').forEach(b => b.addEventListener('click', () => saveFlow(b.dataset.flowZero!, 0)));
  } catch {
    box.innerHTML = '<p class="form-hint negative">Không tải được lịch sử NAV.</p>';
  }
}

async function loadRulesAndRegime() {
  const box = $('accRules');
  if (!box) return;
  try {
    const r = await (await fetch('/api/account/rules')).json();
    const v: Array<{ text: string }> = r.violations || [];
    box.innerHTML = v.length ? `<div class="acc-card danger"><strong>Vi phạm quy tắc của bạn (${v.length})</strong><ul class="tcbs-flags">${v.map(x => `<li class="tcbs-flag high">${esc(x.text)}</li>`).join('')}</ul><p class="form-hint">Sửa quy tắc ở tab Công cụ.</p></div>`
      : '<div class="acc-card"><strong>Quy tắc cá nhân</strong><p class="plan-note">Danh mục đang tuân thủ mọi quy tắc bạn đặt ra.</p></div>';
  } catch { box.innerHTML = ''; }
}

export function renderRegime(regime: null | { state: string; vs_ma200_pct: number; vol_now_pct: number; vol_long_run_pct: number; suggested_stock_pct: number; current_stock_pct: number; advice: string; evidence: string }) {
  const box = $('accRegime');
  if (!box || !regime) return;
  const tone = regime.state === 'THUẬN LỢI' ? 'info' : regime.state === 'PHÒNG THỦ' ? 'high' : 'medium';
  box.innerHTML = `<div class="acc-card"><strong>Trạng thái thị trường</strong> <span class="plan-action ${tone}">${esc(regime.state)}</span>
    <p class="plan-note">VN-Index ${regime.vs_ma200_pct > 0 ? '+' : ''}${regime.vs_ma200_pct}% so với MA200 · biến động ${regime.vol_now_pct}%/năm (thường ${regime.vol_long_run_pct}%). Tỷ trọng cổ phiếu gợi ý ~${regime.suggested_stock_pct}%, hiện tại ${regime.current_stock_pct}%.</p>
    <p class="plan-note"><b>${esc(regime.advice)}</b></p><p class="form-hint">${esc(regime.evidence)}</p></div>`;
}

export function loadOverview(a: OverviewAnalysis) {
  const box = $('accOverview');
  if (!box) return;
  if (a.synced_at === overviewKey) return;
  overviewKey = a.synced_at;
  box.hidden = false;
  box.innerHTML = `
    <div id="accNav"><p class="form-hint">Đang tải lịch sử NAV…</p></div>
    <div class="acc-grid">
      <div class="acc-card"><strong>Phân bổ tài sản</strong>${donut(a.holdings, a.summary.cash, a.summary.nav)}</div>
      <div id="accRegime"><div class="acc-card"><strong>Trạng thái thị trường</strong><p class="form-hint">Đang tính…</p></div></div>
      <div id="accRules"></div>
      ${marginCard(a.margin || [])}
      ${cashCalendar(a.cash_calendar || [])}
    </div>`;
  loadNav();
  loadRulesAndRegime();
}
