// TraderAI - Multi-Agent Investment Council Component
// Inspired by TauricResearch/TradingAgents, adapted for Vietnam Stock Market

import { dataSourceStatus, fetchAgentCouncilAnalysis, fetchTopStocks, streamAgentCouncil } from '../api/stockApi';
import type {
  AgentCouncilContext,
  AgentCouncilEvent,
  AgentCouncilRequest,
  AgentCouncilResult,
  AgentCouncilVerdict,
  AgentRole,
} from '../api/stockApi';

const KEY_STORAGE = 'traderai_llm_key';
const PROVIDER_STORAGE = 'traderai_llm_provider';
// Shown until today's live top stocks load (see loadTodayQuickTickers)
const QUICK_TICKERS = ['HPG', 'FPT', 'VNM', 'SSI', 'MWG', 'TCB'];

let currentCouncilTicker = 'HPG';
let isAnalyzing = false;
let activeController: AbortController | null = null;

const AGENT_META: Record<AgentRole, { avatar: string; title: string; subtitle: string; step: string }> = {
  technical: { avatar: '📈', title: 'Chuyên gia Phân tích Kỹ thuật', subtitle: 'MA20/50/200, RSI, MACD, Bollinger, Khối lượng', step: 'step-tech' },
  fundamental: { avatar: '📑', title: 'Chuyên viên Phân tích Cơ bản', subtitle: 'BCTC VAS, P/E, P/B, ROE & Sức khỏe tài chính', step: 'step-fund' },
  sentiment: { avatar: '📰', title: 'Chuyên viên Tin tức & Dòng tiền', subtitle: 'Tin tức, Giao dịch khối ngoại, VN-Index', step: 'step-sent' },
  bull: { avatar: '🐂', title: 'Phe Bò (Bull Analyst)', subtitle: 'Luận điểm TĂNG GIÁ', step: 'step-debate' },
  bear: { avatar: '🐻', title: 'Phe Gấu (Bear Analyst)', subtitle: 'Phản biện RỦI RO & T+2.5', step: 'step-debate' },
  portfolio_manager: { avatar: '👔', title: 'Quản lý Quỹ', subtitle: 'Phán quyết cuối cùng', step: 'step-verdict' },
};

// ===========================
// Storage helpers (localStorage may be unavailable, e.g. private mode)
// ===========================

function readStorage(key: string, fallback = ''): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeStorage(key: string, value: string) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch { /* ignore */ }
}

// ===========================
// Public API
// ===========================

export function initAgentCouncil() {
  const container = document.getElementById('agentCouncilSection');
  if (!container) return;

  renderCouncilSkeleton(container);
  bindCouncilEvents();
  loadTodayQuickTickers();
}

/** Replace the placeholder chips with today's top-ranked stocks from the live market board. */
async function loadTodayQuickTickers() {
  try {
    const top = await fetchTopStocks(8);
    if (dataSourceStatus.stocks !== 'real') return; // keep placeholders rather than show mock picks
    const tickers = [...new Set(top.map((s: any) => s.ticker).filter(Boolean))].slice(0, 8) as string[];
    const wrap = document.getElementById('quickCouncilTickers');
    if (!wrap || tickers.length === 0) return;

    if (!isAnalyzing && !tickers.includes(currentCouncilTicker)) {
      currentCouncilTicker = tickers[0];
      const input = document.getElementById('councilTickerInput') as HTMLInputElement | null;
      if (input) input.value = currentCouncilTicker;
    }
    wrap.innerHTML = `<span class="quick-label">🔥 Top hôm nay:</span>` + tickers
      .map(t => `<button class="chip" data-ticker="${escapeHtml(t)}">${escapeHtml(t)}</button>`)
      .join('');
    bindQuickChips();
    syncQuickChips();
  } catch {
    /* keep placeholder chips */
  }
}

function bindQuickChips() {
  const input = document.getElementById('councilTickerInput') as HTMLInputElement | null;
  document.querySelectorAll<HTMLButtonElement>('#quickCouncilTickers .chip').forEach(chip => {
    chip.addEventListener('click', () => {
      currentCouncilTicker = chip.dataset.ticker || 'HPG';
      if (input) input.value = currentCouncilTicker;
      syncQuickChips();
      startCouncilAnalysis();
    });
  });
}

export function openCouncilForTicker(ticker: string) {
  currentCouncilTicker = ticker.toUpperCase().trim();
  const input = document.getElementById('councilTickerInput') as HTMLInputElement | null;
  if (input) input.value = currentCouncilTicker;
  syncQuickChips();

  document.getElementById('agentCouncilSection')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  startCouncilAnalysis();
}

// ===========================
// Rendering
// ===========================

function renderCouncilSkeleton(container: HTMLElement) {
  const savedKey = readStorage(KEY_STORAGE);
  const savedProvider = readStorage(PROVIDER_STORAGE, 'gemini');

  container.innerHTML = `
    <div class="container">
      <div class="section-header">
        <div class="council-header-title">
          <h2 class="section-title">
            <span class="section-icon">🏛️</span>
            Hội Đồng Đầu Tư AI (Multi-Agent Council)
          </h2>
          <span class="council-badge">Kiến trúc TradingAgents • Chuẩn TTCK Việt Nam</span>
        </div>
      </div>
      <p class="section-subtitle">
        Mô phỏng hội đồng quản lý quỹ gồm các chuyên gia AI độc lập: Kỹ thuật, Cơ bản, Dòng tiền & Tin tức, tranh biện Phe Bò vs Phe Gấu, và Quản lý quỹ ra quyết định theo quy chuẩn T+2.5.
      </p>

      <div class="council-controls-bar">
        <div class="council-inputs">
          <div class="council-ticker-box">
            <label for="councilTickerInput">Mã Cổ Phiếu:</label>
            <div class="ticker-input-wrapper">
              <input type="text" id="councilTickerInput" value="${escapeHtml(currentCouncilTicker)}" placeholder="VD: HPG, FPT..." maxlength="10" autocomplete="off" />
            </div>
          </div>

          <div class="quick-tickers" id="quickCouncilTickers">
            ${QUICK_TICKERS.map(t => `<button class="chip${t === currentCouncilTicker ? ' active' : ''}" data-ticker="${t}">${t}</button>`).join('')}
          </div>
        </div>

        <div class="council-actions">
          <button class="btn-config-key" id="toggleApiKeyConfig" title="Cài đặt LLM API Key (Gemini / OpenAI)">
            ⚙️ Cấu hình LLM <span class="council-key-dot${savedKey ? ' on' : ''}" id="councilKeyDot"></span>
          </button>
          <button class="btn-run-council" id="startCouncilBtn">
            <span class="run-icon">🚀</span> Triệu tập Hội Đồng
          </button>
        </div>
      </div>

      <div class="api-key-drawer" id="apiKeyDrawer" hidden>
        <div class="drawer-inner">
          <div class="drawer-header">
            <h4>⚙️ Nhà cung cấp LLM (tùy chọn)</h4>
            <span class="drawer-hint">Không có API Key? Hệ thống dùng key trong <code>backend/.env</code> nếu có, hoặc tự chạy chế độ Định lượng Heuristic. Key chỉ lưu trong trình duyệt này.</span>
          </div>
          <div class="drawer-form">
            <div class="form-group">
              <label for="councilProviderSelect">Nhà cung cấp:</label>
              <select id="councilProviderSelect">
                <option value="gemini" ${savedProvider === 'gemini' ? 'selected' : ''}>Google Gemini 2.5 Flash</option>
                <option value="openai" ${savedProvider === 'openai' ? 'selected' : ''}>OpenAI GPT-4o mini</option>
              </select>
            </div>
            <div class="form-group flex-1">
              <label for="councilApiKeyInput">API Key cá nhân:</label>
              <input type="password" id="councilApiKeyInput" value="${escapeHtml(savedKey)}" placeholder="Dán Gemini hoặc OpenAI API Key..." autocomplete="off" />
            </div>
            <button class="btn-save-key" id="saveApiKeyBtn">Lưu</button>
          </div>
          <div class="drawer-hint" id="apiKeySavedMsg" aria-live="polite"></div>
        </div>
      </div>

      <div class="council-workspace" id="councilWorkspace">
        <div class="council-empty-state">
          <div class="empty-icon">👥</div>
          <h3>Sẵn sàng phân tích cổ phiếu</h3>
          <p>Chọn một mã cổ phiếu và bấm <strong>"Triệu tập Hội Đồng"</strong> để khởi động phiên tranh luận đa chiều.</p>
        </div>
      </div>
    </div>
  `;
}

function bindCouncilEvents() {
  const input = document.getElementById('councilTickerInput') as HTMLInputElement | null;
  const drawer = document.getElementById('apiKeyDrawer');
  const keyInput = document.getElementById('councilApiKeyInput') as HTMLInputElement | null;
  const providerSelect = document.getElementById('councilProviderSelect') as HTMLSelectElement | null;

  const runFromInput = () => {
    if (input) currentCouncilTicker = input.value.toUpperCase().trim() || 'HPG';
    syncQuickChips();
    startCouncilAnalysis();
  };

  document.getElementById('startCouncilBtn')?.addEventListener('click', runFromInput);
  input?.addEventListener('keydown', e => {
    if (e.key === 'Enter') runFromInput();
  });

  document.getElementById('toggleApiKeyConfig')?.addEventListener('click', () => {
    if (drawer) drawer.hidden = !drawer.hidden;
  });

  document.getElementById('saveApiKeyBtn')?.addEventListener('click', () => {
    const key = keyInput?.value.trim() ?? '';
    writeStorage(KEY_STORAGE, key);
    if (providerSelect) writeStorage(PROVIDER_STORAGE, providerSelect.value);
    document.getElementById('councilKeyDot')?.classList.toggle('on', !!key);
    const msg = document.getElementById('apiKeySavedMsg');
    if (msg) msg.textContent = key ? '✓ Đã lưu cấu hình LLM.' : '✓ Đã xóa API key — dùng key backend hoặc chế độ Heuristic.';
  });

  bindQuickChips();
}

function syncQuickChips() {
  document.querySelectorAll<HTMLButtonElement>('#quickCouncilTickers .chip').forEach(chip => {
    chip.classList.toggle('active', chip.dataset.ticker === currentCouncilTicker);
  });
}

function setRunButton(running: boolean) {
  const btn = document.getElementById('startCouncilBtn') as HTMLButtonElement | null;
  if (!btn) return;
  btn.disabled = running;
  btn.innerHTML = running
    ? `<span class="spinner small"></span> Đang tranh biện...`
    : `<span class="run-icon">🚀</span> Triệu tập Hội Đồng`;
}

function renderDeliberationShell(ticker: string) {
  const workspace = document.getElementById('councilWorkspace');
  if (!workspace) return;

  const steps: [string, string][] = [
    ['step-tech', 'Kỹ Thuật'],
    ['step-fund', 'Cơ Bản (VAS)'],
    ['step-sent', 'Tin Tức & Dòng Tiền'],
    ['step-debate', 'Tranh Biện Bull vs Bear'],
    ['step-verdict', 'Quản Lý Quỹ (T+2.5)'],
  ];

  workspace.innerHTML = `
    <div class="council-deliberation">
      <div class="deliberation-status">
        <div class="status-pulse" id="statusPulse"></div>
        <span class="status-text" id="statusMsg">Khởi tạo dữ liệu thị trường cho ${escapeHtml(ticker)}...</span>
        <span class="council-mode-badge" id="councilModeBadge" hidden></span>
      </div>

      <div class="agent-steps-grid">
        ${steps.map(([id, role], i) => `
          <div class="agent-step-item" id="${id}">
            <span class="step-num">${i + 1}</span>
            <span class="step-role">${role}</span>
            <span class="step-state">Chờ</span>
          </div>`).join('')}
      </div>

      <div class="council-context-strip" id="councilContext" hidden></div>
      <div class="council-feed" id="councilFeed">
        <div class="feed-placeholder">Đang kết nối hội đồng AI...</div>
      </div>
    </div>
  `;
}

// ===========================
// Analysis flow
// ===========================

async function startCouncilAnalysis() {
  if (isAnalyzing) return;
  isAnalyzing = true;
  setRunButton(true);

  const ticker = currentCouncilTicker;
  const request: AgentCouncilRequest = {
    ticker,
    provider: readStorage(PROVIDER_STORAGE, 'gemini'),
    apiKey: readStorage(KEY_STORAGE) || undefined,
  };

  renderDeliberationShell(ticker);
  activeController?.abort();
  const controller = new AbortController();
  activeController = controller;

  let receivedEvents = false;
  let finished = false;
  try {
    await streamAgentCouncil(
      request,
      event => {
        receivedEvents = true;
        if (event.type === 'final_verdict' || event.type === 'error') finished = true;
        handleStreamEvent(event, ticker);
      },
      controller.signal
    );
    if (!finished) showError('Kết nối bị ngắt trước khi hội đồng đưa ra phán quyết. Vui lòng thử lại.');
  } catch (err) {
    if (controller.signal.aborted) return;
    if (receivedEvents) {
      // The stream started then broke — don't re-run the whole council, just report it.
      showError(`Kết nối bị ngắt giữa phiên: ${errorMessage(err)}`);
    } else {
      // Streaming unavailable (proxy / serverless) — fall back to a single request.
      try {
        renderFullCouncilResult(await fetchAgentCouncilAnalysis(request));
      } catch (fallbackErr) {
        showError(errorMessage(fallbackErr));
      }
    }
  } finally {
    if (activeController === controller) activeController = null;
    isAnalyzing = false;
    setRunButton(false);
    stopPulse();
  }
}

function handleStreamEvent(event: AgentCouncilEvent, ticker: string) {
  const statusMsg = document.getElementById('statusMsg');
  const feed = document.getElementById('councilFeed');
  if (!feed) return;

  switch (event.type) {
    case 'status':
      if (statusMsg) statusMsg.textContent = event.message;
      break;
    case 'context':
      renderContextStrip(event.data);
      break;
    case 'mode':
      renderModeBadge(event.mode, event.model);
      break;
    case 'agent_start':
      if (statusMsg) statusMsg.textContent = `Đang lắng nghe: ${event.name}...`;
      markStep(event.agent, 'active');
      break;
    case 'agent_done':
      appendAgentReport(feed, event.agent, event.content, event.engine);
      if (event.agent !== 'bull') markStep(event.agent, 'completed');
      break;
    case 'final_verdict':
      markStep('portfolio_manager', 'completed');
      if (statusMsg) statusMsg.textContent = `✅ Hội đồng đã hoàn tất phiên tranh luận cho ${ticker}`;
      feed.appendChild(buildVerdictCard(event.structured, event.content, event.engine));
      break;
    case 'warning':
      feed.appendChild(buildNotice(event.message, 'warning'));
      renderModeBadge('heuristic', null);
      break;
    case 'error':
      showError(event.message);
      break;
  }
}

function markStep(agent: AgentRole, state: 'active' | 'completed') {
  const el = document.getElementById(AGENT_META[agent].step);
  if (!el) return;
  el.classList.toggle('active', state === 'active');
  el.classList.toggle('completed', state === 'completed');
  const label = el.querySelector('.step-state');
  if (label) label.textContent = state === 'active' ? 'Đang phân tích...' : '✓ Hoàn thành';
}

function stopPulse() {
  document.getElementById('statusPulse')?.classList.add('idle');
}

function showError(message: string) {
  const feed = document.getElementById('councilFeed');
  if (!feed) return;
  feed.querySelector('.feed-placeholder')?.remove();
  feed.appendChild(buildNotice(`⚠️ ${message}`, 'error'));
  const statusMsg = document.getElementById('statusMsg');
  if (statusMsg) statusMsg.textContent = 'Phiên phân tích không hoàn tất.';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Không thể kết nối hội đồng AI.';
}

function renderModeBadge(mode: 'llm' | 'heuristic', model: string | null) {
  const badge = document.getElementById('councilModeBadge');
  if (!badge) return;
  badge.hidden = false;
  badge.className = `council-mode-badge ${mode}`;
  badge.textContent = mode === 'llm' ? `🧠 ${model ?? 'LLM'}` : '🧮 Heuristic';
  badge.title = mode === 'llm'
    ? 'Các agent được vận hành bởi mô hình ngôn ngữ lớn'
    : 'Chưa có LLM API key (hoặc LLM lỗi) — báo cáo sinh từ mô hình định lượng';
}

function renderContextStrip(ctx: AgentCouncilContext) {
  const el = document.getElementById('councilContext');
  if (!el) return;
  el.hidden = false;
  el.innerHTML = buildContextItems(ctx);
}

function buildContextItems(ctx: AgentCouncilContext): string {
  const num = (v: number | null | undefined, suffix = '') => (v == null ? 'N/A' : `${v.toLocaleString('vi-VN')}${suffix}`);
  const change = ctx.change_5d ?? 0;
  const items: [string, string, string?][] = [
    ['Mã', `${ctx.ticker}${ctx.company_name ? ` · ${ctx.company_name}` : ''}`],
    ['Sàn', `${ctx.exchange ?? 'N/A'} ±${ctx.price_limit_pct ?? 7}%`],
    ['Giá', `${num(ctx.price, ' đ')}`, change >= 0 ? 'text-green' : 'text-red'],
    ['5 phiên', `${change >= 0 ? '+' : ''}${change}%`, change >= 0 ? 'text-green' : 'text-red'],
    ['Trần / Sàn', `${num(ctx.ceiling)} / ${num(ctx.floor)}`],
    ['RSI', num(ctx.rsi)],
    ['P/E · ROE', `${num(ctx.pe, 'x')} · ${num(ctx.roe, '%')}`],
    ['Khối ngoại', ctx.foreign_flow ?? 'N/A'],
  ];
  return items
    .map(([label, value, cls]) => `
      <div class="ctx-item">
        <span class="ctx-label">${label}</span>
        <span class="ctx-value ${cls ?? ''}">${escapeHtml(value)}</span>
      </div>`)
    .join('');
}

function agentCardHtml(agent: AgentRole, content: string, engine?: string): string {
  const meta = AGENT_META[agent];
  return `
    <div class="agent-card-header">
      <div class="agent-avatar">${meta.avatar}</div>
      <div class="agent-meta">
        <h4 class="agent-title">${meta.title}</h4>
        <span class="agent-sub">${meta.subtitle}</span>
      </div>
      ${engine ? `<span class="agent-engine">${escapeHtml(engine === 'heuristic' ? 'heuristic' : engine.split(':').pop() ?? engine)}</span>` : ''}
    </div>
    <div class="agent-card-body">${formatMarkdownText(content)}</div>
  `;
}

function appendAgentReport(feed: HTMLElement, agent: AgentRole, content: string, engine: string) {
  feed.querySelector('.feed-placeholder')?.remove();

  // Bull and Bear share one side-by-side debate arena
  if (agent === 'bull' || agent === 'bear') {
    let arena = feed.querySelector<HTMLElement>('.debate-arena');
    if (!arena) {
      arena = document.createElement('div');
      arena.className = 'debate-arena fade-in';
      arena.innerHTML = `
        <div class="agent-card agent-bull debate-slot" data-slot="bull"><div class="feed-placeholder">🐂 Phe Bò đang chuẩn bị luận điểm...</div></div>
        <div class="agent-card agent-bear debate-slot" data-slot="bear"><div class="feed-placeholder">🐻 Phe Gấu đang chờ phản biện...</div></div>
      `;
      feed.appendChild(arena);
    }
    const slot = arena.querySelector<HTMLElement>(`[data-slot="${agent}"]`);
    if (slot) slot.innerHTML = agentCardHtml(agent, content, engine);
    arena.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return;
  }

  const card = document.createElement('div');
  card.className = `agent-card agent-${agent} fade-in`;
  card.innerHTML = agentCardHtml(agent, content, engine);
  feed.appendChild(card);
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function buildNotice(message: string, kind: 'warning' | 'error'): HTMLElement {
  const el = document.createElement('div');
  el.className = `council-error council-${kind}`;
  el.textContent = message;
  return el;
}

function buildVerdictCard(v: AgentCouncilVerdict, raw: string, engine?: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'verdict-card fade-in';
  const actionClass = v.action === 'MUA' ? 'action-buy' : v.action === 'BÁN' ? 'action-sell' : 'action-hold';

  card.innerHTML = `
    <div class="verdict-header">
      <div class="verdict-title-box">
        <span class="verdict-badge">👔 PHÁN QUYẾT HỘI ĐỒNG ĐẦU TƯ${engine ? ` · ${escapeHtml(engine)}` : ''}</span>
        <h3 class="verdict-title">Quyết định Quản lý Quỹ & Quản trị Rủi ro (T+2.5)</h3>
      </div>
      <div class="verdict-action-tag ${actionClass}">${escapeHtml(v.action)}</div>
    </div>

    <div class="verdict-grid">
      <div class="verdict-metric">
        <span class="metric-label">🎯 Vùng Giá Gom</span>
        <span class="metric-val text-green">${escapeHtml(v.entry_zone)}</span>
      </div>
      <div class="verdict-metric">
        <span class="metric-label">🚀 Giá Mục Tiêu</span>
        <span class="metric-val text-blue">${escapeHtml(v.target_price)}</span>
      </div>
      <div class="verdict-metric">
        <span class="metric-label">🛑 Cắt Lỗ</span>
        <span class="metric-val text-red">${escapeHtml(v.stop_loss)}</span>
      </div>
      <div class="verdict-metric">
        <span class="metric-label">⚖️ Tỷ Trọng</span>
        <span class="metric-val">${escapeHtml(v.sizing)}</span>
      </div>
    </div>

    <div class="verdict-summary">
      <h4>📌 Chiến lược · Rủi ro: ${escapeHtml(v.risk_level)}</h4>
      <p>${formatMarkdownText(v.summary || raw)}</p>
    </div>
    <p class="council-disclaimer">Phân tích tự động mang tính tham khảo, không phải khuyến nghị đầu tư.</p>
  `;
  return card;
}

/** Non-streaming fallback: render the complete result at once. */
function renderFullCouncilResult(res: AgentCouncilResult) {
  const feed = document.getElementById('councilFeed');
  if (!feed) return;
  feed.innerHTML = '';

  renderContextStrip(res.context);
  renderModeBadge(res.mode, null);
  for (const agent of ['technical', 'fundamental', 'sentiment', 'bull', 'bear'] as const) {
    const content = res.reports[agent];
    if (!content) continue;
    appendAgentReport(feed, agent, content, res.engines?.[agent] ?? '');
    markStep(agent, 'completed');
  }
  res.warnings?.forEach(w => feed.appendChild(buildNotice(w, 'warning')));
  if (res.verdict?.structured) {
    feed.appendChild(buildVerdictCard(res.verdict.structured, res.verdict.raw, res.engines?.portfolio_manager));
    markStep('portfolio_manager', 'completed');
  }
  const statusMsg = document.getElementById('statusMsg');
  if (statusMsg) statusMsg.textContent = `✅ Đã hoàn thành phiên phân tích cho ${res.ticker}`;
}

// ===========================
// Text formatting
// ===========================

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Minimal markdown (bold, italic, line breaks). LLM output is untrusted, so escape first. */
export function formatMarkdownText(text: string): string {
  if (!text) return '';
  return escapeHtml(text)
    .replace(/^#{1,6}\s*(.+)$/gm, '<strong>$1</strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .replace(/\n/g, '<br/>');
}
