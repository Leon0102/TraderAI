#!/usr/bin/env bash
# Dump the Docker Postgres database (account documents + market data) to backups/.
#   scripts/backup-db.sh            -> backups/traderai-YYYYmmdd-HHMM.sql.gz
#   scripts/backup-db.sh --restore backups/traderai-….sql.gz
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p backups
if [ "${1:-}" = "--restore" ]; then
  file="${2:?usage: $0 --restore <file.sql.gz>}"
  echo "Restoring $file into the running db container (existing tables are replaced)…"
  gunzip -c "$file" | docker compose exec -T db psql -q -U traderai -d traderai
  echo "Done."
  exit 0
fi
out="backups/traderai-$(date +%Y%m%d-%H%M).sql.gz"
docker compose exec -T db pg_dump -U traderai --clean --if-exists traderai | gzip > "$out"
chmod 600 "$out"
ls -t backups/traderai-*.sql.gz | tail -n +15 | xargs -r rm --   # keep the 14 newest
echo "Saved $out ($(du -h "$out" | cut -f1))"
