"""
TradingAgents Investment Council for Vietnam Stock Market.
Orchestrates multi-agent debate and final investment verdict.
"""

import re
from typing import Dict, Any, Generator, Optional
from datetime import datetime

from .tools import get_stock_context
from .prompts import (
    TECHNICAL_ANALYST_PROMPT,
    FUNDAMENTAL_ANALYST_PROMPT,
    SENTIMENT_ANALYST_PROMPT,
    BULL_ANALYST_PROMPT,
    BEAR_ANALYST_PROMPT,
    PORTFOLIO_MANAGER_PROMPT,
    GROUNDING_RULES,
)
from .llm import (
    call_llm,
    generate_heuristic_response,
    normalize_provider,
    resolve_api_key,
    LLMError,
    DEFAULT_MODELS,
)

TICKER_RE = re.compile(r"^[A-Z0-9]{3,10}$")


def validate_ticker(ticker: str) -> str:
    t = (ticker or "").upper().strip()
    if not TICKER_RE.match(t):
        raise ValueError(f"Mã cổ phiếu không hợp lệ: {ticker!r}")
    return t


def _fmt(v: Any, suffix: str = "") -> str:
    if v is None:
        return "N/A"
    if isinstance(v, (int, float)) and abs(v) >= 1000:
        return f"{v:,.0f}{suffix}"
    return f"{v}{suffix}"


class AgentCouncil:
    def __init__(self, provider: str = "gemini", api_key: Optional[str] = None, model: Optional[str] = None):
        self.provider = normalize_provider(provider)
        self.api_key = resolve_api_key(self.provider, api_key)
        self.model = model or DEFAULT_MODELS.get(self.provider)
        # A permanent failure (bad key, unknown model) disables the LLM for the rest
        # of the session; transient ones only fall back for the agent that hit them.
        self._llm_error: Optional[str] = None if self.api_key else "no_api_key"
        self._transient_failures = 0
        self._last_error: Optional[str] = None

    @property
    def mode(self) -> str:
        return "llm" if self.api_key and not self._llm_error else "heuristic"

    def _execute_agent(self, role: str, system_prompt: str, user_content: str, context: Dict[str, Any]) -> Dict[str, Any]:
        """Call the LLM, or fall back to the heuristic engine. Returns content + which engine produced it."""
        if self.api_key and not self._llm_error:
            try:
                text = call_llm(
                    prompt=user_content,
                    system_prompt=f"{system_prompt}\n\n{GROUNDING_RULES}",
                    provider=self.provider,
                    api_key=self.api_key,
                    model=self.model,
                )
                return {"content": text, "engine": f"{self.provider}:{self.model}"}
            except LLMError as e:
                if e.retryable:
                    self._transient_failures += 1
                    # Give up on the LLM only if the provider keeps failing.
                    if self._transient_failures >= 3:
                        self._llm_error = str(e)
                else:
                    self._llm_error = str(e)
                self._last_error = str(e)
                print(f"[AgentCouncil] {role}: {e} — falling back to heuristic")
        return {"content": generate_heuristic_response(role, context), "engine": "heuristic"}

    def _agent_events(self, role: str, name: str, system_prompt: str, user_content: str, context: Dict[str, Any]):
        yield {"type": "agent_start", "agent": role, "name": name}
        result = self._execute_agent(role, system_prompt, user_content, context)
        yield {"type": "agent_done", "agent": role, "name": name, **result}
        return result["content"]

    def run_council_stream(self, ticker: str) -> Generator[Dict[str, Any], None, None]:
        """
        Stream agent deliberation step-by-step for Server-Sent Events (SSE).
        Yields status updates and agent utterances in real time.
        """
        ticker = validate_ticker(ticker)
        yield {"type": "status", "message": f"Đang thu thập dữ liệu giao dịch, BCTC & tin tức cho {ticker}..."}

        context = get_stock_context(ticker)
        tech = context["technicals"]
        fund = context["fundamentals"]
        exchange, limit = context["exchange"], context["price_limit_pct"]

        if not tech.get("available"):
            yield {"type": "error", "message": f"Không tìm thấy dữ liệu giá cho {ticker}. Kiểm tra lại mã cổ phiếu."}
            return

        yield {
            "type": "context",
            "data": {
                "ticker": ticker,
                "company_name": context["company_name"],
                "exchange": exchange,
                "price_limit_pct": limit,
                "ceiling": context["ceiling"],
                "floor": context["floor"],
                "price": tech.get("price"),
                "change_5d": tech.get("change_5d"),
                "rsi": tech.get("rsi14"),
                "pe": fund.get("pe"),
                "pb": fund.get("pb"),
                "roe": fund.get("roe"),
                "dividend_yield": fund.get("dividend_yield"),
                "corporate_events": context.get("corporate_events", []),
                "foreign_flow": context["foreign_flow"],
                "market_context": context["market_context"],
                "news_sentiment": context["news_sentiment"],
                "last_date": tech.get("last_date"),
            },
        }
        yield {
            "type": "mode",
            "mode": self.mode,
            "provider": self.provider if self.mode == "llm" else None,
            "model": self.model if self.mode == "llm" else None,
        }

        header = (
            f"Mã: {ticker} ({context['company_name']}) — sàn {exchange}, biên độ ±{limit}%. "
            f"Dữ liệu đến phiên {tech.get('last_date')}. Đơn vị giá: VNĐ."
        )

        # 1. Technical Analyst
        tech_prompt = (
            f"{header}\n"
            f"Giá đóng cửa: {_fmt(tech.get('price'))} đ. Trần/Sàn phiên tới: {_fmt(context['ceiling'])} / {_fmt(context['floor'])} đ.\n"
            f"MA20: {_fmt(tech.get('sma20'))}, MA50: {_fmt(tech.get('sma50'))}, MA200: {_fmt(tech.get('sma200'))}.\n"
            f"RSI(14): {tech.get('rsi14')}. MACD: {tech.get('macd')}, Signal: {tech.get('macd_signal')}, Histogram: {tech.get('macd_hist')}.\n"
            f"Bollinger(20,2): {_fmt(tech.get('bb_lower'))} – {_fmt(tech.get('bb_upper'))}.\n"
            f"Khối lượng phiên cuối: {_fmt(tech.get('volume'))} cp = {tech.get('volume_ratio')}x TB20 phiên.\n"
            f"Biến động giá 5/20/60 phiên: {tech.get('change_5d')}% / {tech.get('change_20d')}% / {tech.get('change_60d')}%.\n"
            f"Đỉnh/Đáy 20 phiên: {_fmt(tech.get('high_20d'))} / {_fmt(tech.get('low_20d'))}. "
            f"Đỉnh/Đáy 52 tuần: {_fmt(tech.get('high_52w'))} / {_fmt(tech.get('low_52w'))}."
        )
        tech_report = yield from self._agent_events(
            "technical", "Chuyên gia Kỹ thuật (Technical Analyst)", TECHNICAL_ANALYST_PROMPT, tech_prompt, context
        )

        # 2. Fundamental Analyst
        corp_evts = context.get("corporate_events", [])
        events_str = "; ".join([f"[{e.get('date', '')}] {e.get('title', '')}" for e in corp_evts[:3]]) if corp_evts else "Không có sự kiện bất thường"
        fund_prompt = (
            f"{header}\n"
            f"P/E: {fund.get('pe')}x, P/B: {fund.get('pb')}x, EPS: {_fmt(fund.get('eps'))} đ, ROE: {fund.get('roe')}%.\n"
            f"Biên lợi nhuận ròng: {fund.get('net_margin')}%, Nợ/Vốn CSH: {fund.get('debt_to_equity')}x, "
            f"Thanh toán hiện hành: {fund.get('current_ratio')}x.\n"
            f"Tăng trưởng doanh thu: {fund.get('revenue_growth')}%, Tăng trưởng EPS: {fund.get('eps_growth')}%.\n"
            f"Vốn hóa: {_fmt(fund.get('market_cap'))} tỷ VNĐ, Tỷ suất cổ tức: {fund.get('dividend_yield')}%\n"
            f"Sự kiện doanh nghiệp & Cổ tức/GDKHQ: {events_str}."
        )
        fund_report = yield from self._agent_events(
            "fundamental", "Chuyên viên Cơ bản (Fundamental Analyst)", FUNDAMENTAL_ANALYST_PROMPT, fund_prompt, context
        )

        # 3. Sentiment Analyst
        ns = context["news_sentiment"]
        news = context["news_headlines"]
        sent_prompt = (
            f"{header}\n{context['market_context']}\n"
            f"Khối ngoại: {context['foreign_flow']}\n"
            f"Điểm sentiment tin tức (thang -100..100): {ns['score']} ({ns['label']}), xu hướng {ns['trend']}, "
            f"sự kiện: {', '.join(ns['key_events']) or 'không có'}.\n"
            f"Tin tức gần đây:\n" + ("\n".join(news) if news else "Không có tin tức mới.")
        )
        sent_report = yield from self._agent_events(
            "sentiment", "Chuyên viên Tin tức & Tâm lý (Sentiment Analyst)", SENTIMENT_ANALYST_PROMPT, sent_prompt, context
        )

        analyst_reports = (
            f"{header}\n\n"
            f"=== Báo cáo Kỹ thuật ===\n{tech_report}\n\n"
            f"=== Báo cáo Cơ bản ===\n{fund_report}\n\n"
            f"=== Báo cáo Tin tức & Dòng tiền ===\n{sent_report}"
        )

        # 4. Bull Researcher
        bull_report = yield from self._agent_events(
            "bull", "Phe Bò (Bull Researcher)", BULL_ANALYST_PROMPT, analyst_reports, context
        )

        # 5. Bear Researcher — rebuts the bull case directly
        bear_input = f"{analyst_reports}\n\n=== Luận điểm của Phe Bò ===\n{bull_report}"
        bear_report = yield from self._agent_events(
            "bear", "Phe Gấu (Bear Researcher)", BEAR_ANALYST_PROMPT, bear_input, context
        )

        # 6. Portfolio & Risk Manager
        yield {"type": "agent_start", "agent": "portfolio_manager", "name": "Quản lý Quỹ & Rủi ro (CIO)"}
        manager_input = (
            f"{analyst_reports}\n\n"
            f"=== Luận điểm Phe Bò ===\n{bull_report}\n\n"
            f"=== Phản biện Phe Gấu ===\n{bear_report}\n\n"
            f"Giá hiện tại: {_fmt(tech.get('price'))} đ. Trần/Sàn: {_fmt(context['ceiling'])} / {_fmt(context['floor'])} đ. "
            f"Hỗ trợ 20 phiên: {_fmt(tech.get('low_20d'))}, kháng cự 20 phiên: {_fmt(tech.get('high_20d'))}.\n"
            f"Hãy đưa ra phán quyết cuối cùng theo đúng định dạng yêu cầu."
        )
        decision = self._execute_agent("portfolio_manager", PORTFOLIO_MANAGER_PROMPT, manager_input, context)

        yield {
            "type": "final_verdict",
            "agent": "portfolio_manager",
            "content": decision["content"],
            "engine": decision["engine"],
            "structured": parse_decision(decision["content"], tech.get("price") or 0),
        }
        if self._last_error:
            scope = "đã chuyển hẳn sang chế độ Heuristic" if self._llm_error else "một số agent dùng chế độ Heuristic"
            yield {"type": "warning", "message": f"LLM gặp lỗi, {scope}: {self._last_error}"}

    def run_council(self, ticker: str) -> Dict[str, Any]:
        """Run full council deliberation and return complete JSON."""
        result: Dict[str, Any] = {
            "ticker": validate_ticker(ticker),
            "timestamp": datetime.now().isoformat(),
            "mode": "heuristic",
            "context": {},
            "reports": {},
            "engines": {},
            "verdict": {},
            "warnings": [],
        }

        for ev in self.run_council_stream(ticker):
            ev_type = ev.get("type")
            if ev_type == "context":
                result["context"] = ev["data"]
            elif ev_type == "mode":
                result["mode"] = ev["mode"]
            elif ev_type == "agent_done":
                result["reports"][ev["agent"]] = ev["content"]
                result["engines"][ev["agent"]] = ev["engine"]
            elif ev_type == "final_verdict":
                result["verdict"] = {"raw": ev["content"], "structured": ev["structured"]}
                result["engines"]["portfolio_manager"] = ev["engine"]
            elif ev_type in ("warning", "error"):
                result["warnings"].append(ev["message"])

        return result


def parse_decision(text: str, current_price: float) -> Dict[str, Any]:
    """Parse structured fields from the manager verdict. Tolerates markdown (**bold**, bullets)."""
    clean = re.sub(r"[*_#`]", "", text or "")
    clean = re.sub(r"^\s*[-•]\s*", "", clean, flags=re.MULTILINE)

    def field(label: str) -> Optional[str]:
        m = re.search(rf"{label}[^\n:]*:\s*(.+)", clean, re.IGNORECASE)
        return m.group(1).strip() if m else None

    raw_action = (field("HÀNH ĐỘNG") or "").upper()
    if raw_action.startswith("MUA"):
        action = "MUA"
    elif raw_action.startswith("BÁN"):
        action = "BÁN"
    else:
        action = "QUAN SÁT"

    summary_m = re.search(r"KẾT LUẬN[^\n:]*:\s*(.+)", clean, re.IGNORECASE | re.DOTALL)
    p = round(current_price)
    return {
        "action": action,
        "entry_zone": field("VÙNG GIÁ GOM") or f"{round(p * 0.98, -1):,.0f} - {round(p * 1.005, -1):,.0f} đ",
        "target_price": field("GIÁ MỤC TIÊU") or f"{round(p * 1.1, -1):,.0f} đ",
        "stop_loss": field("ĐIỂM CẮT LỖ") or f"{round(p * 0.94, -1):,.0f} đ",
        "sizing": field("TỶ TRỌNG") or "10%",
        "risk_level": field("MỨC ĐỘ RỦI RO") or "Trung bình",
        "summary": summary_m.group(1).strip() if summary_m else "Giải ngân từng phần, tuân thủ kỷ luật cắt lỗ.",
    }
