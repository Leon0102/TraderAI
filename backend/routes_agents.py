"""Multi-agent council endpoints (TradingAgents)."""

import json
import os
from typing import Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from agents.council import AgentCouncil, validate_ticker
from agents.llm import DEFAULT_MODELS

router = APIRouter()


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


@router.get("/api/agents/config")
def api_agents_config():
    gemini_env = bool(os.environ.get("GEMINI_API_KEY"))
    openai_env = bool(os.environ.get("OPENAI_API_KEY"))
    return {
        "has_gemini_env": gemini_env,
        "has_openai_env": openai_env,
        "active_provider": "gemini" if gemini_env else ("openai" if openai_env else "heuristic"),
        "default_models": DEFAULT_MODELS,
    }


def _log_council(ticker: str, structured: dict, price, engine=None) -> None:
    try:
        import council_log
        council_log.log_verdict(ticker, structured, price, engine)
    except Exception:  # the track record is a bonus; never break the council over it
        pass


@router.post("/api/agents/analyze")
def api_agents_analyze(req: AgentAnalyzeRequest):
    result = _council_for(req).run_council(req.ticker)
    structured = (result.get("verdict") or {}).get("structured")
    if structured:
        _log_council(req.ticker, structured, (result.get("context") or {}).get("price"), (result.get("engines") or {}).get("portfolio_manager"))
    return result


@router.post("/api/agents/stream")
def api_agents_stream(req: AgentAnalyzeRequest):
    council = _council_for(req)

    def event_generator():
        price = None
        try:
            for event in council.run_council_stream(req.ticker):
                if event.get("type") == "context":
                    price = (event.get("data") or {}).get("price")
                elif event.get("type") == "final_verdict" and event.get("structured"):
                    _log_council(req.ticker, event["structured"], price, event.get("engine"))
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
