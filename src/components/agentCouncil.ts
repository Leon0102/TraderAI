// TraderAI - Multi-Agent Investment Council Component
// Inspired by TauricResearch/TradingAgents, adapted for Vietnam Stock Market

import { dataSourceStatus, fetchAgentCouncilAnalysis, fetchTopStocks, streamAgentCouncil } from '../api/stockApi';
import { getAccount, sizingText } from './accountStore';
import type {
  AgentCouncilContext,
  AgentCouncilEvent,
  AgentCouncilRequest,
  AgentCouncilResult,
  AgentCouncilVerdict,
  AgentRole,
  CorporateEvent,
} from '../api/stockApi';

export interface SectorInfo {
  id: string;
  label: string;
  tickers: string[];
}

export const SECTORS: SectorInfo[] = [
  { id: 'ALL', label: '🔥 Top Ngày', tickers: ['HPG', 'FPT', 'VNM', 'SSI', 'MWG', 'TCB'] },
  { id: 'BANK', label: '🏦 Ngân Hàng', tickers: ['VCB', 'TCB', 'MBB', 'ACB', 'CTG', 'VPB', 'STB'] },
  { id: 'STEEL', label: '🏗️ Thép', tickers: ['HPG', 'NKG', 'HSG', 'VGS'] },
  { id: 'REALESTATE', label: '🏢 BĐS', tickers: ['VHM', 'VIC', 'KDH', 'NLG', 'PDR', 'DXG'] },
  { id: 'SECURITIES', label: '📈 Chứng Khoán', tickers: ['SSI', 'VND', 'VCI', 'HCM', 'SHS'] },
  { id: 'RETAIL', label: '🛒 Bán Lẻ', tickers: ['MWG', 'MSN', 'VNM', 'PNJ', 'FRT'] },
  { id: 'ENERGY', label: '⚡ Năng Lượng', tickers: ['GAS', 'PVD', 'PVS', 'BSR', 'POW'] },
  { id: 'TECH', label: '💻 Công Nghệ', tickers: ['FPT', 'CMG', 'ELC'] },
];

let currentSectorId = 'ALL';
let todayTopTickers = ['HPG', 'FPT', 'VNM', 'SSI', 'MWG', 'TCB'];

let currentCouncilTicker = 'HPG';
let isAnalyzing = false;
let activeController: AbortController | null = null;
let currentAgentFilter: 'all' | 'verdict' | 'debate' | 'technical' | 'fundamental' | 'sentiment' = 'all';
let latestContext: AgentCouncilContext | null = null;

const VERDICTS_STORAGE_KEY = 'traderai_council_verdicts';

export interface StoredCouncilVerdict {
  action: 'MUA' | 'BÁN' | 'QUAN SÁT';
  entry_zone: string;
  target_price: string;
  stop_loss: string;
  sizing: string;
  risk_level: string;
  timestamp: number;
}

function getStorage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    /* ignore */
  }
  return null;
}

export function saveCouncilVerdict(ticker: string, verdict: AgentCouncilVerdict) {
  try {
    const storage = getStorage();
    if (!storage) return;
    const raw = storage.getItem(VERDICTS_STORAGE_KEY);
    const map: Record<string, StoredCouncilVerdict> = raw ? JSON.parse(raw) : {};
    map[ticker.toUpperCase()] = {
      action: verdict.action,
      entry_zone: verdict.entry_zone,
      target_price: verdict.target_price,
      stop_loss: verdict.stop_loss,
      sizing: verdict.sizing,
      risk_level: verdict.risk_level,
      timestamp: Date.now(),
    };
    storage.setItem(VERDICTS_STORAGE_KEY, JSON.stringify(map));
    if (typeof window !== 'undefined' && window.dispatchEvent) {
      window.dispatchEvent(new CustomEvent('councilVerdictSaved', { detail: { ticker: ticker.toUpperCase(), verdict } }));
    }
  } catch (e) {
    console.error('Failed to save council verdict:', e);
  }
}

export function getCouncilVerdict(ticker: string): StoredCouncilVerdict | null {
  try {
    const storage = getStorage();
    if (!storage) return null;
    const raw = storage.getItem(VERDICTS_STORAGE_KEY);
    if (!raw) return null;
    const map = JSON.parse(raw);
    return map[ticker.toUpperCase()] || null;
  } catch {
    return null;
  }
}

const AGENT_META: Record<AgentRole, { avatar: string; title: string; subtitle: string; step: string }> = {
  technical: { avatar: '📈', title: 'Chuyên gia Phân tích Kỹ thuật', subtitle: 'MA20/50/200, RSI, MACD, Bollinger, Khối lượng', step: 'step-tech' },
  fundamental: { avatar: '📑', title: 'Chuyên viên Phân tích Cơ bản', subtitle: 'BCTC VAS, P/E, P/B, ROE & Sức khỏe tài chính', step: 'step-fund' },
  sentiment: { avatar: '📰', title: 'Chuyên viên Tin tức & Dòng tiền', subtitle: 'Tin tức, Giao dịch khối ngoại, VN-Index', step: 'step-sent' },
  bull: { avatar: '🐂', title: 'Phe Bò (Bull Analyst)', subtitle: 'Luận điểm TĂNG GIÁ', step: 'step-debate' },
  bear: { avatar: '🐻', title: 'Phe Gấu (Bear Analyst)', subtitle: 'Phản biện RỦI RO & T+2.5', step: 'step-debate' },
  portfolio_manager: { avatar: '👔', title: 'Quản lý Quỹ & Quản trị Rủi ro', subtitle: 'Phán quyết đầu tư & Kỷ luật T+2.5', step: 'step-verdict' },
};

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
    if (dataSourceStatus.stocks !== 'real') return;
    const tickers = [...new Set(top.map((s: any) => s.ticker).filter(Boolean))].slice(0, 8) as string[];
    if (tickers.length === 0) return;

    todayTopTickers = tickers;
    if (!isAnalyzing && !tickers.includes(currentCouncilTicker) && currentSectorId === 'ALL') {
      currentCouncilTicker = tickers[0];
      const input = document.getElementById('councilTickerInput') as HTMLInputElement | null;
      if (input) input.value = currentCouncilTicker;
    }

    if (currentSectorId === 'ALL') {
      updateQuickTickersDisplay();
    }
  } catch {
    /* keep placeholder chips */
  }
}

function updateQuickTickersDisplay() {
  const wrap = document.getElementById('quickCouncilTickers');
  if (!wrap) return;

  const currentSector = SECTORS.find(s => s.id === currentSectorId) || SECTORS[0];
  const tickers = currentSectorId === 'ALL' ? todayTopTickers : currentSector.tickers;
  const label = currentSectorId === 'ALL' ? '🔥 Top hôm nay:' : `${currentSector.label}:`;

  wrap.innerHTML = `<span class="quick-label">${label}</span>` + tickers
    .map(t => `<button class="chip${t === currentCouncilTicker ? ' active' : ''}" data-ticker="${escapeHtml(t)}">${escapeHtml(t)}</button>`)
    .join('');

  bindQuickChips();
  syncQuickChips();
}

function bindSectorChips() {
  document.querySelectorAll<HTMLButtonElement>('#councilSectorRow .sector-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      currentSectorId = btn.dataset.sector || 'ALL';
      document.querySelectorAll('#councilSectorRow .sector-chip').forEach(b => {
        b.classList.toggle('active', (b as HTMLElement).dataset.sector === currentSectorId);
      });
      updateQuickTickersDisplay();
    });
  });
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

  // If ticker belongs to a known sector, switch to that sector
  const matched = SECTORS.find(s => s.id !== 'ALL' && s.tickers.includes(currentCouncilTicker));
  if (matched) {
    currentSectorId = matched.id;
    document.querySelectorAll('#councilSectorRow .sector-chip').forEach(b => {
      b.classList.toggle('active', (b as HTMLElement).dataset.sector === currentSectorId);
    });
  }
  updateQuickTickersDisplay();

  document.getElementById('agentCouncilSection')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  startCouncilAnalysis();
}

// ===========================
// Rendering
// ===========================

function renderCouncilSkeleton(container: HTMLElement) {
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

      <!-- Main Controls Bar -->
      <div class="council-controls-bar">
        <!-- Sector Selector Row -->
        <div class="council-sector-row" id="councilSectorRow">
          <span class="sector-row-label">🏷️ Nhóm ngành:</span>
          <div class="sector-chips">
            ${SECTORS.map(s => `<button class="sector-chip${s.id === currentSectorId ? ' active' : ''}" data-sector="${s.id}">${escapeHtml(s.label)}</button>`).join('')}
          </div>
        </div>

        <div class="council-inputs">
          <div class="council-ticker-box">
            <label for="councilTickerInput">Mã Cổ Phiếu:</label>
            <div class="ticker-input-wrapper">
              <input type="text" id="councilTickerInput" value="${escapeHtml(currentCouncilTicker)}" placeholder="VD: HPG, FPT..." maxlength="10" autocomplete="off" />
            </div>
          </div>

          <div class="quick-tickers" id="quickCouncilTickers">
            <span class="quick-label">🔥 Top hôm nay:</span>
            ${todayTopTickers.map(t => `<button class="chip${t === currentCouncilTicker ? ' active' : ''}" data-ticker="${t}">${t}</button>`).join('')}
          </div>
        </div>

        <div class="council-actions">
          <button class="btn-run-council" id="startCouncilBtn">
            <span class="run-icon">🚀</span> Triệu tập Hội Đồng
          </button>
        </div>
      </div>

      <!-- Agent Perspective Selector (Choose Agent Focus) -->
      <div class="council-agent-selector">
        <span class="selector-label">🎯 Góc nhìn Phân tích:</span>
        <div class="agent-pills" id="agentPills">
          <button class="agent-pill active" data-agent="all">
            <span class="pill-icon">🏛️</span>
            <span class="pill-text">Toàn Bộ Hội Đồng</span>
          </button>
          <button class="agent-pill" data-agent="verdict">
            <span class="pill-icon">👔</span>
            <span class="pill-text">Phán Quyết Quản Lý Quỹ</span>
          </button>
          <button class="agent-pill" data-agent="debate">
            <span class="pill-icon">⚔️</span>
            <span class="pill-text">Tranh Biện Bull vs Bear</span>
          </button>
          <button class="agent-pill" data-agent="technical">
            <span class="pill-icon">📈</span>
            <span class="pill-text">Kỹ Thuật</span>
          </button>
          <button class="agent-pill" data-agent="fundamental">
            <span class="pill-icon">📑</span>
            <span class="pill-text">Cơ Bản (VAS)</span>
          </button>
          <button class="agent-pill" data-agent="sentiment">
            <span class="pill-icon">📰</span>
            <span class="pill-text">Dòng Tiền & Tin Tức</span>
          </button>
        </div>
      </div>

      <!-- Deliberation / Results Workspace -->
      <div class="council-workspace" id="councilWorkspace">
        <div class="council-empty-state">
          <div class="empty-icon">👥</div>
          <h3>Sẵn sàng phân tích cổ phiếu</h3>
          <p>Bấm chọn mã cổ phiếu hoặc nhấn <strong>"Triệu tập Hội Đồng"</strong> để AI tự động kích hoạt phiên tranh luận.</p>
        </div>
      </div>
    </div>
  `;
}

function bindCouncilEvents() {
  const input = document.getElementById('councilTickerInput') as HTMLInputElement | null;

  const runFromInput = () => {
    if (input) currentCouncilTicker = input.value.toUpperCase().trim() || 'HPG';
    syncQuickChips();
    startCouncilAnalysis();
  };

  document.getElementById('startCouncilBtn')?.addEventListener('click', runFromInput);
  input?.addEventListener('keydown', e => {
    if (e.key === 'Enter') runFromInput();
  });

  // Sector chips
  bindSectorChips();

  // Agent Perspective Pills
  document.querySelectorAll<HTMLButtonElement>('#agentPills .agent-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      const agent = pill.dataset.agent as any;
      if (agent) applyAgentFilter(agent);
    });
  });

  bindQuickChips();
}

function applyAgentFilter(filter: 'all' | 'verdict' | 'debate' | 'technical' | 'fundamental' | 'sentiment') {
  currentAgentFilter = filter;
  document.querySelectorAll('#agentPills .agent-pill').forEach(p => {
    p.classList.toggle('active', p.getAttribute('data-agent') === filter);
  });

  const feed = document.getElementById('councilFeed');
  if (!feed) return;

  const cards = feed.querySelectorAll<HTMLElement>('[data-agent-role]');
  cards.forEach(card => {
    const role = card.getAttribute('data-agent-role');
    if (filter === 'all') {
      card.style.display = '';
      card.classList.remove('filter-dim');
    } else if (filter === 'debate' && (role === 'bull' || role === 'bear' || role === 'debate')) {
      card.style.display = '';
      card.classList.remove('filter-dim');
    } else if (filter === 'verdict' && role === 'portfolio_manager') {
      card.style.display = '';
      card.classList.remove('filter-dim');
    } else if (filter === role) {
      card.style.display = '';
      card.classList.remove('filter-dim');
    } else {
      card.style.display = 'none';
    }
  });

  const firstVisible = feed.querySelector<HTMLElement>('[data-agent-role]:not([style*="display: none"])');
  if (firstVisible) {
    firstVisible.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
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
    provider: 'gemini',
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
      showError(`Kết nối bị ngắt giữa phiên: ${errorMessage(err)}`);
    } else {
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
      latestContext = event.data;
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
      markStep(event.agent, 'completed');
      break;
    case 'warning':
      feed.appendChild(buildNotice(event.message, 'warning'));
      break;
    case 'final_verdict':
      markStep('portfolio_manager', 'completed');
      if (statusMsg) statusMsg.textContent = `✅ Hội đồng đã hoàn tất phiên tranh luận cho ${ticker}!`;
      feed.appendChild(buildVerdictCard(event.structured, event.content, event.engine));
      saveCouncilVerdict(ticker, event.structured);
      applyAgentFilter(currentAgentFilter);
      break;
    case 'error':
      showError(event.message);
      break;
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'Lỗi không xác định';
}

function showError(msg: string) {
  const statusMsg = document.getElementById('statusMsg');
  if (statusMsg) statusMsg.textContent = `⚠️ ${msg}`;
  const feed = document.getElementById('councilFeed');
  feed?.querySelector('.feed-placeholder')?.remove();
  feed?.appendChild(buildNotice(msg, 'error'));
}

function stopPulse() {
  document.getElementById('statusPulse')?.classList.add('stopped');
}

function markStep(agent: AgentRole, state: 'active' | 'completed') {
  const id = AGENT_META[agent]?.step;
  if (!id) return;
  const el = document.getElementById(id);
  if (!el) return;

  if (state === 'active') {
    el.classList.add('active');
    el.classList.remove('completed');
    const txt = el.querySelector('.step-state');
    if (txt) txt.textContent = 'Đang họp...';
  } else {
    el.classList.remove('active');
    el.classList.add('completed');
    const txt = el.querySelector('.step-state');
    if (txt) txt.textContent = '✓ Xong';
  }
}

function renderModeBadge(mode: 'llm' | 'heuristic', model: string | null | undefined) {
  const badge = document.getElementById('councilModeBadge');
  if (!badge) return;
  badge.hidden = false;
  if (mode === 'llm') {
    badge.className = 'council-mode-badge mode-llm';
    badge.textContent = `🤖 AI ${model ?? 'LLM'}`;
  } else {
    badge.className = 'council-mode-badge mode-heuristic';
    badge.textContent = '📐 Định lượng AI Heuristic';
  }
}

function renderCorporateEventsBanner(events?: CorporateEvent[]): string {
  if (!events || events.length === 0) return '';
  return `
    <div class="corporate-events-banner">
      <div class="events-banner-header">
        <span class="banner-icon">📢</span>
        <span class="banner-title">Sự Kiện & Lịch Cổ Tức / GDKHQ:</span>
      </div>
      <div class="events-pill-row">
        ${events.slice(0, 3).map(ev => `
          <div class="event-chip">
            <span class="event-date">${escapeHtml(ev.date || 'Gần đây')}</span>
            <span class="event-tag">${escapeHtml(ev.type || 'SỰ KIỆN')}</span>
            <span class="event-title" title="${escapeHtml(ev.title)}">${escapeHtml(ev.title)}</span>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function renderContextStrip(ctx: AgentCouncilContext | null | undefined) {
  const el = document.getElementById('councilContext');
  if (!el || !ctx) return;
  el.hidden = false;
  el.innerHTML = `
    <div class="context-items-grid">
      ${buildContextItems(ctx)}
    </div>
    ${renderCorporateEventsBanner(ctx.corporate_events)}
  `;
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
    ['Cổ tức', ctx.dividend_yield != null ? `${ctx.dividend_yield}%` : 'N/A'],
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

  // Bull and Bear share the central side-by-side debate arena with a VS badge
  if (agent === 'bull' || agent === 'bear') {
    let arena = feed.querySelector<HTMLElement>('.debate-arena');
    if (!arena) {
      arena = document.createElement('div');
      arena.className = 'debate-arena fade-in';
      arena.setAttribute('data-agent-role', 'debate');
      arena.innerHTML = `
        <div class="agent-card agent-bull debate-slot" data-slot="bull" data-agent-role="bull"><div class="feed-placeholder">🐂 Phe Bò đang chuẩn bị luận điểm...</div></div>
        <div class="debate-divider-vs"><span class="vs-badge">VS</span></div>
        <div class="agent-card agent-bear debate-slot" data-slot="bear" data-agent-role="bear"><div class="feed-placeholder">🐻 Phe Gấu đang chờ phản biện...</div></div>
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
  card.setAttribute('data-agent-role', agent);
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

function calculateBullBearScore(v: AgentCouncilVerdict): { bullPct: number; bearPct: number; statusText: string } {
  let bullPct = 52;
  let bearPct = 48;
  let statusText = '⚖️ Trạng thái Giằng Co (Cân bằng)';

  const rsi = latestContext?.rsi ?? 50;
  const roe = latestContext?.roe ?? 15;

  if (v.action === 'MUA') {
    bullPct = Math.min(85, Math.max(62, Math.round(55 + (roe > 15 ? 10 : 5) + (rsi < 65 ? 8 : 0))));
    bearPct = 100 - bullPct;
    statusText = '🐂 Phe Bò Chiếm Ưu Thế Rõ Rệt';
  } else if (v.action === 'BÁN') {
    bearPct = Math.min(85, Math.max(65, Math.round(60 + (rsi > 70 ? 15 : 8))));
    bullPct = 100 - bearPct;
    statusText = '🐻 Phe Gấu Áp Đảo (Rủi ro cao)';
  } else {
    bullPct = Math.round(48 + (rsi > 50 ? 4 : -2));
    bearPct = 100 - bullPct;
    statusText = '⚖️ Thận Trọng Quan Sát (Chờ tín hiệu T+2.5)';
  }

  return { bullPct, bearPct, statusText };
}

function calculateRR(v: AgentCouncilVerdict): string | null {
  try {
    const parseNum = (str: string) => {
      const match = str.replace(/,/g, '').match(/\d+(\.\d+)?/);
      return match ? parseFloat(match[0]) : null;
    };
    const target = parseNum(v.target_price);
    const stop = parseNum(v.stop_loss);
    const entry = parseNum(v.entry_zone);
    if (target && stop && entry && target > entry && entry > stop) {
      const reward = target - entry;
      const risk = entry - stop;
      if (risk > 0) {
        const ratio = (reward / risk).toFixed(1);
        return `1 : ${ratio}`;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** "15% tổng tài sản" in money and round lots of the real TCBS NAV, when an account is connected. */
function sizingInAccount(v: AgentCouncilVerdict): string {
  const text = sizingText(v.sizing, v.entry_zone, getAccount(), currentCouncilTicker);
  return text ? `<span class="metric-sub">${escapeHtml(text)}</span>` : '';
}

function buildVerdictCard(v: AgentCouncilVerdict, raw: string, engine?: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'verdict-card fade-in';
  card.setAttribute('data-agent-role', 'portfolio_manager');
  const actionClass = v.action === 'MUA' ? 'action-buy' : v.action === 'BÁN' ? 'action-sell' : 'action-hold';

  const { bullPct, bearPct, statusText } = calculateBullBearScore(v);
  const rrRatio = calculateRR(v);

  card.innerHTML = `
    <div class="verdict-header">
      <div class="verdict-title-box">
        <span class="verdict-badge">👔 PHÁN QUYẾT HỘI ĐỒNG ĐẦU TƯ${engine ? ` · ${escapeHtml(engine)}` : ''}</span>
        <h3 class="verdict-title">Quyết định Quản lý Quỹ & Quản trị Rủi ro (T+2.5)</h3>
      </div>
      <div class="verdict-header-actions">
        <button class="btn-copy-verdict" id="btnCopyVerdict" type="button" title="Sao chép tóm tắt khuyến nghị">
          📋 Sao chép
        </button>
        <div class="verdict-action-tag ${actionClass}">${escapeHtml(v.action)}</div>
      </div>
    </div>

    <!-- Bull vs Bear Power Gauge -->
    <div class="bull-bear-meter-box">
      <div class="meter-header">
        <span class="meter-bull-badge">🐂 Phe Bò: <strong>${bullPct}%</strong></span>
        <span class="meter-status-tag">${statusText}</span>
        <span class="meter-bear-badge">Phe Gấu: <strong>${bearPct}%</strong> 🐻</span>
      </div>
      <div class="meter-track">
        <div class="meter-fill-bull" style="width: ${bullPct}%;"></div>
        <div class="meter-fill-bear" style="width: ${bearPct}%;"></div>
      </div>
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
        <span class="metric-label">🛑 Cắt Lỗ (Kỷ luật T+2.5)</span>
        <span class="metric-val text-red">${escapeHtml(v.stop_loss)}</span>
      </div>
      <div class="verdict-metric">
        <span class="metric-label">⚖️ Tỷ Trọng Danh Mục</span>
        <span class="metric-val">${escapeHtml(v.sizing)}</span>
        ${sizingInAccount(v)}
        ${rrRatio ? `<span class="rr-ratio-pill" title="Tỷ lệ Lợi nhuận / Rủi ro">R/R = ${rrRatio}</span>` : ''}
      </div>
    </div>

    <div class="verdict-summary">
      <h4>📌 Chiến lược · Rủi ro: ${escapeHtml(v.risk_level)}</h4>
      <p>${formatMarkdownText(v.summary || raw)}</p>
    </div>
    <p class="council-disclaimer">Phân tích tự động mang tính tham khảo, không phải khuyến nghị đầu tư.</p>
  `;

  // Attach copy handler
  const copyBtn = card.querySelector<HTMLButtonElement>('#btnCopyVerdict');
  copyBtn?.addEventListener('click', async () => {
    const textToCopy = `🏛️ PHÁN QUYẾT HỘI ĐỒNG AI - ${currentCouncilTicker}\n` +
      `• Khuyến nghị: ${v.action}\n` +
      `• Vùng giá gom: ${v.entry_zone}\n` +
      `• Giá mục tiêu: ${v.target_price}\n` +
      `• Điểm cắt lỗ: ${v.stop_loss}\n` +
      `• Tỷ trọng: ${v.sizing}\n` +
      `• Rủi ro: ${v.risk_level}\n` +
      `• Tóm tắt: ${v.summary || raw}\n` +
      `Nguồn: TraderAI (Tauric TradingAgents Architecture • Chuẩn TTCK VN)`;
    try {
      await navigator.clipboard.writeText(textToCopy);
      copyBtn.textContent = '✓ Đã sao chép!';
      setTimeout(() => { copyBtn.textContent = '📋 Sao chép'; }, 2000);
    } catch {
      /* ignore clipboard rejection */
    }
  });

  return card;
}

/** Non-streaming fallback: render the complete result at once. */
function renderFullCouncilResult(res: AgentCouncilResult) {
  const feed = document.getElementById('councilFeed');
  if (!feed) return;
  feed.innerHTML = '';

  latestContext = res.context;
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
    saveCouncilVerdict(res.ticker, res.verdict.structured);
    markStep('portfolio_manager', 'completed');
  }
  const statusMsg = document.getElementById('statusMsg');
  if (statusMsg) statusMsg.textContent = `✅ Đã hoàn thành phiên phân tích cho ${res.ticker}`;
  applyAgentFilter(currentAgentFilter);
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
