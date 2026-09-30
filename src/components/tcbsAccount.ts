// Real TCBS account (read-only). Served by the local backend only (backend/server.py
// /api/account/*); on the deployed site those routes don't exist and the panel says so.
import { addAlerts, syncTcbsHoldings } from './portfolio';
import { setAccount } from './accountStore';
import { loadInsights } from './portfolioInsights';
import { initAccountTabs, loadOverview, type OverviewAnalysis } from './accountOverview';
import { loadAdvanced, loadTools } from './accountTools';
import { loadAccountQuant } from './quantPanel';

type Holding = { ticker: string; quantity: number; sellable: number; pending: number; avg_cost: number; price: number; market_value: number; pnl: number; pnl_pct: number; weight_pct: number };
type Analysis = {
  synced_at: string;
  summary: { nav: number; stock_value: number; cost_value: number; unrealized_pnl: number; unrealized_pnl_pct: number; cash: number; cash_pct: number; withdrawable: number; pending_buy: number; cash_dividend_pending: number };
  holdings: Holding[];
  concentration: { positions: number; top1_pct: number; top3_pct: number; effective_positions: number };
  flags: Array<{ level: 'high' | 'medium' | 'info'; text: string }>;
  today_trades: Array<{ ticker: string; buy_qty: number; buy_value: number; sell_qty: number; sell_value: number }>;
  accounts: Array<{ account: string; type: string; stock_value: number; cash: number }>;
  errors: string[];
};
type Status = { configured: boolean; logged_in: boolean; token_expires_at: string | null; last_sync: string | null };

let analysis: Analysis | null = null;

type Bands = { p10: number; p50: number; p90: number };
type PlanPosition = {
  ticker: string; quantity: number; avg_cost: number; price: number; pnl_pct: number; weight_pct: number;
  breakeven: number; gap_to_breakeven_pct: number; in_profit_after_costs: boolean;
  volatility_annual_pct?: number; drift_annual_pct?: number;
  breakeven_odds?: Record<string, number>; breakeven_sessions_by_trend?: number | null;
  average_down?: { shares: number; cost: number; new_avg_cost: number; new_breakeven: number; new_gap_pct: number; new_weight_pct: number; advisable: boolean; why: string } | null;
  scenarios?: Record<string, Bands>; dividend_yield_pct?: number;
  action?: string; reasons?: string[]; trend?: string; stop_loss?: number; target?: number; risk_reward?: number | null;
};
type Plan = {
  assumptions: { sell_fee_pct: number; sell_tax_pct: number; drift_shrink: number; max_weight_pct: number; cash_reserve_pct: number };
  positions: PlanPosition[];
  portfolio: { nav: number; model_available: boolean; volatility_annual_pct?: number; drift_annual_pct?: number; scenarios?: Record<string, Bands>; goal?: { goal_pct: number; months: number; target_nav: number; probability_pct: number; required_annual_pct: number }; dca?: { monthly: number; months: number; contributed: number; target_nav: number; probability_pct: number; p10: number; p50: number; p90: number; median_profit: number }; dividend_income_annual?: number };
  rebalance: { trims: Array<{ ticker: string; sell_shares: number; value: number; note: string }>; cash_after_trims: number; reserve: number; deployable: number; add_candidates: string[] };
  headline: { losing_positions: number; capital_to_recover: number };
};

let goal = { pct: 20, months: 12, monthly: 0 };
// Same snapshot + goal -> same plan; render() runs several times per sync, so don't refetch.
let planKey = '';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;
const esc = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] || char));
const vnd = (value: number) => Math.round(value).toLocaleString('vi-VN');
const signed = (value: number, text: string) => `<span class="${value >= 0 ? 'positive' : 'negative'}">${value >= 0 ? '+' : ''}${text}</span>`;
const time = (iso: string | null) => (iso ? new Date(iso).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }) : '');

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/account/${path}`, { headers: { 'Content-Type': 'application/json' }, ...init });
  // Only the local backend serves /api/account/*. On the deployed site the SPA fallback answers
  // with index.html (HTTP 200), so anything that is not the backend's JSON means "offline".
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  if (path === 'status' && (!res.ok || !isJson)) throw new Error('offline');
  const body = await res.json().catch(() => ({}));
  if (path === 'status' && typeof body?.configured !== 'boolean') throw new Error('offline');
  if (!res.ok) {
    const detail = body?.detail;
    const err = new Error(typeof detail === 'string' ? detail : detail?.message || `HTTP ${res.status}`) as Error & { needsLogin?: boolean };
    err.needsLogin = Boolean(detail?.needs_login);
    throw err;
  }
  return body as T;
}

function setStatus(text: string, isError = false) {
  const el = $('tcbsStatus');
  if (el) { el.textContent = text; el.classList.toggle('negative', isError); }
}

function showControls(loggedIn: boolean) {
  $('tcbsLogin')!.hidden = loggedIn;
  $('tcbsSync')!.hidden = !loggedIn;
  $('tcbsReview')!.hidden = !analysis;
}

let publishedKey = '';
/** Share the snapshot with the rest of the app (virtual portfolio, allocator, council sizing). */
function publish(a: Analysis) {
  const key = `${a.synced_at}|${a.holdings.length}`;
  if (key === publishedKey) return;
  publishedKey = key;
  setAccount(a);
  // the virtual portfolio stores prices in thousand VND, like the rest of the app
  syncTcbsHoldings(a.holdings.map(h => ({ ticker: h.ticker, quantity: h.quantity, avgPrice: h.avg_cost / 1000, price: h.price / 1000 })));
}

function render() {
  const box = $('tcbsContent');
  if (!box || !analysis) return;
  const { summary: s, concentration: c } = analysis;
  const flags = analysis.flags.map(f => `<li class="tcbs-flag ${f.level}">${esc(f.text)}</li>`).join('');
  const rows = analysis.holdings.map(h => `<tr>
    <td><strong>${esc(h.ticker)}</strong></td>
    <td>${vnd(h.quantity)}${h.pending ? `<small> (chờ về ${vnd(h.pending)})</small>` : ''}</td>
    <td>${vnd(h.avg_cost)}</td><td>${vnd(h.price)}</td><td>${vnd(h.market_value)}</td>
    <td>${signed(h.pnl, `${vnd(h.pnl)} (${h.pnl_pct.toFixed(2)}%)`)}</td>
    <td><div class="tcbs-weight"><span style="width:${Math.min(h.weight_pct, 100)}%"></span></div>${h.weight_pct.toFixed(1)}%</td>
    <td><button class="table-action" type="button" data-tcbs-council="${esc(h.ticker)}">AI</button></td></tr>`).join('');
  const trades = analysis.today_trades.map(t => `${esc(t.ticker)}: ${t.buy_qty ? `mua ${vnd(t.buy_qty)}` : ''}${t.buy_qty && t.sell_qty ? ', ' : ''}${t.sell_qty ? `bán ${vnd(t.sell_qty)}` : ''}`).join(' · ');
  box.innerHTML = `
    <div class="portfolio-summary tcbs-summary">
      <div><span>Tổng tài sản (NAV)</span><strong>${vnd(s.nav)} đ</strong></div>
      <div><span>Giá trị cổ phiếu</span><strong>${vnd(s.stock_value)} đ</strong></div>
      <div><span>Tiền mặt</span><strong>${vnd(s.cash)} đ · ${s.cash_pct}%</strong></div>
      <div><span>Lãi/lỗ chưa thực hiện</span><strong>${signed(s.unrealized_pnl, `${vnd(s.unrealized_pnl)} (${s.unrealized_pnl_pct}%)`)}</strong></div>
    </div>
    <p class="form-hint">${c.positions} mã · top 1 ${c.top1_pct}% · top 3 ${c.top3_pct}% · ~${c.effective_positions} vị thế hiệu dụng${s.cash_dividend_pending ? ` · cổ tức tiền chờ về ${vnd(s.cash_dividend_pending)} đ` : ''} · tiểu khoản ${analysis.accounts.map(a => esc(a.account)).join(', ')}</p>
    ${flags ? `<ul class="tcbs-flags">${flags}</ul>` : ''}
    ${rows ? `<div class="portfolio-table-wrap"><table class="portfolio-table"><thead><tr><th>Mã</th><th>SL</th><th>Giá vốn</th><th>Giá hiện tại</th><th>Giá trị</th><th>Lãi/Lỗ</th><th>Tỷ trọng</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="portfolio-empty">Tài khoản chưa nắm giữ cổ phiếu.</div>'}
    ${trades ? `<p class="form-hint">Khớp lệnh hôm nay: ${trades}</p>` : ''}
    ${analysis.errors.length ? `<p class="form-hint negative">Một số dữ liệu chưa tải được: ${analysis.errors.map(esc).join('; ')}</p>` : ''}`;
  publish(analysis);
  loadPlan();
  loadInsights(analysis.synced_at, analysis.holdings.map(h => h.ticker));
  loadOverview(analysis as unknown as OverviewAnalysis);
  if (analysis.holdings.length) { loadAdvanced(analysis.synced_at); loadAccountQuant(analysis.synced_at); }
  loadTools(analysis.synced_at);
  box.querySelectorAll<HTMLElement>('[data-tcbs-council]').forEach(btn => btn.addEventListener('click', () => window.openCouncilForTicker?.(btn.dataset.tcbsCouncil!)));
}

async function refreshStatus(): Promise<Status | null> {
  try {
    const st = await call<Status>('status');
    if (!st.configured) { setStatus('Chưa có API key: đặt TCBS_API_KEY trong backend/.env hoặc tạo file key.txt ở thư mục gốc.', true); return st; }
    if (st.last_sync) {
      analysis = await call<Analysis>('portfolio').catch(() => null);
      render();
    }
    showControls(st.logged_in);
    const synced = st.last_sync ? ` · đồng bộ lần cuối ${time(st.last_sync)}` : '';
    setStatus(st.logged_in ? `Đã đăng nhập, token dùng đến ${time(st.token_expires_at)}${synced}` : `Nhập iOTP từ TCInvest (Cài đặt → Bảo mật → iOTP → Nhận mã iOTP), tối đa 10 lần/ngày${synced}`);
    return st;
  } catch {
    $('tcbsPanel')?.classList.add('tcbs-offline');
    const tabs = $('accTabs');
    if (tabs) tabs.hidden = true;
    setStatus('Tài khoản TCBS chỉ chạy trên máy của bạn (npm run local). Bản online không giữ API key để bảo vệ tài khoản.');
    return null;
  }
}

/** Exchange an OTP for a token, then pull fresh data. Returns an error message, or null on success. */
async function loginWithOtp(otp: string): Promise<string | null> {
  if (!/^\d{4,8}$/.test(otp)) return 'OTP gồm 4–8 chữ số.';
  setStatus('Đang đăng nhập…');
  try {
    await call<Status>('login', { method: 'POST', body: JSON.stringify({ otp }) });
  } catch (e) {
    setStatus((e as Error).message, true);
    return (e as Error).message;
  }
  await sync();
  return null;
}

function openOtpDialog() {
  const dialog = $<HTMLDialogElement>('tcbsOtpDialog');
  if (!dialog || dialog.open) return;
  $('tcbsOtpDialogError')!.textContent = '';
  dialog.showModal();
  $<HTMLInputElement>('tcbsOtpDialogInput')?.focus();
}

let syncing = false;

async function sync(background = false) {
  if (syncing) return;
  syncing = true;
  const btn = $<HTMLButtonElement>('tcbsSync');
  if (btn) btn.disabled = true;
  if (!background) setStatus('Đang tải dữ liệu từ TCBS…');
  try {
    analysis = await call<Analysis>('sync', { method: 'POST' });
    lastSyncAt = Date.now();
    render();
    await refreshStatus();
  } catch (e) {
    const err = e as Error & { needsLogin?: boolean };
    setStatus(err.needsLogin ? 'Phiên TCBS đã hết hạn (token tối đa 8 giờ) — bấm "Nhập OTP" để tiếp tục.' : err.message, true);
    // A background refresh must not pop the dialog up on its own; the user asked for "OTP once".
    if (err.needsLogin) { showControls(false); if (!background) openOtpDialog(); }
  } finally {
    syncing = false;
    if (btn) btn.disabled = false;
  }
}

async function review() {
  const out = $('tcbsReviewOut');
  const btn = $<HTMLButtonElement>('tcbsReview');
  if (!out) return;
  out.hidden = false;
  out.textContent = 'AI đang đánh giá danh mục…';
  if (btn) btn.disabled = true;
  try {
    const r = await call<{ content: string; engine: string; warning?: string }>('review', { method: 'POST', body: JSON.stringify({ provider: 'gemini' }) });
    out.innerHTML = `<div class="tcbs-review-engine">${esc(r.engine)}${r.warning ? ` · ${esc(r.warning)}` : ''}</div>${esc(r.content)}`;
  } catch (e) {
    out.textContent = (e as Error).message;
  } finally {
    if (btn) btn.disabled = false;
  }
}

const ACTION_TONE: Record<string, string> = { 'CẮT LỖ / HẠ TỶ TRỌNG': 'high', 'THẬN TRỌNG': 'medium', 'GIỮ CÓ ĐIỀU KIỆN': 'medium', 'CHỐT LỜI 1/3': 'info', 'GIỮ, NÂNG STOP': 'info' };
const sessionsText = (n: number | null | undefined) => (n == null ? 'xu hướng hiện tại không kéo về hòa vốn' : n === 0 ? 'đã hòa vốn' : `~${n} phiên (~${Math.max(1, Math.round(n / 21))} tháng) nếu giữ nhịp tăng hiện tại`);

function renderPosition(p: PlanPosition): string {
  const tone = ACTION_TONE[p.action || ''] || '';
  const odds = p.breakeven_odds
    ? `<div class="plan-odds">${Object.entries(p.breakeven_odds).map(([k, v]) => `<div><span>${esc(k)}</span><div class="plan-bar"><i style="width:${v}%"></i></div><b>${v}%</b></div>`).join('')}</div>`
    : '';
  const s12 = p.scenarios?.['12 tháng'];
  const avg = p.average_down;
  return `<article class="plan-card">
    <header><strong>${esc(p.ticker)}</strong><span class="plan-action ${tone}">${esc(p.action || '—')}</span></header>
    <p class="plan-reason">${(p.reasons || []).map(esc).join(' · ')}</p>
    <dl>
      <div><dt>Giá hòa vốn (sau phí, thuế)</dt><dd>${vnd(p.breakeven)} đ</dd></div>
      <div><dt>${p.in_profit_after_costs ? 'Đang lãi sau phí' : 'Cần tăng để hồi vốn'}</dt><dd>${p.in_profit_after_costs ? signed(p.pnl_pct, `${p.pnl_pct.toFixed(2)}%`) : `<span class="negative">+${p.gap_to_breakeven_pct}%</span>`}</dd></div>
      <div><dt>Stop-loss / Mục tiêu</dt><dd>${vnd(p.stop_loss || 0)} / ${vnd(p.target || 0)}${p.risk_reward ? ` <small>R:R ${p.risk_reward}</small>` : ''}</dd></div>
      ${s12 ? `<div><dt>Vùng giá 12 tháng (P10–P90)</dt><dd>${vnd(s12.p10)} – ${vnd(s12.p90)}</dd></div>` : ''}
    </dl>
    ${odds ? `<div class="plan-sub">Xác suất chạm giá hòa vốn</div>${odds}<p class="plan-note">${sessionsText(p.breakeven_sessions_by_trend)}</p>` : ''}
    ${avg ? `<div class="plan-avg ${avg.advisable ? 'ok' : 'no'}"><b>Trung bình giá:</b> mua thêm ${vnd(avg.shares)} cp (~${vnd(avg.cost)} đ) → giá vốn ${vnd(avg.new_avg_cost)}, chỉ cần +${avg.new_gap_pct}% để hòa vốn, tỷ trọng ${avg.new_weight_pct}%. <em>${esc(avg.why)}</em></div>` : ''}
    ${p.volatility_annual_pct != null ? `<p class="plan-note">Biến động ${p.volatility_annual_pct}%/năm${p.dividend_yield_pct ? ` · cổ tức ${p.dividend_yield_pct}%/năm` : ''}</p>` : ''}
  </article>`;
}

function renderPlan(plan: Plan) {
  const box = $('tcbsPlan');
  if (!box) return;
  const pf = plan.portfolio;
  const g = pf.goal;
  const bands = pf.scenarios ? Object.entries(pf.scenarios).map(([k, b]) => `<tr><td>${esc(k)}</td><td>${vnd(b.p10)}</td><td>${vnd(b.p50)}</td><td>${vnd(b.p90)}</td></tr>`).join('') : '';
  const rb = plan.rebalance;
  const a = plan.assumptions;
  box.innerHTML = `
    <div class="plan-head">
      <h3>Kế hoạch hồi vốn &amp; tăng trưởng</h3>
      <form id="planGoalForm" class="plan-goal">Mục tiêu +<input id="planGoalPct" type="number" min="1" max="500" step="1" value="${goal.pct}" aria-label="Mục tiêu tăng trưởng %">% trong <input id="planGoalMonths" type="number" min="1" max="60" step="1" value="${goal.months}" aria-label="Số tháng"> tháng, góp thêm <input id="planGoalMonthly" class="wide" type="number" min="0" step="1000000" value="${goal.monthly}" aria-label="Tiền góp thêm mỗi tháng"> đ/tháng <button class="btn-ghost" type="submit">Tính lại</button></form>
    </div>
    <div class="portfolio-summary tcbs-summary">
      ${g ? `<div><span>Xác suất đạt +${g.goal_pct}% trong ${g.months} tháng</span><strong>${g.probability_pct}%</strong><small>cần ${g.required_annual_pct}%/năm · NAV mục tiêu ${vnd(g.target_nav)} đ</small></div>` : '<div><span>Mục tiêu</span><strong>—</strong><small>chưa đủ dữ liệu lịch sử giá</small></div>'}
      <div><span>Vốn cần hồi (${plan.headline.losing_positions} mã lỗ)</span><strong>${vnd(plan.headline.capital_to_recover)} đ</strong></div>
      <div><span>Biến động danh mục</span><strong>${pf.volatility_annual_pct ?? '—'}%/năm</strong></div>
      <div><span>Cổ tức ước tính / năm</span><strong>${pf.dividend_income_annual != null ? `${vnd(pf.dividend_income_annual)} đ` : '—'}</strong></div>
    </div>
    ${pf.dca ? `<div class="plan-dca"><strong>Góp thêm ${vnd(pf.dca.monthly)} đ/tháng trong ${pf.dca.months} tháng</strong> (tổng ${vnd(pf.dca.contributed)} đ): xác suất lãi ≥ ${goal.pct}% trên tổng vốn là <b>${pf.dca.probability_pct}%</b>. NAV cuối kỳ trung vị ${vnd(pf.dca.p50)} đ (xấu ${vnd(pf.dca.p10)} – tốt ${vnd(pf.dca.p90)}), lãi trung vị ${signed(pf.dca.median_profit, `${vnd(pf.dca.median_profit)} đ`)}.</div>` : ''}
    ${bands ? `<div class="portfolio-table-wrap"><table class="portfolio-table"><thead><tr><th>Kịch bản NAV</th><th>Xấu (P10)</th><th>Trung vị (P50)</th><th>Tốt (P90)</th></tr></thead><tbody>${bands}</tbody></table></div>` : ''}
    <div class="plan-grid">${plan.positions.map(renderPosition).join('')}</div>
    <div class="plan-alerts"><button class="btn-ghost" id="planMakeAlerts" type="button">Tạo cảnh báo stop-loss, hòa vốn &amp; mục tiêu</button><span id="planAlertsMsg" class="form-hint"></span></div>
    <div class="plan-rebalance">
      <strong>Tái cân bằng &amp; giải ngân</strong>
      <ul>
        ${rb.trims.map(t => `<li>Bán ${vnd(t.sell_shares)} cp <b>${esc(t.ticker)}</b> (~${vnd(t.value)} đ) — ${esc(t.note)}</li>`).join('')}
        <li>Giữ dự phòng ${a.cash_reserve_pct}% NAV (${vnd(rb.reserve)} đ). Tiền có thể giải ngân: <b>${vnd(rb.deployable)} đ</b>${rb.add_candidates.length ? ` — ưu tiên mã đang uptrend còn dư tỷ trọng: ${rb.add_candidates.map(esc).join(', ')}` : ''}.</li>
        ${rb.deployable > 0 ? '<li>Giải ngân chia 3 lần (1/3 mỗi lần) khi giá giữ trên MA20, thay vì mua một lần.</li>' : ''}
      </ul>
    </div>
    <p class="form-hint">Giả định: phí bán ${a.sell_fee_pct}% + thuế ${a.sell_tax_pct}% (giá vốn TCBS đã gồm phí mua); xu hướng 1 năm qua giảm ${Math.round(a.drift_shrink * 100)}% để tránh lạc quan; trần tỷ trọng ${a.max_weight_pct}%/mã. Đây là ước tính thống kê từ biến động quá khứ, không phải dự báo.</p>`;
  box.hidden = false;
  box.querySelector<HTMLFormElement>('#planGoalForm')?.addEventListener('submit', event => {
    event.preventDefault();
    const pct = Number($<HTMLInputElement>('planGoalPct')!.value);
    const months = Number($<HTMLInputElement>('planGoalMonths')!.value);
    const monthly = Math.max(0, Number($<HTMLInputElement>('planGoalMonthly')!.value) || 0);
    if (pct > 0 && pct <= 500 && months >= 1 && months <= 60) { goal = { pct, months, monthly }; loadPlan(); }
  });
  box.querySelector('#planMakeAlerts')?.addEventListener('click', () => {
    // Alerts use thousand VND like the rest of the virtual portfolio.
    const items = plan.positions.flatMap(p => [
      ...(p.stop_loss ? [{ ticker: p.ticker, type: 'below' as const, value: p.stop_loss / 1000 }] : []),
      ...(p.target ? [{ ticker: p.ticker, type: 'above' as const, value: p.target / 1000 }] : []),
      ...(!p.in_profit_after_costs ? [{ ticker: p.ticker, type: 'above' as const, value: Math.ceil(p.breakeven / 100) / 10 }] : []), // next 100 đ tick
    ]);
    const added = addAlerts(items);
    const msg = $('planAlertsMsg');
    if (msg) msg.textContent = added ? ` Đã thêm ${added} cảnh báo vào mục cảnh báo bên dưới.` : ' Các cảnh báo này đã có sẵn.';
  });
}

async function loadPlan() {
  const box = $('tcbsPlan');
  if (!box || !analysis?.holdings.length) { if (box) box.hidden = true; return; }
  const key = `${analysis.synced_at}|${goal.pct}|${goal.months}|${goal.monthly}`;
  if (key === planKey) return;
  planKey = key;
  if (box.hidden) { box.hidden = false; box.innerHTML = '<p class="form-hint">Đang tính kế hoạch từ lịch sử giá 1 năm…</p>'; }
  try {
    renderPlan(await call<Plan>('plan', { method: 'POST', body: JSON.stringify({ goalPct: goal.pct, goalMonths: goal.months, monthlyContribution: goal.monthly }) }));
  } catch (e) {
    planKey = '';
    box.innerHTML = `<p class="form-hint negative">Không tính được kế hoạch: ${esc((e as Error).message)}</p>`;
  }
}

export function initTcbsAccount() {
  if (!$('tcbsPanel')) return;
  $('tcbsLogin')?.addEventListener('click', openOtpDialog);
  const dialog = $<HTMLDialogElement>('tcbsOtpDialog');
  $('tcbsOtpDialogForm')?.addEventListener('submit', async event => {
    event.preventDefault();
    const input = $<HTMLInputElement>('tcbsOtpDialogInput')!;
    const submit = $<HTMLButtonElement>('tcbsOtpDialogSubmit')!;
    submit.disabled = true;
    const error = await loginWithOtp(input.value.trim());
    submit.disabled = false;
    input.value = '';
    if (error) { $('tcbsOtpDialogError')!.textContent = error; input.focus(); } else dialog?.close();
  });
  $('tcbsOtpDialogLater')?.addEventListener('click', () => dialog?.close());
  $('tcbsSync')?.addEventListener('click', () => sync());
  $('tcbsReview')?.addEventListener('click', review);
  // Ask for the OTP once, up front: a still-valid token (up to 8h) syncs straight away, otherwise
  // prompt. After that the account refreshes on its own while the token lasts.
  initAccountTabs();
  refreshStatus().then(st => {
    if (!st?.configured) return;
    if (st.logged_in) sync(); else openOtpDialog();
    startAutoRefresh();
  });
}

const REFRESH_MS = 5 * 60_000;
let lastSyncAt = 0;
let autoTimer: number | undefined;

function inTradingHours(d = new Date()): boolean {
  const vn = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }));
  const minutes = vn.getHours() * 60 + vn.getMinutes();
  return vn.getDay() >= 1 && vn.getDay() <= 5 && minutes >= 9 * 60 && minutes <= 15 * 60 + 5;
}

/** Re-sync every 5 minutes during trading hours and when the tab comes back after a while. */
function startAutoRefresh() {
  const tick = async (force = false) => {
    if (document.hidden || syncing) return;
    try {
      // The token check is a cheap local call; only the TCBS sync is throttled to every 5 minutes.
      const st = await call<Status>('status');
      if (st.logged_in) {
        if ((force || inTradingHours()) && Date.now() - lastSyncAt >= REFRESH_MS) await sync(true);
      } else if (analysis) {  // token ran out: say so, keep showing the last data, no pop-up
        showControls(false);
        setStatus('Phiên TCBS đã hết hạn (token tối đa 8 giờ) — đang hiển thị dữ liệu lần đồng bộ trước. Bấm "Nhập OTP" để cập nhật.', true);
      }
    } catch { /* offline: ignore */ }
  };
  window.clearInterval(autoTimer);
  autoTimer = window.setInterval(() => tick(), 60_000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(true); });
}
