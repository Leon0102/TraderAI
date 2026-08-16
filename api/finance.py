"""Vercel serverless function: /api/finance"""
from http.server import BaseHTTPRequestHandler
import json
import warnings
warnings.filterwarnings('ignore')

import sys, os
from typing import Optional
sys.path.insert(0, os.path.dirname(__file__))
from _tcbs import tcbs_get
from _vci import financial_ratio, income_statement_years

# Income-statement fields come back as coded keys (isa1, isa2, ...) rather
# than names. Order verified against vnstock 4.0.6's fixed VCI row mapping
# and cross-checked against live values (revenue/net-profit/EPS magnitude
# and internal consistency: after-tax profit - minority interest ==
# attributable-to-parent).
ISA_NET_SALES = 'isa3'
ISA_EPS_BASIC = 'isa23'


def _get_finance_vci(ticker: str) -> Optional[dict]:
    """Fundamentals via VCI. Returns None on any failure."""
    ratio = financial_ratio(ticker)
    if not ratio:
        return None

    pe = ratio.get('pe') or 0
    pb = ratio.get('pb') or 0
    roe = round((ratio.get('roe') or 0) * 100, 2)
    dividend_yield = round((ratio.get('dividendYield') or 0) * 100, 2)
    debt_on_equity = ratio.get('debtPerEquity') or ratio.get('debtToEquity') or 0
    current_ratio = ratio.get('currentRatio') or 0
    net_margin = round((ratio.get('afterTaxProfitMargin') or 0) * 100, 2)
    market_cap = (ratio.get('marketCap') or 0) / 1_000_000_000  # VND -> billion VND

    eps = 0
    revenue_growth = 0
    eps_growth = 0
    try:
        years = income_statement_years(ticker)
        if len(years) >= 1:
            eps = years[-1].get(ISA_EPS_BASIC) or 0
        if len(years) >= 2:
            rev_last, rev_prev = years[-1].get(ISA_NET_SALES), years[-2].get(ISA_NET_SALES)
            if rev_last and rev_prev:
                revenue_growth = round((rev_last - rev_prev) / abs(rev_prev) * 100, 2)
            eps_last, eps_prev = years[-1].get(ISA_EPS_BASIC), years[-2].get(ISA_EPS_BASIC)
            if eps_last and eps_prev:
                eps_growth = round((eps_last - eps_prev) / abs(eps_prev) * 100, 2)
    except Exception:
        pass

    return {
        "ticker": ticker, "pe": round(pe, 2), "pb": round(pb, 2), "roe": roe,
        "eps": round(eps, 2), "revenue": 0,
        "revenueGrowth": revenue_growth, "epsGrowth": eps_growth,
        "marketCap": round(market_cap, 2),
        "dividendYield": dividend_yield, "debtOnEquity": round(debt_on_equity, 2),
        "netMargin": net_margin,
        "freeCashFlow": 0, "totalAssets": 0, "interestCoverage": 0,
        "currentRatio": round(current_ratio, 2), "industry": "",
    }


def get_finance(ticker: str) -> dict:
    """Fundamental overview for a ticker. Tries VCI first, falls back to TCBS. source: 'vci'|'tcbs'|'error'."""
    vci_data = _get_finance_vci(ticker)
    if vci_data:
        return {"data": vci_data, "source": "vci"}

    data = tcbs_get(f"/tcanalysis/v1/ticker/{ticker}/overview", ttl=300)
    if not data:
        return {"data": None, "source": "error"}

    roe = data.get("roe", 0)
    if isinstance(roe, (int, float)) and 0 < roe < 1:
        roe = round(roe * 100, 2)
    net_margin = data.get("netMargin", 0)
    if isinstance(net_margin, (int, float)) and 0 < net_margin < 1:
        net_margin = round(net_margin * 100, 2)
    eps_growth = data.get("epsGrowth", 0)
    if isinstance(eps_growth, (int, float)) and abs(eps_growth) < 5:
        eps_growth = round(eps_growth * 100, 2)
    rev_growth = data.get("revenueGrowth", 0)
    if isinstance(rev_growth, (int, float)) and abs(rev_growth) < 5:
        rev_growth = round(rev_growth * 100, 2)

    return {"data": {"ticker": data.get("ticker", ticker),
        "pe": data.get("pe", 0), "pb": data.get("pb", 0), "roe": roe,
        "eps": data.get("eps", 0), "revenue": data.get("revenue", 0),
        "revenueGrowth": rev_growth,
        "epsGrowth": eps_growth,
        "marketCap": data.get("marketCap", 0),
        "dividendYield": data.get("dividendYield", data.get("dividend", 0)),
        "debtOnEquity": data.get("debtOnEquity", data.get("debtToEquity", 0)),
        "netMargin": net_margin,
        "freeCashFlow": data.get("freeCashFlow", data.get("fcf", 0)),
        "totalAssets": data.get("totalAssets", data.get("asset", 0)),
        "interestCoverage": data.get("interestCoverage", 0),
        "currentRatio": data.get("currentRatio", 0),
        "industry": data.get("industry", data.get("industryEn", ""))
        }, "source": "tcbs"}


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        from urllib.parse import parse_qs, urlparse
        params = parse_qs(urlparse(self.path).query)
        ticker = params.get('ticker', ['FPT'])[0]

        result = get_finance(ticker)

        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(result).encode())
