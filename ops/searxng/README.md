# SearXNG observability ops (host `192.168.144.120`, container `searxng`)

Everything here was measured on 2026-11-02 against the live instance. File paths
and line numbers refer to files inside the running container
(`docker exec searxng …`) or on the DietPi host (`ssh root@192.168.144.120`).

---

## 1. Why you can only see logs from yesterday

This is the state as found, before §2 was applied. It is kept as written because
it is the diagnosis, and because the same reasoning is what you would apply to
the next host.

The chain, end to end:

| Layer | What it is here | Evidence |
|---|---|---|
| app | searxng logs to stdout (uwsgi), no log file | `/etc/searxng/` inside the container contains `settings.yml` and nothing else |
| docker | logging driver is **journald**, so there are no `<id>-json.log` files | `docker info` → `Logging Driver: journald`; `docker inspect searxng --format '{{.HostConfig.LogConfig.Type}}'` → `journald` |
| journald | **volatile only** — nothing is written to disk | `ls -ld /var/log/journal` → *No such file or directory*; `journalctl --disk-usage` → 8 MB, all of it under `/run/log/journal` |
| config | defaults, with no drop-in | `/etc/systemd/journald.conf` contains only `[Journal]` |

`journalctl --list-boots` is the clincher:

```
IDX BOOT ID                          FIRST ENTRY                 LAST ENTRY
  0 bdd4526ad2384bd5867c7f35d4c0a0b8 Sun 2026-11-01 19:09:56 CET Mon 2026-11-02 11:12:50 CET
```

One boot. A volatile journal dies with the boot, so the window does not start at
"yesterday" because of a retention rule — it starts at the last boot. The first
searxng line in it is `Nov 01 19:10:41 … SearXNG 2026.10.24-ef0ec03da`, i.e. the
container coming up after that boot.

**Anything before 2026-11-01 19:09:56 CET is not recoverable on that host.** It
was never written to disk, and there is no rsyslog/syslog-ng, no json-file log,
no searxng log file, and the result-cache volume (`core-data` →
`/var/cache/searxng/`) is empty — `search.cache_span` defaults to 0, so nothing
was cached either.

What *is* still recoverable about the past:

```bash
docker inspect searxng --format 'created={{.Created}} started={{.State.StartedAt}} restarts={{.RestartCount}}'
#   created=2026-10-24T20:19:30Z  started=2026-11-01T18:10:39Z  restartcount=0
curl -s http://192.168.144.120:8888/stats/errors   # per-engine failure percentages since that start
ls -l /opt/docker/llm/searxng/core-config/settings.yml
```

So: the container's *lifetime* history survives (Docker's own metadata), and the
instance's in-process engine statistics survive; the *log lines* do not.

## 2. Making it durable — `journal-persist.sh` (applied 2026-11-02 12:45 CET)

`journal-persist.sh` turns the volatile journal into a disk-backed one. It
verifies before changing anything, prints exactly what it is about to do, and
refuses to run without `--apply`. It writes
`/etc/systemd/journald.conf.d/90-searxng-retention.conf` with `Storage=persistent`
plus size caps, creates `/var/log/journal`, restarts `systemd-journald`, flushes
the current volatile entries to disk, and rotates them to bound growth:

```bash
ssh root@192.168.144.120 'cat > /usr/local/sbin/journal-persist.sh && chmod 755 /usr/local/sbin/journal-persist.sh' < journal-persist.sh
ssh root@192.168.144.120 'journal-persist.sh'            # read-only: shows state + what would change
ssh root@192.168.144.120 'journal-persist.sh --apply'    # the change
journalctl --disk-usage && journalctl --list-boots       # verify
```

Here it was piped to `bash` once rather than installed under `/usr/local/sbin`,
so re-running it means piping `journal-persist.sh` again. State on the host now:

```
/etc/systemd/journald.conf.d/90-searxng-retention.conf   Storage=persistent, SystemMaxUse=1G,
                                                          SystemMaxFileSize=100M, SystemMaxFiles=20,
                                                          MaxFileSec=1week
journalctl --disk-usage                                   5M
/var/log/journal                                          present, owned root
```

The change paid for itself within the hour. At 12:39 CET the container was
crash-looping over a bad `settings.yml` (see §5), and the journal kept it —
`autocomplete: null` is rejected by the schema, and every restart said so:

```
2026-11-02T12:39:08+01:00 … search.autocomplete: The value has to be one of these types/values: str
2026-11-02T12:39:08+01:00 …   File "/usr/local/searxng/searx/settings_defaults.py", line 179, in apply_schema
2026-11-02T12:39:08+01:00 …     raise ValueError("Invalid settings.yml")
```

Under the old volatile journal a restart of `systemd-journald`, a reboot, or a
`docker compose down` would have thrown that away. (The 12:45 CET flush is
what saved those lines at all; the hourly logclear described in §3 wiped them
from the journal at 13:17 CET, so the quote above is now the only copy.)

After that, searxng logs survive reboots, `docker compose down`, and container
recreation. Note this is host-wide — it also keeps DietPi's other services.
Nothing here needs a reboot; `systemctl restart systemd-journald` is enough, and
it does not touch the searxng container.

## 3. The harvest loop

`harvest.sh` (server side) appends NDJSON to
`/opt/docker/llm/searxng/harvest/harvest-YYYY-MM.ndjson`, one record per line,
in four kinds:

- `journal` — each searxng log line since the last run, parsed into
  `engine` / `exception` / `file` / `line`. Read with `journalctl
  --after-cursor=<last cursor>` — one combined option, because a bare
  `--after-cursor` flag errors out and the script's `|| true` swallows it.
  That is exactly what happened on 2026-11-02: the first run (10:46:28Z,
  `--since=today`) wrote the cursor and landed the 24 journal records, and
  every run after that took this branch and silently landed nothing until
  14:05:29Z, a 3.3 h gap in the journal sample — so it is incremental and never
  re-reads a window.
- `stats_errors` — the instance's own `GET /stats/errors` snapshot: per-engine
  failure classes with percentages *relative to that engine's requests since
  instance start*. Only repeated snapshots make a trend.
- `metrics` — `GET /metrics` OpenMetrics counters, collected when
  `OPEN_METRICS_PASSWORD` is set. This is the only source of denominators:
  `searxng_engines_request_count_total`, `…_result_count_total`,
  `…_reliability_total`, `…_response_time_*_seconds`. It is now the fourth kind
  in the live sample, not a plan: `general.open_metrics` is set, and
  `harvest.sh` authenticates with **HTTP Basic** — `curl -u "metrics:$pass"`.
  `webapp.py:1182` compares `sxng_request.authorization.password`, which is
  Werkzeug reading the `Authorization` header; `?password=…` in the query string
  is never read (it returns 401 on this build, which is what cost the first two
  harvest runs their metrics). Before `open_metrics` was set the endpoint
  answered 404; a wrong password answers 401.
- `settings` — the engine table, hashed, recorded only when it changes; so a
  month of tuning becomes a readable history of what was enabled/disabled when.

Retention: current month uncompressed, previous months gzip'd, `HARVEST_KEEP_MONTHS`
(default 12) before deletion.

Two rules this file has to obey, both learned the hard way:

- **One record per line.** The metrics `jq` was missing `-c`, so its record landed
  pretty-printed across ~130 lines, every one of them unparseable, and
  `scripts/engine-trends.ts` reported `0 metrics` while the data sat in the file.
  The NDJSON was rewritten compactly (110 lines → 34) and `-c` is now on that
  call.
- **Secrets stay off the host's git.** `settings.yml` in this directory carries
  `COPY_THE_EXISTING_KEY` / `SET_A_SEPARATE_METRICS_PASSWORD` placeholders; the
  live file at `/opt/docker/llm/searxng/core-config/settings.yml` carries the real
  values (previous version kept as `settings.yml.bak-20261102T113510Z`), and
  `harvest.sh` gets the metrics password from
  `/opt/docker/llm/searxng/harvest/harvest.env` (root, mode 600), which it sources
  itself. That is the second thing this wiring got wrong before it got right: a
  crontab line that sources the file (`cron.d` runs its command through a shell
  where `. file` assigns **without** exporting) left `harvest.sh` with the
  variable unset, so the `metrics` record quietly stopped landing every 15 minutes
  while the other three kinds kept arriving. `env -u OPEN_METRICS_PASSWORD -i …
  harvest.sh` is the check that proves the script can find its own config.
  Applying this drop-in therefore means: read
  the two live secrets, substitute them into a copy of this file, write it,
  restart — never edit the copy in git.

`/etc/cron.d/searxng-harvest` (from `cron.d.example`) is installed and `cron` is
active, so a sample lands every 15 minutes whether anyone is looking or not. Its
run log is `/opt/docker/llm/searxng/harvest/harvest.log`, deliberately **not** in
`/var/log`: `/etc/cron.hourly/dietpi` runs `/boot/dietpi/func/dietpi-logclear`
every hour at :17 and truncates **every file under `/var/log`** in place — no
logrotate config, no `.1` copy, the file is simply 0 bytes afterwards (measured
on a log that had two lines in it; `/var/log/rsyncd.log` was empty in the same
minute). That includes the journald storage under `/var/log/journal/`, so even
the §2 persistent journal keeps only the last hour of lines (measured: the
12:39 CET crash-loop lines, flushed to disk at 12:45 CET, were gone at the
13:17 CET pass; everything logged since remained). The 15-minute cadence is
therefore the actual retention mechanism for journal lines — a gap of more than
an hour (host off, cron off) loses whatever the journal still held. Do
**not** cron `scripts/engine-health.ts` — its probes send real queries to real
engines, and doing that unattended is how you get rate-limited, which is the very
failure it measures.

Then, from this machine:

```bash
bash ops/searxng/fetch-harvest.sh   # ssh-cat the NDJSON into ~/.dsh/data/web-index/
npm run trends                      # aggregate the whole sample → settings candidates
npm run health                      # live probe sweep, by hand, when you want a fresh read
```

(`fetch-harvest.sh` uses `ssh host cat`, not `scp`: DietPi ships no
`/usr/lib/sftp-server`, so `scp` dies with "Connection closed".)

## 4. Reading the logs by hand

The gotcha that costs people the most time: `journalctl -u searxng` returns
`-- No entries --`. Containers are not systemd units here — the unit is
`docker.service`. Filter by the container field instead:

```bash
journalctl CONTAINER_NAME=searxng --since "2026-11-01 19:10:00" --until now
journalctl CONTAINER_NAME=searxng -p warning --no-pager          # warnings and errors only
journalctl CONTAINER_NAME=searxng --output=json --since today |  # machine-readable, what harvest.sh reads
  jq -r 'select(.MESSAGE!=null) | .MESSAGE'
journalctl CONTAINER_NAME=searxng -n 1 --show-cursor -q | tail -1  # the cursor to resume from

docker logs searxng --since 24h          # same content, through the journald driver
curl -s http://192.168.144.120:8888/stats/errors | jq 'to_entries[] | {engine:.key, errors:[.value[] | {class:.exception_classname, pct:.percentage}]}'
```

And the red herring to skip: `ERROR:searx.botdetection: X-Forwarded-For nor
X-Real-IP header is set!` appears once per container start and means nothing is
wrong. `searx/limiter.py:226-231` initializes botdetection *"even if the limiter
is not activated"* (the self-info plugin wants a client IP), and
`searx/botdetection/trusted_proxies.py:151` logs that line once per process when
neither header is present. Agents connect straight to `:8888`, so it is expected.

## 5. What today's sample says

`npm run health` (10 probe queries, sequential) and `npm run trends` (the
harvested hour) on 2026-11-02:

| engine | harvested failures | `/stats/errors` | probes answered | verdict |
|---|---|---|---|---|
| duckduckgo | 6 (CAPTCHA ×5) | CAPTCHA 80%, IndexError 5% | 0 / 10 | disable for now, re-measure later |
| qwant | 8 (access denied ×6) | access denied 90% | 0 / 10 | disable (already auto-suspended) |
| yahoo | 4 (`engine timeout`) | 5% timeout, 5% error | 10 / 10 | keep, raise `timeout` to 5.0 |
| wikipedia | 2 (`engine timeout`) | 5% timeout | – | keep, raise `timeout` to 5.0 |
| brave, google cse | 0 | – | 10 / 10 | keep |
| bing, mwmbl | 0 | – | 5 / 10, 5 / 10 | keep |

Query latency in that sweep: p50 1486 ms, worst 2005 ms; no query returned fewer
than 5 results.

The drop-in is applied to the live instance, and the denominators arrived the
same day, which turned the counts into rates. From `npm run trends` on the
harvested sample (24 journal, 8 stats_errors, 2 metrics, 2 settings records,
09:50Z → 12:05Z):

| engine | journal failures | counted requests | results | rate | dominant mode |
|---|---|---|---|---|---|
| yahoo | 4 | 5 | 7 | 80% | timeout, no exception recorded |
| wikipedia | 2 | 5 | 0 | 40% | timeout |
| bing / brave / google cse / mwmbl / wikidata | 0 | 5 each | 10 / 23 / 20 / 9 / 0 | 0% | — |
| duckduckgo | 6 | never counted | — | n/a | CAPTCHA ×5 |
| qwant | 8 | never counted | — | n/a | access denied ×6 |

An engine that never appears in `/metrics` has never served a successful request
since instance start — that absence is itself the signal, and it is why the
candidate rule in `engine-trends.ts` accepts "≥5 failures **and** no request
counter" as disqualifying.

Two incidents worth recording, both caught by the new persistent journal:

- `autocomplete: null` (an attempt to switch autocomplete off) crash-looped the
  container: `search.autocomplete: The value has to be one of these types/values:
  str` → `ValueError: Invalid settings.yml` (`settings_defaults.py:179`), repeated
  on every worker start. The schema allows `""`, not `null`. The live file now has
  `autocomplete: bing` — an engine that is actually enabled, since the default
  backend is duckduckgo, which this file disables.
- Editing `settings.yml` on the host is the risky operation, not this repo's copy:
  a bad value takes the search instance down until it is fixed. Keep the backup
  (`settings.yml.bak-<utc>`) next to it, and `docker inspect searxng` will not
  tell you it happened — `RestartCount` reads 0 after the container comes back up,
  so the journal is the only record of the crash-loop.

`settings.yml` in this directory is a drop-in that keeps everything the live file
does and applies those findings, with the measurement written next to each
change. Two things it fixes that are not engine-related: the live file declares
`use_default_settings: true` **twice** (lines 1 and 20 — PyYAML keeps the last
silently, so a future dict form would be surprising), and it states
`general.enable_metrics` explicitly because `/metrics` needs it.

## 6. What is still weak about this

- The journal's retention on this host is ~1 hour: DietPi's hourly logclear
  truncates the journald storage too (see §3), so the harvest cadence is
  load-bearing and the NDJSON is the only durable copy of journal lines.
- Engine health is time-of-day and rate-limit dependent. duckduckgo contributed
  the best-scoring results earlier on 2026-11-02 and was CAPTCHA-blocked 10/10
  later the same day. Treat every candidate block as provisional and re-measure.
- Denominators exist now, but they are **per process**: `/metrics` counts from
  instance start, so `engine-trends.ts` diffs consecutive snapshots and treats a
  counter that went down as a restart. A restart inside a window still blurs who
  answered what, and the sample so far contains a restart at 11:43Z plus the
  12:39Z crash-loop.
- The sample is two hours, four record kinds, and one instance generation. The
  thresholds in `engine-trends.ts` (≥5 failures, or ≥25% of counted requests) are
  starting points for a decision, not statistics. The cron job is what makes it a
  sample rather than an anecdote — let it run for weeks before trusting a rate.
- Nothing measures the *agent side* yet: `web_search` quality (does the engine mix
  actually answer a research question) is a judgement about results, and no
  harvested counter here speaks to that. `scripts/engine-health.ts` is the closest
  thing, and it is manual by design.
- What has been changed on the host, and how to undo it:
  `/etc/systemd/journald.conf.d/90-searxng-retention.conf` (`rm` it and
  `systemctl restart systemd-journald` to go back to volatile),
  `/etc/systemd/journald.conf.d`/`/var/log/journal` (created; `du -sh` says 5M),
  `core-config/settings.yml` (replaced from this directory, with real secrets
  substituted and `settings.yml.bak-20261102T113510Z` beside it),
  `/etc/cron.d/searxng-harvest`, and `/opt/docker/llm/searxng/harvest/`
  (NDJSON + `.state/` cursor + `harvest.env`, mode 600). `/var/log/journal` is
  new (5M so far, capped at 1G). `rm -f
  /etc/cron.d/searxng-harvest && rm -rf /opt/docker/llm/searxng/harvest` and
  restoring the `.bak` reverts the observability work completely.
