// News Sentiment Analysis Engine
// Processes news articles to generate sentiment signals and impact modifiers

import type { NewsArticle, SentimentSummary } from '../api/stockApi';

export interface NewsSignal {
  ticker: string;
  sentimentScore: number;        // -100 to +100
  sentimentLabel: 'positive' | 'negative' | 'neutral';
  momentum: 'IMPROVING' | 'WORSENING' | 'STABLE';
  impactModifier: number;        // -20 to +20 (applied to combined score)
  confidence: number;            // 0-100
  catalysts: string[];           // key event descriptions
  topHeadline: string;           // most relevant headline
  articleCount: number;
}

/**
 * Analyze news sentiment for a specific ticker.
 * Returns a NewsSignal with sentiment strength, momentum, and impact modifier.
 */
export function analyzeNewsSentiment(
  articles: NewsArticle[],
  sentiment: SentimentSummary,
  ticker: string
): NewsSignal {
  // Filter ticker-specific articles
  const tickerArticles = articles.filter(a => a.relatedTickers.includes(ticker));
  const hasTickerNews = tickerArticles.length > 0;

  // Sentiment score: use ticker-specific if available, otherwise market-wide
  const sentimentScore = hasTickerNews
    ? Math.round(tickerArticles.reduce((s, a) => s + a.sentiment, 0) / tickerArticles.length)
    : Math.round(sentiment.overall * 0.3); // dilute market sentiment for specific ticker

  // Momentum: compare recent vs older articles
  const recentArticles = tickerArticles.slice(0, Math.ceil(tickerArticles.length / 2));
  const olderArticles = tickerArticles.slice(Math.ceil(tickerArticles.length / 2));
  let momentum: 'IMPROVING' | 'WORSENING' | 'STABLE' = sentiment.trend;

  if (recentArticles.length > 0 && olderArticles.length > 0) {
    const recentAvg = recentArticles.reduce((s, a) => s + a.sentiment, 0) / recentArticles.length;
    const olderAvg = olderArticles.reduce((s, a) => s + a.sentiment, 0) / olderArticles.length;
    if (recentAvg > olderAvg + 15) momentum = 'IMPROVING';
    else if (recentAvg < olderAvg - 15) momentum = 'WORSENING';
    else momentum = 'STABLE';
  }

  // Impact modifier: how much news should affect the combined score
  // Range: -20 to +20
  let impact = 0;
  if (hasTickerNews) {
    // Direct news about the ticker has stronger impact
    impact = Math.round(sentimentScore * 0.2);

    // Event-based amplification
    const events = tickerArticles.map(a => a.eventType);
    if (events.includes('EARNINGS')) impact = Math.round(impact * 1.5);
    if (events.includes('M&A')) impact = Math.round(impact * 1.3);
    if (events.includes('INSIDER')) impact = Math.round(impact * 1.2);
    if (events.includes('DIVIDEND') && sentimentScore > 0) impact += 3;
    if (events.includes('REGULATION')) impact = Math.round(impact * 1.1);
  } else {
    // Only market-wide news: smaller impact
    impact = Math.round(sentimentScore * 0.08);
  }
  impact = Math.max(-20, Math.min(20, impact));

  // Confidence: based on article count and consistency
  const consistency = tickerArticles.length > 1
    ? 1 - (tickerArticles.reduce((s, a) => s + Math.abs(a.sentiment - sentimentScore), 0) / (tickerArticles.length * 100))
    : 0.5;
  const confidence = Math.min(100, Math.round(
    (hasTickerNews ? 40 : 10) +
    Math.min(tickerArticles.length * 10, 30) +
    consistency * 30
  ));

  // Catalysts: extract event descriptions
  const catalysts: string[] = [];
  for (const art of tickerArticles.slice(0, 3)) {
    const eventLabel = getEventLabel(art.eventType);
    const sentLabel = art.sentiment > 15 ? '🟢' : art.sentiment < -15 ? '🔴' : '🟡';
    catalysts.push(`${sentLabel} ${eventLabel}: ${art.title.slice(0, 60)}`);
  }

  // Top headline
  const topHeadline = tickerArticles.length > 0
    ? tickerArticles[0].title
    : (articles.length > 0 ? articles[0].title : '');

  return {
    ticker,
    sentimentScore,
    sentimentLabel: sentimentScore > 15 ? 'positive' : sentimentScore < -15 ? 'negative' : 'neutral',
    momentum,
    impactModifier: impact,
    confidence,
    catalysts,
    topHeadline,
    articleCount: tickerArticles.length,
  };
}

/**
 * Calculate how news should modify the combined investment score.
 * Considers alignment between news sentiment and technical/fundamental signals.
 */
export function calculateNewsImpact(
  newsSignal: NewsSignal,
  techScore: number,     // 0-100
  fundScore: number      // 0-100
): number {
  let modifier = newsSignal.impactModifier;

  // Amplify when news aligns with other signals
  const avgSignal = (techScore + fundScore) / 2;
  const bullish = avgSignal > 60;
  const bearish = avgSignal < 40;

  if (bullish && newsSignal.sentimentScore > 20) {
    // All signals agree bullish → stronger boost
    modifier = Math.round(modifier * 1.3);
  } else if (bearish && newsSignal.sentimentScore < -20) {
    // All signals agree bearish → stronger penalty
    modifier = Math.round(modifier * 1.3);
  } else if ((bullish && newsSignal.sentimentScore < -20) || (bearish && newsSignal.sentimentScore > 20)) {
    // Divergence between news and other signals → moderate the impact
    modifier = Math.round(modifier * 0.7);
  }

  // Momentum adjustment
  if (newsSignal.momentum === 'IMPROVING') modifier += 2;
  else if (newsSignal.momentum === 'WORSENING') modifier -= 2;

  return Math.max(-20, Math.min(20, modifier));
}

/**
 * Get Vietnamese label for event type.
 */
function getEventLabel(eventType: string): string {
  const labels: Record<string, string> = {
    'EARNINGS': 'KQKD',
    'DIVIDEND': 'Cổ tức',
    'M&A': 'M&A',
    'INSIDER': 'Nội bộ',
    'REGULATION': 'Chính sách',
    'INDUSTRY': 'Ngành',
    'MARKET': 'Thị trường',
  };
  return labels[eventType] || eventType;
}
