// News Feed Component
// Renders a market news timeline with sentiment badges, event filters, and article cards

import type { NewsArticle, SentimentSummary } from '../api/stockApi';
import { openStockDetail } from './stockDetail';

let currentFilter: string = 'ALL';

export function renderNewsFeed(articles: NewsArticle[], sentiment: SentimentSummary) {
  const container = document.getElementById('newsContent');
  if (!container) return;

  const sentimentClass = sentiment.label === 'positive' ? 'sentiment-positive' :
                         sentiment.label === 'negative' ? 'sentiment-negative' : 'sentiment-neutral';
  const sentimentEmoji = sentiment.label === 'positive' ? '🟢' :
                         sentiment.label === 'negative' ? '🔴' : '🟡';
  const trendEmoji = sentiment.trend === 'IMPROVING' ? '↑' :
                     sentiment.trend === 'WORSENING' ? '↓' : '→';

  // Event type filters
  const eventTypes = ['ALL', ...new Set(articles.map(a => a.eventType).filter(Boolean))];

  const filterHtml = eventTypes.map(type => {
    const label = getEventFilterLabel(type);
    return `<button class="news-filter-btn ${type === currentFilter ? 'active' : ''}" data-filter="${type}">${label}</button>`;
  }).join('');

  // Filter articles
  const filtered = currentFilter === 'ALL'
    ? articles
    : articles.filter(a => a.eventType === currentFilter);

  const articlesHtml = filtered.slice(0, 8).map(article => {
    const sentClass = article.sentiment > 15 ? 'news-pos' :
                      article.sentiment < -15 ? 'news-neg' : 'news-neu';
    const sentIcon = article.sentiment > 15 ? '🟢' :
                     article.sentiment < -15 ? '🔴' : '🟡';
    const timeAgo = getTimeAgo(article.publishedAt);
    const eventTag = article.eventType && article.eventType !== 'MARKET'
      ? `<span class="news-event-tag">${getEventLabel(article.eventType)}</span>`
      : '';
    const tickerTags = article.relatedTickers.slice(0, 3).map(t =>
      `<span class="news-ticker-tag" data-ticker="${t}">${t}</span>`
    ).join('');

    return `
      <div class="news-card ${sentClass}">
        <div class="news-card-header">
          <span class="news-sentiment-icon">${sentIcon}</span>
          <span class="news-source">${article.source}</span>
          <span class="news-time">${timeAgo}</span>
        </div>
        <div class="news-card-title">${escapeHtml(article.title)}</div>
        ${article.summary ? `<div class="news-card-summary">${escapeHtml(article.summary)}</div>` : ''}
        <div class="news-card-footer">
          <div class="news-tags">
            ${eventTag}
            ${tickerTags}
          </div>
          <span class="news-sentiment-score">${article.sentiment > 0 ? '+' : ''}${article.sentiment}</span>
        </div>
      </div>
    `;
  }).join('');

  container.innerHTML = `
    <div class="news-summary-bar ${sentimentClass}">
      <div class="news-summary-left">
        <span class="news-summary-emoji">${sentimentEmoji}</span>
        <span class="news-summary-label">Sentiment thị trường: <strong>${sentiment.overall > 0 ? '+' : ''}${sentiment.overall}</strong></span>
        <span class="news-summary-trend">${trendEmoji} ${sentiment.trend === 'IMPROVING' ? 'Cải thiện' : sentiment.trend === 'WORSENING' ? 'Xấu đi' : 'Ổn định'}</span>
      </div>
      <div class="news-summary-right">
        <span class="news-count-pos">🟢 ${sentiment.positiveCount}</span>
        <span class="news-count-neg">🔴 ${sentiment.negativeCount}</span>
        <span class="news-count-neu">🟡 ${sentiment.neutralCount}</span>
      </div>
    </div>
    <div class="news-filters">${filterHtml}</div>
    <div class="news-grid">${articlesHtml}</div>
    ${filtered.length > 8 ? `<button class="news-load-more" id="loadMoreNews">Xem thêm (${filtered.length - 8} tin)</button>` : ''}
  `;

  // Attach event handlers
  container.querySelectorAll('.news-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      currentFilter = (btn as HTMLElement).dataset.filter || 'ALL';
      renderNewsFeed(articles, sentiment);
    });
  });

  container.querySelectorAll('.news-ticker-tag').forEach(tag => {
    tag.addEventListener('click', (e) => {
      e.stopPropagation();
      const ticker = (tag as HTMLElement).dataset.ticker;
      if (ticker) openStockDetail(ticker);
    });
  });
}

function getEventFilterLabel(type: string): string {
  const labels: Record<string, string> = {
    ALL: '📰 Tất cả',
    EARNINGS: '📊 KQKD',
    DIVIDEND: '💰 Cổ tức',
    'M&A': '🤝 M&A',
    INSIDER: '👤 Nội bộ',
    REGULATION: '📋 Quy định',
    INDUSTRY: '🏭 Ngành',
    MARKET: '📈 Thị trường',
  };
  return labels[type] || type;
}

function getEventLabel(type: string): string {
  const labels: Record<string, string> = {
    EARNINGS: 'KQKD',
    DIVIDEND: 'Cổ tức',
    'M&A': 'M&A',
    INSIDER: 'Nội bộ',
    REGULATION: 'Quy định',
    INDUSTRY: 'Ngành',
    MARKET: 'Thị trường',
  };
  return labels[type] || type;
}

function getTimeAgo(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 60) return `${diffMins} phút trước`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours} giờ trước`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays} ngày trước`;
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
