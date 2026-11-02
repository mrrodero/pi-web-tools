#!/usr/bin/env bash
# Harvest SearXNG health evidence into append-only NDJSON that outlives both
# the container's journal and SearXNG's in-process metrics.
#
# Why this exists: both obvious sources are ephemeral. journald on this host was
# volatile (RAM only, wiped at boot) until journal-persist.sh ran — it is
# persistent now, but capped (SystemMaxUse=1G), so the oldest engine evidence
# still rolls off. And `/stats`, `/stats/errors` and `/metrics` count from
# process start: a restart resets them, a redeploy wipes the sample. Tuning an
# engine allowlist needs a sample that accumulates for months, so make it
# accumulate on purpose.
#
# Four record kinds land in one NDJSON stream (the `kind` field separates them):
#   journal        one line per container log entry, cursor-based (no dupes, no gaps)
#   stats_errors   /stats/errors snapshot: per-engine failure modes and shares
#   metrics        /metrics (OpenMetrics) snapshot: request/result/reliability counters
#   settings       /config engine table, written only when it actually changes
#
# Raw `msg` is always kept; `engine`/`exception`/`file`/`line` are derived
# conveniences and stay null when a line does not match the known shapes.
#
# Run from cron (see cron.d.example). Idempotent and safe to re-run by hand.
set -euo pipefail

# Config lives next to the script: a root-only (mode 600) file of KEY=value
# pairs — OPEN_METRICS_PASSWORD plus any of the knobs below. Sourcing it here
# rather than in the crontab is deliberate: cron runs its command in a shell
# where `. file` assigns *without* exporting, so a crontab-sourced password was
# invisible to harvest.sh and the metrics snapshot quietly stopped landing while
# everything else looked healthy.
self_dir=$(cd "$(dirname "$0")" && pwd)
if [ -r "$self_dir/harvest.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$self_dir/harvest.env"
  set +a
fi

SEARXNG_URL="${SEARXNG_URL:-http://127.0.0.1:8888}"
CONTAINER="${CONTAINER:-searxng}"
HARVEST_DIR="${HARVEST_DIR:-/opt/docker/llm/searxng/harvest}"
RETAIN_DAYS="${RETAIN_DAYS:-365}"

STATE_DIR=$HARVEST_DIR/.state
CURSOR_FILE=$STATE_DIR/journal.cursor
SETTINGS_HASH_FILE=$STATE_DIR/settings.sha256

mkdir -p "$HARVEST_DIR" "$STATE_DIR"
month=$(date -u +%Y-%m)
out=$HARVEST_DIR/harvest-$month.ndjson
now=$(date -u +%FT%TZ)
tmp=$(mktemp)
tmp2=$(mktemp)
tmp3=$(mktemp)
trap 'rm -f "$tmp" "$tmp.jsonl" "$tmp2" "$tmp3"' EXIT

# --- 1. container journal, continued from the last cursor --------------------
journal_args=(CONTAINER_NAME="$CONTAINER" --output=json --no-pager --quiet)
if [ -s "$CURSOR_FILE" ]; then
  journal_args+=(--cursor="$(cat "$CURSOR_FILE")" --after-cursor)
else
  journal_args+=(--since=today)
fi

journalctl "${journal_args[@]}" > "$tmp.jsonl" 2>/dev/null || true

# searxng writes its Python log to stdout, so each entry is one line shaped as
#   ERROR:searx.engines.yahoo: engine timeout
#   WARNING:searx.engines.qwant: ErrorContext('searx/engines/qwant.py', 182,
#     'raise SearxEngineAccessDeniedException()', 'searx.exceptions.…', None,
#     ('Access denied (suspended_time=180)',)) False
#   ERROR:searx: call to ResultContainer.add_unresponsive_engine after …
jq -c --arg now "$now" '
  select(.MESSAGE != null)
  | . as $e
  | ($e.MESSAGE | if type == "array" then join("\n") else tostring end) as $msg
  | ($msg | (capture("searx\\.engines\\.(?<name>[A-Za-z0-9 ._-]+):") | .name) // null) as $engine
  | ($msg | (capture(", \u0027(?<klass>[A-Za-z0-9_.]+)\u0027, ") | .klass) // null) as $exception
  | ($msg | (capture("ErrorContext.\u0027(?<file>[^,]+)\u0027, (?<line>[0-9]+),") // null)) as $where
  | {
      kind: "journal",
      ts: (($e.__REALTIME_TIMESTAMP // "0") | tonumber / 1000000 | todate),
      collected_at: $now,
      boot_id: ($e._BOOT_ID // null),
      prio: ($e.PRIORITY // null),
      ident: ($e.SYSLOG_IDENTIFIER // $e._COMM // null),
      engine: $engine,
      exception: $exception,
      file: $where.file,
      line: $where.line,
      msg: $msg
    }
' "$tmp.jsonl" >> "$out" 2>/dev/null || true

new_cursor=$(jq -rs 'if length == 0 then empty else (last.__CURSOR // empty) end' "$tmp.jsonl" 2>/dev/null || true)
if [ -n "$new_cursor" ]; then printf '%s\n' "$new_cursor" > "$CURSOR_FILE"; fi

# --- 2. in-process engine failure breakdown ----------------------------------
# `percentage` is relative to that engine's own requests since instance start,
# so frequent snapshots are what turn a snapshot into a trend.
if curl -fsS -m 20 "$SEARXNG_URL/stats/errors" -o "$tmp" 2>/dev/null; then
  jq -c --arg now "$now" '{kind:"stats_errors", ts:$now, payload:.}' "$tmp" >> "$out"
else
  echo "$(date -u +%FT%TZ) harvest: $SEARXNG_URL/stats/errors unavailable" >&2
fi

# --- 3. OpenMetrics engine counters, when a password is configured ----------
# `/metrics` 404s until `general.open_metrics` is set in settings.yml (verified
# on this instance: 404 without it), and it 401s unless the password arrives as
# HTTP Basic auth: webapp.py:1182 compares `sxng_request.authorization.password`,
# which is Werkzeug parsing the `Authorization` header — `?password=...` in the
# query string is not read at all. It is the only source with the *denominator*:
#   searxng_engines_request_count_total   requests sent to the engine
#   searxng_engines_result_count_total    results the engine returned
#   searxng_engines_reliability_total     searxng's own reliability score
#   searxng_engines_response_time_{total,processing,http}_seconds
# Together with journal + /stats/errors this gives failure rates, not just
# failure counts. Counters reset with the process, so a sample right after a
# restart is empty (only engines that have served traffic since start appear).
if [ -n "${OPEN_METRICS_PASSWORD:-}" ]; then
  if curl -fsS -m 20 -u "metrics:${OPEN_METRICS_PASSWORD}" "$SEARXNG_URL/metrics" -o "$tmp" 2>/dev/null; then
    sed -nE 's/^searxng_engines_([a-z_]+)\{engine_name="([^"]+)"\} ([0-9.e+-]+).*/\2\t\1\t\3/p' "$tmp" > "$tmp3"
    if [ -s "$tmp3" ]; then
      # -c is not cosmetic: this file is NDJSON, and a pretty-printed record is
      # read as several unparseable lines (scripts/engine-trends.ts silently
      # counted 0 metrics records until this flag was here).
      jq -c -R -s --arg now "$now" '
        split("\n") | map(select(length > 0) | split("\t"))
        | group_by(.[0])
        | map({ engine: .[0][0], metrics: (map({ (.[1]): (.[2] | tonumber) }) | add) })
        | { kind: "metrics", ts: $now, payload: . }
      ' "$tmp3" >> "$out"
    fi
    rm -f "$tmp3"
  else
    echo "$(date -u +%FT%TZ) harvest: $SEARXNG_URL/metrics unavailable" >&2
  fi
fi

# --- 4. engine configuration, only when it changes ---------------------------
# Engine provenance over time: what was enabled, weighted, timed out, suspended
# at each point in the tuning history. Cheap because it is content-hashed.
if curl -fsS -m 20 "$SEARXNG_URL/config" -o "$tmp" 2>/dev/null; then
  jq -c '{
      engines: [
        .engines[]? | {
          name,
          enabled: (.enabled // false),
          disabled: (.disabled // false),
          suspended_at,
          timeout: (.timeout // null),
          weight: (.weight // null),
          categories: (.categories // []),
          language: (.language // null)
        }
      ]
    }' "$tmp" > "$tmp2" 2>/dev/null || true
  if [ -s "$tmp2" ]; then
    hash=$(sha256sum < "$tmp2" | cut -d' ' -f1)
    if [ ! -f "$SETTINGS_HASH_FILE" ] || [ "$(cat "$SETTINGS_HASH_FILE")" != "$hash" ]; then
      jq -c --arg now "$now" --arg hash "$hash" \
        '{kind:"settings", ts:$now, sha256:$hash, payload:.}' "$tmp2" >> "$out"
      printf '%s\n' "$hash" > "$SETTINGS_HASH_FILE"
    fi
  fi
  rm -f "$tmp2"
fi

# --- 5. retention ------------------------------------------------------------
case "$RETAIN_DAYS" in
  '' | 0) ;;
  *) find "$HARVEST_DIR" -maxdepth 1 -name 'harvest-*.ndjson' -mtime "+$RETAIN_DAYS" -delete ;;
esac

echo "$(date -u +%FT%TZ) harvest ok → $out ($(wc -l < "$out") lines)"
