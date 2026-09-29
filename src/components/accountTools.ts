// Tools tab (pre-trade checklist, alternatives, personal rules, auto-sync & notifications),
// plus the risk tab's correlation / Black–Litterman block and the forecast track record.
import { getCouncilVerdict } from './agentCouncil';
import { renderRegime } from './accountOverview';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;
const esc = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] || char));
const vnd = (value: number) => Math.round(value).toLocaleString('vi-VN');
const pct = (v: number | null | undefined, d = 1) => (v == null ? '—' : `<span class="${v >= 0 ? 'positive' : 'negative'}">${v >= 0 ? '+' : ''}${v.toFixed(d)}%</span>`);
const STATUS_TONE: Record<string, string> = { PASS: 'info', WARN: 'medium', FAIL: 'high' };
const VERDICT_TONE: Record<string, string> = { 'ĐẠT': 'info', 'CÂN NHẮC': 'medium', 'KHÔNG ĐẠT': 'high' };
const RULE_LABELS: Record<string, string> = {
  max_positions: 'Số mã tối đa', max_weight_pct: 'Tỷ trọng tối đa 1 mã (%)', max_sector_pct: 'Tỷ trọng tối đa 1 ngành (%)',
  min_cash_pct: 'Tiền mặt tối thiểu (%)', max_loss_pct: 'Cắt lỗ khi lỗ quá (%)', max_risk_per_trade_pct: 'Rủi ro tối đa mỗi lệnh (% NAV)',
  no_average_down: 'Cấm trung bình giá xuống',
};

let advancedKey = '';
let toolsKey = '';
let tags: string[] = [];

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.detail?.message || (typeof body?.detail === 'string' ? body.detail : '') || `HTTP ${res.status}`);
  return body as T;
}

// ---------- risk tab: correlation + Black–Litterman ----------

type Advanced = {
  correlation: null | { tickers: string[]; matrix: number[][]; avg_correlation: number; clusters: string[][]; notes: string[] };
  regime: Parameters<typeof renderRegime>[0];
  black_litterman: null | { rows: Array<{ ticker: string; current_pct: number; bl_pct: number; prior_return_pct: number; posterior_return_pct: number; view_pct: number | null }>; note: string };
  alternatives?: Alternatives;
};

function heat(v: number): string {
  const a = Math.min(1, Math.abs(v));
  return v >= 0 ? `rgba(255,71,87,${(a * 0.55).toFixed(2)})` : `rgba(22,199,132,${(a * 0.55).toFixed(2)})`;
}

function renderAdvanced(d: Advanced): string {
  const c = d.correlation;
  const matrix = c ? `<div class="portfolio-table-wrap"><table class="portfolio-table corr-table"><thead><tr><th></th>${c.tickers.map(t => `<th>${esc(t)}</th>`).join('')}</tr></thead><tbody>${c.matrix.map((row, i) => `<tr><th>${esc(c.tickers[i])}</th>${row.map((v, j) => `<td style="background:${i === j ? 'transparent' : heat(v)}">${i === j ? '—' : v.toFixed(2)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
    <p class="form-hint">Tương quan trung bình ${c.avg_correlation}. Đỏ đậm = các mã lên xuống cùng nhau (đa dạng hóa kém).</p>${c.notes.map(n => `<p class="tcbs-flag medium">${esc(n)}</p>`).join('')}` : '<p class="form-hint">Cần ít nhất 2 mã để tính tương quan.</p>';
  const bl = d.black_litterman;
  const blRows = bl ? bl.rows.map(r => `<tr><td><strong>${esc(r.ticker)}</strong></td><td>${r.current_pct}%</td><td><b>${r.bl_pct}%</b></td><td>${pct(r.prior_return_pct)}</td><td>${pct(r.view_pct)}</td><td>${pct(r.posterior_return_pct)}</td></tr>`).join('') : '';
  return `<section class="insight-block"><h4>Tương quan giữa các mã</h4>${matrix}</section>
    ${bl ? `<section class="insight-block"><h4>Tỷ trọng gợi ý Black–Litterman</h4><div class="portfolio-table-wrap"><table class="portfolio-table"><thead><tr><th>Mã</th><th>Hiện tại</th><th>Gợi ý</th><th>Lợi nhuận cân bằng</th><th>Quan điểm (nhà phân tích)</th><th>Lợi nhuận kết hợp</th></tr></thead><tbody>${blRows}</tbody></table></div><p class="form-hint">${esc(bl.note)} Kết quả nhạy với giá mục tiêu — dùng làm tham khảo khi tái cân bằng, không phải lệnh.</p></section>` : ''}`;
}

export async function loadAdvanced(syncedAt: string) {
  const box = $('accAdvanced');
  if (!box || syncedAt === advancedKey) return;
  advancedKey = syncedAt;
  box.hidden = false;
  box.innerHTML = '<p class="form-hint">Đang tính tương quan, trạng thái thị trường và Black–Litterman…</p>';
  try {
    const d = await getJson<Advanced>('/api/account/advanced');
    box.innerHTML = renderAdvanced(d);
    renderRegime(d.regime);
  } catch (e) {
    advancedKey = '';
    box.innerHTML = `<p class="form-hint negative">Không tính được: ${esc((e as Error).message)}</p>`;
  }
}

// ---------- forecast track record ----------

export async function loadForecastScore() {
  const box = $('forecastScore');
  if (!box) return;
  try {
    const s = await getJson<{ scored: number; pending: number; coverage90_pct?: number; coverage50_pct?: number; brier?: number; verdict?: string; rows: Array<{ date: string; ticker: string; price: number; realised: number; in90: boolean; prob_up: number; went_up: boolean }> }>('/api/account/forecast/score');
    if (!s.scored) {
      box.innerHTML = `<p class="form-hint">Chấm điểm dự báo: đã lưu ${s.pending} dự báo 1 tháng, sẽ có kết quả sau ~30 ngày. Mỗi tuần app tự lưu một bản để đối chiếu với giá thật.</p>`;
      return;
    }
    box.innerHTML = `<div class="acc-card"><strong>Dự báo có đúng không? (${s.scored} lần đã có kết quả)</strong>
      <dl><div><dt>Giá thật nằm trong vùng 90%</dt><dd>${s.coverage90_pct}% <small>(nên ≈ 90%)</small></dd></div>
      <div><dt>Giá thật nằm trong vùng 50%</dt><dd>${s.coverage50_pct}% <small>(nên ≈ 50%)</small></dd></div>
      <div><dt>Brier score xác suất tăng</dt><dd>${s.brier} <small>(0.25 = tung đồng xu)</small></dd></div></dl>
      <p class="plan-note">${esc(s.verdict || '')}</p></div>`;
  } catch { box.innerHTML = ''; }
}

// ---------- tools tab ----------

type Alternatives = {
  universe_size: number; note: string;
  replacements: Array<{ ticker: string; sector: string | null; candidates: Candidate[] }>;
  diversifiers: Candidate[]; top: Candidate[];
};
type Candidate = { ticker: string; sector: string | null; name: string | null; price: number; momentum_6m_pct: number; vs_ma200_pct: number; corr_with_portfolio: number | null; analyst_upside_pct: number | null; rating: string | null; score: number };

const candRow = (c: Candidate) => `<tr><td><strong>${esc(c.ticker)}</strong><small> ${esc(c.sector || '')}</small></td><td>${vnd(c.price)}</td><td>${pct(c.momentum_6m_pct)}</td><td>${pct(c.vs_ma200_pct)}</td><td>${c.corr_with_portfolio ?? '—'}</td><td>${pct(c.analyst_upside_pct)}</td><td><button class="table-action" data-check-ticker="${esc(c.ticker)}" data-check-price="${c.price}">Kiểm tra</button></td></tr>`;
const candTable = (rows: Candidate[]) => rows.length ? `<div class="portfolio-table-wrap"><table class="portfolio-table"><thead><tr><th>Mã</th><th>Giá</th><th>Momentum 6T</th><th>So MA200</th><th>Tương quan</th><th>Upside NPT</th><th></th></tr></thead><tbody>${rows.map(candRow).join('')}</tbody></table></div>` : '<p class="form-hint">Không có ứng viên đạt tiêu chí (momentum và xu hướng dương).</p>';

async function findAlternatives() {
  const out = $('altOut');
  if (!out) return;
  out.innerHTML = '<p class="form-hint">Đang quét VN30 + mã thanh khoản cao (có thể mất ~30–60 giây)…</p>';
  try {
    const d = await getJson<Advanced>('/api/account/advanced?alternatives=true');
    const a = d.alternatives!;
    out.innerHTML = `${a.replacements.length ? a.replacements.map(r => `<p class="plan-note"><b>Thay cho ${esc(r.ticker)}</b> (${esc(r.sector || 'chưa rõ ngành')}) — đang lỗ quá 7% hoặc giá dưới MA200. Ứng viên cùng ngành:</p>${candTable(r.candidates)}`).join('') : '<p class="plan-note">Không có mã nào trong danh mục đang yếu (lỗ quá 7% hoặc dưới MA200).</p>'}
      <p class="plan-note"><b>Mã giúp đa dạng hóa</b> (tương quan thấp nhất với danh mục, đang uptrend):</p>${candTable(a.diversifiers)}
      <p class="form-hint">${esc(a.note)} Đã chấm ${a.universe_size} mã. Bấm "Kiểm tra" để chạy phiếu kiểm tra trước khi mua.</p>`;
    out.querySelectorAll<HTMLElement>('[data-check-ticker]').forEach(b => b.addEventListener('click', () => {
      ($('ptTicker') as HTMLInputElement).value = b.dataset.checkTicker!;
      ($('ptPrice') as HTMLInputElement).value = String(Math.round(Number(b.dataset.checkPrice)) / 1000);
      ($('ptStop') as HTMLInputElement).focus();
      $('ptForm')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }));
  } catch (e) {
    out.innerHTML = `<p class="form-hint negative">Không quét được: ${esc((e as Error).message)}</p>`;
  }
}

type PretradeResult = { ticker: string; price: number; stop: number; target: number | null; verdict: string; checks: Array<{ status: string; name: string; text: string }>; sizing: { chosen_shares: number; risk_pct_nav: number; value: number } | null };
let lastCheck: PretradeResult | null = null;

async function runPretrade(event: Event) {
  event.preventDefault();
  const out = $('ptOut');
  if (!out) return;
  const num = (id: string) => { const v = ($(id) as HTMLInputElement).value.trim(); return v ? Number(v) : null; };
  const ticker = ($('ptTicker') as HTMLInputElement).value.trim().toUpperCase();
  const body = { ticker, price: num('ptPrice'), stop: num('ptStop'), target: num('ptTarget'), quantity: num('ptQty') };
  if (!/^[A-Z0-9]{1,6}$/.test(ticker) || !body.price || !body.stop) { out.innerHTML = '<p class="form-hint negative">Nhập mã, giá mua và stop-loss.</p>'; return; }
  out.innerHTML = '<p class="form-hint">Đang kiểm tra…</p>';
  try {
    const r = await getJson<PretradeResult>('/api/account/pretrade', { method: 'POST', body: JSON.stringify(body) });
    const council = getCouncilVerdict(ticker);
    if (council) {
      const status = council.action === 'MUA' ? 'PASS' : council.action === 'BÁN' ? 'FAIL' : 'WARN';
      r.checks.push({ status, name: 'Hội đồng AI', text: `Phán quyết gần nhất: ${council.action} (${new Date(council.timestamp).toLocaleDateString('vi-VN')}).` });
      if (status === 'FAIL') r.verdict = 'KHÔNG ĐẠT';
    } else {
      r.checks.push({ status: 'WARN', name: 'Hội đồng AI', text: 'Chưa chạy Hội đồng AI cho mã này.' });
    }
    lastCheck = r;
    out.innerHTML = `<div class="pt-verdict"><span class="plan-action ${VERDICT_TONE[r.verdict] || ''}">${esc(r.verdict)}</span>${r.sizing ? ` <span class="plan-note">${vnd(r.sizing.chosen_shares)} cp · ~${vnd(r.sizing.chosen_shares * r.price)} đ · rủi ro ${r.sizing.risk_pct_nav}% NAV</span>` : ''}</div>
      <ul class="pt-checks">${r.checks.map(c => `<li><span class="plan-action ${STATUS_TONE[c.status]}">${c.status === 'PASS' ? 'ĐẠT' : c.status === 'WARN' ? 'LƯU Ý' : 'KHÔNG'}</span><b>${esc(c.name)}</b><span>${esc(c.text)}</span></li>`).join('')}</ul>
      <div class="plan-alerts"><button class="btn-ghost" id="ptSave" type="button">Lưu kế hoạch vào nhật ký</button><span id="ptSaveMsg" class="form-hint"></span></div>`;
    $('ptSave')?.addEventListener('click', savePlan);
  } catch (e) {
    out.innerHTML = `<p class="form-hint negative">${esc((e as Error).message)}</p>`;
  }
}

async function savePlan() {
  if (!lastCheck) return;
  const msg = $('ptSaveMsg');
  const reason = ($('ptReason') as HTMLSelectElement).value || null;
  const note = ($('ptNote') as HTMLInputElement).value;
  try {
    await getJson('/api/account/pretrade/plan', { method: 'POST', body: JSON.stringify({ ticker: lastCheck.ticker, price: lastCheck.price, stop: lastCheck.stop, target: lastCheck.target, quantity: lastCheck.sizing?.chosen_shares, reason, note, verdict: lastCheck.verdict }) });
    if (msg) msg.textContent = ' Đã lưu. Khi lệnh mua khớp và bạn đồng bộ, lý do này tự gắn vào giao dịch.';
  } catch (e) {
    if (msg) msg.textContent = ` ${(e as Error).message}`;
  }
}

async function loadRulesEditor() {
  const box = $('rulesEditor');
  if (!box) return;
  const r = await getJson<{ rules: Record<string, number | boolean>; tags: string[] }>('/api/account/rules');
  tags = r.tags || [];
  const reason = $('ptReason') as HTMLSelectElement | null;
  if (reason) reason.innerHTML = `<option value="">— lý do mua —</option>${tags.map(t => `<option>${esc(t)}</option>`).join('')}`;
  box.innerHTML = `<form id="rulesForm" class="rules-form">${Object.entries(r.rules).map(([k, v]) => typeof v === 'boolean'
    ? `<label class="rule-check"><input type="checkbox" name="${k}" ${v ? 'checked' : ''}> ${esc(RULE_LABELS[k] || k)}</label>`
    : `<label>${esc(RULE_LABELS[k] || k)}<input type="number" name="${k}" value="${v}" step="${k === 'max_positions' ? 1 : 0.5}"></label>`).join('')}
    <button class="btn-ghost" type="submit">Lưu quy tắc</button><span id="rulesMsg" class="form-hint"></span></form>`;
  $('rulesForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const update: Record<string, number | boolean> = {};
    form.querySelectorAll<HTMLInputElement>('input').forEach(i => { update[i.name] = i.type === 'checkbox' ? i.checked : Number(i.value); });
    try {
      await getJson('/api/account/rules', { method: 'POST', body: JSON.stringify(update) });
      $('rulesMsg')!.textContent = ' Đã lưu.';
    } catch (err) {
      $('rulesMsg')!.textContent = ` ${(err as Error).message}`;
    }
  });
}

async function loadAutosync() {
  const box = $('autosyncBox');
  if (!box) return;
  try {
    const s = await getJson<{ installed: boolean; times: string[]; telegram_configured: boolean; log: string[] }>('/api/account/autosync');
    box.innerHTML = `<dl class="acc-dl"><div><dt>Tự đồng bộ (${s.times.join(' & ')}, thứ 2–6)</dt><dd>${s.installed ? '<span class="positive">Đang bật</span>' : 'Tắt'}</dd></div>
      <div><dt>Telegram</dt><dd>${s.telegram_configured ? '<span class="positive">Đã cấu hình</span>' : 'Chưa cấu hình'}</dd></div></dl>
      <div class="plan-alerts"><button class="btn-ghost" id="autosyncToggle" type="button">${s.installed ? 'Tắt tự đồng bộ' : 'Bật tự đồng bộ'}</button><button class="btn-ghost" id="notifyTest" type="button">Gửi thông báo thử</button><span id="autosyncMsg" class="form-hint"></span></div>
      ${s.telegram_configured ? '' : '<p class="form-hint">Để nhận cảnh báo trên điện thoại: tạo bot với @BotFather, nhắn cho bot một tin, lấy chat id tại api.telegram.org/bot&lt;token&gt;/getUpdates, rồi thêm TELEGRAM_BOT_TOKEN và TELEGRAM_CHAT_ID vào .env.local và khởi động lại backend. Chưa có Telegram thì app vẫn hiện thông báo macOS.</p>'}
      <p class="form-hint">Buổi sáng nhập OTP một lần (token dùng 8 giờ); job sẽ đồng bộ, gửi cảnh báo chạm stop/mục tiêu, biến động tăng vọt, margin, vi phạm quy tắc, sự kiện cổ tức và tự tạo báo cáo tuần vào thứ Sáu. Tin gửi đi chỉ có mã, giá và %, không có số tài khoản hay NAV.</p>
      ${s.log.length ? `<details><summary>Nhật ký chạy gần nhất</summary><pre class="autosync-log">${s.log.map(esc).join('\n')}</pre></details>` : ''}`;
    $('autosyncToggle')?.addEventListener('click', async () => {
      try { await getJson('/api/account/autosync', { method: 'POST', body: JSON.stringify({ enable: !s.installed }) }); loadAutosync(); }
      catch (e) { $('autosyncMsg')!.textContent = ` ${(e as Error).message}`; }
    });
    $('notifyTest')?.addEventListener('click', async () => {
      const r = await getJson<{ sent: number; telegram?: string }>('/api/account/notify/test', { method: 'POST' });
      $('autosyncMsg')!.textContent = ` Đã gửi (Telegram: ${r.telegram === 'ok' ? 'thành công' : r.telegram === 'not configured' ? 'chưa cấu hình' : r.telegram}).`;
    });
  } catch (e) {
    box.innerHTML = `<p class="form-hint negative">${esc((e as Error).message)}</p>`;
  }
}

export function loadTools(syncedAt: string) {
  const box = $('accTools');
  if (!box || syncedAt === toolsKey) return;
  toolsKey = syncedAt;
  box.hidden = false;
  box.innerHTML = `
    <section class="insight-block"><h4>Phiếu kiểm tra trước khi mua</h4>
      <form id="ptForm" class="pt-form">
        <label>Mã<input id="ptTicker" maxlength="6" placeholder="VNM" required></label>
        <label>Giá mua<input id="ptPrice" type="number" step="0.05" min="0" placeholder="60.5" required></label>
        <label>Stop-loss<input id="ptStop" type="number" step="0.05" min="0" placeholder="56" required></label>
        <label>Mục tiêu<input id="ptTarget" type="number" step="0.05" min="0" placeholder="70"></label>
        <label>Số lượng<input id="ptQty" type="number" step="100" min="0" placeholder="tự tính"></label>
        <label>Lý do<select id="ptReason"><option value="">— lý do mua —</option></select></label>
        <label class="wide">Ghi chú<input id="ptNote" maxlength="300" placeholder="VD: về vùng hỗ trợ MA200, khối lượng cạn"></label>
        <button class="btn-ghost" type="submit">Kiểm tra</button>
      </form>
      <p class="form-hint">Giá nhập theo nghìn đồng (60.5 = 60.500 đ). Để trống số lượng để app tự tính theo quy tắc rủi ro.</p>
      <div id="ptOut"></div>
    </section>
    <section class="insight-block"><h4>Tìm mã thay thế &amp; đa dạng hóa</h4>
      <div class="plan-alerts"><button class="btn-ghost" id="altFind" type="button">Quét ứng viên</button></div>
      <div id="altOut"></div>
    </section>
    <section class="insight-block"><h4>Quy tắc cá nhân</h4><div id="rulesEditor"></div></section>
    <section class="insight-block"><h4>Tự đồng bộ &amp; thông báo</h4><div id="autosyncBox"></div></section>`;
  $('ptForm')?.addEventListener('submit', runPretrade);
  $('altFind')?.addEventListener('click', findAlternatives);
  loadRulesEditor().catch(() => { /* shown as empty */ });
  loadAutosync();
}
