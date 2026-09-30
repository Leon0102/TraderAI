"""Who may read account data: local callers only (plus the Docker network and configured hostnames)."""

import ipaddress
import os
from typing import Optional
from urllib.parse import urlparse

from fastapi import HTTPException, Request

_LOCAL_HOSTS = {"127.0.0.1", "::1", "localhost"}
# Self-hosted behind the password gate: the site's own hostname(s) may call account endpoints.
_ALLOWED_ORIGIN_HOSTS = _LOCAL_HOSTS | {h.strip() for h in os.environ.get("ACCOUNT_ALLOWED_ORIGINS", "").split(",") if h.strip()}
# Local-only DNS names that resolve to this machine: OrbStack containers (*.orb.local) and *.localhost.
_LOCAL_SUFFIXES = (".orb.local", ".localhost")


def _host_allowed(host: Optional[str]) -> bool:
    """A hostname we serve: loopback, configured names, or a local-only suffix. Checking the Host
    header too (not just Origin) is what stops DNS-rebinding pages from reading account data."""
    host = (host or "").strip().lower().rstrip(".")
    return bool(host) and (host in _ALLOWED_ORIGIN_HOSTS or host.endswith(_LOCAL_SUFFIXES))
# Docker: requests reach the backend from the nginx container, not 127.0.0.1. docker-compose sets
# ACCOUNT_TRUSTED_NETWORKS to its private bridge network and publishes ports on 127.0.0.1 only.
_TRUSTED_NETS = [ipaddress.ip_network(n.strip()) for n in os.environ.get("ACCOUNT_TRUSTED_NETWORKS", "").split(",") if n.strip()]


def _is_trusted_client(host: str) -> bool:
    if host in _LOCAL_HOSTS:
        return True
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    return any(ip in net for net in _TRUSTED_NETS)


def _require_local(request: Request) -> None:
    """Account data must not leak: the server binds 0.0.0.0 and CORS allows any origin,
    so reject callers from other machines and pages served from other sites."""
    client = request.client.host if request.client else ""
    origin = request.headers.get("origin")
    request_host = urlparse(f"//{request.headers.get('host', '')}").hostname
    origin_host = urlparse(origin).hostname if origin else None
    if not _is_trusted_client(client) or not _host_allowed(request_host) or (origin and not _host_allowed(origin_host)):
        blocked = origin_host or request_host or client
        raise HTTPException(status_code=403, detail=f"Dữ liệu tài khoản TCBS chỉ truy cập được từ máy local (bị chặn: {blocked}). "
                                                    "Truy cập qua localhost, *.orb.local, hoặc thêm tên miền vào ACCOUNT_ALLOWED_ORIGINS.")
