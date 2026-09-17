"""
Tests for TraderAI Agent Council.
Run: python3 -m backend.agents.test_council          (from project root)
     python3 -m backend.agents.test_council --offline (skip live-data runs)
"""

import os
import sys

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from backend.agents.council import AgentCouncil, parse_decision, validate_ticker  # noqa: E402
from backend.agents import llm as llm_module  # noqa: E402
from backend.agents.llm import LLMError, resolve_api_key, generate_heuristic_response  # noqa: E402

REQUIRED_AGENTS = {"technical", "fundamental", "sentiment", "bull", "bear"}


def test_parse_decision_plain():
    text = (
        "HÀNH ĐỘNG: MUA\nVÙNG GIÁ GOM: 21.000 - 21.300 đ\nGIÁ MỤC TIÊU (TARGET): 23.500 đ\n"
        "ĐIỂM CẮT LỖ (STOP-LOSS): 19.900 đ\nTỶ TRỌNG ĐỀ XUẤT: 15%\nMỨC ĐỘ RỦI RO: Thấp\n"
        "KẾT LUẬN & CHIẾN LƯỢC: Mua dần.\nDòng thứ hai."
    )
    d = parse_decision(text, 21200)
    assert d["action"] == "MUA"
    assert d["entry_zone"] == "21.000 - 21.300 đ"
    assert d["target_price"] == "23.500 đ"
    assert d["stop_loss"] == "19.900 đ"
    assert d["sizing"] == "15%"
    assert d["risk_level"] == "Thấp"
    assert "Dòng thứ hai" in d["summary"]


def test_parse_decision_markdown():
    text = "**HÀNH ĐỘNG:** BÁN\n- **VÙNG GIÁ GOM:** N/A\n**KẾT LUẬN & CHIẾN LƯỢC:** Hạ tỷ trọng."
    d = parse_decision(text, 50000)
    assert d["action"] == "BÁN"
    assert d["entry_zone"] == "N/A"
    assert d["summary"] == "Hạ tỷ trọng."


def test_parse_decision_quan_sat_default():
    assert parse_decision("Không rõ", 10000)["action"] == "QUAN SÁT"
    # "MUA" inside "QUAN SÁT, chưa MUA" must not be read as a buy
    assert parse_decision("HÀNH ĐỘNG: QUAN SÁT, chưa MUA", 10000)["action"] == "QUAN SÁT"


def test_validate_ticker():
    assert validate_ticker(" hpg ") == "HPG"
    for bad in ("", "H", "HPG;DROP", "../etc"):
        try:
            validate_ticker(bad)
        except ValueError:
            continue
        raise AssertionError(f"accepted invalid ticker {bad!r}")


def test_resolve_api_key_is_provider_specific():
    os.environ["GEMINI_API_KEY"] = "g-key"
    os.environ.pop("OPENAI_API_KEY", None)
    try:
        assert resolve_api_key("gemini") == "g-key"
        assert resolve_api_key("openai") is None, "Gemini key must not be sent to OpenAI"
        assert resolve_api_key("openai", "user-key") == "user-key"
    finally:
        os.environ.pop("GEMINI_API_KEY", None)


def test_heuristic_sell_on_weak_context():
    ctx = {
        "ticker": "XYZ", "exchange": "HNX", "price_limit_pct": 10, "foreign_net_volume": -5000,
        "technicals": {"available": True, "price": 10000, "sma20": 11000, "sma50": 12000, "sma200": 14000,
                       "rsi14": 45, "macd_hist": -50, "volume_ratio": 2.0, "change_5d": -6,
                       "low_20d": 9800, "high_20d": 11500, "bb_lower": 9500},
        "fundamentals": {"pe": -3, "roe": 2, "eps_growth": -40, "debt_to_equity": 2.5},
        "news_sentiment": {"score": -40, "trend": "WORSENING", "key_events": []},
    }
    verdict = parse_decision(generate_heuristic_response("portfolio_manager", ctx), 10000)
    assert verdict["action"] == "BÁN", verdict


def test_transient_llm_error_retries_then_keeps_llm_for_later_agents():
    """A 503 must not knock every remaining agent down to heuristic."""
    calls = []
    original = llm_module.call_llm
    original_backoff = llm_module.RETRY_BACKOFF_SECONDS
    llm_module.RETRY_BACKOFF_SECONDS = (0, 0)

    def fake_call_llm(**kwargs):
        calls.append(kwargs)
        if len(calls) <= 1:  # first agent only (call_llm already exhausted its own retries)
            raise LLMError("Gemini lỗi: 503 UNAVAILABLE high demand", retryable=True)
        return "Báo cáo giả lập."

    import backend.agents.council as council_module
    council_module.call_llm = fake_call_llm
    try:
        c = AgentCouncil(provider="gemini", api_key="k")
        ctx = {"ticker": "AAA", "technicals": {}, "fundamentals": {}, "news_sentiment": {}}
        first = c._execute_agent("technical", "sys", "user", ctx)
        second = c._execute_agent("fundamental", "sys", "user", ctx)
        assert first["engine"] == "heuristic", first
        assert second["engine"].startswith("gemini"), second
        assert c.mode == "llm"

        permanent = AgentCouncil(provider="gemini", api_key="k")
        council_module.call_llm = lambda **kw: (_ for _ in ()).throw(LLMError("API key not valid", retryable=False))
        permanent._execute_agent("technical", "sys", "user", ctx)
        assert permanent.mode == "heuristic", "a bad key must disable the LLM"
    finally:
        council_module.call_llm = original
        llm_module.RETRY_BACKOFF_SECONDS = original_backoff


def test_llm_retries_transient_errors():
    attempts = {"n": 0}
    original_once = llm_module._call_llm_once
    llm_module.RETRY_BACKOFF_SECONDS = (0, 0)

    def flaky(*a, **kw):
        attempts["n"] += 1
        if attempts["n"] < 3:
            raise LLMError("503 overloaded", retryable=True)
        return "ok"

    llm_module._call_llm_once = flaky
    try:
        assert llm_module.call_llm("p", "s", "gemini", "k") == "ok"
        assert attempts["n"] == 3
    finally:
        llm_module._call_llm_once = original_once


def run_live(ticker: str, provider: str = "gemini", api_key=None):
    result = AgentCouncil(provider=provider, api_key=api_key).run_council(ticker)
    assert result["context"].get("price"), f"{ticker}: no price in context"
    assert REQUIRED_AGENTS <= set(result["reports"]), f"{ticker}: missing reports {result['reports'].keys()}"
    assert all(result["reports"][a].strip() for a in REQUIRED_AGENTS)
    assert result["verdict"]["structured"]["action"] in ("MUA", "BÁN", "QUAN SÁT")
    return result


def main():
    unit_tests = [v for k, v in globals().items() if k.startswith("test_")]
    for t in unit_tests:
        t()
        print(f"✓ {t.__name__}")

    if "--offline" in sys.argv:
        return

    for ticker in ("HPG", "FPT", "VNM"):
        r = run_live(ticker)
        c, v = r["context"], r["verdict"]["structured"]
        print(f"✓ live {ticker} [{r['mode']}] {c['exchange']} {c['price']:,} đ → {v['action']} | "
              f"gom {v['entry_zone']} | TP {v['target_price']} | SL {v['stop_loss']} | {v['sizing']}")

    # Invalid key must degrade to heuristic with a warning, not crash
    r = run_live("HPG", provider="openai", api_key="sk-invalid")
    assert r["mode"] == "llm" and set(r["engines"].values()) == {"heuristic"} and r["warnings"], r
    print(f"✓ invalid key falls back to heuristic ({r['warnings'][0][:70]}...)")

    print("\n✅ All AgentCouncil tests passed!")


if __name__ == "__main__":
    main()
