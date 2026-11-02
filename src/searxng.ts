/**
 * `web_search` backend: a self-hosted SearXNG instance's JSON API
 * (`GET /search?format=json`). Entries without a snippet are dropped —
 * there is no other field to derive one from, and inventing one would lie.
 *
 * The response also carries SearXNG's own engine-health report
 * (`unresponsive_engines`) and the per-result `engines` provenance, both of
 * which are surfaced: an agent that cannot tell "nothing matches this query"
 * from "the engines behind this instance broke" tunes its search blind.
 *
 * Ported from `@deepseek-ai/dsh-web-tools` (MIT).
 * @module pi-web-tools/searxng
 */

/** Time-range filter values SearXNG accepts for `time_range`. */
export type SearxngTimeRange = 'day' | 'month' | 'year'

/** One normalized search result. */
export interface SearxngHit {
  readonly url: string
  readonly title: string
  readonly snippet: string
  readonly publishedAt?: string
  /** Engines that contributed this result (SearXNG merges duplicates). */
  readonly engines: string[]
}

/**
 * One engine SearXNG could not get an answer from on this query.
 * `reason` is SearXNG's failure key (`timeout`, `captcha`, `access denied`,
 * `too many requests`, …) or the exception text for older builds.
 */
export interface UnresponsiveEngine {
  readonly engine: string
  readonly reason: string
}

/** One search: the ranked hits plus the engine-health report. */
export interface SearxngSearch {
  readonly hits: SearxngHit[]
  readonly unresponsive: UnresponsiveEngine[]
}

/** Raw SearXNG response envelope (the fields this module uses). */
interface SearxngResult {
  url?: string
  title?: string
  content?: string
  publishedDate?: string
  engines?: string[]
}

interface SearxngSearchResponse {
  results?: SearxngResult[]
  unresponsive_engines?: unknown[]
  error?: string
  message?: string
}

/**
 * Run one search.
 *
 * @param baseURL - the SearXNG instance base URL.
 * @param query - the query text.
 * @param opts - filters and the result cap.
 * @param signal - optional cancellation signal.
 * @returns the ranked hits and the engines SearXNG could not use.
 */
export async function searchSearxng(
  baseURL: string,
  query: string,
  opts: {
    categories?: string
    language?: string
    timeRange?: SearxngTimeRange
    maxResults: number
    signal?: AbortSignal
  },
): Promise<SearxngSearch> {
  if (baseURL.length === 0 || !URL.canParse(baseURL)) {
    throw new Error('web_search unavailable: SearXNG base URL not configured')
  }
  const search = new URL('/search', baseURL)
  search.searchParams.set('q', query)
  search.searchParams.set('format', 'json')
  if (opts.categories !== undefined && opts.categories.length > 0) {
    search.searchParams.set('categories', opts.categories)
  }
  if (opts.language !== undefined && opts.language.length > 0) {
    search.searchParams.set('language', opts.language)
  }
  if (opts.timeRange !== undefined) {
    search.searchParams.set('time_range', opts.timeRange)
  }

  let response: Response
  try {
    response = await fetch(search, {
      redirect: 'error',
      headers: { accept: 'application/json' },
      signal: opts.signal,
    })
  } catch (error) {
    if (isAbortError(error)) throw new Error('SearXNG search aborted')
    throw new Error(`SearXNG search request failed: ${String(error)}`)
  }

  if (!response.ok) {
    let message = `SearXNG API error (HTTP ${response.status})`
    try {
      const parsed = (await response.json()) as { error?: string; message?: string }
      const detail = parsed.error ?? parsed.message
      if (typeof detail === 'string' && detail.length > 0) message = detail
    } catch {
      // A non-JSON error body can only cost a richer error message.
    }
    throw new Error(message)
  }

  let payload: SearxngSearchResponse
  try {
    payload = (await response.json()) as SearxngSearchResponse
  } catch (error) {
    if (isAbortError(error)) throw new Error('SearXNG search aborted')
    throw new Error('SearXNG returned an unprocessable response body')
  }

  const hits: SearxngHit[] = []
  for (const result of payload.results ?? []) {
    const snippet = result.content?.trim()
    if (result.url === undefined || snippet === undefined || snippet.length === 0) continue
    const publishedAt = result.publishedDate
    hits.push({
      url: result.url,
      title: result.title?.trim() ?? '',
      snippet,
      // SearXNG emits `"publishedDate": null` rather than omitting the field.
      ...(typeof publishedAt === 'string' && publishedAt.length > 0 ? { publishedAt } : {}),
      engines: Array.isArray(result.engines) ? result.engines.map(String) : [],
    })
    if (hits.length >= opts.maxResults) break
  }
  return { hits, unresponsive: parseUnresponsive(payload.unresponsive_engines) }
}

/** Normalize SearXNG's `unresponsive_engines` pairs/strings. */
export function parseUnresponsive(entries: unknown[] | undefined): UnresponsiveEngine[] {
  const out: UnresponsiveEngine[] = []
  for (const entry of entries ?? []) {
    if (Array.isArray(entry)) {
      const engine = String(entry[0] ?? '').trim()
      if (engine.length === 0) continue
      out.push({ engine, reason: String(entry[1] ?? 'unresponsive').trim() })
    } else if (typeof entry === 'string' && entry.trim().length > 0) {
      out.push({ engine: entry.trim(), reason: 'unresponsive' })
    }
  }
  return out
}

/**
 * One compact line naming the engines that came back empty, so a thin result
 * set reads as an instance problem and not as "nothing on the internet
 * matches". Kept short — it is appended to every search.
 */
export function unresponsiveHealthNote(unresponsive: readonly UnresponsiveEngine[]): string {
  if (unresponsive.length === 0) return ''
  const shown = unresponsive.slice(0, 6).map(entry => `${entry.engine} (${entry.reason})`)
  const rest = unresponsive.length > shown.length ? ` +${unresponsive.length - shown.length} more` : ''
  return `\n\nEngines without results: ${shown.join(', ')}${rest}`
}

/** True for an `AbortSignal` abort. */
function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}
