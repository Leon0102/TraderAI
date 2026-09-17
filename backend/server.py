"""
TraderAI Backend - FastAPI server for local development.

This is a thin HTTP wrapper around the same data-fetching logic used by the
Vercel serverless functions in api/*.py, so there is a single source of
truth for how TCBS/vnstock data is fetched, cached, and normalized.
Run: python3 backend/server.py
"""

import warnings
warnings.filterwarnings('ignore')

import os
import sys
from datetime import datetime, timedelta
from typing import Optional

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

os.environ['PYTHONDONTWRITEBYTECODE'] = '1'

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'api'))
from market import get_market_overview, get_market_analysis  # noqa: E402
from stocks import get_top_stocks, get_symbols  # noqa: E402
from finance import get_finance  # noqa: E402
from history import get_history  # noqa: E402
from news import get_news as _get_news  # noqa: E402

app = FastAPI(title="TraderAI API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/market")
def api_market(action: Optional[str] = Query(default=None)):
    # Matches api/market.py's query-param convention (?action=analysis),
    # since the frontend calls this same path either way.
    return get_market_analysis() if action == 'analysis' else get_market_overview()


@app.get("/api/stocks")
def api_stocks(count: int = Query(default=20, ge=1, le=50), action: Optional[str] = Query(default=None)):
    # ?action=symbols -> every listed stock, for search autocomplete
    return get_symbols() if action == 'symbols' else get_top_stocks(count)


@app.get("/api/history")
def api_history(
    ticker: str = Query(..., description="Stock ticker symbol"),
    start: Optional[str] = Query(default=None, description="Start date YYYY-MM-DD"),
    end: Optional[str] = Query(default=None, description="End date YYYY-MM-DD"),
):
    if not end:
        end = datetime.now().strftime('%Y-%m-%d')
    if not start:
        start = (datetime.now() - timedelta(days=120)).strftime('%Y-%m-%d')
    return get_history(ticker, start, end)


@app.get("/api/finance")
def api_finance(ticker: str = Query(...)):
    return get_finance(ticker)


@app.get("/api/listing")
def api_listing():
    """Get all listed stocks using vnstock (no TCBS equivalent, kept local-only)."""
    try:
        from vnstock import listing_companies
        df = listing_companies()
        stocks = []
        for _, row in df.iterrows():
            stocks.append({
                "ticker": row.get('ticker', ''),
                "name": row.get('organShortName', row.get('organName', '')),
                "exchange": row.get('comGroupCode', ''),
                "industry": row.get('icbName', ''),
                "vn30": bool(row.get('VN30', False)),
            })
        return {"data": stocks, "total": len(stocks), "source": "vnstock"}
    except Exception as e:
        return {"data": [], "total": 0, "source": "error", "error": str(e)}


@app.get("/api/news")
def api_news(
    ticker: Optional[str] = Query(default=None),
    tickers: Optional[str] = Query(default=None),
    action: Optional[str] = Query(default=None),
):
    return _get_news(ticker=ticker, tickers=tickers, action=action)


# ==========================================
# Multi-Agent Council Endpoints (TradingAgents)
# ==========================================
import json  # noqa: E402

from fastapi import HTTPException  # noqa: E402
from fastapi.responses import StreamingResponse  # noqa: E402
from pydantic import BaseModel  # noqa: E402


def _load_env_files():
    """Minimal .env loader (backend/.env, then project .env) so GEMINI_API_KEY / OPENAI_API_KEY work locally."""
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    for path in (os.path.join(root, 'backend', '.env'), os.path.join(root, '.env')):
        if not os.path.isfile(path):
            continue
        with open(path, encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                key, _, value = line.partition('=')
                os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_env_files()

sys.path.insert(0, os.path.dirname(__file__))
from agents.council import AgentCouncil, validate_ticker  # noqa: E402
from agents.llm import DEFAULT_MODELS  # noqa: E402


class AgentAnalyzeRequest(BaseModel):
    ticker: str
    provider: Optional[str] = "gemini"
    # Sent in the body (never the URL) so keys don't end up in access logs
    apiKey: Optional[str] = None
    model: Optional[str] = None


def _council_for(req: AgentAnalyzeRequest) -> AgentCouncil:
    try:
        validate_ticker(req.ticker)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return AgentCouncil(provider=req.provider or "gemini", api_key=req.apiKey, model=req.model)


@app.get("/api/agents/config")
def api_agents_config():
    gemini_env = bool(os.environ.get("GEMINI_API_KEY"))
    openai_env = bool(os.environ.get("OPENAI_API_KEY"))
    return {
        "has_gemini_env": gemini_env,
        "has_openai_env": openai_env,
        "active_provider": "gemini" if gemini_env else ("openai" if openai_env else "heuristic"),
        "default_models": DEFAULT_MODELS,
    }


@app.post("/api/agents/analyze")
def api_agents_analyze(req: AgentAnalyzeRequest):
    return _council_for(req).run_council(req.ticker)


@app.post("/api/agents/stream")
def api_agents_stream(req: AgentAnalyzeRequest):
    council = _council_for(req)

    def event_generator():
        try:
            for event in council.run_council_stream(req.ticker):
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
        except Exception as e:  # surface failures to the UI instead of silently cutting the stream
            err = {"type": "error", "message": f"Lỗi hội đồng AI: {e}"}
            yield f"data: {json.dumps(err, ensure_ascii=False)}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


if __name__ == "__main__":
    print("🚀 TraderAI Backend starting...")
    print("📊 Reusing api/*.py data-fetching logic (SSI + DNSE + Vietcap)")
    print("🤖 Multi-Agent Council (TradingAgents) enabled at /api/agents/*")
    print("🌐 API docs: http://localhost:8000/docs")
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")
