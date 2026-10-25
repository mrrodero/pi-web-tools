/**
 * `web_search` backend: a self-hosted SearXNG instance's JSON API
 * (`GET /search?format=json`). Entries without a snippet are dropped —
 * there is no other field to derive one from, and inventing one would lie.
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
}

/** Raw SearXNG response envelope (the fields this module uses). */
interface SearxngResult {
  url?: string
  title?: string
  content?: string
  publishedDate?: string
}

interface SearxngSearchResponse {
  results?: SearxngResult[]
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
 * @returns the ranked hits (snippet-less entries dropped, capped).
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
): Promise<SearxngHit[]> {
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
    })
    if (hits.length >= opts.maxResults) break
  }
  return hits
}

/** True for an `AbortSignal` abort. */
function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}
