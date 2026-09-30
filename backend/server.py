"""
TraderAI Backend - FastAPI server for local development and Docker.

Thin HTTP layer over the same data-fetching logic the Vercel functions in api/*.py use.
Routes live in routes_*.py; who may read account data is decided in guards.py.
Run: python3 backend/server.py
"""

import warnings
warnings.filterwarnings('ignore')

import os
import sys

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

os.environ['PYTHONDONTWRITEBYTECODE'] = '1'
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def _load_env_files():
    """Minimal .env loader (backend/.env, project .env, then .env.local) so API keys and TCBS settings work locally."""
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    for path in (os.path.join(root, 'backend', '.env'), os.path.join(root, '.env'), os.path.join(root, '.env.local')):
        if not os.path.isfile(path):
            continue
        with open(path, encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                key, _, value = line.partition('=')
                os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_env_files()  # before the route modules read their configuration

import storage as storage_mod  # noqa: E402
import routes_account  # noqa: E402
import routes_agents  # noqa: E402
import routes_auth  # noqa: E402
import routes_market  # noqa: E402
import routes_quant  # noqa: E402

app = FastAPI(title="TraderAI API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.middleware("http")(routes_auth.password_gate)   # password gate (off unless APP_PASSWORD / AUTH_SECRET are set)

for _router in (routes_auth.router, routes_market.router, routes_agents.router, routes_account.router, routes_quant.router):
    app.include_router(_router)

if storage_mod.using_database():
    print(f"🗄️  Storage: Postgres (imported {storage_mod.import_files_once()} existing runtime documents)")


if __name__ == "__main__":
    print("🚀 TraderAI Backend starting...")
    print("📊 Reusing api/*.py data-fetching logic (SSI + DNSE + Vietcap)")
    print("🤖 Multi-Agent Council (TradingAgents) enabled at /api/agents/*")
    print("🌐 API docs: http://localhost:8000/docs")
    import quant_service
    quant_service.warm()   # scores computed in the background so the first screen is instant
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")
