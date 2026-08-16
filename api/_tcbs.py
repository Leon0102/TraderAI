"""Shared TCBS HTTP client with a short TTL cache, used by every api/*.py handler."""
from typing import Optional
from _cache import cache_get, cache_set

TCBS_BASE = "https://apipubaws.tcbs.com.vn"


def tcbs_get(path: str, ttl: float = 60.0) -> Optional[dict]:
    """Fetch JSON from TCBS, cached for `ttl` seconds. Returns None on any failure."""
    cache_key = f"tcbs:{path}"
    cached = cache_get(cache_key)
    if cached is not None:
        return cached

    try:
        import requests as req
        resp = req.get(f"{TCBS_BASE}{path}", timeout=10, headers={"Accept": "application/json"})
        if resp.status_code == 200:
            data = resp.json()
            return cache_set(cache_key, data, ttl)
    except Exception:
        pass
    return None
