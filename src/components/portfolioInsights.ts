// Deeper views on the real TCBS portfolio: benchmark vs VN-Index, sectors, analyst targets,
// dividends, corporate events, the trade journal, and the AI council run over every holding.
import { fetchAgentCouncilAnalysis, type AgentCouncilVerdict } from '../api/stockApi';
import { saveCouncilVerdict } from './agentCouncil';

type Insights = {
  benchmark: { portfolio_beta: number | null; stocks: Array<{ ticker: string; beta: number | null; correlation: number | null; weight_pct: number }>; windows: Array<{ window: string; portfolio_pct: number; vnindex_pct: number; excess_pct: number }> };
  sectors: { sectors: Array<{ sector: string; weight_pct: number; tickers: string[] }>; flags: string[] };
  analysts: { rows: Array<{ ticker: string; rating: string | null; target_price: number | null; upside_pct: number | null; vs_cost_pct: number | null; dividend_per_share: number | null; dividend_yield_on_cost_pct: number | null }>; dividend_income_annual: number | null };
  events: Array<{ ticker: string; date: string; type: string; title: string }>;
  journal: {
    since: string | null; trade_count: number; buys: number; sells: number; realized_pnl: number;
    win_rate_pct: number | null; avg_win_pct: number | null; avg_loss_pct: number | null; profit_factor: number | null; avg_holding_days: number | null;
    by_ticker: Array<{ ticker: string; pnl: number; sells: number }>; monthly: Array<{ month: string; pnl: number }>;
    recent_closed: Array<{ key: string; date: string; ticker: string; qty: number; price: number; cost_basis: number; pnl: number; pnl_pct: number; reason?: string | null }>;
    unknown_basis_sells: number;
    by_reason: Array<{ reason: string; closed: number; win_rate_pct: number; avg_pnl_pct: number }>;
    recent_trades: Array<{ key: string; date: string; ticker: string; side: 'B' | 'S'; qty: number; price: number; tag?: string | null; note?: string }>;
    tags: string[];
  };
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;
const esc = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] || char));
const vnd = (value: number) => Math.round(value).toLocaleString('vi-VN');
const pct = (value: number | null | undefined, digits = 2) => (value == null ? '—' : `<span class="${value >= 0 ? 'positive' : 'negative'}">${value >= 0 ? '+' : ''}${value.toFixed(digits)}%</span>`);
const RATING_VN: Record<string, string> = { BUY: 'Mua', OUTPERFORM: 'Khả quan', HOLD: 'Nắm giữ', NEUTRAL: 'Trung lập', UNDERPERFORM: 'Kém khả quan', SELL: 'Bán' };

type Band = { p5: number; p25: number; p50: number; p75: number; p95: number };
type Forecast = {
  price: number;
  garch: { alpha: number; beta: number; persistence: number; vol_now_annual_pct: number; vol_long_run_annual_pct: number };
  signals: { components: Record<string, { value_pct: number; score: number }>; composite: number; label: string };
  expected_return_annual_pct: number;
  bands: Record<string, Band>;
  prob_up: Record<string, number>;
  risk: { var95_1d_pct: number; var95_1m_pct: number; es95_1m_pct: number };
  prob_breakeven?: Record<string, number>;
  target_vs_stop_3m?: { target_first: number; stop_first: number; neither: number };
  validation?: { origins: number; horizon_sessions: number; interval80_coverage_pct: number; signal_hit_rate_pct: number | null; signal_calls: number; always_up_hit_rate_pct: number; naive_hit_rate_pct: number } | null;
} | null;

const SIGNAL_NAMES: Record<string, string> = { momentum_6m: 'Momentum 6 tháng', trend_ma200: 'So với MA200', reversal_1w: 'Đảo chiều 1 tuần', market_regime: 'VN-Index vs MA200' };

function validationVerdict(v: NonNullable<NonNullable<Forecast>['validation']>): string {
  const cov = v.interval80_coverage_pct;
  const risk = cov >= 70 && cov <= 90 ? 'khoảng giá dự báo đáng tin (gần 80% như thiết kế)' : cov < 70 ? 'khoảng giá dự báo đang quá hẹp — biến động thực tế lớn hơn mô hình' : 'khoảng giá dự báo hơi rộng (thận trọng)';
  const edge = v.signal_hit_rate_pct == null ? 'tín hiệu hướng chưa đủ lần để đánh giá'
    : v.signal_hit_rate_pct >= v.naive_hit_rate_pct + 5 ? `tín hiệu hướng đúng ${v.signal_hit_rate_pct}%, tốt hơn cách đoán ngây thơ (${v.naive_hit_rate_pct}%)`
    : `tín hiệu hướng đúng ${v.signal_hit_rate_pct}%, KHÔNG tốt hơn cách đoán ngây thơ "luôn theo chiều phổ biến" (${v.naive_hit_rate_pct}%) — đừng dựa vào nó để đoán hướng`;
  return `Kiểm định ${v.origins} lần trên 1 năm gần nhất: ${risk}; ${edge}.`;
}

function renderForecast(ticker: string, f: Forecast): string {
  if (!f) return `<article class="plan-card"><header><strong>${esc(ticker)}</strong></header><p class="plan-note">Chưa đủ 1 năm lịch sử giá để dự báo.</p></article>`;
  const tone = f.signals.composite > 0.1 ? 'info' : f.signals.composite < -0.1 ? 'high' : 'medium';
  const rows = Object.entries(f.bands).map(([k, b]) => `<tr><td>${esc(k)}</td><td>${vnd(b.p5)}</td><td><b>${vnd(b.p50)}</b></td><td>${vnd(b.p95)}</td><td>${f.prob_up[k]}%</td>${f.prob_breakeven ? `<td>${f.prob_breakeven[k]}%</td>` : ''}</tr>`).join('');
  const comps = Object.entries(f.signals.components).map(([k, c]) => `<span class="fc-chip ${c.score > 0.1 ? 'up' : c.score < -0.1 ? 'down' : ''}">${esc(SIGNAL_NAMES[k] || k)} ${c.value_pct > 0 ? '+' : ''}${c.value_pct}%</span>`).join('');
  const ts = f.target_vs_stop_3m;
  return `<article class="plan-card fc-card">
    <header><strong>${esc(ticker)}</strong><span class="plan-action ${tone}">${esc(f.signals.label)}</span></header>
    <div class="fc-chips">${comps}</div>
    <div class="fc-table"><table><thead><tr><th></th><th>Xấu 5%</th><th>Trung vị</th><th>Tốt 95%</th><th>P(tăng)</th>${f.prob_breakeven ? '<th>P(hòa vốn)</th>' : ''}</tr></thead><tbody>${rows}</tbody></table></div>
    <dl>
      <div><dt>Biến động hiện tại / dài hạn</dt><dd>${f.garch.vol_now_annual_pct}% / ${f.garch.vol_long_run_annual_pct}%</dd></div>
      <div><dt>Rủi ro 1 ngày / 1 tháng (VaR 95%)</dt><dd>-${f.risk.var95_1d_pct}% / -${f.risk.var95_1m_pct}%</dd></div>
      <div><dt>Trung bình 5% ngày tệ nhất (1 tháng)</dt><dd>-${f.risk.es95_1m_pct}%</dd></div>
      ${ts ? `<div><dt>3 tháng: chạm mục tiêu trước / stop trước</dt><dd><span class="positive">${ts.target_first}%</span> / <span class="negative">${ts.stop_first}%</span></dd></div>` : ''}
    </dl>
    ${f.validation ? `<p class="plan-note">${esc(validationVerdict(f.validation))}</p>` : ''}
  </article>`;
}

async function loadForecast() {
  const box = $('insightForecast');
  if (!box) return;
  box.innerHTML = '<p class="form-hint">Đang ước lượng GARCH, mô phỏng 3.000 kịch bản và kiểm định walk-forward…</p>';
  try {
    const res = await fetch('/api/account/forecast');
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.detail?.message || body?.detail || `HTTP ${res.status}`);
    const forecasts = body.forecasts as Record<string, Forecast>;
    box.innerHTML = `<div class="plan-grid fc-grid">${Object.entries(forecasts).map(([t, f]) => renderForecast(t, f)).join('')}</div>
      <p class="form-hint">Phương pháp: GARCH(1,1) dự báo biến động + Filtered Historical Simulation (bootstrap dừng Politis–Romano trên phần dư chuẩn hóa, 3 năm dữ liệu) cho phân phối giá; xu hướng lịch sử giảm 50% và tín hiệu chỉ nghiêng kỳ vọng tối đa ±10%/năm. Biến động dự báo được khá tốt; hướng giá gần như ngẫu nhiên — dùng để quản trị rủi ro, không phải để đoán đỉnh đáy.</p>`;
  } catch (e) {
    box.innerHTML = `<p class="form-hint negative">Không tính được dự báo: ${esc((e as Error).message)}</p>`;
  }
}

type Risk = {
  risk_pct: number;
  sizing: Array<{ ticker: string; held: number; suggested: number; stop: number; current_risk_pct_nav: number; delta: number; limited_by: string }>;
  risk_parity: { rows: Array<{ ticker: string; weight_pct: number; risk_share_pct: number; erc_weight_pct: number; vol_annual_pct: number }>; vol_now_pct: number; vol_erc_pct: number; note: string } | null;
  stress: Array<{ scenario: string; vnindex_pct: number; portfolio_pct: number; loss: number; rows: Array<{ ticker: string; move_pct: number; source: string }> }>;
  vol_spikes: Array<{ ticker: string; ratio: number; text: string }>;
  backtests: Record<string, { rules: Array<{ label: string; entries: number; avg_return_pct: number; median_return_pct: number; win_rate_pct: number; worst_pct: number; p10_pct: number }>; best: string } | null>;
};

let riskPct = 1;

function renderRisk(r: Risk): string {
  const sizing = r.sizing.map(z => `<tr><td><strong>${esc(z.ticker)}</strong></td><td>${vnd(z.held)}</td><td>${vnd(z.suggested)}</td><td>${z.delta === 0 ? '—' : z.delta > 0 ? `<span class="positive">+${vnd(z.delta)}</span>` : `<span class="negative">${vnd(z.delta)}</span>`}</td><td>${vnd(z.stop)}</td><td class="${z.current_risk_pct_nav > r.risk_pct * 1.5 ? 'negative' : ''}">${z.current_risk_pct_nav}%</td><td>${esc(z.limited_by || '')}</td></tr>`).join('');
  const rp = r.risk_parity;
  const rpRows = rp ? rp.rows.map(x => `<tr><td><strong>${esc(x.ticker)}</strong></td><td>${x.weight_pct}%</td><td class="${x.risk_share_pct > x.weight_pct * 1.3 ? 'negative' : ''}">${x.risk_share_pct}%</td><td>${x.erc_weight_pct}%</td><td>${x.vol_annual_pct}%</td></tr>`).join('') : '';
  const stress = r.stress.map(x => `<tr><td>${esc(x.scenario)}</td><td>${pct(x.vnindex_pct, 1)}</td><td>${pct(x.portfolio_pct, 1)}</td><td><span class="${x.loss >= 0 ? 'positive' : 'negative'}">${vnd(x.loss)} đ</span></td><td class="stress-detail">${x.rows.map(m => `${esc(m.ticker)} ${m.move_pct > 0 ? '+' : ''}${m.move_pct}%${m.source !== 'thực tế' ? '*' : ''}`).join(' · ')}</td></tr>`).join('');
  const bt = Object.entries(r.backtests).filter(([, b]) => b).map(([t, b]) => `<tr><td rowspan="${b!.rules.length}"><strong>${esc(t)}</strong></td>${b!.rules.map((x, i) => `${i ? '<tr>' : ''}<td>${esc(x.label)}${x.label === b!.best ? ' ✓' : ''}</td><td>${pct(x.avg_return_pct)}</td><td>${x.win_rate_pct}%</td><td>${pct(x.p10_pct, 1)}</td><td>${pct(x.worst_pct, 1)}</td></tr>`).join('')}`).join('');
  return `
    ${r.vol_spikes.map(v => `<p class="tcbs-flag high">${esc(v.text)}</p>`).join('')}
    <div class="plan-head"><strong>Định cỡ vị thế</strong><form id="riskPctForm" class="plan-goal">Rủi ro tối đa mỗi mã <input id="riskPctInput" type="number" min="0.25" max="10" step="0.25" value="${r.risk_pct}" aria-label="Rủi ro mỗi mã % NAV">% NAV <button class="btn-ghost" type="submit">Tính lại</button></form></div>
    <div class="portfolio-table-wrap"><table class="portfolio-table"><thead><tr><th>Mã</th><th>Đang giữ</th><th>Đề xuất</th><th>Chênh lệch</th><th>Stop dùng</th><th>Rủi ro hiện tại/NAV</th><th>Giới hạn bởi</th></tr></thead><tbody>${sizing}</tbody></table></div>
    <p class="form-hint">Số cổ phiếu sao cho nếu chạm stop thì chỉ mất ${r.risk_pct}% NAV (trần 25% NAV/mã). Không có stop thì dùng stop theo biến động GARCH (2 độ lệch chuẩn của 10 phiên).</p>
    ${rp ? `<strong>Đóng góp rủi ro (risk parity)</strong>
    <div class="portfolio-table-wrap"><table class="portfolio-table"><thead><tr><th>Mã</th><th>Tỷ trọng vốn</th><th>Tỷ trọng rủi ro</th><th>Tỷ trọng cân bằng rủi ro</th><th>Biến động/năm</th></tr></thead><tbody>${rpRows}</tbody></table></div>
    <p class="form-hint">Biến động phần cổ phiếu: hiện tại ${rp.vol_now_pct}%/năm → ${rp.vol_erc_pct}%/năm nếu chia theo cân bằng rủi ro (mỗi mã góp rủi ro bằng nhau). ${esc(rp.note)}</p>` : ''}
    <strong>Stress test</strong>
    <div class="portfolio-table-wrap"><table class="portfolio-table"><thead><tr><th>Kịch bản</th><th>VN-Index</th><th>Danh mục</th><th>Lãi/lỗ</th><th>Từng mã</th></tr></thead><tbody>${stress}</tbody></table></div>
    <p class="form-hint">Giả sử cú sập lặp lại với danh mục hôm nay, dùng biến động giá thật của từng mã (* = mã chưa niêm yết lúc đó, ước tính theo beta). Tiền mặt không đổi.</p>
    ${bt ? `<strong>Backtest quy tắc thoát lệnh (3 năm, vào lệnh mỗi tuần, đã gồm phí)</strong>
    <div class="portfolio-table-wrap"><table class="portfolio-table"><thead><tr><th>Mã</th><th>Quy tắc</th><th>Lợi nhuận TB</th><th>Tỷ lệ thắng</th><th>10% tệ nhất</th><th>Tệ nhất</th></tr></thead><tbody>${bt}</tbody></table></div>
    <p class="form-hint">✓ = quy tắc cho lợi nhuận trung bình cao nhất trên chính mã đó. Cắt lỗ thường giảm lỗ tệ nhất nhưng có thể cắt mất nhịp hồi — xem cả hai cột.</p>` : ''}`;
}

async function loadRisk() {
  const box = $('insightRisk');
  if (!box) return;
  box.innerHTML = '<p class="form-hint">Đang tính định cỡ vị thế, risk parity, stress test và backtest (5 năm dữ liệu)…</p>';
  try {
    const res = await fetch(`/api/account/risk?riskPct=${riskPct}`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.detail?.message || body?.detail || `HTTP ${res.status}`);
    box.innerHTML = renderRisk(body as Risk);
    box.querySelector<HTMLFormElement>('#riskPctForm')?.addEventListener('submit', event => {
      event.preventDefault();
      const v = Number($<HTMLInputElement>('riskPctInput')!.value);
      if (v > 0 && v <= 10) { riskPct = v; loadRisk(); }
    });
  } catch (e) {
    box.innerHTML = `<p class="form-hint negative">Không tính được phần rủi ro: ${esc((e as Error).message)}</p>`;
  }
}

/** Minimal Markdown → HTML for our own reports: headings, lists, checkboxes, tables, bold, italics. */
function markdownToHtml(md: string): string {
  const inline = (t: string) => esc(t).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/_(.+?)_/g, '<em>$1</em>');
  const out: string[] = [];
  let list = false;
  let table: string[][] = [];
  const flush = () => {
    if (list) { out.push('</ul>'); list = false; }
    if (table.length) {
      const [head, ...body] = table;
      out.push(`<div class="portfolio-table-wrap"><table class="portfolio-table"><thead><tr>${head.map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      table = [];
    }
  };
  for (const line of md.split('\n')) {
    if (line.startsWith('|')) {
      if (list) { out.push('</ul>'); list = false; }
      if (!/^\|(\s*-+\s*\|)+$/.test(line.replace(/---/g, '-'))) table.push(line.split('|').slice(1, -1).map(c => c.trim()));
      continue;
    }
    if (table.length) flush();
    const h = line.match(/^(#{1,3}) (.*)/);
    if (h) { flush(); out.push(`<h${h[1].length + 2}>${inline(h[2])}</h${h[1].length + 2}>`); continue; }
    const li = line.match(/^- (\[ \] )?(.*)/);
    if (li) { if (!list) { out.push('<ul>'); list = true; } out.push(`<li>${li[1] ? '☐ ' : ''}${inline(li[2])}</li>`); continue; }
    flush();
    if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  flush();
  return out.join('');
}

function downloadMarkdown(name: string, md: string) {
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `traderai-bao-cao-${name}.md`; a.click();
  URL.revokeObjectURL(url);
}

async function showReport(name: string) {
  const out = $('reportOut');
  if (!out) return;
  const res = await fetch(`/api/account/reports/${encodeURIComponent(name)}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { out.innerHTML = `<p class="form-hint negative">${esc(body?.detail?.message || 'Không mở được báo cáo')}</p>`; return; }
  out.innerHTML = `<div class="report-view">${markdownToHtml(body.markdown)}</div><button class="btn-ghost" type="button" id="reportDownload">Tải file .md</button>`;
  $('reportDownload')?.addEventListener('click', () => downloadMarkdown(name, body.markdown));
}

async function generateReport(auto = false) {
  const status = $('reportStatus');
  const btn = $<HTMLButtonElement>('reportMake');
  if (status) status.textContent = auto ? ' Cuối tuần rồi — đang tự tạo báo cáo tuần…' : ' Đang tạo báo cáo…';
  if (btn) btn.disabled = true;
  try {
    const res = await fetch('/api/account/report', { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.detail?.message || `HTTP ${res.status}`);
    if (status) status.textContent = ` Đã lưu báo cáo ${body.name}.`;
    await loadReports(false);
    showReport(body.name);
  } catch (e) {
    if (status) status.textContent = ` Không tạo được báo cáo: ${(e as Error).message}`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function loadReports(allowAuto = true) {
  const list = $('reportList');
  if (!list) return;
  try {
    const res = await fetch('/api/account/reports');
    const body = await res.json();
    const reports: Array<{ name: string; updated_at: string }> = body.reports || [];
    list.innerHTML = reports.length ? reports.map(r => `<button class="btn-ghost report-chip" type="button" data-report="${esc(r.name)}">${esc(r.name)}</button>`).join('') : '<span class="form-hint">Chưa có báo cáo nào.</span>';
    list.querySelectorAll<HTMLElement>('[data-report]').forEach(b => b.addEventListener('click', () => showReport(b.dataset.report!)));
    // Weekly and automatic: from Friday on, the first visit of the week writes that week's report.
    const weekend = [5, 6, 0].includes(new Date().getDay());
    if (allowAuto && weekend && !reports.some(r => r.name === body.current_week)) generateReport(true);
  } catch {
    list.innerHTML = '<span class="form-hint negative">Không đọc được danh sách báo cáo.</span>';
  }
}

let insightsKey = '';
let tickers: string[] = [];
let councilCancelled = false;

function betaText(beta: number | null): string {
  if (beta == null) return 'chưa đủ dữ liệu';
  if (beta > 1.2) return `${beta} — biến động mạnh hơn thị trường`;
  if (beta < 0.8) return `${beta} — phòng thủ hơn thị trường`;
  return `${beta} — đi cùng thị trường`;
}

function renderJournal(j: Insights['journal']): string {
  if (!j.trade_count) {
    return `<p class="form-hint">TCBS chỉ trả lệnh khớp trong ngày, nên app tự ghi nhật ký mỗi lần đồng bộ. Hãy đồng bộ vào cuối mỗi phiên có giao dịch để tích lũy lãi/lỗ đã chốt, tỷ lệ thắng và thời gian nắm giữ.</p>`;
  }
  const closed = j.recent_closed.map(c => `<tr><td>${esc(c.date)}</td><td><strong>${esc(c.ticker)}</strong></td><td>${vnd(c.qty)}</td><td>${vnd(c.cost_basis)} → ${vnd(c.price)}</td><td><span class="${c.pnl >= 0 ? 'positive' : 'negative'}">${c.pnl >= 0 ? '+' : ''}${vnd(c.pnl)}</span> (${pct(c.pnl_pct)})</td><td>${esc(c.reason || '—')}</td></tr>`).join('');
  const reasons = j.by_reason.map(r => `<tr><td>${esc(r.reason)}</td><td>${r.closed}</td><td>${r.win_rate_pct}%</td><td>${pct(r.avg_pnl_pct)}</td></tr>`).join('');
  const options = (sel?: string | null) => `<option value="">— lý do —</option>${j.tags.map(t => `<option${t === sel ? ' selected' : ''}>${esc(t)}</option>`).join('')}`;
  const tagRows = j.recent_trades.map(t => `<tr data-trade="${esc(t.key)}"><td>${esc(t.date)}</td><td><strong>${esc(t.ticker)}</strong></td><td class="${t.side === 'B' ? 'positive' : 'negative'}">${t.side === 'B' ? 'Mua' : 'Bán'} ${vnd(t.qty)} @ ${vnd(t.price)}</td><td><select class="note-tag" aria-label="Lý do">${options(t.tag)}</select></td><td><input class="note-text" maxlength="300" value="${esc(t.note || '')}" placeholder="Ghi chú" aria-label="Ghi chú"></td><td><button class="table-action" type="button" data-note-save>Lưu</button></td></tr>`).join('');
  return `
    <div class="portfolio-summary tcbs-summary">
      <div><span>Lãi/lỗ đã chốt (sau phí, thuế)</span><strong><span class="${j.realized_pnl >= 0 ? 'positive' : 'negative'}">${j.realized_pnl >= 0 ? '+' : ''}${vnd(j.realized_pnl)} đ</span></strong><small>từ ${esc(j.since || '')} · ${j.buys} lệnh mua, ${j.sells} lệnh bán</small></div>
      <div><span>Tỷ lệ thắng</span><strong>${j.win_rate_pct ?? '—'}%</strong><small>lãi TB ${pct(j.avg_win_pct)} · lỗ TB ${pct(j.avg_loss_pct)}</small></div>
      <div><span>Profit factor</span><strong>${j.profit_factor ?? '—'}</strong><small>tổng lãi / tổng lỗ (&gt;1.5 là tốt)</small></div>
      <div><span>Thời gian nắm giữ TB</span><strong>${j.avg_holding_days != null ? `${j.avg_holding_days} ngày` : '—'}</strong><small>theo các lệnh mua đã ghi nhật ký</small></div>
    </div>
    ${closed ? `<div class="portfolio-table-wrap"><table class="portfolio-table"><thead><tr><th>Ngày</th><th>Mã</th><th>SL bán</th><th>Giá vốn → bán</th><th>Lãi/lỗ</th><th>Lý do mua</th></tr></thead><tbody>${closed}</tbody></table></div>` : ''}
    ${reasons ? `<strong>Hiệu quả theo lý do vào lệnh</strong><div class="portfolio-table-wrap"><table class="portfolio-table"><thead><tr><th>Lý do</th><th>Số lệnh đóng</th><th>Tỷ lệ thắng</th><th>Lãi/lỗ TB</th></tr></thead><tbody>${reasons}</tbody></table></div>` : ''}
    ${tagRows ? `<strong>Gắn lý do cho giao dịch</strong><p class="form-hint">Lệnh bán được tính theo lý do của lệnh mua gần nhất cùng mã. Sau vài chục lệnh bạn sẽ thấy kiểu vào lệnh nào thật sự hiệu quả.</p><div class="portfolio-table-wrap"><table class="portfolio-table note-table"><thead><tr><th>Ngày</th><th>Mã</th><th>Lệnh</th><th>Lý do</th><th>Ghi chú</th><th></th></tr></thead><tbody>${tagRows}</tbody></table></div>` : ''}
    ${j.unknown_basis_sells ? `<p class="form-hint">${j.unknown_basis_sells} lệnh bán chưa rõ giá vốn (bán trước khi app kịp ghi nhận vị thế) nên không tính vào lãi/lỗ.</p>` : ''}`;
}

function render(data: Insights) {
  const box = $('tcbsInsights');
  if (!box) return;
  const b = data.benchmark;
  const windows = b.windows.map(w => `<tr><td>${esc(w.window)}</td><td>${pct(w.portfolio_pct)}</td><td>${pct(w.vnindex_pct)}</td><td>${pct(w.excess_pct)}</td></tr>`).join('');
  const sectors = data.sectors.sectors.map(s => `<div class="sector-row"><span>${esc(s.sector)}</span><div class="plan-bar"><i style="width:${Math.min(100, s.weight_pct)}%"></i></div><b>${s.weight_pct.toFixed(1)}%</b><small>${s.tickers.map(esc).join(', ')}</small></div>`).join('');
  const analysts = data.analysts.rows.map(r => `<tr><td><strong>${esc(r.ticker)}</strong></td><td>${r.rating ? esc(RATING_VN[r.rating] || r.rating) : '—'}</td><td>${r.target_price ? vnd(r.target_price) : '—'}</td><td>${pct(r.upside_pct, 1)}</td><td>${pct(r.vs_cost_pct, 1)}</td><td>${r.dividend_per_share ? `${vnd(r.dividend_per_share)} đ` : '—'}</td><td>${r.dividend_yield_on_cost_pct != null ? `${r.dividend_yield_on_cost_pct}%` : '—'}</td></tr>`).join('');
  const events = data.events.map(e => `<li><span class="event-date">${esc(e.date)}</span><span class="plan-action ${e.type === 'CỔ TỨC' || e.type === 'CHỐT QUYỀN' ? 'info' : ''}">${esc(e.type)}</span><span>${esc(e.title)}</span></li>`).join('');
  const stockBetas = b.stocks.map(s => `${esc(s.ticker)} β ${s.beta ?? '—'}`).join(' · ');

  box.innerHTML = `
    <div class="plan-head"><h3>Phân tích chuyên sâu</h3></div>

    <section class="insight-block">
      <h4>Dự báo định lượng</h4>
      <div id="insightForecast"></div>
    </section>

    <section class="insight-block">
      <h4>Quản trị rủi ro</h4>
      <div id="insightRisk"></div>
    </section>

    <section class="insight-block">
      <h4>So với VN-Index</h4>
      <p class="plan-note">Beta danh mục: <b>${betaText(b.portfolio_beta)}</b>. Beta 1.3 nghĩa là VN-Index giảm 10% thì danh mục thường giảm ~13%. <span class="insight-muted">${stockBetas}</span></p>
      ${windows ? `<div class="portfolio-table-wrap"><table class="portfolio-table"><thead><tr><th>Giai đoạn</th><th>Danh mục hiện tại</th><th>VN-Index</th><th>Chênh lệch</th></tr></thead><tbody>${windows}</tbody></table></div><p class="form-hint">Mô phỏng: nếu nắm đúng tỷ trọng hiện tại từ đầu giai đoạn (không gồm tiền mặt, phí, cổ tức).</p>` : ''}
    </section>

    <section class="insight-block">
      <h4>Phân bổ theo ngành</h4>
      <div class="sector-list">${sectors}</div>
      ${data.sectors.flags.map(f => `<p class="tcbs-flag medium">${esc(f)}</p>`).join('')}
    </section>

    <section class="insight-block">
      <h4>Nhà phân tích &amp; cổ tức</h4>
      <div class="portfolio-table-wrap"><table class="portfolio-table"><thead><tr><th>Mã</th><th>Khuyến nghị</th><th>Giá mục tiêu</th><th>Upside</th><th>So với giá vốn</th><th>Cổ tức/cp</th><th>Tỷ suất/giá vốn</th></tr></thead><tbody>${analysts}</tbody></table></div>
      <p class="form-hint">Nguồn: Vietcap. ${data.analysts.dividend_income_annual ? `Cổ tức tiền ước tính theo số cổ phiếu đang nắm: <b>${vnd(data.analysts.dividend_income_annual)} đ/năm</b>.` : ''}</p>
    </section>

    <section class="insight-block">
      <h4>Lịch sự kiện doanh nghiệp (120 ngày)</h4>
      ${events ? `<ul class="event-list">${events}</ul><p class="form-hint">Mua trước ngày GDKHQ mới được nhận cổ tức/quyền; sau ngày đó giá được điều chỉnh giảm tương ứng.</p>` : '<p class="form-hint">Không có công bố cổ tức, chốt quyền hay phát hành gần đây.</p>'}
    </section>

    <section class="insight-block">
      <h4>Nhật ký giao dịch &amp; hiệu suất</h4>
      ${renderJournal(data.journal)}
    </section>

    <section class="insight-block">
      <h4>Báo cáo tuần</h4>
      <p class="plan-note">Tổng hợp NAV, lãi/lỗ, cảnh báo, rủi ro, sự kiện và việc cần làm. Từ thứ Sáu, lần mở app đầu tiên trong tuần sẽ tự tạo báo cáo; file lưu trong runtime/reports/.</p>
      <div class="plan-alerts"><button class="btn-ghost" id="reportMake" type="button">Tạo báo cáo tuần này</button><span id="reportStatus" class="form-hint"></span></div>
      <div id="reportList" class="report-list"></div>
      <div id="reportOut"></div>
    </section>

    <section class="insight-block">
      <h4>Hội đồng AI cho toàn danh mục</h4>
      <p class="plan-note">Chạy Hội đồng AI (kỹ thuật, cơ bản, tin tức, tranh biện Bò/Gấu, CIO) lần lượt cho từng mã đang nắm. Mỗi mã mất khoảng 30–90 giây khi dùng LLM.</p>
      <div class="plan-alerts"><button class="btn-ghost" id="councilAllRun" type="button">Chạy cho ${tickers.length} mã</button><button class="btn-ghost" id="councilAllStop" type="button" hidden>Dừng</button><span id="councilAllStatus" class="form-hint"></span></div>
      <div id="councilAllOut"></div>
    </section>`;
  box.hidden = false;
  $('councilAllRun')?.addEventListener('click', runCouncilAll);
  $('councilAllStop')?.addEventListener('click', () => { councilCancelled = true; });
  $('reportMake')?.addEventListener('click', () => generateReport());
  box.querySelectorAll<HTMLElement>('[data-note-save]').forEach(btn => btn.addEventListener('click', async () => {
    const row = btn.closest<HTMLElement>('tr[data-trade]');
    if (!row) return;
    const tag = row.querySelector<HTMLSelectElement>('.note-tag')!.value || null;
    const note = row.querySelector<HTMLInputElement>('.note-text')!.value;
    const res = await fetch('/api/account/journal/note', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: row.dataset.trade, tag, note }) });
    btn.textContent = res.ok ? 'Đã lưu' : 'Lỗi';
    setTimeout(() => { btn.textContent = 'Lưu'; }, 1500);
  }));
  loadForecast();
  loadRisk();
  loadReports();
}

const ACTION_CLASS: Record<string, string> = { MUA: 'info', 'BÁN': 'high', 'QUAN SÁT': 'medium' };

async function runCouncilAll() {
  const run = $<HTMLButtonElement>('councilAllRun');
  const stop = $<HTMLButtonElement>('councilAllStop');
  const status = $('councilAllStatus');
  const out = $('councilAllOut');
  if (!run || !stop || !status || !out) return;
  councilCancelled = false;
  run.disabled = true;
  stop.hidden = false;
  const results: Array<{ ticker: string; verdict?: AgentCouncilVerdict; engine?: string; error?: string }> = [];
  const draw = () => {
    const counts = results.reduce<Record<string, number>>((acc, r) => { if (r.verdict) acc[r.verdict.action] = (acc[r.verdict.action] || 0) + 1; return acc; }, {});
    out.innerHTML = `${results.length ? `<p class="plan-note">Tổng hợp: ${Object.entries(counts).map(([k, v]) => `${esc(k)} ${v}`).join(' · ') || '—'}</p>` : ''}
      <div class="portfolio-table-wrap"><table class="portfolio-table"><thead><tr><th>Mã</th><th>Phán quyết</th><th>Vùng gom</th><th>Mục tiêu</th><th>Stop-loss</th><th>Tỷ trọng</th><th>Rủi ro</th></tr></thead><tbody>${results.map(r => r.verdict
        ? `<tr><td><strong>${esc(r.ticker)}</strong></td><td><span class="plan-action ${ACTION_CLASS[r.verdict.action] || ''}">${esc(r.verdict.action)}</span></td><td>${esc(r.verdict.entry_zone)}</td><td>${esc(r.verdict.target_price)}</td><td>${esc(r.verdict.stop_loss)}</td><td>${esc(r.verdict.sizing)}</td><td>${esc(r.verdict.risk_level)}</td></tr>
           <tr class="council-summary-row"><td></td><td colspan="6">${esc(r.verdict.summary || '')} <small>${esc(r.engine || '')}</small></td></tr>`
        : `<tr><td><strong>${esc(r.ticker)}</strong></td><td colspan="6" class="negative">${esc(r.error || 'Lỗi')}</td></tr>`).join('')}</tbody></table></div>`;
  };
  for (const [i, ticker] of tickers.entries()) {
    if (councilCancelled) break;
    status.textContent = ` Đang phân tích ${ticker} (${i + 1}/${tickers.length})…`;
    try {
      const r = await fetchAgentCouncilAnalysis({ ticker, provider: 'gemini' });
      saveCouncilVerdict(ticker, r.verdict.structured);
      results.push({ ticker, verdict: r.verdict.structured, engine: r.engines?.portfolio_manager });
    } catch (e) {
      results.push({ ticker, error: (e as Error).message });
    }
    draw();
  }
  status.textContent = councilCancelled ? ` Đã dừng sau ${results.length}/${tickers.length} mã.` : ' Hoàn tất. Phán quyết đã lưu vào danh sách theo dõi.';
  run.disabled = false;
  stop.hidden = true;
}

export async function loadInsights(syncedAt: string, holdingTickers: string[]) {
  const box = $('tcbsInsights');
  if (!box) return;
  if (!holdingTickers.length) { box.hidden = true; return; }
  if (syncedAt === insightsKey) return;
  insightsKey = syncedAt;
  tickers = holdingTickers;
  box.hidden = false;
  box.innerHTML = '<p class="form-hint">Đang tải so sánh VN-Index, ngành, cổ tức và sự kiện…</p>';
  try {
    const res = await fetch('/api/account/insights');
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.detail?.message || body?.detail || `HTTP ${res.status}`);
    render(body as Insights);
  } catch (e) {
    insightsKey = '';
    box.innerHTML = `<p class="form-hint negative">Không tải được phân tích chuyên sâu: ${esc((e as Error).message)}</p>`;
  }
}
