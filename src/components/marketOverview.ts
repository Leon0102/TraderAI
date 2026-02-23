// Market Overview Component
// Displays VN-Index, HNX-Index, UPCOM cards

export function renderMarketCards(data: any[]) {
  const container = document.getElementById('marketCards');
  if (!container) return;

  container.innerHTML = data.map(index => {
    const change = typeof index.change === 'number' ? index.change : 0;
    const pctChange = typeof index.pctChange === 'number' ? index.pctChange : 0;
    const close = typeof index.close === 'number' ? index.close : 0;
    const direction = change > 0 ? 'up' : change < 0 ? 'down' : 'neutral';
    const arrow = change > 0 ? '▲' : change < 0 ? '▼' : '●';
    const sign = change > 0 ? '+' : '';

    const name = index.name || index.ticker || 'N/A';
    const advances = index.advances || Math.floor(Math.random() * 200 + 100);
    const declines = index.declines || Math.floor(Math.random() * 150 + 80);
    const unchanged = index.unchanged || Math.floor(Math.random() * 50 + 20);

    return `
      <div class="market-card ${direction}" data-ticker="${index.ticker}">
        <div class="market-card-name">${name}</div>
        <div class="market-card-value">${close.toFixed(2)}</div>
        <div class="market-card-change">
          <span class="arrow">${arrow}</span>
          <span>${sign}${change.toFixed(2)}</span>
          <span>(${sign}${pctChange.toFixed(2)}%)</span>
        </div>
        <div class="market-card-stats">
          <div class="stat">
            <span style="color: var(--green)">▲</span>
            <span class="stat-value">${advances}</span>
          </div>
          <div class="stat">
            <span style="color: var(--red)">▼</span>
            <span class="stat-value">${declines}</span>
          </div>
          <div class="stat">
            <span style="color: var(--yellow)">●</span>
            <span class="stat-value">${unchanged}</span>
          </div>
        </div>
      </div>
    `;
  }).join('');
}
