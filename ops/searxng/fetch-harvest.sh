#!/usr/bin/env bash
# Pull the harvested SearXNG sample from the search host into the local corpus
# directory, where scripts/engine-trends.ts reads it.
#
# scp is not usable here: DietPi ships no /usr/lib/sftp-server, so `scp` fails
# with "Connection closed". Plain `ssh host cat` streaming to a local file works
# everywhere and keeps this script one dependency deep.
#
# Override with SEARXNG_SSH_HOST / SEARXNG_HARVEST_DIR / LOCAL_DIR.
set -euo pipefail

SEARXNG_SSH_HOST="${SEARXNG_SSH_HOST:-root@192.168.144.120}"
SEARXNG_HARVEST_DIR="${SEARXNG_HARVEST_DIR:-/opt/docker/llm/searxng/harvest}"
LOCAL_DIR="${LOCAL_DIR:-$HOME/.dsh/data/web-index}"

mkdir -p "$LOCAL_DIR"

files=$(ssh -o BatchMode=yes -o ConnectTimeout=8 "$SEARXNG_SSH_HOST" \
  "ls -1 '$SEARXNG_HARVEST_DIR'/harvest-*.ndjson 2>/dev/null" || true)

if [ -z "$files" ]; then
  echo "no harvest-*.ndjson on $SEARXNG_SSH_HOST:$SEARXNG_HARVEST_DIR — run harvest.sh there first (cron.d.example installs it)" >&2
  exit 1
fi

for remote in $files; do
  name=$(basename "$remote")
  ssh -o BatchMode=yes -o ConnectTimeout=8 "$SEARXNG_SSH_HOST" "cat '$remote'" > "$LOCAL_DIR/$name"
  echo "fetched $name ($(wc -l < "$LOCAL_DIR/$name") lines) → $LOCAL_DIR/$name"
done

echo
echo "next: npm run trends"
