"""
LLM Client Adapter for TraderAI Agent Council.
Supports Google Gemini, OpenAI, and a quantitative heuristic fallback.
"""

import os
from typing import Optional, Dict, Any, List, Tuple

DEFAULT_MODELS = {
    "gemini": "gemini-2.5-flash",
    "openai": "gpt-4o-mini",
}

PROVIDER_ALIASES = {"google": "gemini", "chatgpt": "openai"}
ENV_KEYS = {"gemini": "GEMINI_API_KEY", "openai": "OPENAI_API_KEY"}


class LLMError(Exception):
    pass


def normalize_provider(provider: Optional[str]) -> str:
    p = (provider or "gemini").lower().strip()
    return PROVIDER_ALIASES.get(p, p)


def resolve_api_key(provider: str, api_key: Optional[str] = None) -> Optional[str]:
    """A key supplied by the client wins; otherwise use the provider's own env var."""
    if api_key and api_key.strip():
        return api_key.strip()
    env_name = ENV_KEYS.get(normalize_provider(provider))
    return os.environ.get(env_name) if env_name else None


def _mask(message: str, key: str) -> str:
    """Provider errors may echo the API key back; never forward it to logs or the client."""
    return message.replace(key, "***")[:200]


def call_llm(
    prompt: str,
    system_prompt: str,
    provider: str = "gemini",
    api_key: Optional[str] = None,
    model: Optional[str] = None,
) -> str:
    """Invoke an LLM. Raises LLMError on any failure so callers can fall back and report why."""
    provider = normalize_provider(provider)
    key = resolve_api_key(provider, api_key)
    if not key:
        raise LLMError(f"Chưa cấu hình API key cho {provider}")
    model_name = model or DEFAULT_MODELS.get(provider)

    if provider == "gemini":
        try:
            from google import genai
            from google.genai import types
        except ImportError as e:
            raise LLMError("Thiếu thư viện google-genai (pip install google-genai)") from e
        try:
            client = genai.Client(api_key=key)
            response = client.models.generate_content(
                model=model_name,
                contents=prompt,
                config=types.GenerateContentConfig(system_instruction=system_prompt, temperature=0.4),
            )
            text = (response.text or "").strip() if response else ""
        except Exception as e:
            raise LLMError(f"Gemini lỗi: {_mask(str(e), key)}") from e

    elif provider == "openai":
        try:
            from openai import OpenAI
        except ImportError as e:
            raise LLMError("Thiếu thư viện openai (pip install openai)") from e
        try:
            client = OpenAI(api_key=key)
            resp = client.chat.completions.create(
                model=model_name,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": prompt},
                ],
                temperature=0.4,
            )
            text = (resp.choices[0].message.content or "").strip() if resp.choices else ""
        except Exception as e:
            raise LLMError(f"OpenAI lỗi: {_mask(str(e), key)}") from e
    else:
        raise LLMError(f"Nhà cung cấp không hỗ trợ: {provider}")

    if not text:
        raise LLMError(f"{provider} trả về nội dung rỗng")
    return text


# ===========================
# Heuristic engine
# ===========================

def _round_price(p: float) -> int:
    """Round to HOSE tick size (10đ <10k, 50đ <50k, 100đ above) — close enough for all boards."""
    tick = 10 if p < 10_000 else (50 if p < 50_000 else 100)
    return int(round(p / tick) * tick)


def _fmt(p: Optional[float]) -> str:
    return f"{p:,.0f} đ" if p else "N/A"


def score_signals(context: Dict[str, Any]) -> Tuple[int, List[str], List[str]]:
    """
    Quantitative scorecard shared by every heuristic agent so Bull, Bear and the
    Portfolio Manager argue from the same facts. Returns (score, bull_points, bear_points).
    """
    t = context.get("technicals", {})
    f = context.get("fundamentals", {})
    s = context.get("news_sentiment", {})
    bull: List[str] = []
    bear: List[str] = []

    price, sma20, sma50, sma200 = t.get("price"), t.get("sma20"), t.get("sma50"), t.get("sma200")
    rsi = t.get("rsi14")
    if price and sma20 and sma50:
        if price > sma20 > sma50:
            bull.append(f"Giá {_fmt(price)} nằm trên MA20 ({_fmt(sma20)}) và MA50 ({_fmt(sma50)}) — xu hướng tăng ngắn hạn được xác nhận")
        elif price < sma20 < sma50:
            bear.append(f"Giá {_fmt(price)} dưới MA20 ({_fmt(sma20)}) và MA50 ({_fmt(sma50)}) — cấu trúc giảm ngắn hạn")
    if price and sma200:
        (bull if price > sma200 else bear).append(
            f"Giá {'trên' if price > sma200 else 'dưới'} MA200 ({_fmt(sma200)}) — xu hướng dài hạn {'tích cực' if price > sma200 else 'tiêu cực'}"
        )
    if rsi is not None:
        if rsi > 70:
            bear.append(f"RSI(14) = {rsi} vùng quá mua, rủi ro mua đuổi khi hàng về T+2.5")
        elif rsi < 30:
            bull.append(f"RSI(14) = {rsi} vùng quá bán, xác suất hồi kỹ thuật cao")
    if t.get("macd_hist") is not None:
        if t["macd_hist"] > 0:
            bull.append(f"MACD histogram dương ({t['macd_hist']}) — động lượng tăng")
        else:
            bear.append(f"MACD histogram âm ({t['macd_hist']}) — động lượng suy yếu")
    vol_ratio = t.get("volume_ratio") or 1
    chg5 = t.get("change_5d") or 0
    if vol_ratio >= 1.5:
        (bull if chg5 >= 0 else bear).append(
            f"Khối lượng đột biến {vol_ratio}x TB20 phiên kèm giá {'tăng' if chg5 >= 0 else 'giảm'} {chg5}%/5 phiên — dấu hiệu {'dòng tiền lớn gom hàng' if chg5 >= 0 else 'phân phối'}"
        )

    pe, pb, roe = f.get("pe"), f.get("pb"), f.get("roe")
    if pe and pe > 0:
        if pe < 10:
            bull.append(f"P/E {pe}x thấp hơn mặt bằng VN-Index (~12-15x) — định giá hấp dẫn")
        elif pe > 20:
            bear.append(f"P/E {pe}x cao hơn đáng kể mặt bằng thị trường — đã phản ánh nhiều kỳ vọng")
    elif pe is not None and pe < 0:
        bear.append("P/E âm — doanh nghiệp đang lỗ")
    if roe is not None:
        if roe >= 15:
            bull.append(f"ROE {roe}% — hiệu quả sử dụng vốn tốt")
        elif roe < 8:
            bear.append(f"ROE chỉ {roe}% — hiệu quả sinh lời yếu")
    if f.get("eps_growth") is not None:
        g = f["eps_growth"]
        if g >= 15:
            bull.append(f"Tăng trưởng EPS {g}% — lợi nhuận tăng tốc")
        elif g < 0:
            bear.append(f"EPS suy giảm {g}% — lợi nhuận đi lùi")
    de = f.get("debt_to_equity")
    if de is not None and de > 1.5:
        bear.append(f"Nợ/Vốn CSH {de}x — đòn bẩy cao, nhạy cảm với lãi suất")
    if pb and pb > 4:
        bear.append(f"P/B {pb}x — định giá tài sản cao")

    score_news = s.get("score", 0) or 0
    if score_news > 15:
        bull.append(f"Tin tức nghiêng tích cực (điểm {score_news}, xu hướng {s.get('trend')})")
    elif score_news < -15:
        bear.append(f"Tin tức nghiêng tiêu cực (điểm {score_news}, xu hướng {s.get('trend')})")
    if "INSIDER" in (s.get("key_events") or []):
        bear.append("Có giao dịch nội bộ/người liên quan gần đây — cần kiểm tra chiều mua/bán")
    net = context.get("foreign_net_volume") or 0
    if net > 0:
        bull.append(f"Khối ngoại mua ròng phiên gần nhất ({net:,} cp)")
    elif net < 0:
        bear.append(f"Khối ngoại bán ròng phiên gần nhất ({abs(net):,} cp)")

    return len(bull) - len(bear), bull, bear


def _bullets(points: List[str], empty: str) -> str:
    return "\n".join(f"{i}. {p}." for i, p in enumerate(points, 1)) if points else empty


def generate_heuristic_response(agent_role: str, context: Dict[str, Any]) -> str:
    """Rule-based report from quantitative data so the council works without any LLM key."""
    ticker = context.get("ticker", "CP")
    t = context.get("technicals", {})
    f = context.get("fundamentals", {})
    s = context.get("news_sentiment", {})
    exchange, limit = context.get("exchange", "HOSE"), context.get("price_limit_pct", 7)
    price = t.get("price") or 0
    score, bull_pts, bear_pts = score_signals(context)

    if agent_role == "technical":
        if not t.get("available"):
            return "• Không đủ dữ liệu lịch sử giá để phân tích kỹ thuật."
        sma20 = t.get("sma20") or price
        trend = "Tăng" if price >= sma20 else "Điều chỉnh / tích lũy"
        rsi = t.get("rsi14")
        rsi_state = "quá mua" if rsi and rsi > 70 else ("quá bán" if rsi and rsi < 30 else "trung tính")
        tech_score = sum(1 for p in bull_pts if "MA" in p or "RSI" in p or "MACD" in p or "Khối lượng" in p) - \
            sum(1 for p in bear_pts if "MA" in p or "RSI" in p or "MACD" in p or "Khối lượng" in p)
        verdict = "Tích cực" if tech_score > 0 else ("Rủi ro" if tech_score < 0 else "Trung lập")
        return (
            f"• **Xu hướng**: {trend} — giá {_fmt(price)}, MA20 {_fmt(t.get('sma20'))}, MA50 {_fmt(t.get('sma50'))}, MA200 {_fmt(t.get('sma200'))}. "
            f"Biến động 5/20/60 phiên: {t.get('change_5d')}% / {t.get('change_20d')}% / {t.get('change_60d')}%.\n"
            f"• **Động lượng**: RSI(14) **{rsi}** ({rsi_state}); MACD {t.get('macd')} vs signal {t.get('macd_signal')}; "
            f"khối lượng {t.get('volume_ratio')}x TB20 phiên.\n"
            f"• **Ngưỡng giá**: Hỗ trợ {_fmt(max(t.get('low_20d') or 0, t.get('bb_lower') or 0))}, "
            f"kháng cự {_fmt(t.get('high_20d'))}; dải Bollinger {_fmt(t.get('bb_lower'))} – {_fmt(t.get('bb_upper'))}. "
            f"Biên độ {exchange} ±{limit}%.\n"
            f"• **Đánh giá kỹ thuật**: **{verdict}**."
        )

    if agent_role == "fundamental":
        pe, roe = f.get("pe"), f.get("roe")
        if pe is None and roe is None:
            return "• Không lấy được dữ liệu báo cáo tài chính cho mã này."
        pe_eval = "rẻ" if pe and 0 < pe < 10 else ("hợp lý" if pe and pe <= 16 else "đắt / cần kiểm chứng")
        roe_eval = "xuất sắc" if roe and roe >= 18 else ("khá" if roe and roe >= 12 else "yếu")
        verdict = "Xuất sắc" if (roe or 0) >= 18 and pe and 0 < pe < 15 else ("Đạt chuẩn" if (roe or 0) >= 10 else "Kém")
        return (
            f"• **Định giá**: P/E **{pe}x** ({pe_eval}), P/B **{f.get('pb')}x**, EPS {_fmt(f.get('eps'))}.\n"
            f"• **Hiệu quả**: ROE **{roe}%** ({roe_eval}), biên LN ròng {f.get('net_margin')}%.\n"
            f"• **Sức khỏe tài chính**: Nợ/Vốn CSH {f.get('debt_to_equity')}x, thanh toán hiện hành {f.get('current_ratio')}x.\n"
            f"• **Tăng trưởng**: Doanh thu {f.get('revenue_growth')}%, EPS {f.get('eps_growth')}%.\n"
            f"• **Đánh giá cơ bản**: **{verdict}**."
        )

    if agent_role == "sentiment":
        headlines = context.get("news_headlines", [])
        label = {"positive": "Tích cực", "negative": "Tiêu cực"}.get(s.get("label"), "Trung tính")
        top = "\n".join(f"  {h}" for h in headlines[:3]) if headlines else "  (không có tin mới)"
        return (
            f"• **Tin tức**: {len(headlines)} tin gần đây, tông giọng **{label}** (điểm {s.get('score', 0)}, xu hướng {s.get('trend')}). "
            f"Sự kiện đáng chú ý: {', '.join(s.get('key_events') or []) or 'không có'}.\n{top}\n"
            f"• **Khối ngoại**: {context.get('foreign_flow')}.\n"
            f"• **Thị trường chung**: {context.get('market_context')}.\n"
            f"• **Tâm lý tổng quan**: {'Tích cực' if score > 1 else ('Thận trọng' if score < -1 else 'Cân bằng')}."
        )

    if agent_role == "bull":
        report = f"Phe Bò bảo vệ luận điểm **TĂNG GIÁ** cho {ticker}:\n" + _bullets(
            bull_pts,
            "1. Dữ liệu hiện tại không cung cấp nhiều luận điểm tăng giá mạnh; cơ hội chủ yếu nằm ở kịch bản hồi phục theo thị trường chung.",
        )
        if price:
            target = _round_price(max(t.get("high_20d") or 0, price * 1.08))
            report += f"\n\n**Mục tiêu kỳ vọng**: {_fmt(target)} ({(target / price - 1) * 100:+.1f}%)."
        return report

    if agent_role == "bear":
        return (
            f"Phe Gấu phản biện — các **RỦI RO** hội đồng cần cân nhắc với {ticker}:\n"
            + _bullets(bear_pts, "1. Không có tín hiệu tiêu cực rõ ràng trong dữ liệu, nhưng rủi ro thị trường chung luôn hiện hữu.")
            + f"\n\n**Rủi ro T+2.5**: hàng mua hôm nay chỉ về tài khoản chiều T+2; với biên độ {exchange} ±{limit}%, "
            f"hai phiên giảm sàn liên tiếp có thể khiến vị thế lỗ tới ~{limit * 2}% trước khi bán được."
        )

    if agent_role == "portfolio_manager":
        if not price:
            return (
                "HÀNH ĐỘNG: QUAN SÁT\nVÙNG GIÁ GOM: N/A\nGIÁ MỤC TIÊU (TARGET): N/A\nĐIỂM CẮT LỖ (STOP-LOSS): N/A\n"
                "TỶ TRỌNG ĐỀ XUẤT: 0%\nMỨC ĐỘ RỦI RO: Cao\nKẾT LUẬN & CHIẾN LƯỢC: Thiếu dữ liệu giá, không đủ cơ sở ra quyết định."
            )
        rsi = t.get("rsi14") or 50
        if score >= 3 and rsi < 70:
            action, sizing, risk = "MUA", "15% - 20%", "Trung bình"
        elif score >= 1 and rsi < 70:
            action, sizing, risk = "MUA", "10%", "Trung bình"
        elif score <= -3:
            action, sizing, risk = "BÁN", "0%", "Cao"
        else:
            action, sizing, risk = "QUAN SÁT", "0% (chờ tín hiệu)", "Trung bình" if score > -2 else "Cao"

        support = max(t.get("low_20d") or 0, t.get("bb_lower") or 0, price * 0.95)
        entry_low, entry_high = _round_price(max(min(support, price * 0.99), price * 0.97)), _round_price(price * 1.005)
        # Stop just under support, but never wider than -6% so a +10% target keeps R:R >= 1.5
        stop = _round_price(max(support * 0.98, entry_high * 0.94))
        target = _round_price(max(t.get("high_20d") or 0, entry_high * 1.10))
        rr = (target - entry_high) / (entry_high - stop) if entry_high > stop else 0

        reason = {
            "MUA": f"Luận điểm của phe Bò ({len(bull_pts)} tín hiệu) vượt trội phe Gấu ({len(bear_pts)} tín hiệu). Giải ngân từng phần trong vùng gom, không mua đuổi giá trần, cắt lỗ dứt khoát nếu thủng {_fmt(stop)}.",
            "BÁN": f"Rủi ro áp đảo ({len(bear_pts)} tín hiệu tiêu cực so với {len(bull_pts)} tích cực). Hạ tỷ trọng/đứng ngoài, chỉ xem xét lại khi giá lấy lại MA20.",
            "QUAN SÁT": f"Hai phe cân bằng ({len(bull_pts)} tích cực / {len(bear_pts)} tiêu cực). Chờ xác nhận xu hướng (giá vượt MA20 kèm khối lượng) trước khi giải ngân.",
        }[action]
        return (
            f"HÀNH ĐỘNG: {action}\n"
            f"VÙNG GIÁ GOM: {entry_low:,} - {entry_high:,} đ\n"
            f"GIÁ MỤC TIÊU (TARGET): {target:,} đ ({(target / entry_high - 1) * 100:+.1f}%)\n"
            f"ĐIỂM CẮT LỖ (STOP-LOSS): {stop:,} đ ({(stop / entry_high - 1) * 100:+.1f}%)\n"
            f"TỶ TRỌNG ĐỀ XUẤT: {sizing}\n"
            f"MỨC ĐỘ RỦI RO: {risk} (R:R ≈ {rr:.1f})\n"
            f"KẾT LUẬN & CHIẾN LƯỢC: {reason}"
        )

    return ""
