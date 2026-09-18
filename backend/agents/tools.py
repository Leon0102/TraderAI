"""
Data Tools for Vietnam Stock Market (TraderAI Agent Council).
Interfaces with existing TraderAI data extractors (Vietcap, TCBS, News Crawler)
and condenses them into a compact, LLM-friendly context. All prices are in VND.
"""

import os
import time
import sys
from datetime import datetime, timedelta
from typing import Dict, Any, List, Optional

API_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "api"))
if API_DIR not in sys.path:
    sys.path.insert(0, API_DIR)

from history import get_history  # noqa: E402
from finance import get_finance  # noqa: E402
from news import get_news  # noqa: E402
from market import get_market_overview  # noqa: E402
from _vci import price_board as vci_price_board  # noqa: E402
from _ssi import price_board as ssi_price_board  # noqa: E402

# Daily price limits by exchange (VCI board code -> (display name, limit %))
EXCHANGE_LIMITS = {
    "HSX": ("HOSE", 7),
    "HOSE": ("HOSE", 7),
    "HNX": ("HNX", 10),
    "UPCOM": ("UPCoM", 15),
}


def _to_vnd(price: Optional[float]) -> Optional[float]:
    """VCI/TCBS quote prices in thousand VND (21.2 = 21,200 đ). Normalize to VND."""
    if price is None:
        return None
    return price * 1000 if 0 < price < 1000 else price


def _sma(values: List[float], n: int) -> Optional[float]:
    return sum(values[-n:]) / n if len(values) >= n else None


def _ema_series(values: List[float], n: int) -> List[float]:
    k = 2 / (n + 1)
    out = [values[0]]
    for v in values[1:]:
        out.append(v * k + out[-1] * (1 - k))
    return out


def _rsi(closes: List[float], n: int = 14) -> Optional[float]:
    """Wilder's RSI."""
    if len(closes) <= n:
        return None
    gains = [max(closes[i] - closes[i - 1], 0) for i in range(1, len(closes))]
    losses = [max(closes[i - 1] - closes[i], 0) for i in range(1, len(closes))]
    avg_gain = sum(gains[:n]) / n
    avg_loss = sum(losses[:n]) / n
    for g, l in zip(gains[n:], losses[n:]):
        avg_gain = (avg_gain * (n - 1) + g) / n
        avg_loss = (avg_loss * (n - 1) + l) / n
    if avg_loss == 0:
        return 100.0
    return round(100 - 100 / (1 + avg_gain / avg_loss), 1)


def calculate_indicators(bars: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Key technical indicators from daily bars. Prices returned in VND."""
    closes = [_to_vnd(float(b.get("close") or 0)) for b in bars if b.get("close")]
    if len(closes) < 20:
        return {"available": False, "bars": len(closes)}

    highs = [_to_vnd(float(b.get("high") or 0)) for b in bars if b.get("close")]
    lows = [_to_vnd(float(b.get("low") or 0)) for b in bars if b.get("close")]
    volumes = [float(b.get("volume") or 0) for b in bars if b.get("close")]
    price = closes[-1]

    sma20, sma50, sma200 = _sma(closes, 20), _sma(closes, 50), _sma(closes, 200)

    macd = macd_signal = macd_hist = None
    if len(closes) >= 35:
        ema12, ema26 = _ema_series(closes, 12), _ema_series(closes, 26)
        macd_line = [a - b for a, b in zip(ema12, ema26)]
        signal_line = _ema_series(macd_line[25:], 9)
        macd, macd_signal = macd_line[-1], signal_line[-1]
        macd_hist = macd - macd_signal

    window = closes[-20:]
    std20 = (sum((c - sma20) ** 2 for c in window) / 20) ** 0.5
    bb_upper, bb_lower = sma20 + 2 * std20, sma20 - 2 * std20

    avg_vol20 = sum(volumes[-20:]) / 20
    vol_ratio = round(volumes[-1] / avg_vol20, 2) if avg_vol20 > 0 else 1.0

    def pct_change(n: int) -> Optional[float]:
        if len(closes) > n and closes[-1 - n] > 0:
            return round((price / closes[-1 - n] - 1) * 100, 2)
        return None

    r = lambda v: round(v) if v is not None else None  # noqa: E731
    return {
        "available": True,
        "last_date": bars[-1].get("tradingDate", ""),
        "price": r(price),
        "sma20": r(sma20),
        "sma50": r(sma50),
        "sma200": r(sma200),
        "rsi14": _rsi(closes),
        "macd": round(macd, 1) if macd is not None else None,
        "macd_signal": round(macd_signal, 1) if macd_signal is not None else None,
        "macd_hist": round(macd_hist, 1) if macd_hist is not None else None,
        "bb_upper": r(bb_upper),
        "bb_lower": r(bb_lower),
        "volume": int(volumes[-1]),
        "volume_20d_avg": int(avg_vol20),
        "volume_ratio": vol_ratio,
        "high_20d": r(max(highs[-20:])),
        "low_20d": r(min(lows[-20:])),
        "high_52w": r(max(highs[-250:])),
        "low_52w": r(min(lows[-250:])),
        "change_5d": pct_change(5),
        "change_20d": pct_change(20),
        "change_60d": pct_change(60),
    }


def _quote_info(ticker: str) -> Dict[str, Any]:
    """Exchange, ceiling/floor and today's foreign flow from the VCI price board."""
    rows = []
    for attempt in range(3):
        try:
            rows = ssi_price_board([ticker]) or vci_price_board([ticker])
        except Exception:
            rows = []
        if rows:
            break
        time.sleep(1.0 * (attempt + 1))
    if not rows:
        return {}
    row = rows[0]
    board = (row.get("board") or "").upper()
    exchange, limit = EXCHANGE_LIMITS.get(board, (board or "N/A", 7))
    return {
        "company_name": row.get("companyName", ""),
        "exchange": exchange,
        "price_limit_pct": limit,
        "ceiling": row.get("ceiling"),
        "floor": row.get("floor"),
        "ref_price": row.get("refPrice"),
        "foreign_buy_volume": row.get("foreignBuyVolume", 0),
        "foreign_sell_volume": row.get("foreignSellVolume", 0),
        "foreign_net_volume": row.get("foreignNetVolume", 0),
    }


def _vnindex_summary() -> str:
    try:
        overview = get_market_overview()
    except Exception:
        return "Không lấy được dữ liệu VN-Index."
    rows = overview.get("data", []) if isinstance(overview, dict) else overview or []
    for idx in rows:
        if idx.get("ticker") == "VNINDEX" or idx.get("name") in ("VN-Index", "VNINDEX"):
            pct = idx.get("pctChange", 0) or 0
            return f"VN-Index: {idx.get('close')} điểm ({'+' if pct >= 0 else ''}{pct}% phiên gần nhất)"
    return "Không lấy được dữ liệu VN-Index."


def get_stock_context(ticker: str) -> Dict[str, Any]:
    """
    Comprehensive Vietnam stock context:
    technicals, fundamentals, news & sentiment, foreign flow, exchange rules, VN-Index.
    """
    ticker = ticker.upper().strip()
    end_date = datetime.now().strftime("%Y-%m-%d")
    # ~330 calendar days ≈ 225 sessions: enough for MA200 without an oversized request
    start_date = (datetime.now() - timedelta(days=330)).strftime("%Y-%m-%d")

    # VCI occasionally returns nothing under load (e.g. while the dashboard is fetching); retry before giving up
    hist = {}
    for attempt in range(3):
        hist = get_history(ticker, start_date, end_date)
        if hist.get("data"):
            break
        time.sleep(1.5 * (attempt + 1))
    technicals = calculate_indicators(hist.get("data", []))

    fin = (get_finance(ticker) or {}).get("data") or {}

    news_resp = get_news(ticker=ticker)
    articles = news_resp.get("articles", []) if isinstance(news_resp, dict) else []
    sentiment = news_resp.get("sentiment", {}) if isinstance(news_resp, dict) else {}
    headlines = []
    corporate_events = []
    corp_keywords = [
        "cổ tức", "chốt quyền", "gdkhq", "không hưởng quyền",
        "đhđcđ", "đại hội", "thưởng cổ phiếu", "phát hành", "tăng vốn", "trả cổ tức"
    ]
    for a in articles:
        title = (a.get("title") or "").strip()
        if not title:
            continue
        date = (a.get("publishedAt") or "")[:10]
        event_type = a.get("eventType", "N/A")
        t_lower = title.lower()

        if len(headlines) < 8:
            headlines.append(
                f"- [{a.get('source', '')} {date}] {title} "
                f"(sentiment {a.get('sentiment', 0)}, {event_type})"
            )

        if event_type in ("DIVIDEND", "EARNINGS", "INSIDER", "M&A") or any(k in t_lower for k in corp_keywords):
            corporate_events.append({
                "type": event_type if event_type != "N/A" else "SỰ KIỆN",
                "title": title,
                "date": date,
                "source": a.get("source", ""),
            })

    quote = _quote_info(ticker)
    net = quote.get("foreign_net_volume")
    if quote:
        side = "Mua ròng" if net > 0 else ("Bán ròng" if net < 0 else "Cân bằng")
        foreign_summary = (
            f"Phiên gần nhất: {side} {abs(net):,} cp "
            f"(mua {quote['foreign_buy_volume']:,} / bán {quote['foreign_sell_volume']:,})"
        )
    else:
        foreign_summary = "Không có số liệu giao dịch khối ngoại"

    return {
        "ticker": ticker,
        "date": end_date,
        "data_source": hist.get("source"),
        "company_name": quote.get("company_name", ""),
        "exchange": quote.get("exchange", "N/A"),
        "price_limit_pct": quote.get("price_limit_pct", 7),
        "ceiling": quote.get("ceiling"),
        "floor": quote.get("floor"),
        "market_context": _vnindex_summary(),
        "technicals": technicals,
        "fundamentals": {
            "pe": fin.get("pe"),
            "pb": fin.get("pb"),
            "roe": fin.get("roe"),
            "eps": fin.get("eps"),
            "net_margin": fin.get("netMargin"),
            "debt_to_equity": fin.get("debtOnEquity"),
            "current_ratio": fin.get("currentRatio"),
            "revenue_growth": fin.get("revenueGrowth"),
            "eps_growth": fin.get("epsGrowth"),
            "market_cap": fin.get("marketCap"),
            "dividend_yield": fin.get("dividendYield"),
        },
        "corporate_events": corporate_events[:5],
        "news_headlines": headlines,
        "news_sentiment": {
            "score": sentiment.get("overall", 0),
            "label": sentiment.get("label", "neutral"),
            "positive": sentiment.get("positiveCount", 0),
            "negative": sentiment.get("negativeCount", 0),
            "trend": sentiment.get("trend", "STABLE"),
            "key_events": sentiment.get("keyEvents", []),
        },
        "foreign_flow": foreign_summary,
        "foreign_net_volume": net or 0,
    }
