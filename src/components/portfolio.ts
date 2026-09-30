
type Holding = { ticker: string; quantity: number; avgPrice: number; addedAt: string; source?: 'tcbs' };
type Alert = { id: string; ticker: string; type: 'above' | 'below'; value: number; triggered: boolean };

const HOLDINGS_KEY = 'traderai_portfolio_v1';
const ALERTS_KEY = 'traderai_alerts_v1';
let prices = new Map<string, number>();
// Last prices reported by TCBS for real positions; used when the market list lacks a ticker.
let tcbsPrices = new Map<string, number>();
const priceOf = (ticker: string) => prices.get(ticker) ?? tcbsPrices.get(ticker);

const esc = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] || char));
const read = <T>(key: string, fallback: T): T => { try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); } catch { return fallback; } };
const write = (key: string, value: unknown) => localStorage.setItem(key, JSON.stringify(value));
const money = (value: number) => value.toLocaleString('vi-VN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function render() {
  const container = document.getElementById('portfolioContent');
  if (!container) return;
  const holdings = read<Holding[]>(HOLDINGS_KEY, []);
  if (!holdings.length) { container.innerHTML = '<div class="portfolio-empty">Chưa có vị thế. Thêm mã đầu tiên để bắt đầu nhật ký giao dịch.</div>'; return; }
  const totalCost = holdings.reduce((sum, h) => sum + h.quantity * h.avgPrice, 0);
  const totalValue = holdings.reduce((sum, h) => sum + h.quantity * (priceOf(h.ticker) ?? h.avgPrice), 0);
  const pnl = totalValue - totalCost;
  container.innerHTML = `<div class="portfolio-summary"><div><span>Tổng vốn</span><strong>${money(totalCost)}</strong></div><div><span>Giá trị hiện tại</span><strong>${money(totalValue)}</strong></div><div class="${pnl >= 0 ? 'positive' : 'negative'}"><span>Lãi/Lỗ</span><strong>${pnl >= 0 ? '+' : ''}${money(pnl)} (${totalCost ? (pnl / totalCost * 100).toFixed(2) : '0.00'}%)</strong></div></div><div class="portfolio-table-wrap"><table class="portfolio-table"><thead><tr><th>Mã</th><th>SL</th><th>Giá vốn</th><th>Giá hiện tại</th><th>Lãi/Lỗ</th><th></th></tr></thead><tbody>${holdings.map(h => { const current = priceOf(h.ticker) ?? h.avgPrice; const value = (current - h.avgPrice) * h.quantity; const pct = h.avgPrice ? (current - h.avgPrice) / h.avgPrice * 100 : 0; return `<tr><td><strong>${esc(h.ticker)}</strong>${h.source === 'tcbs' ? ' <span class="tcbs-badge">TCBS</span>' : ''}</td><td>${h.quantity.toLocaleString('vi-VN')}</td><td>${money(h.avgPrice)}</td><td>${money(current)}</td><td class="${value >= 0 ? 'positive' : 'negative'}">${value >= 0 ? '+' : ''}${money(value)} (${pct.toFixed(2)}%)</td><td>${h.source === 'tcbs' ? '' : `<button class="table-action" data-remove-holding="${esc(h.ticker)}" type="button">Xóa</button>`}</td></tr>`; }).join('')}</tbody></table></div>`;
  container.querySelectorAll('[data-remove-holding]').forEach(button => button.addEventListener('click', () => { const ticker = (button as HTMLElement).dataset.removeHolding; write(HOLDINGS_KEY, holdings.filter(h => h.ticker !== ticker)); render(); }));
}

function renderAlerts() {
  const list = document.getElementById('alertList');
  if (!list) return;
  const alerts = read<Alert[]>(ALERTS_KEY, []);
  list.innerHTML = alerts.length ? `<div class="alert-list-title">Cảnh báo đang theo dõi</div>${alerts.map(a => `<div class="alert-item ${a.triggered ? 'triggered' : ''}"><span><strong>${esc(a.ticker)}</strong> ${a.type === 'above' ? 'vượt' : 'dưới'} ${money(a.value)}${a.triggered ? ' · Đã chạm' : ''}</span><button class="table-action" data-remove-alert="${a.id}" type="button">Xóa</button></div>`).join('')}` : '';
  list.querySelectorAll('[data-remove-alert]').forEach(button => button.addEventListener('click', () => { const id = (button as HTMLElement).dataset.removeAlert; write(ALERTS_KEY, alerts.filter(a => a.id !== id)); renderAlerts(); }));
}

function checkAlerts() {
  const alerts = read<Alert[]>(ALERTS_KEY, []);
  let changed = false; const hits: string[] = [];
  alerts.forEach(alert => { const price = priceOf(alert.ticker); if (price == null || alert.triggered) return; const hit = alert.type === 'above' ? price >= alert.value : price <= alert.value; if (hit) { alert.triggered = true; changed = true; hits.push(`${alert.ticker} đã ${alert.type === 'above' ? 'vượt' : 'giảm dưới'} ${money(alert.value)}`); } });
  if (changed) write(ALERTS_KEY, alerts);
  const status = document.getElementById('alertStatus');
  if (status) status.innerHTML = hits.length ? `<strong>⚡ Cảnh báo:</strong> ${hits.map(esc).join(' · ')}` : '';
  renderAlerts();
}

export function setPortfolioPrices(stocks: Array<{ ticker: string; close: number }>) { prices = new Map(stocks.map(stock => [stock.ticker, stock.close])); render(); checkAlerts(); }

/** Mirror the real TCBS positions (prices in thousand VND). Manual positions stay unless TCBS now holds the same ticker. */
export function syncTcbsHoldings(items: Array<{ ticker: string; quantity: number; avgPrice: number; price?: number }>) {
  tcbsPrices = new Map(items.filter(i => i.price).map(i => [i.ticker, i.price as number]));
  const addedAt = new Date().toISOString();
  const real = new Set(items.map(i => i.ticker));
  const manual = read<Holding[]>(HOLDINGS_KEY, []).filter(h => h.source !== 'tcbs' && !real.has(h.ticker));
  write(HOLDINGS_KEY, [...items.map(({ price: _price, ...i }) => ({ ...i, addedAt, source: 'tcbs' as const })), ...manual]);
  const lede = document.getElementById('portfolioLede');
  if (lede) lede.textContent = `Vị thế thật tự đồng bộ từ TCBS (${items.length} mã, nhãn TCBS) cùng các vị thế ảo bạn tự thêm để thử nghiệm. Cảnh báo giá áp dụng cho cả hai.`;
  render();
}

/** Add price alerts (thousand VND), skipping ones already tracked. Returns how many were added. */
export function addAlerts(items: Array<{ ticker: string; type: Alert['type']; value: number }>): number {
  const alerts = read<Alert[]>(ALERTS_KEY, []);
  const fresh = items.filter(item => item.value > 0 && !alerts.some(a => a.ticker === item.ticker && a.type === item.type && Math.abs(a.value - item.value) < 1e-6 && !a.triggered));
  fresh.forEach((item, i) => alerts.push({ id: `${Date.now()}-${i}-${item.ticker}`, ...item, triggered: false }));
  if (fresh.length) { write(ALERTS_KEY, alerts); checkAlerts(); }
  return fresh.length;
}

export function exportPortfolioCsv() {
  const holdings = read<Holding[]>(HOLDINGS_KEY, []);
  const rows = [['Ticker', 'Quantity', 'Average price', 'Current price', 'PnL', 'PnL %'], ...holdings.map(h => { const current = priceOf(h.ticker) ?? h.avgPrice; const pnl = (current - h.avgPrice) * h.quantity; return [h.ticker, String(h.quantity), h.avgPrice.toFixed(2), current.toFixed(2), pnl.toFixed(2), ((current - h.avgPrice) / h.avgPrice * 100).toFixed(2)]; })];
  const blob = new Blob([rows.map(row => row.join(',')).join('\n')], { type: 'text/csv;charset=utf-8' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `traderai-portfolio-${new Date().toISOString().slice(0, 10)}.csv`; link.click(); URL.revokeObjectURL(url);
}

export function initPortfolio() {
  document.getElementById('portfolioForm')?.addEventListener('submit', event => { event.preventDefault(); const ticker = (document.getElementById('portfolioTicker') as HTMLInputElement).value.trim().toUpperCase(); const quantity = Number((document.getElementById('portfolioQty') as HTMLInputElement).value); const price = Number((document.getElementById('portfolioPrice') as HTMLInputElement).value); if (!/^[A-Z0-9]{1,6}$/.test(ticker) || quantity <= 0 || price <= 0) return; const holdings = read<Holding[]>(HOLDINGS_KEY, []); const existing = holdings.find(h => h.ticker === ticker); if (existing) { const totalQty = existing.quantity + quantity; existing.avgPrice = (existing.avgPrice * existing.quantity + price * quantity) / totalQty; existing.quantity = totalQty; } else holdings.push({ ticker, quantity, avgPrice: price, addedAt: new Date().toISOString() }); write(HOLDINGS_KEY, holdings); (event.target as HTMLFormElement).reset(); render(); });
  document.getElementById('alertAdd')?.addEventListener('click', () => { const ticker = (document.getElementById('alertTicker') as HTMLInputElement).value.trim().toUpperCase(); const type = (document.getElementById('alertType') as HTMLSelectElement).value as Alert['type']; const value = Number((document.getElementById('alertValue') as HTMLInputElement).value); if (!/^[A-Z0-9]{1,6}$/.test(ticker) || value <= 0) return; const alerts = read<Alert[]>(ALERTS_KEY, []); alerts.push({ id: `${Date.now()}-${ticker}`, ticker, type, value, triggered: false }); write(ALERTS_KEY, alerts); renderAlerts(); });
  document.getElementById('portfolioExport')?.addEventListener('click', exportPortfolioCsv); render(); renderAlerts();
}
