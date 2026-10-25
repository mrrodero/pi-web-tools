/**
 * The crawl engine: a bounded breadth-first crawl of one domain. The engine
 * is fetcher-agnostic — it receives a {@link PageFetcher} (plain HTTP or a
 * headless browser) plus a page-indexing hook, and owns the queue, the
 * visited set, robots filtering, politeness delay, and abort handling.
 *
 * Ported from `@deepseek-ai/dsh-web-tools` (MIT).
 * @module pi-web-tools/crawl
 */

import { extractPage } from './extract.ts'
import { fetchRobots, robotsAllowed, type RobotsPolicy } from './robots.ts'
import { domainKey, isHttpUrl, normalizeUrl } from './urls.ts'

/** Resolved crawl options. */
export interface CrawlOptions {
  /** Maximum number of pages to fetch (inclusive). */
  readonly maxPages: number
  /** Maximum link depth from the seed (0 = seed only). */
  readonly maxDepth: number
  /** Polite delay between page fetches (ms). */
  readonly delayMs: number
  /** Cap on each page's extracted markdown (chars). */
  readonly maxPageChars: number
  /** `User-Agent` sent to crawled pages. */
  readonly userAgent: string
}

/** One crawled page (successful or failed). */
export interface CrawledPage {
  /** The page's final URL. */
  readonly url: string
  /** Link depth from the seed (0 = seed). */
  readonly depth: number
  /** The page title (empty when absent). */
  readonly title: string
  /** The extracted content as markdown (empty on failure). */
  readonly markdown: string
  /** HTTP status code (0 when no HTTP response was obtained). */
  readonly status: number
  /** Failure reason, present only when the page could not be crawled. */
  readonly error?: string
}

/** The complete result of one crawl. */
export interface CrawlResult {
  /** The normalized seed URL. */
  readonly seed: string
  /** Pages in crawl (BFS) order. */
  readonly pages: CrawledPage[]
  /** Total extracted markdown characters across successful pages. */
  readonly totalChars: number
  /** True when the page cap stopped the crawl before the queue drained. */
  readonly truncated: boolean
}

/** A raw fetched page before extraction. */
export interface RawPage {
  readonly url: string
  readonly finalUrl: string
  readonly status: number
  readonly html: string
}

/**
 * Fetch one page. Returns `null` for pages that are not crawlable HTML
 * (non-HTML content types). Implementations must honor the signal.
 */
export type PageFetcher = (url: string, signal: AbortSignal | undefined) => Promise<RawPage | null>

/** A fetched page together with its discovered link frontier. */
interface FetchedPage {
  readonly page: CrawledPage
  readonly links: readonly string[]
}

/**
 * Run one bounded crawl.
 *
 * @param seed - the seed URL (validated and normalized by the caller).
 * @param options - the resolved crawl options.
 * @param fetcher - the page fetcher (plain HTTP or browser-backed).
 * @param onIndex - optional hook called with each successfully crawled page
 *   (the local index); failures here never fail the crawl.
 * @param signal - optional cancellation signal; aborting throws.
 * @param policy - an already-fetched robots policy; when omitted it is
 *   fetched from the seed's origin.
 * @returns the crawl result in BFS order.
 */
export async function crawl(
  seed: string,
  options: CrawlOptions,
  fetcher: PageFetcher,
  onIndex: ((page: CrawledPage) => Promise<void>) | undefined,
  signal: AbortSignal | undefined,
  policy: RobotsPolicy | undefined = undefined,
): Promise<CrawlResult> {
  const seedUrl = normalizeUrl(seed)
  const seedDomain = domainKey(seedUrl)
  const visited = new Set<string>([seedUrl])
  const queue: Array<{ url: string; depth: number }> = [{ url: seedUrl, depth: 0 }]
  const pages: CrawledPage[] = []
  const robots = policy ?? await fetchRobots(seedUrl, options.userAgent, signal)
  let truncated = false

  while (queue.length > 0) {
    if (pages.length >= options.maxPages) {
      truncated = true
      break
    }
    const item = queue.shift()
    if (item === undefined) break
    if (item.depth > options.maxDepth) continue
    if (signal?.aborted) throw new Error('crawl aborted')
    if (!robotsAllowed(item.url, robots, options.userAgent)) continue

    const fetched = await fetchAndExtract(item.url, item.depth, options, fetcher, signal)
    pages.push(fetched.page)
    if (fetched.page.error === undefined && onIndex !== undefined) {
      try {
        await onIndex(fetched.page)
      } catch {
        // Indexing failures never fail the crawl.
      }
    }

    if (fetched.page.error === undefined) {
      for (const rawLink of fetched.links) {
        const link = normalizeUrl(rawLink)
        if (visited.has(link)) continue
        if (!isHttpUrl(link)) continue
        if (domainKey(link) !== seedDomain) continue
        visited.add(link)
        queue.push({ url: link, depth: item.depth + 1 })
      }
    }
    await sleep(options.delayMs, signal)
  }

  return {
    seed: seedUrl,
    pages,
    totalChars: pages.reduce((total, page) => total + page.markdown.length, 0),
    truncated,
  }
}

/**
 * Fetch one page and extract it; failures become error pages (the crawl
 * continues). Redirects that leave the seed domain are treated as failures.
 */
async function fetchAndExtract(
  url: string,
  depth: number,
  options: CrawlOptions,
  fetcher: PageFetcher,
  signal: AbortSignal | undefined,
): Promise<FetchedPage> {
  let raw: RawPage | null
  try {
    raw = await fetcher(url, signal)
  } catch (error) {
    return { page: { url, depth, title: '', markdown: '', status: 0, error: `fetch failed: ${String(error)}` }, links: [] }
  }
  if (raw === null) {
    return { page: { url, depth, title: '', markdown: '', status: 0, error: 'not crawlable (non-HTML or blocked)' }, links: [] }
  }
  if (domainKey(raw.finalUrl) !== domainKey(url)) {
    return {
      page: { url, depth, title: '', markdown: '', status: raw.status, error: `redirect left the crawl domain (${raw.finalUrl})` },
      links: [],
    }
  }
  const extracted = extractPage(raw.html, raw.finalUrl, options.maxPageChars)
  return {
    page: {
      url: raw.finalUrl,
      depth,
      title: extracted.title,
      markdown: extracted.markdown,
      status: raw.status,
    },
    links: extracted.links,
  }
}

/** Sleep for `ms`, resolving early when the signal aborts. */
async function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (ms <= 0) return
  if (signal === undefined) {
    await new Promise(resolve => setTimeout(resolve, ms))
    return
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
