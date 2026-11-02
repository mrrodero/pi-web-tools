/**
 * Engine-health harness for the self-hosted SearXNG instance.
 *
 * Two signals, one report:
 * 1. `/stats/errors` — SearXNG's own per-engine failure breakdown (exception
 *    class, file:line, share of that engine's failures) since instance start.
 * 2. A fixed probe-query sweep through the same code path `web_search` uses,
 *    which counts what the agent actually experiences: thin result sets and
 *    `unresponsive_engines`.
 *
 * Every run appends one NDJSON line to a durable log next to the corpus, so
 * the sample grows across days instead of dying with the container's journal.
 * SearXNG's in-process metrics reset on restart; this log does not.
 *
 * Usage: `npm run health [-- errors-only] [--probes N] [--no-log]`
 * @module pi-web-tools/scripts/engine-health
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { loadConfig } from '../src/config.ts'
import { searchSearxng } from '../src/searxng.ts'

/** Fixed probe set: stable across runs so samples are comparable. */
const SEED_QUERIES = [
  'rust async runtime comparison',
  'sqlite wal checkpoint mode',
  'docker compose healthcheck nonprivileged',
  'typescript satisfies operator',
  'onnxruntime node gpu execution provider',
  'systemd journald persistent storage SystemMaxUse',
  'searxng settings.yml disable engine',
  'playwright headless chromium docker memory',
  'llama.cpp gguf quantization quality selection',
  'node:sqlite DatabaseSync prepared statement',
]

/** One engine's aggregate over the sweep. */
interface EngineTally {
  engine: string
  /** Times the engine contributed one of the returned hits. */
  hitAppearances: number
  /** Times SearXNG reported this engine as unresponsive. */
  failures: number
  /** Failure reasons seen, most frequent first. */
  reasons: Map<string, number>
  /** Slowest observed query latency while this engine was in flight (ms). */
  worstQueryMs: number
}

interface SweepRow {
  query: string
  ms: number
  results: number
  unresponsive: Array<{ engine: string, reason: string }>
}

interface HealthLogRecord {
  at: string
  baseURL: string
  probes: number
  sweep: SweepRow[]
  tally: Array<Omit<EngineTally, 'reasons'> & { reasons: Record<string, number> }>
  statsErrors: unknown
}

const args = process.argv.slice(2)
const errorsOnly = args.includes('--errors-only')
const noLog = args.includes('--no-log')
const probesIndex = args.findIndex(arg => arg === '--probes' || arg.startsWith('--probes='))
const probesValue = probesIndex === -1
  ? undefined
  : (args[probesIndex].includes('=') ? args[probesIndex].split('=')[1] : args[probesIndex + 1])
const probeCount = probesValue === undefined || probesValue === ''
  ? SEED_QUERIES.length
  : Math.max(1, Math.min(SEED_QUERIES.length, Number(probesValue) || SEED_QUERIES.length))

const config = loadConfig()
const logPath = process.env.PI_WEB_TOOLS_HEALTH_LOG
  ?? join(homedir(), '.dsh', 'data', 'web-index', 'engine-health.ndjson')

const errors = await fetchStatsErrors(config.searxngBaseURL)
printStatsErrors(errors)

const tally = new Map<string, EngineTally>()
const sweep: SweepRow[] = []

if (!errorsOnly) {
  console.log(`\n=== probe sweep (${probeCount} queries, sequential) ===`)
  for (const query of SEED_QUERIES.slice(0, probeCount)) {
    const started = performance.now()
    try {
      const { hits, unresponsive } = await searchSearxng(config.searxngBaseURL, query, { maxResults: 10 })
      const ms = Math.round(performance.now() - started)
      sweep.push({ query, ms, results: hits.length, unresponsive })
      const contributed = new Set(hits.flatMap(hit => hit.engines))
      for (const engine of contributed) tallyOf(engine).hitAppearances += 1
      for (const entry of unresponsive) {
        const row = tallyOf(entry.engine)
        row.failures += 1
        row.reasons.set(entry.reason, (row.reasons.get(entry.reason) ?? 0) + 1)
      }
      for (const engine of contributed) tallyOf(engine).worstQueryMs = Math.max(tallyOf(engine).worstQueryMs, ms)
      for (const entry of unresponsive) tallyOf(entry.engine).worstQueryMs = Math.max(tallyOf(entry.engine).worstQueryMs, ms)
      console.log(
        `${String(hits.length).padStart(3)} results ${String(ms).padStart(5)}ms  ${query}`
        + (unresponsive.length > 0 ? `  — dead: ${unresponsive.map(e => `${e.engine}:${e.reason}`).join(' ')}` : ''),
      )
    } catch (error) {
      console.log(`  !! ${query}: ${String(error)}`)
    }
  }
  printTally(tally, sweep)
}

const record: HealthLogRecord = {
  at: new Date().toISOString(),
  baseURL: config.searxngBaseURL,
  probes: sweep.length,
  sweep,
  tally: [...tally.values()]
    .sort((a, b) => b.failures - a.failures || a.hitAppearances - b.hitAppearances)
    .map(row => ({
      engine: row.engine,
      hitAppearances: row.hitAppearances,
      failures: row.failures,
      worstQueryMs: row.worstQueryMs,
      reasons: Object.fromEntries(row.reasons),
    })),
  statsErrors: errors,
}

if (!noLog) {
  mkdirSync(dirname(logPath), { recursive: true })
  appendFileSync(logPath, `${JSON.stringify(record)}\n`, 'utf8')
  console.log(`\nappended sample to ${logPath}`)
}

function tallyOf(engine: string): EngineTally {
  let row = tally.get(engine)
  if (row === undefined) {
    row = { engine, hitAppearances: 0, failures: 0, reasons: new Map(), worstQueryMs: 0 }
    tally.set(engine, row)
  }
  return row
}

/** SearXNG's `/stats/errors` is JSON without auth on a LAN instance. */
async function fetchStatsErrors(baseURL: string): Promise<unknown> {
  try {
    const response = await fetch(`${baseURL.replace(/\/+$/u, '')}/stats/errors`, {
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) return { error: `HTTP ${response.status}` }
    return await response.json()
  } catch (error) {
    return { error: String(error) }
  }
}

function printStatsErrors(errors: unknown): void {
  console.log('=== /stats/errors (instance-side, since last restart) ===')
  if (errors === null || typeof errors !== 'object' || Array.isArray(errors)) {
    console.log(`  unavailable: ${JSON.stringify(errors)}`)
    return
  }
  for (const [engine, entries] of Object.entries(errors as Record<string, unknown>)) {
    if (!Array.isArray(entries)) continue
    const parts = entries.map((entry: Record<string, unknown>) => {
      const pct = typeof entry.percentage === 'number' ? `${entry.percentage}%` : '?'
      const where = typeof entry.filename === 'string' ? ` (${entry.filename}:${String(entry.line_no ?? '?')})` : ''
      return `${pct} ${String(entry.exception_classname ?? 'error')}${where}`
    })
    console.log(`  ${engine.padEnd(16)} ${parts.join(' | ')}`)
  }
}

function printTally(tallies: Map<string, EngineTally>, sweep: SweepRow[]): void {
  const rows = [...tallies.values()].sort(
    (a, b) => b.failures - a.failures || b.hitAppearances - a.hitAppearances,
  )
  const latencies = sweep.map(row => row.ms).sort((a, b) => a - b)
  const dead = new Map<string, number>()
  for (const row of sweep) {
    for (const entry of row.unresponsive) dead.set(entry.engine, (dead.get(entry.engine) ?? 0) + 1)
  }

  console.log('\n=== engine tally over this sweep ===')
  console.log('appearances = hit-contributions + failures (an engine that returned only')
  console.log('deduplicated-away results counts as neither, so rates are lower bounds)')
  console.log('engine                hits  fails   rate   slowest')
  for (const row of rows) {
    const total = row.hitAppearances + row.failures
    const rate = total === 0 ? '  n/a' : `${Math.round((row.failures / total) * 100)}%`.padStart(5)
    const reasons = [...row.reasons.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => `${reason}×${count}`)
      .join(' ')
    console.log(
      `  ${row.engine.padEnd(20)} ${String(row.hitAppearances).padStart(4)} ${String(row.failures).padStart(6)}`
      + ` ${rate}  ${String(row.worstQueryMs).padStart(6)}ms  ${reasons}`,
    )
  }

  console.log(`\nquery latency: p50 ${latencies[Math.floor(latencies.length / 2)] ?? 0}ms `
    + `max ${latencies[latencies.length - 1] ?? 0}ms`)
  const thin = sweep.filter(row => row.results < 5)
  console.log(`queries with <5 results: ${thin.length}/${sweep.length}`
    + (thin.length > 0 ? ` (${thin.map(row => row.query).join('; ')})` : ''))

  const candidates = [...dead.entries()]
    .filter(([engine, count]) => count >= Math.max(2, sweep.length / 3) && (tally.get(engine)?.hitAppearances ?? 0) === 0)
    .sort((a, b) => b[1] - a[1])
  if (candidates.length > 0) {
    console.log('\n=== settings.yml candidates (dead in most probes, never contributed a hit) ===')
    console.log('engines:')
    for (const [engine, count] of candidates) {
      console.log(`  - name: ${engine}\n    disabled: true   # dead in ${count}/${sweep.length} probes`)
    }
  }
}
