"""Simple in-memory TTL cache shared by the Vercel serverless handlers.

Each serverless invocation may run in a fresh process, so this cache mainly
helps warm (reused) lambda instances and the local FastAPI backend, where a
single process serves many requests. It still meaningfully cuts down on
repeated calls to TCBS within a short window and reduces the chance of
getting rate-limited / bot-challenged.
"""
import time

_store: dict[str, tuple[float, object]] = {}


def cache_get(key: str):
    entry = _store.get(key)
    if not entry:
        return None
    expires_at, value = entry
    if time.time() > expires_at:
        del _store[key]
        return None
    return value


def cache_set(key: str, value, ttl: float = 60.0):
    _store[key] = (time.time() + ttl, value)
    return value
