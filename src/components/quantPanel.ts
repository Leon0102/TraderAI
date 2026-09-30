// Quant section (local backend + market database only): market breadth, sector rotation,
// valuation band, foreign flows, the graded screener, validation results and data ingest.
// Also exports the per-stock score card used by the stock detail and the account tab.
import { createChart, ColorType, LineSeries } from 'lightweight-charts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;
const esc = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] || char));
const vnd = (value: number) => Math.round(value).toLocaleString('vi-VN');
const pct = (v: number | null | undefined, d = 1) => (v == null ? '—' : `<span class="${v >= 0 ? 'positive' : 'negative'}">${v >= 0 ? '+' : ''}${v.toFixed(d)}%</span>`);
const GRADE_TONE: Record<string, string> = { A: 'info', B: 'info', C: 'medium', D: 'high', F: 'high' };
const VERDICT_TONE: Record<string, string> = { 'CÓ BẰNG CHỨNG': 'info', 'YẾU': 'medium', 'KHÔNG HIỆU QUẢ': '', 'NGƯỢC CHIỀU': 'high', 'CHƯA ĐỦ DỮ LIỆU': '' };
const GROUP_LABEL: Record<string, string> = { value: 'Giá trị', quality: 'Chất lượng', growth: 'Tăng trưởng', health: 'Sức khỏe', momentum: 'Momentum*' };
const badge = (g: string | null | undefined) => `<span class="grade grade-${esc(g || 'na')} ${GRADE_TONE[g || ''] || ''}">${esc(g || '—')}</span>`;

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...init });
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  if (!isJson) throw Object.assign(new Error('offline'), { offline: true });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.detail?.message || (typeof body?.detail === 'string' ? body.detail : `HTTP ${res.status}`));
  return body as T;
}

const charts: Array<ReturnType<typeof createChart>> = [];
function lineChart(el: HTMLElement, series: Array<{ name: string; color: string; points: Array<{ time: string; value: number }>; dashed?: boolean }>, suffix = '') {
  const chart = createChart(el, {
    layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#9AA6B8', attributionLogo: false },
    grid: { vertLines: { color: 'rgba(255,255,255,0.04)' }, horzLines: { color: 'rgba(255,255,255,0.04)' } },
    rightPriceScale: { borderVisible: false }, timeScale: { borderVisible: false }, height: 220, autoSize: true,
  });
  const fmt = { type: 'custom' as const, formatter: (v: number) => `${v.toFixed(1)}${suffix}` };
  for (const s of series) {
    const line = chart.addSeries(LineSeries, { color: s.color, lineWidth: s.dashed ? 1 : 2, lineStyle: s.dashed ? 2 : 0, title: s.name, priceFormat: fmt });
    line.setData(s.points);
  }
  chart.timeScale().fitContent();
  charts.push(chart);
}

// ---------- market tab ----------

type Market = {
  breadth: { universe: number; state: string | null; latest: Record<string, number>; points: Array<{ date: string; pct_above_ma50: number | null; pct_above_ma200: number | null; ad_line: number; new_highs: number; new_lows: number }> };
  rotation: { sectors: Array<{ sector: string; stocks: number; quadrant: string; relative_4w_pct: number | null; tail: Array<{ date: string; rs_ratio: number; rs_momentum: number }> }>; note: string };
  flows: { days_available: number; market: Array<{ date: string; net: number; value: number }>; top_buy: Array<{ ticker: string; net_20d: number; net_20d_pct_value: number | null }>; top_sell: Array<{ ticker: string; net_20d: number; net_20d_pct_value: number | null }>; note: string };
  valuation: { points: Array<{ date: string; pe: number }>; stats: null | { mean: number; sd: number; now: number; z: number | null; percentile: number; earnings_yield_pct: number }; note?: string };
};

function rrgSvg(sectors: Market['rotation']['sectors']): string {
  const all = sectors.flatMap(s => s.tail);
  if (!all.length) return '';
  const xs = all.map(p => p.rs_ratio), ys = all.map(p => p.rs_momentum);
  const pad = 0.5;
  const x0 = Math.min(99, ...xs) - pad, x1 = Math.max(101, ...xs) + pad, y0 = Math.min(99, ...ys) - pad, y1 = Math.max(101, ...ys) + pad;
  const W = 560, H = 380, sx = (x: number) => ((x - x0) / (x1 - x0)) * W, sy = (y: number) => H - ((y - y0) / (y1 - y0)) * H;
  const colors: Record<string, string> = { 'DẪN DẮT': '#16C784', 'SUY YẾU': '#F2C744', 'TỤT HẬU': '#FF4757', 'CẢI THIỆN': '#6E8FD6' };
  const tails = sectors.map(s => {
    const pts = s.tail.map(p => `${sx(p.rs_ratio).toFixed(1)},${sy(p.rs_momentum).toFixed(1)}`).join(' ');
    const last = s.tail[s.tail.length - 1];
    const c = colors[s.quadrant] || '#8E9CB4';
    return `<polyline points="${pts}" fill="none" stroke="${c}" stroke-opacity=".55" stroke-width="1.5"/><circle cx="${sx(last.rs_ratio)}" cy="${sy(last.rs_momentum)}" r="4" fill="${c}"><title>${esc(s.sector)}: ${last.rs_ratio} / ${last.rs_momentum}</title></circle><text x="${sx(last.rs_ratio) + 6}" y="${sy(last.rs_momentum) + 3}" class="rrg-label">${esc(s.sector)}</text>`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="rrg" role="img" aria-label="Biểu đồ luân chuyển ngành">
    <line x1="${sx(100)}" y1="0" x2="${sx(100)}" y2="${H}" class="rrg-axis"/><line x1="0" y1="${sy(100)}" x2="${W}" y2="${sy(100)}" class="rrg-axis"/>
    <text x="${W - 6}" y="14" text-anchor="end" class="rrg-q">DẪN DẮT</text><text x="${W - 6}" y="${H - 6}" text-anchor="end" class="rrg-q">SUY YẾU</text>
    <text x="6" y="${H - 6}" class="rrg-q">TỤT HẬU</text><text x="6" y="14" class="rrg-q">CẢI THIỆN</text>${tails}</svg>`;
}

function renderMarket(m: Market): string {
  const b = m.breadth, l = b.latest || {};
  const v = m.valuation.stats;
  const buy = m.flows.top_buy.slice(0, 6).map(r => `<li><b>${esc(r.ticker)}</b><span class="positive">+${vnd(r.net_20d / 1e9)} tỷ</span></li>`).join('');
  const sell = m.flows.top_sell.slice(0, 6).map(r => `<li><b>${esc(r.ticker)}</b><span class="negative">${vnd(r.net_20d / 1e9)} tỷ</span></li>`).join('');
  return `
    <div class="portfolio-summary tcbs-summary">
      <div><span>Độ rộng (${b.universe} mã thanh khoản)</span><strong>${esc(b.state || '—')}</strong><small>${l.pct_above_ma200 ?? '—'}% trên MA200 · ${l.pct_above_ma50 ?? '—'}% trên MA50</small></div>
      <div><span>Đỉnh / đáy 52 tuần mới</span><strong>${l.new_highs ?? '—'} / ${l.new_lows ?? '—'}</strong><small>tăng ${l.advances ?? '—'} · giảm ${l.declines ?? '—'} phiên gần nhất</small></div>
      <div><span>P/E thị trường (tổng hợp)</span><strong>${v ? `${v.now}x` : '—'}</strong><small>${v ? `TB 5 năm ${v.mean}x ± ${v.sd} · phân vị ${v.percentile}%` : 'chưa đủ dữ liệu'}</small></div>
      <div><span>Tỷ suất lợi nhuận thị trường</span><strong>${v ? `${v.earnings_yield_pct}%` : '—'}</strong><small>1 / P/E</small></div>
    </div>
    <div class="acc-grid quant-grid">
      <div class="acc-card"><strong>% cổ phiếu trên MA50 / MA200</strong><div id="qBreadth" class="q-chart"></div><p class="form-hint">Độ rộng dự báo được lợi nhuận nhưng tác dụng mờ dần sau 2–3 tháng — dùng để đọc trạng thái, không để canh điểm mua.</p></div>
      <div class="acc-card"><strong>P/E thị trường & dải ±1σ/±2σ</strong><div id="qValuation" class="q-chart"></div><p class="form-hint">${esc(m.valuation.note || '')}</p></div>
    </div>
    <div class="acc-card"><strong>Luân chuyển ngành (RRG, 5 tuần gần nhất)</strong>${rrgSvg(m.rotation.sectors)}
      <div class="rrg-legend">${m.rotation.sectors.map(s => `<span class="plan-action ${s.quadrant === 'DẪN DẮT' ? 'info' : s.quadrant === 'TỤT HẬU' ? 'high' : 'medium'}">${esc(s.sector)} · ${esc(s.quadrant)}</span>`).join('')}</div>
      <p class="form-hint">${esc(m.rotation.note)} Ngành đi theo chiều kim đồng hồ: Cải thiện → Dẫn dắt → Suy yếu → Tụt hậu.</p></div>
    <div class="acc-card"><strong>Khối ngoại 20 phiên (${m.flows.days_available} ngày dữ liệu)</strong>
      <div class="flow-cols"><div><small>Mua ròng nhiều nhất</small><ul class="flow-list">${buy}</ul></div><div><small>Bán ròng nhiều nhất</small><ul class="flow-list">${sell}</ul></div></div>
      <p class="form-hint">${esc(m.flows.note)}</p></div>`;
}

function drawMarketCharts(m: Market) {
  const b = $('qBreadth');
  if (b) lineChart(b, [
    { name: 'MA50', color: '#6E8FD6', points: m.breadth.points.filter(p => p.pct_above_ma50 != null).map(p => ({ time: p.date, value: p.pct_above_ma50 as number })) },
    { name: 'MA200', color: '#16C784', points: m.breadth.points.filter(p => p.pct_above_ma200 != null).map(p => ({ time: p.date, value: p.pct_above_ma200 as number })) },
  ], '%');
  const v = $('qValuation'), st = m.valuation.stats;
  if (v && st) {
    const pts = m.valuation.points;
    const flat = (val: number) => pts.map(p => ({ time: p.date, value: val }));
    lineChart(v, [
      { name: 'P/E', color: '#E9EDF4', points: pts.map(p => ({ time: p.date, value: p.pe })) },
      { name: 'TB', color: '#8E9CB4', points: flat(st.mean), dashed: true },
      { name: '+1σ', color: '#F2C744', points: flat(st.mean + st.sd), dashed: true },
      { name: '-1σ', color: '#F2C744', points: flat(st.mean - st.sd), dashed: true },
      { name: '+2σ', color: '#FF4757', points: flat(st.mean + 2 * st.sd), dashed: true },
      { name: '-2σ', color: '#16C784', points: flat(st.mean - 2 * st.sd), dashed: true },
    ], 'x');
  }
}

// ---------- screener & stock card ----------

type Row = { ticker: string; name: string | null; sector: string | null; price: number; overall: string | null; overall_pct: number | null; grades: Record<string, string | null>; caps: string[]; fscore: number | null; pe: number | null; pb: number | null; roe_op: number | null; momentum_6_1_pct: number | null; target_change_90d_pct: number | null };
let screenerState = { sector: '', grade: '' };

async function loadScreener() {
  const box = $('qScreener');
  if (!box) return;
  const params = new URLSearchParams({ limit: '150' });
  if (screenerState.sector) params.set('sector', screenerState.sector);
  if (screenerState.grade) params.set('grade', screenerState.grade);
  box.innerHTML = '<p class="form-hint">Đang chấm điểm…</p>';
  try {
    const d = await getJson<{ as_of: string; count: number; rows: Row[]; sectors: string[] }>(`/api/quant/screener?${params}`);
    box.innerHTML = `<form id="qFilter" class="plan-goal"><select id="qSector" aria-label="Ngành"><option value="">Tất cả ngành</option>${d.sectors.map(s => `<option${s === screenerState.sector ? ' selected' : ''}>${esc(s)}</option>`).join('')}</select>
        <select id="qGrade" aria-label="Điểm tối thiểu"><option value="">Mọi điểm</option>${['A', 'B', 'C'].map(g => `<option value="${g}"${g === screenerState.grade ? ' selected' : ''}>Từ ${g} trở lên</option>`).join('')}</select>
        <span class="form-hint">${d.count} mã · ngày ${esc(d.as_of)}</span></form>
      <div class="portfolio-table-wrap"><table class="portfolio-table q-table"><thead><tr><th>Mã</th><th>Ngành</th><th>Tổng</th><th>Giá trị</th><th>Chất lượng</th><th>Tăng trưởng</th><th>Sức khỏe</th><th>Momentum*</th><th>F-score</th><th>P/E</th><th>P/B</th><th>Δ mục tiêu 90N</th><th>Giá</th><th></th></tr></thead><tbody>
      ${d.rows.map(r => `<tr><td><strong>${esc(r.ticker)}</strong></td><td class="q-sector">${esc(r.sector || '')}</td><td>${badge(r.overall)}${r.caps.length ? ' <span title="' + esc(r.caps.join('; ')) + '">⚑</span>' : ''}</td>${['value', 'quality', 'growth', 'health', 'momentum'].map(g => `<td>${badge(r.grades[g])}</td>`).join('')}<td>${r.fscore ?? '—'}</td><td>${r.pe ?? '—'}</td><td>${r.pb ?? '—'}</td><td>${pct(r.target_change_90d_pct)}</td><td>${vnd(r.price)}</td><td><button class="table-action" data-qcard="${esc(r.ticker)}">Chi tiết</button></td></tr>`).join('')}
      </tbody></table></div>
      <div id="qCard"></div>
      <p class="form-hint">Điểm A–F so với các mã cùng ngành (A = top 20%). Tổng = 35% Chất lượng + 35% Giá trị + 15% Tăng trưởng + 15% Sức khỏe; ⚑ = bị hạ bậc vì cờ đỏ. *Momentum chỉ để tham khảo — không có bằng chứng hiệu quả ở Việt Nam, không tính vào điểm tổng.</p>`;
    $('qSector')?.addEventListener('change', e => { screenerState.sector = (e.target as HTMLSelectElement).value; loadScreener(); });
    $('qGrade')?.addEventListener('change', e => { screenerState.grade = (e.target as HTMLSelectElement).value; loadScreener(); });
    box.querySelectorAll<HTMLElement>('[data-qcard]').forEach(b => b.addEventListener('click', () => { renderStockQuantCard(b.dataset.qcard!, $('qCard')!); $('qCard')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }));
  } catch (e) {
    box.innerHTML = `<p class="form-hint negative">${esc((e as Error).message)}</p>`;
  }
}

type Card = {
  ticker: string; name: string | null; sector: string | null; as_of: string; overall: string | null; overall_pct: number | null;
  grades: Record<string, string | null>; group_pct: Record<string, number | null>; caps: string[]; percentiles: Record<string, number>;
  factors: Record<string, number | null>; fscore: null | { score: number; tests: number; score_9: number; year: number; details: Record<string, boolean | null> };
  dcf: null | { applicable: boolean; reason?: string; reliability?: string; fair_value?: number; low?: number; high?: number; discount_pct?: number; cost_of_equity_pct?: number; stage1_growth_pct?: number; terminal_growth_pct?: number; beta_used?: number; zone?: string };
  analyst: { target: number | null; rating: string | null; dps: number | null; revisions: null | { days: number; change_30d_pct: number | null; change_90d_pct: number | null; since?: string } };
  evidence: Record<string, string>; grade_history: Array<{ d: string; overall_pct: number | null; overall: string | null }>;
};

function revisionText(r: Card['analyst']['revisions']): string {
  if (!r) return '';
  if (r.change_30d_pct == null && r.change_90d_pct == null) return ` · theo dõi điều chỉnh mục tiêu từ ${esc(r.since || 'hôm nay')} (${r.days} ngày dữ liệu)`;
  return ` · điều chỉnh mục tiêu 30 ngày ${pct(r.change_30d_pct)}, 90 ngày ${pct(r.change_90d_pct)}`;
}

function gradeSparkline(h: Card['grade_history']): string {
  const pts = h.filter(p => p.overall_pct != null);
  if (pts.length < 2) return `<p class="form-hint">Lịch sử điểm: ${pts.length} lần chấm (tích lũy mỗi lần nạp dữ liệu).</p>`;
  const W = 240, H = 40;
  const path = pts.map((p, i) => `${(i / (pts.length - 1) * W).toFixed(1)},${(H - (p.overall_pct as number) / 100 * H).toFixed(1)}`).join(' ');
  return `<div class="q-spark"><span class="form-hint">Điểm tổng theo thời gian (${esc(pts[0].d)} → ${esc(pts[pts.length - 1].d)})</span>
    <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><line x1="0" y1="${H * 0.4}" x2="${W}" y2="${H * 0.4}" class="rrg-axis"/><polyline points="${path}" fill="none" stroke="#6E8FD6" stroke-width="2"/></svg></div>`;
}

export async function renderStockQuantCard(ticker: string, el: HTMLElement) {
  el.innerHTML = '<p class="form-hint">Đang tải điểm định lượng…</p>';
  try {
    const c = await getJson<Card>(`/api/quant/stock/${encodeURIComponent(ticker)}`);
    const f = c.factors;
    const fs = c.fscore;
    const d = c.dcf;
    const ev = (k: string) => c.evidence[k] ? `<span class="plan-action ${VERDICT_TONE[c.evidence[k]] || ''}">${esc(c.evidence[k].toLowerCase())}</span>` : '';
    el.innerHTML = `<div class="acc-card q-card">
      <header class="q-card-head"><strong>${esc(c.ticker)} · Điểm định lượng</strong>${badge(c.overall)}<span class="form-hint">${esc(c.sector || '')} · ${esc(c.as_of)} · kiểm định: ${ev('overall')}</span></header>
      ${c.caps.length ? `<p class="tcbs-flag high">Hạ bậc: ${esc(c.caps.join('; '))}</p>` : ''}
      <div class="q-groups">${Object.entries(c.grades).map(([g, v]) => `<div><span>${esc(GROUP_LABEL[g] || g)}</span>${badge(v)}<small>${c.group_pct[g] ?? '—'} điểm %</small></div>`).join('')}</div>
      <dl class="acc-dl">
        <div><dt>E/P (lợi nhuận/giá) ${ev('earnings_yield')}</dt><dd>${f.earnings_yield != null ? (f.earnings_yield * 100).toFixed(1) + '%' : '—'}</dd></div>
        <div><dt>B/P (sổ sách/giá) ${ev('book_to_price')}</dt><dd>${f.book_to_price ?? '—'}</dd></div>
        <div><dt>Lợi nhuận hoạt động/vốn ${ev('op_profitability')}</dt><dd>${f.op_profitability != null ? (f.op_profitability * 100).toFixed(1) + '%' : '—'}</dd></div>
        <div><dt>Tăng trưởng doanh thu / lợi nhuận (TTM)</dt><dd>${pct(f.revenue_growth != null ? f.revenue_growth * 100 : null)} / ${pct(f.earnings_growth != null ? f.earnings_growth * 100 : null)}</dd></div>
        <div><dt>Nợ / tài sản</dt><dd>${f.liabilities_to_assets != null ? (f.liabilities_to_assets * 100).toFixed(0) + '%' : '—'}</dd></div>
        <div><dt>Vốn hóa ${ev('size')}</dt><dd>${f.market_cap ? vnd((f.market_cap as number) / 1e9) + ' tỷ' : '—'}</dd></div>
      </dl>
      ${fs ? `<details><summary>Piotroski F-score ${fs.score_9}/9 (năm ${fs.year}) ${ev('fscore')}</summary><ul class="pt-checks">${Object.entries(fs.details).map(([k, ok]) => `<li><span class="plan-action ${ok === true ? 'info' : ok === false ? 'high' : ''}">${ok === true ? 'ĐẠT' : ok === false ? 'KHÔNG' : '—'}</span><b>${esc(k)}</b><span></span></li>`).join('')}</ul></details>` : ''}
      ${d ? (d.applicable ? `<div class="q-dcf"><strong>DCF 2 giai đoạn</strong> <span class="plan-action ${d.zone === 'DƯỚI GIÁ TRỊ' ? 'info' : d.zone === 'TRÊN GIÁ TRỊ' ? 'high' : 'medium'}">${esc(d.zone || '')}</span>
          <p class="plan-note">Giá trị hợp lý ~<b>${vnd(d.fair_value!)} đ</b> (vùng ${vnd(d.low!)} – ${vnd(d.high!)}), chiết khấu ${d.discount_pct}% so với giá hiện tại. Chi phí vốn ${d.cost_of_equity_pct}% (beta ${d.beta_used}), tăng trưởng giai đoạn 1 ${d.stage1_growth_pct}%, dài hạn ${d.terminal_growth_pct}%.</p>
          ${d.reliability === 'thấp' ? '<p class="tcbs-flag medium">Độ tin cậy thấp: giá trị hợp lý lệch quá 60% so với giá — nhiều khả năng giả định dòng tiền không phù hợp với doanh nghiệp này.</p>' : ''}
          <p class="form-hint">Dòng tiền tự do = dòng tiền kinh doanh − chi đầu tư TSCĐ, trung bình 3 năm; tăng trưởng giai đoạn 1 lấy mức thấp nhất giữa trung vị, CAGR và 4 quý gần nhất. Độ rộng vùng theo biến động giá. Rất nhạy với giả định — dùng làm tham chiếu.</p></div>`
          : `<p class="form-hint">DCF: ${esc(d.reason || 'không áp dụng')}</p>`) : ''}
      ${c.analyst.target ? `<p class="form-hint">Nhà phân tích (Vietcap): ${esc(c.analyst.rating || '')} · mục tiêu ${vnd(c.analyst.target)} đ${c.analyst.dps ? ` · cổ tức ${vnd(c.analyst.dps)} đ/cp` : ''}${revisionText(c.analyst.revisions)}</p>` : ''}
      ${gradeSparkline(c.grade_history)}
    </div>`;
  } catch (e) {
    el.innerHTML = (e as { offline?: boolean }).offline ? '' : `<p class="form-hint">${esc((e as Error).message)}</p>`;
  }
}

// ---------- validation & data tabs ----------

type Curve = { label: string; stats: { cagr_pct: number | null; vol_pct: number | null; sharpe: number | null; max_dd_pct: number | null; total_pct: number | null }; monthly: Array<{ month: string; ret: number }>; latest_picks?: string[]; beat_vnindex_pct?: number | null };
type Strategies = { size: number; benchmarks: Record<string, Curve>; models: Record<string, Curve>; note: string };
type Validation = { strategies?: Strategies; results: Array<{ factor: string; label: string; months: number; verdict: string; net_excess: { mean_pct: number | null; t: number | null; hit_pct: number | null; annual_pct: number | null }; long_short: { mean_pct: number | null }; vs_all_market: { annual_pct: number | null }; ic_mean: number | null }>; months: number; avg_eligible: number; from: string; to: string; cost_per_turnover_pct: number; caveat: string; updated_at: string };

async function loadValidation() {
  const box = $('qValidation');
  if (!box) return;
  try {
    const v = await getJson<Validation>('/api/quant/validation');
    box.innerHTML = `<p class="plan-note">Mỗi cuối tháng từ ${esc(v.from)} đến ${esc(v.to)} (${v.months} tháng, trung bình ${v.avg_eligible} mã thanh khoản): chọn 20% mã tốt nhất theo từng tiêu chí bằng dữ liệu có tại thời điểm đó, giữ 1 tháng, so với trung bình các mã được chấm, trừ phí ${v.cost_per_turnover_pct}%/lần đổi danh mục.</p>
      <div class="portfolio-table-wrap"><table class="portfolio-table"><thead><tr><th>Tiêu chí</th><th>Kết luận</th><th>Vượt trội/tháng (sau phí)</th><th>~/năm</th><th>t-stat</th><th>Tháng thắng</th><th>Top − đáy/tháng</th><th>IC</th></tr></thead><tbody>
      ${v.results.map(r => `<tr><td><strong>${esc(r.label)}</strong></td><td><span class="plan-action ${VERDICT_TONE[r.verdict] || ''}">${esc(r.verdict)}</span></td><td>${pct(r.net_excess.mean_pct, 2)}</td><td>${pct(r.net_excess.annual_pct)}</td><td>${r.net_excess.t ?? '—'}</td><td>${r.net_excess.hit_pct ?? '—'}%</td><td>${pct(r.long_short.mean_pct, 2)}</td><td>${r.ic_mean ?? '—'}</td></tr>`).join('')}
      </tbody></table></div>
      <p class="form-hint">"Có bằng chứng" = t ≥ 2. ${esc(v.caveat)} Kiểm định lúc ${esc(v.updated_at)}.</p>
      ${v.strategies ? renderStrategies(v.strategies) : ''}`;
    if (v.strategies) drawStrategies(v.strategies);
    box.querySelectorAll<HTMLElement>('[data-pick]').forEach(b => b.addEventListener('click', async () => {
      await showTab('screener');  // resolves once the screener (and its card slot) is rendered
      const el = $('qCard');
      if (el) { await renderStockQuantCard(b.dataset.pick!, el); el.scrollIntoView({ behavior: 'smooth' }); }
    }));
  } catch (e) {
    box.innerHTML = `<p class="form-hint">${esc((e as Error).message)}</p>`;
  }
}

const CURVE_COLORS: Record<string, string> = { vnindex: '#8E9CB4', equal_weight: '#69758A', overall: '#6E8FD6', value_combo: '#16C784' };

function renderStrategies(st: Strategies): string {
  const rows = [...Object.entries(st.models), ...Object.entries(st.benchmarks)].map(([k, c]) => `<tr><td><i class="dot" style="background:${CURVE_COLORS[k] || '#ccc'}"></i><strong>${esc(c.label)}</strong></td><td>${pct(c.stats.cagr_pct)}</td><td>${pct(c.stats.total_pct)}</td><td>${c.stats.vol_pct ?? '—'}%</td><td>${c.stats.sharpe ?? '—'}</td><td>${pct(c.stats.max_dd_pct)}</td><td>${c.beat_vnindex_pct != null ? `${c.beat_vnindex_pct}%` : '—'}</td></tr>`).join('');
  const picks = Object.entries(st.models).map(([, c]) => `<p class="plan-note"><b>${esc(c.label)}</b> — danh mục tháng này: ${(c.latest_picks || []).map(t => `<button class="table-action" data-pick="${esc(t)}">${esc(t)}</button>`).join(' ')}</p>`).join('');
  return `<section class="insight-block"><h4>Danh mục mẫu (top ${st.size}, tái cân bằng hàng tháng)</h4>
    <div id="qStrategyChart" class="q-chart"></div>
    <div class="portfolio-table-wrap"><table class="portfolio-table"><thead><tr><th>Danh mục</th><th>Lợi nhuận/năm</th><th>Tổng</th><th>Biến động/năm</th><th>Sharpe</th><th>Sụt giảm lớn nhất</th><th>Tháng thắng VN-Index</th></tr></thead><tbody>${rows}</tbody></table></div>
    ${picks}
    <p class="tcbs-flag medium">${esc(st.note)} Kết quả quá khứ trên dữ liệu có thiên lệch sống sót thường đẹp hơn thực tế đáng kể — đây là cơ sở để nghiên cứu tiếp, không phải cam kết lợi nhuận.</p></section>`;
}

function drawStrategies(st: Strategies) {
  const el = $('qStrategyChart');
  if (!el) return;
  const curve = (c: Curve) => { let eq = 100; return c.monthly.map(m => ({ time: m.month, value: (eq *= 1 + m.ret) })); };
  lineChart(el, [...Object.entries(st.models), ...Object.entries(st.benchmarks)].map(([k, c]) => ({ name: c.label.replace('Top 10 theo ', ''), color: CURVE_COLORS[k] || '#ccc', points: curve(c), dashed: k in st.benchmarks })));
}

type Status = { available: boolean; engine?: string; running?: boolean; counts?: Record<string, number>; ingest?: Record<string, unknown> & { updated_at?: string; state?: string; seconds?: number; error?: string }; validation_at?: string };

function renderStatus(s: Status): string {
  const i = s.ingest || {};
  return `<dl class="acc-dl"><div><dt>Cơ sở dữ liệu</dt><dd>${esc(s.engine || '—')}</dd></div>
    <div><dt>Giá / BCTC / hồ sơ / khối ngoại</dt><dd>${s.counts ? `${vnd(s.counts.prices)} / ${vnd(s.counts.statements)} / ${vnd(s.counts.universe)} / ${vnd(s.counts.flows)}` : '—'}</dd></div>
    <div><dt>Lần nạp gần nhất</dt><dd>${esc(String(i.updated_at || '—'))} ${i.state ? `(${esc(String(i.state))}${i.seconds ? `, ${i.seconds}s` : ''})` : ''}</dd></div>
    <div><dt>Kiểm định</dt><dd>${esc(s.validation_at || 'chưa chạy')}</dd></div></dl>
    ${i.error ? `<p class="form-hint negative">${esc(String(i.error))}</p>` : ''}
    <div class="plan-alerts"><button class="btn-ghost" id="qIngest" type="button" ${s.running ? 'disabled' : ''}>${s.running ? 'Đang nạp…' : 'Nạp dữ liệu & kiểm định lại'}</button><button class="btn-ghost" id="qIngestQuick" type="button" ${s.running ? 'disabled' : ''}>Chỉ cập nhật giá & khối ngoại</button></div>
    <p class="form-hint">Nạp đầy đủ: toàn bộ ~1.400 mã HOSE/HNX/UPCoM (5 năm giá), BCTC 8 năm + các quý cho mã thanh khoản ≥ 1 tỷ/phiên, rồi chạy lại kiểm định (~1–2 phút). Khối ngoại chỉ có từ ngày app bắt đầu nạp — nên nạp nhanh mỗi cuối phiên (scheduler trong Docker tự làm lúc 15:30).</p>`;
}

async function loadStatus(poll = false) {
  const box = $('qStatus');
  if (!box) return;
  const s = await getJson<Status>('/api/quant/status');
  box.innerHTML = renderStatus(s);
  const start = async (quick: boolean) => { await getJson(`/api/quant/ingest?quick=${quick}`, { method: 'POST' }); loadStatus(true); };
  $('qIngest')?.addEventListener('click', () => start(false));
  $('qIngestQuick')?.addEventListener('click', () => start(true));
  if (s.running || poll) {
    setTimeout(async () => {
      const again = await getJson<Status>('/api/quant/status');
      if (again.running) loadStatus(true);
      else { box.innerHTML = renderStatus(again); loadStatus(); loadedTabs.clear(); showTab(currentTab); }
    }, 3000);
  }
}

// ---------- section wiring ----------

const loadedTabs = new Set<string>();
let currentTab = 'market';

async function showTab(tab: string): Promise<void> {
  currentTab = tab;
  document.querySelectorAll<HTMLElement>('[data-qtab-btn]').forEach(b => b.classList.toggle('active', b.dataset.qtabBtn === tab));
  document.querySelectorAll<HTMLElement>('[data-qtab]').forEach(p => { p.hidden = p.dataset.qtab !== tab; });
  if (loadedTabs.has(tab)) return;
  loadedTabs.add(tab);
  if (tab === 'market') {
    const box = $('qMarket')!;
    box.innerHTML = '<p class="form-hint">Đang tính độ rộng, luân chuyển ngành, định giá…</p>';
    try {
      const m = await getJson<Market>('/api/quant/market');
      charts.splice(0).forEach(c => c.remove());
      box.innerHTML = renderMarket(m);
      drawMarketCharts(m);
    } catch (e) {
      loadedTabs.delete(tab);
      box.innerHTML = `<p class="form-hint">${esc((e as Error).message)}</p>`;
    }
  } else if (tab === 'screener') await loadScreener();
  else if (tab === 'validation') await loadValidation();
  else if (tab === 'data') await loadStatus();
}

export async function initQuantPanel() {
  const section = $('quant');
  if (!section) return;
  try {
    const s = await getJson<Status>('/api/quant/status');
    section.hidden = false;
    document.querySelector<HTMLElement>('.nav-link[data-section="quant"]')?.removeAttribute('hidden');
    section.querySelectorAll<HTMLElement>('[data-qtab-btn]').forEach(b => b.addEventListener('click', () => showTab(b.dataset.qtabBtn!)));
    showTab(s.available ? 'market' : 'data');
  } catch {
    section.hidden = true; // deployed site: no market database
  }
}

// ---------- account: grades of holdings + factor regression ----------

type Regression = { coefficients: Record<string, { coef: number; t: number | null; annual_pct?: number }>; r2: number; observations: number; from: string; to: string } | null;

let accountQuantKey = '';

export async function loadAccountQuant(syncedAt: string) {
  const box = $('accQuant');
  if (!box || syncedAt === accountQuantKey) return;
  accountQuantKey = syncedAt;
  try {
    const [g, r] = await Promise.all([
      getJson<{ holdings: Array<{ ticker: string; weight_pct: number; card: Card | null }> }>('/api/account/grades'),
      getJson<{ replay: Regression; actual: Regression; labels: Record<string, string>; note: string }>('/api/account/factors'),
    ]);
    const regTable = (x: Regression, title: string) => !x ? `<p class="form-hint">${esc(title)}: chưa đủ dữ liệu.</p>` : `<strong>${esc(title)}</strong> <span class="form-hint">${x.observations} phiên · R² ${x.r2}</span>
      <div class="portfolio-table-wrap"><table class="portfolio-table"><thead><tr><th>Yếu tố</th><th>Hệ số</th><th>t</th></tr></thead><tbody>
      ${Object.entries(x.coefficients).map(([k, v]) => `<tr><td>${k === 'alpha' ? `Alpha (~${v.annual_pct}%/năm)` : esc(r.labels[k] || k)}</td><td>${v.coef}</td><td class="${v.t != null && Math.abs(v.t) >= 2 ? 'positive' : ''}">${v.t ?? '—'}</td></tr>`).join('')}</tbody></table></div>`;
    box.hidden = false;
    box.innerHTML = `<section class="insight-block"><h4>Điểm định lượng các mã đang nắm</h4>
      <div class="portfolio-table-wrap"><table class="portfolio-table"><thead><tr><th>Mã</th><th>Tỷ trọng</th><th>Tổng</th><th>Giá trị</th><th>Chất lượng</th><th>Tăng trưởng</th><th>Sức khỏe</th><th>F-score</th><th>DCF</th></tr></thead><tbody>
      ${g.holdings.map(h => h.card ? `<tr><td><strong>${esc(h.ticker)}</strong></td><td>${h.weight_pct}%</td><td>${badge(h.card.overall)}</td>${['value', 'quality', 'growth', 'health'].map(k => `<td>${badge(h.card!.grades[k])}</td>`).join('')}<td>${h.card.fscore?.score_9 ?? '—'}</td><td>${h.card.dcf?.applicable ? `${esc(h.card.dcf.zone || '')} (${h.card.dcf.discount_pct}%)` : '—'}</td></tr>` : `<tr><td><strong>${esc(h.ticker)}</strong></td><td>${h.weight_pct}%</td><td colspan="7" class="form-hint">chưa đủ thanh khoản/BCTC để chấm</td></tr>`).join('')}
      </tbody></table></div></section>
      <section class="insight-block"><h4>Danh mục của bạn nghiêng về yếu tố nào?</h4>${regTable(r.replay, 'Tỷ trọng hiện tại, 1 năm qua')}${regTable(r.actual, 'NAV thật (TWR)')}<p class="form-hint">${esc(r.note)}</p></section>`;
  } catch (e) {
    if ((e as { offline?: boolean }).offline) return;
    box.hidden = false;
    box.innerHTML = `<p class="form-hint">Điểm định lượng: ${esc((e as Error).message)}</p>`;
  }
}
