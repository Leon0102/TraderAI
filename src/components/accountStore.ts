// The latest real TCBS account snapshot, shared with every part of the app that needs account
// figures (virtual portfolio, capital allocator, AI council sizing). Filled after each sync.

export type AccountHolding = { ticker: string; quantity: number; avg_cost: number; price: number; market_value: number; weight_pct: number; pnl_pct: number };
export type AccountSnapshot = {
  synced_at: string;
  summary: { nav: number; cash: number; stock_value: number; withdrawable?: number; debt?: number };
  holdings: AccountHolding[];
};

const EVENT = 'tcbs-account';
let current: AccountSnapshot | null = null;

export function setAccount(snapshot: AccountSnapshot) {
  if (current?.synced_at === snapshot.synced_at && current.holdings.length === snapshot.holdings.length) return;
  current = snapshot;
  window.dispatchEvent(new CustomEvent<AccountSnapshot>(EVENT, { detail: snapshot }));
}

export function getAccount(): AccountSnapshot | null {
  return current;
}

/** Run `cb` now if an account is known, and again after every new sync. */
export function onAccount(cb: (snapshot: AccountSnapshot) => void) {
  if (current) cb(current);
  window.addEventListener(EVENT, e => cb((e as CustomEvent<AccountSnapshot>).detail));
}

/** Vietnamese price text ("28.000 - 28.500 đ", "28,5", "62,600") -> VND of the first number. */
export function firstPriceVnd(text: string): number | null {
  const m = text.match(/\d[\d.,]*/);
  if (!m) return null;
  const token = m[0];
  const n = /^\d{1,3}([.,]\d{3})+$/.test(token) ? Number(token.replace(/[.,]/g, '')) : Number(token.replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1000 ? n * 1000 : n;
}

/** Council sizing ("15% tổng tài sản") expressed in VND and round lots of the account's NAV. */
export function sizingText(sizing: string, entryZone: string, account: AccountSnapshot | null, ticker?: string): string {
  const pct = Number((sizing.match(/(\d+(?:[.,]\d+)?)\s*%/) || [])[1]?.replace(',', '.'));
  const price = firstPriceVnd(entryZone);
  if (!account || !pct || !price || account.summary.nav <= 0) return '';
  const amount = account.summary.nav * pct / 100;
  const shares = Math.floor(amount / price / 100) * 100;
  const held = ticker ? account.holdings.find(h => h.ticker === ticker) : undefined;
  const parts = [`≈ ${Math.round(amount).toLocaleString('vi-VN')} đ ≈ ${shares.toLocaleString('vi-VN')} cp theo NAV TCBS`];
  if (held) parts.push(`đang giữ ${held.quantity.toLocaleString('vi-VN')} cp (${held.weight_pct}% NAV)`);
  if (amount > account.summary.cash) parts.push('vượt tiền mặt hiện có');
  return parts.join(' · ');
}
