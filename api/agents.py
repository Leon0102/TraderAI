"""Vercel serverless function: /api/agents/{config,analyze,stream}

vercel.json rewrites /api/agents/<action> to /api/agents?action=<action>.
Mirrors the FastAPI endpoints in backend/server.py; the council itself lives
in backend/agents so both share one implementation.
"""
from http.server import BaseHTTPRequestHandler
import json
import warnings
warnings.filterwarnings('ignore')

import sys, os
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, ROOT)

from backend.agents.council import AgentCouncil, validate_ticker  # noqa: E402
from backend.agents.llm import DEFAULT_MODELS  # noqa: E402

MAX_BODY_BYTES = 10_000


class handler(BaseHTTPRequestHandler):
    def _action(self) -> str:
        from urllib.parse import parse_qs, urlparse
        parsed = urlparse(self.path)
        action = parse_qs(parsed.query).get('action', [''])[0]
        return action or parsed.path.rstrip('/').rsplit('/', 1)[-1]

    def _json(self, status: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self._action() != 'config':
            return self._json(404, {"detail": "Not found"})
        gemini_env = bool(os.environ.get("GEMINI_API_KEY"))
        openai_env = bool(os.environ.get("OPENAI_API_KEY"))
        self._json(200, {
            "has_gemini_env": gemini_env,
            "has_openai_env": openai_env,
            "active_provider": "gemini" if gemini_env else ("openai" if openai_env else "heuristic"),
            "default_models": DEFAULT_MODELS,
        })

    def do_POST(self):
        action = self._action()
        if action not in ('analyze', 'stream'):
            return self._json(404, {"detail": "Not found"})

        length = int(self.headers.get('Content-Length') or 0)
        if length <= 0 or length > MAX_BODY_BYTES:
            return self._json(400, {"detail": "Invalid request body"})
        try:
            req = json.loads(self.rfile.read(length))
            ticker = validate_ticker(str(req.get('ticker', '')))
        except (ValueError, json.JSONDecodeError) as e:
            return self._json(400, {"detail": str(e)})

        council = AgentCouncil(provider=req.get('provider') or 'gemini', api_key=req.get('apiKey'), model=req.get('model'))

        if action == 'analyze':
            return self._json(200, council.run_council(ticker))

        # SSE framing. Vercel may buffer the response until the function ends; the
        # client parser handles both incremental and all-at-once delivery.
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('X-Accel-Buffering', 'no')
        self.end_headers()

        def send(data: str):
            self.wfile.write(f"data: {data}\n\n".encode('utf-8'))
            self.wfile.flush()

        try:
            for event in council.run_council_stream(ticker):
                send(json.dumps(event, ensure_ascii=False))
        except Exception as e:
            send(json.dumps({"type": "error", "message": f"Lỗi hội đồng AI: {e}"}, ensure_ascii=False))
        send("[DONE]")
