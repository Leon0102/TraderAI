"""Market database, scores, validation, forward test and market-wide views."""

import threading as _threading
from datetime import date, timedelta
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Request

import market_views
import quant_service
from agents.council import validate_ticker
from guards import _require_local

router = APIRouter()

_market_cache: dict = {}


@router.get("/api/quant/status")
def api_quant_status():
    return quant_service.status()


@router.post("/api/quant/ingest")
def api_quant_ingest(request: Request, quick: bool = Query(default=False)):
    _require_local(request)  # heavy job: only from this machine
    if quant_service.status().get("running"):
        return {"started": False, "message": "Đang chạy."}
    _threading.Thread(target=quant_service.run_pipeline, kwargs={"quick": quick}, daemon=True).start()
    _market_cache.clear()
    return {"started": True}


def _need_data():
    if not quant_service.available():
        raise HTTPException(status_code=404, detail={"message": "Chưa có dữ liệu thị trường — bấm 'Nạp dữ liệu'.", "needs_login": False})


@router.get("/api/quant/screener")
def api_quant_screener(sector: Optional[str] = None, grade: Optional[str] = Query(default=None, pattern="^[A-F]$"),
                       limit: int = Query(default=100, ge=1, le=400)):
    _need_data()
    return quant_service.screener(sector, grade, limit)


@router.get("/api/quant/stock/{ticker}")
def api_quant_stock(ticker: str):
    _need_data()
    try:
        validate_ticker(ticker)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    card = quant_service.stock_card(ticker)
    if not card:
        raise HTTPException(status_code=404, detail={"message": "Mã này chưa đủ thanh khoản hoặc chưa có BCTC để chấm điểm.", "needs_login": False})
    return card


@router.get("/api/quant/validation")
def api_quant_validation():
    _need_data()
    v = quant_service.validation_summary()
    if not v:
        raise HTTPException(status_code=404, detail={"message": "Chưa chạy kiểm định.", "needs_login": False})
    return v


@router.get("/api/quant/council-score")
def api_quant_council_score():
    _need_data()
    import council_log
    log = council_log.load()
    tickers = sorted({e["ticker"] for e in log.values()}) + ["VNINDEX"]
    import market_db
    return council_log.score(log, market_db.price_panel(tickers, since=(date.today() - timedelta(days=400)).isoformat()))


@router.get("/api/quant/forward")
def api_quant_forward():
    _need_data()
    return quant_service.forward_status()


@router.get("/api/quant/market")
def api_quant_market():
    _need_data()
    import time as _time
    hit = _market_cache.get("views")
    if not hit or _time.time() - hit[0] > 600:
        _market_cache["views"] = (_time.time(), market_views.all_views())
    return _market_cache["views"][1]
