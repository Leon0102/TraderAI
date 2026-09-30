"""
Document storage for everything the account features persist (token, snapshot, journal, NAV
history, rules, forecast log, alert state, weekly reports).

- DATABASE_URL set (Docker): one Postgres table of JSONB documents keyed by name.
- Otherwise: private JSON files under runtime/, exactly as before.

Callers keep passing file paths; the key is the path relative to runtime/ (e.g.
"tcbs_journal.json", "reports/2026-W40.md"), so both backends address the same documents.
"""

import json
import os
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

RUNTIME_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "runtime")
_SCHEMA = """CREATE TABLE IF NOT EXISTS documents (
    key TEXT PRIMARY KEY,
    data JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
)"""
_schema_ready = False


def _db_url() -> Optional[str]:
    return os.environ.get("DATABASE_URL") or None


def _key(path: str) -> str:
    rel = os.path.relpath(os.path.abspath(path), RUNTIME_DIR)
    return path if rel.startswith("..") else rel.replace(os.sep, "/")


def _connect():
    global _schema_ready
    import psycopg  # only needed in Docker

    conn = psycopg.connect(_db_url(), autocommit=True)
    if not _schema_ready:
        conn.execute(_SCHEMA)
        _schema_ready = True
    return conn


def using_database() -> bool:
    return bool(_db_url())


def read(path: str) -> Optional[Dict[str, Any]]:
    if using_database():
        with _connect() as conn:
            row = conn.execute("SELECT data FROM documents WHERE key = %s", (_key(path),)).fetchone()
        return row[0] if row else None
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def write(path: str, data: Any) -> None:
    if using_database():
        from psycopg.types.json import Jsonb

        with _connect() as conn:
            conn.execute("INSERT INTO documents (key, data, updated_at) VALUES (%s, %s, now()) "
                         "ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_at = now()",
                         (_key(path), Jsonb(data)))
        return
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def delete(path: str) -> None:
    if using_database():
        with _connect() as conn:
            conn.execute("DELETE FROM documents WHERE key = %s", (_key(path),))
        return
    try:
        os.remove(path)
    except OSError:
        pass


def list_prefix(folder: str) -> List[Tuple[str, str]]:
    """(file name, updated_at ISO) of documents inside `folder`, newest name first."""
    if using_database():
        prefix = _key(folder).rstrip("/") + "/"
        with _connect() as conn:
            rows = conn.execute("SELECT key, updated_at FROM documents WHERE key LIKE %s ORDER BY key DESC",
                                (prefix.replace("%", r"\%") + "%",)).fetchall()
        return [(k[len(prefix):], ts.isoformat(timespec="minutes")) for k, ts in rows]
    if not os.path.isdir(folder):
        return []
    return [(fn, datetime.fromtimestamp(os.stat(os.path.join(folder, fn)).st_mtime).isoformat(timespec="minutes"))
            for fn in sorted(os.listdir(folder), reverse=True)]


def import_files_once() -> int:
    """First start with a database: copy existing runtime/ JSON documents and reports into it."""
    if not using_database() or not os.path.isdir(RUNTIME_DIR):
        return 0
    with _connect() as conn:
        if conn.execute("SELECT 1 FROM documents LIMIT 1").fetchone():
            return 0
    count = 0
    # Only this app's own documents: top-level runtime/*.json and runtime/reports/*.md.
    for fn in os.listdir(RUNTIME_DIR):
        path = os.path.join(RUNTIME_DIR, fn)
        if fn.endswith(".json") and os.path.isfile(path):
            try:
                with open(path, encoding="utf-8") as f:
                    write(path, json.load(f))
                count += 1
            except (OSError, ValueError):
                continue
    reports = os.path.join(RUNTIME_DIR, "reports")
    if os.path.isdir(reports):
        for fn in os.listdir(reports):
            if fn.endswith(".md"):
                with open(os.path.join(reports, fn), encoding="utf-8") as f:
                    write(os.path.join(reports, fn), {"markdown": f.read()})
                count += 1
    return count
