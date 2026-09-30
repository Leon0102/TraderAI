// Capital Allocator Component
import { onAccount } from './accountStore';
// Takes a VND amount from the user and turns the combined BUY signals into a
// concrete, tradable position: how many shares (in 100-share lots, the HOSE/
// HNX minimum) of which tickers, for how much, with how much cash left over.

import type { CombinedSignal } from './suggestions';
import { openStockDetail } from './stockDetail';

const LOT_SIZE = 100; // HOSE/HNX minimum order size
const MIN_SCORE = 65;
const MAX_POSITIONS = 8;

let cachedSignals: CombinedSignal[] = [];

export function setAllocatorSignals(signals: CombinedSignal[]) {
  cachedSignals = signals;
}

export function initCapitalAllocator() {
  const btn = document.getElementById('allocateBtn');
  const input = document.getElementById('capitalInput') as HTMLInputElement | null;
  if (!btn || !input) return;

  const formatInputValue = () => {
    const digits = input.value.replace(/[^\d]/g, '');
    input.value = digits ? Number(digits).toLocaleString('vi-VN') : '';
  };
  input.addEventListener('input', formatInputValue);

  const run = () => {
    const capital = Number(input.value.replace(/[^\d]/g, ''));
    if (!capital || capital <= 0) {
      renderError('Vui lòng nhập số vốn hợp lệ.');
      return;
    }
    renderAllocation(capital);
  };

  btn.addEventListener('click', run);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') run();
  });

  // Real TCBS cash as the default capital once the account is connected.
  onAccount(a => {
    const presets = document.querySelector('.capital-presets');
    if (!presets) return;
    let btn = document.getElementById('capitalPresetTcbs') as HTMLButtonElement | null;
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'capitalPresetTcbs';
      btn.className = 'capital-preset capital-preset-tcbs';
      btn.type = 'button';
      btn.addEventListener('click', () => {
        const amount = Number(btn!.dataset.amount);
        input.value = amount.toLocaleString('vi-VN');
        renderAllocation(amount);
      });
      presets.prepend(btn);
    }
    const cash = Math.max(0, Math.round(a.summary.cash));
    btn.dataset.amount = String(cash);
    btn.textContent = `Tiền mặt TCBS ${(cash / 1e6).toLocaleString('vi-VN', { maximumFractionDigits: 1 })}tr`;
    btn.title = `Tiền mặt trong tài khoản TCBS lúc ${a.synced_at}`;
    if (!input.value) input.value = cash.toLocaleString('vi-VN');
  });

  document.querySelectorAll('.capital-preset').forEach(b => {
    b.addEventListener('click', () => {
      const amount = (b as HTMLElement).dataset.amount;
      if (!amount || !input) return;
      input.value = Number(amount).toLocaleString('vi-VN');
      renderAllocation(Number(amount));
    });
  });
}

function renderError(message: string) {
  const container = document.getElementById('allocationResult');
  if (container) container.innerHTML = `<p class="allocation-note">${message}</p>`;
}

function vnd(n: number): string {
  return Math.round(n).toLocaleString('vi-VN') + 'đ';
}

export function renderAllocation(capital: number) {
  const container = document.getElementById('allocationResult');
  if (!container) return;

  const candidates = cachedSignals
    .filter(s => s.decision === 'BUY' && s.combinedScore >= MIN_SCORE && s.techSignal.entryZone.high > 0)
    .slice(0, MAX_POSITIONS);

  if (candidates.length === 0) {
    container.innerHTML = `<p class="allocation-note">Hiện chưa có mã nào đủ tín hiệu MUA rõ ràng để phân bổ vốn. Hãy thử lại sau khi thị trường có xu hướng rõ hơn, hoặc xem tab "Tổng Hợp" ở trên.</p>`;
    return;
  }

  const totalScore = candidates.reduce((s, c) => s + c.combinedScore, 0);

  const rows = candidates.map(c => {
    const priceVnd = c.techSignal.entryZone.high * 1000; // display units are "nghìn đồng"
    const weight = c.combinedScore / totalScore;
    const targetAmount = capital * weight;
    const lots = Math.floor(targetAmount / (priceVnd * LOT_SIZE));
    const shares = lots * LOT_SIZE;
    return { ticker: c.ticker, priceVnd, score: c.combinedScore, shares, cost: shares * priceVnd };
  });

  // Greedily spend leftover cash on more full lots, richest signal first.
  let totalCost = rows.reduce((s, r) => s + r.cost, 0);
  let leftover = capital - totalCost;
  let addedMore = true;
  while (addedMore) {
    addedMore = false;
    for (const r of rows) {
      const lotCost = r.priceVnd * LOT_SIZE;
      if (leftover >= lotCost) {
        r.shares += LOT_SIZE;
        r.cost += lotCost;
        leftover -= lotCost;
        totalCost += lotCost;
        addedMore = true;
        break;
      }
    }
  }

  const bought = rows.filter(r => r.shares > 0);
  const skipped = rows.filter(r => r.shares === 0);

  if (bought.length === 0) {
    const cheapest = Math.min(...rows.map(r => r.priceVnd * LOT_SIZE));
    renderError(`Vốn ${vnd(capital)} chưa đủ mua 1 lô (100 CP) của bất kỳ mã đề xuất nào. Cần tối thiểu khoảng ${vnd(cheapest)}.`);
    return;
  }

  const rowsHtml = bought.map(r => `
    <tr class="allocation-row" data-ticker="${r.ticker}">
      <td><span class="stock-symbol">${r.ticker}</span></td>
      <td>${r.priceVnd.toLocaleString('vi-VN')}đ</td>
      <td>${r.shares.toLocaleString('vi-VN')}</td>
      <td>${vnd(r.cost)}</td>
      <td>${((r.cost / capital) * 100).toFixed(1)}%</td>
      <td><span class="confidence-badge ${r.score >= 70 ? 'confidence-high' : 'confidence-mid'}">${r.score}/100</span></td>
    </tr>
  `).join('');

  container.innerHTML = `
    <div class="allocation-summary">
      <div class="alloc-stat"><span>Tổng vốn</span><strong>${vnd(capital)}</strong></div>
      <div class="alloc-stat"><span>Đã phân bổ</span><strong class="target-text">${vnd(totalCost)}</strong></div>
      <div class="alloc-stat"><span>Tiền còn lại</span><strong>${vnd(leftover)}</strong></div>
      <div class="alloc-stat"><span>Số mã</span><strong>${bought.length}</strong></div>
    </div>
    <div class="table-container">
      <table class="stock-table allocation-table">
        <thead>
          <tr><th>Mã CK</th><th>Giá</th><th>KL (CP)</th><th>Số tiền</th><th>% Vốn</th><th>Điểm TH</th></tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
    ${skipped.length > 0 ? `<p class="allocation-note">⚠️ Vốn phân bổ theo tỷ trọng chưa đủ 1 lô (100 CP) cho: ${skipped.map(r => r.ticker).join(', ')} — số vốn này đã được dồn sang các mã điểm cao hơn.</p>` : ''}
    <p class="allocation-disclaimer">⚠️ Đây là gợi ý phân bổ dựa trên thuật toán kỹ thuật + cơ bản + tin tức tại thời điểm hiện tại, không phải lời khuyên đầu tư. Giá và tín hiệu có thể thay đổi liên tục — vui lòng tự nghiên cứu và cân nhắc rủi ro trước khi quyết định.</p>
  `;

  container.querySelectorAll('.allocation-row').forEach(row => {
    row.addEventListener('click', () => {
      const t = (row as HTMLElement).dataset.ticker;
      if (t) openStockDetail(t);
    });
  });
}
