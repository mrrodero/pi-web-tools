/**
 * Engine tuning report over the *durable* SearXNG sample.
 *
 * `ops/searxng/harvest.sh` appends three kinds of records to monthly NDJSON on
 * the search host; `ops/searxng/fetch-harvest.sh` pulls them here. This script
 * turns months of that sample into the decision the instance needs: which
 * engines earn their keep, which are failing and why, and what the settings
 * history already changed.
 *
 * Counts come from three independent views, deliberately not merged:
 *   journal   per-failure records (engine, exception class, file:line)
 *   metrics   engine request/result counters — the denominator, so rates
 *   settings  engine table snapshots — what was already tuned, and when
 *
 * Usage: `npm run trends [--file path.ndjson] [--since 2026-01-01]`
 * @module pi-web-tools/scripts/engine-trends
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

interface JournalRecord {
  kind: 'journal'
  ts: string
  engine: string | null
  exception: string | null
  file: string | null
  line: string | null
  msg: string
}

interface StatsRecord {
  kind: 'stats_errors'
  ts: string
  payload: Record<string, Array<Record<string, unknown>>>
}

interface MetricsRecord {
  kind: 'metrics'
  ts: string
  payload: Array<{ engine: string, metrics: Record<string, number> }>
}

interface SettingsRecord {
  kind: 'settings'
  ts: string
  sha256: string
  payload: { engines: Array<{ name: string, enabled: boolean, disabled: boolean, suspended_at?: string | null }> }
}

type Record_ = JournalRecord | StatsRecord | MetricsRecord | SettingsRecord

const HARVEST_GLOB_DIR = join(homedir(), '.dsh', 'data', 'web-index')

const args = process.argv.slice(2)
const fileFlag = args.findIndex(arg => arg === '--file')
const sinceFlag = args.findIndex(arg => arg === '--since')
const since = sinceFlag === -1 ? undefined : args[sinceFlag + 1]
const files = fileFlag === -1 ? discoverHarvestFiles() : [args[fileFlag + 1]]

if (files.length === 0) {
  console.error(`no harvest files in ${HARVEST_GLOB_DIR} — run ops/searxng/harvest.sh on the search host, then fetch them with ops/searxng/fetch-harvest.sh`)
  process.exit(1)
}

const records: Record_[] = []
for (const file of files) {
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    try {
      const record = JSON.parse(line) as Record_
      if (since !== undefined && record.ts < since) continue
      records.push(record)
    } catch {
      // A torn final line from an interrupted harvest is not worth a stack trace.
    }
  }
}

const journal = records.filter((r): r is JournalRecord => r.kind === 'journal')
const stats = records.filter((r): r is StatsRecord => r.kind === 'stats_errors')
const metrics = records.filter((r): r is MetricsRecord => r.kind === 'metrics')
const settings = records.filter((r): r is SettingsRecord => r.kind === 'settings')

const span = records.length > 0
  ? `${records.reduce((min, r) => (r.ts < min ? r.ts : min), records[0].ts)} → ${records.reduce((max, r) => (r.ts > max ? r.ts : max), records[0].ts)}`
  : 'empty'

console.log(`=== sample ===`)
console.log(`files: ${files.join(', ')}`)
console.log(`span: ${span}`)
console.log(`records: ${journal.length} journal, ${stats.length} stats_errors, ${metrics.length} metrics, ${settings.length} settings`)

// --- journal view: who fails, how, and how often ---------------------------
interface EngineProfile {
  engine: string
  failures: number
  modes: Map<string, number>
  firstSeen: string
  lastSeen: string
  requests?: number
  results?: number
  reliability?: number
  /** Seconds per counted request, from the OpenMetrics gauges (see below). */
  avgTotalSec?: number
  avgHttpSec?: number
}

const profiles = new Map<string, EngineProfile>()

for (const entry of journal) {
  if (entry.engine === null) continue
  const profile = profiles.get(entry.engine) ?? {
    engine: entry.engine,
    failures: 0,
    modes: new Map<string, number>(),
    firstSeen: entry.ts,
    lastSeen: entry.ts,
  }
  profile.failures += 1
  const mode = failureMode(entry)
  profile.modes.set(mode, (profile.modes.get(mode) ?? 0) + 1)
  if (entry.ts < profile.firstSeen) profile.firstSeen = entry.ts
  if (entry.ts > profile.lastSeen) profile.lastSeen = entry.ts
  profiles.set(entry.engine, profile)
}

// Counters are cumulative per process start, so sum the increase across each
// snapshot pair instead of reading them as absolute numbers. A counter that went
// *down* means the instance restarted (they are per-process), so the current
// value is itself the increase — clamping it to zero would silently drop every
// request made after a restart, which is exactly the window where engines
// misbehave most.
//
// Response times are gauges (an average over the requests counted so far), so
// they are not differenced directly: multiply by that snapshot's request count
// to get a total, then take the difference of totals and divide it by the
// requests that arrived in between. That attributes latency to the window it
// happened in, which is what `timeout:` in settings.yml is being chosen against.
const counters = new Map<string, {
  requests: number, results: number, reliability: number,
  totalSec: number, httpSec: number
}>()
const previous = new Map<string, Record<string, number>>()
for (const snapshot of metrics) {
  for (const engine of snapshot.payload) {
    const before = previous.get(engine.engine)
    const acc = counters.get(engine.engine)
      ?? { requests: 0, results: 0, reliability: 0, totalSec: 0, httpSec: 0 }
    const increase = (key: string) => {
      const now = engine.metrics[key] ?? 0
      const was = before?.[key] ?? 0
      return before === undefined || now < was ? now : now - was
    }
    acc.requests += increase('request_count_total')
    acc.results += increase('result_count_total')
    acc.reliability = engine.metrics.reliability_total ?? acc.reliability

    const nNow = engine.metrics.request_count_total ?? 0
    const nWas = before?.request_count_total ?? 0
    const restarted = before === undefined || nNow < nWas
    for (const [key, field] of [
      ['response_time_total_seconds', 'totalSec'],
      ['response_time_http_seconds', 'httpSec'],
    ] as const) {
      const now = (engine.metrics[key] ?? 0) * nNow
      const was = restarted ? 0 : (before?.[key] ?? 0) * nWas
      acc[field] += Math.max(0, now - was)
    }

    counters.set(engine.engine, acc)
    previous.set(engine.engine, engine.metrics)
  }
}

// The last /stats/errors snapshot is the instance's own current view.
const latestStats = new Map<string, string>()
if (stats.length > 0) {
  for (const [engine, entries] of Object.entries(stats[stats.length - 1].payload)) {
    const parts = entries.map(entry => {
      const klass = String(entry.exception_classname ?? 'error')
      const pct = typeof entry.percentage === 'number' ? `${entry.percentage}%` : '?'
      return `${klass} ${pct}`
    })
    latestStats.set(engine, parts.join(', '))
  }
}

for (const [engine, acc] of counters) {
  const profile = profiles.get(engine) ?? {
    engine, failures: 0, modes: new Map(), firstSeen: '', lastSeen: '',
  }
  profile.requests = acc.requests
  profile.results = acc.results
  profile.reliability = acc.reliability
  profile.avgTotalSec = acc.requests > 0 ? acc.totalSec / acc.requests : undefined
  profile.avgHttpSec = acc.requests > 0 ? acc.httpSec / acc.requests : undefined
  profiles.set(engine, profile)
}

const rows = [...profiles.values()].sort((a, b) => b.failures - a.failures || a.engine.localeCompare(b.engine))

console.log('\n=== engine failure counts (harvested journal) ===')
console.log('engine              fails  rate   requests  results  reliab  avg_s  http_s  dominant failure mode')
for (const row of rows) {
  const rate = row.requests !== undefined && row.requests > 0
    ? `${Math.round((row.failures / row.requests) * 100)}%`.padStart(5)
    : '  n/a'
  const mode = [...row.modes.entries()].sort((a, b) => b[1] - a[1])[0]
  const secs = (v: number | undefined) =>
    typeof v === 'number' ? v.toFixed(2).padStart(5) : '    -'
  console.log(
    `  ${row.engine.padEnd(18)} ${String(row.failures).padStart(5)} ${rate}`
    + ` ${String(row.requests ?? '-').padStart(9)} ${String(row.results ?? '-').padStart(7)}`
    + ` ${typeof row.reliability === 'number' ? row.reliability.toFixed(2).padStart(6) : '     -'}`
    + ` ${secs(row.avgTotalSec)} ${secs(row.avgHttpSec)}`
    + `  ${mode === undefined ? '' : `${mode[0]} ×${mode[1]}`}`,
  )
}
if (metrics.length > 0) {
  console.log(
    'avg_s / http_s are per-request averages over the requests this sample counted,\n' + 
    'derived from SearXNG\'s gauges; `http_s` is the fetch and the difference is\n' +
    'SearXNG\'s own processing. A timeout failure on an engine whose avg_s is well\n' +
    'below the configured `timeout:` means the budget is not the problem — the engine\n' +
    'or the path to it is.',
  )
}

// --- non-engine journal: the instance's own problems -----------------------
// Journal lines without an engine name are searxng complaining about itself —
// 500s, tracebacks, configuration, limiter. They are collected by harvest.sh in
// the same pass, so they get a section here instead of being silently dropped.
const serverModes = new Map<string, { count: number, firstSeen: string, lastSeen: string, example: string }>()
for (const entry of journal) {
  if (entry.engine !== null) continue
  const signature = entry.msg
    .replace(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d,\d+ \w+:searx[^:]*: ?/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100)
  if (signature === '') continue
  const mode = serverModes.get(signature) ?? { count: 0, firstSeen: entry.ts, lastSeen: entry.ts, example: entry.msg }
  mode.count += 1
  if (entry.ts < mode.firstSeen) mode.firstSeen = entry.ts
  if (entry.ts > mode.lastSeen) mode.lastSeen = entry.ts
  serverModes.set(signature, mode)
}

console.log('\n=== journal without an engine (instance-level noise) ===')
if (serverModes.size === 0) {
  console.log('  none in this sample')
} else {
  const top = [...serverModes.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 12)
  for (const [signature, mode] of top) {
    console.log(`  ×${String(mode.count).padStart(4)}  ${signature}`)
    console.log(`        first ${mode.firstSeen}  last ${mode.lastSeen}`)
  }
  const dropped = serverModes.size - top.length
  if (dropped > 0) console.log(`  (${dropped} further signatures not shown)`)
}

// --- settings history: what has already been tuned -------------------------
console.log('\n=== settings changes in the sample ===')
if (settings.length === 0) {
  console.log('  (no settings snapshots yet)')
} else {
  let previousState: Map<string, string> | undefined
  for (const snapshot of settings) {
    const state = new Map<string, string>()
    for (const engine of snapshot.payload.engines) {
      state.set(engine.name, engine.disabled ? 'disabled' : engine.enabled ? 'enabled' : 'off')
    }
    const changes: string[] = []
    if (previousState !== undefined) {
      for (const [name, value] of state) {
        const before = previousState.get(name)
        if (before === undefined) changes.push(`+${name} (${value})`)
        else if (before !== value) changes.push(`${name}: ${before} → ${value}`)
      }
      for (const name of previousState.keys()) {
        if (!state.has(name)) changes.push(`-${name} (removed)`)
      }
    }
    console.log(`  ${snapshot.ts}  ${settings.length > 1 && changes.length === 0 ? '(unchanged snapshot)' : `${state.size} engines`}${changes.length > 0 ? `  ${changes.slice(0, 12).join(', ')}${changes.length > 12 ? ` …+${changes.length - 12} more` : ''}` : ''}`)
    previousState = state
  }
}

// --- instance's own current view -------------------------------------------
if (latestStats.size > 0) {
  console.log('\n=== latest /stats/errors snapshot ===')
  for (const [engine, modes] of latestStats) console.log(`  ${engine.padEnd(18)} ${modes}`)
}

// --- decision block ---------------------------------------------------------
const candidates = rows.filter(row => {
  if (row.failures === 0) return false
  if (row.requests !== undefined && row.requests >= 20 && row.failures / row.requests < 0.25) return false
  return row.failures >= 5
})

console.log('\n=== settings.yml candidates ===')
console.log('Rules: ≥5 recorded failures, and either no request counter (never')
console.log('succeeded) or ≥25% failure rate over counted requests. Re-measure after')
console.log('each change — engine health is time-of-day and rate-limit dependent.')
if (candidates.length === 0) {
  console.log('  none: the sample does not yet show a persistently failing engine')
}
for (const row of candidates) {
  const mode = [...row.modes.entries()].sort((a, b) => b[1] - a[1])[0]
  console.log(`  - name: ${row.engine}`)
  console.log(`    disabled: true   # ${row.failures} failures${row.requests !== undefined ? ` / ${row.requests} requests` : ''}, ${mode[0]}`)
}

function discoverHarvestFiles(): string[] {
  if (!existsSync(HARVEST_GLOB_DIR)) return []
  return readdirSync(HARVEST_GLOB_DIR)
    .filter(name => name.startsWith('harvest-') && name.endsWith('.ndjson'))
    .sort()
    .map(name => join(HARVEST_GLOB_DIR, name))
}

/**
 * A short label for why an engine failed. Most lines carry an exception class;
 * the timeout/error lines that searxng logs without one are identified by the
 * text after its `LEVEL:searx.engines.<name>: ` prefix, so a month of samples
 * groups into a handful of modes instead of a wall of distinct messages.
 */
function failureMode(entry: JournalRecord): string {
  if (entry.exception !== null) return entry.exception
  const tail = entry.msg.replace(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d,\d+ \w+:searx[^:]*: ?/, '').trim()
  const timeout = tail.match(/(engine timeout|timed? out)/i)
  if (timeout !== null) return 'timeout (no exception recorded)'
  return tail.slice(0, 60)
}
