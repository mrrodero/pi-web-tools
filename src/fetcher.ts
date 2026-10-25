/**
 * Plain-HTTP page fetch for `web_fetch` and `web_crawl`: timeout, body cap,
 * SSRF guard, and content-type triage (HTML vs plain text vs unsupported).
 * @module pi-web-tools/fetcher
 */

import { assertAddressAllowed } from './ssrf.ts'

/** A fetched HTML page ready for extraction. */
export interface RawPage {
  /** The requested URL. */
  readonly url: string
  /** The final URL after redirects. */
  readonly finalUrl: string
  /** HTTP status code. */
  readonly status: number
  /** The response body as text. */
  readonly html: string
}

export interface FetchPageOptions {
  readonly userAgent: string
  readonly timeoutMs: number
  readonly maxBodyBytes: number
  readonly allowPrivate: boolean
  /** When true, `text/*` (non-HTML) content types are returned as-is instead of `null`. */
  readonly acceptText?: boolean
  readonly signal?: AbortSignal
}

/**
 * Fetch one page over plain HTTP.
 *
 * @param url - the absolute http(s) URL.
 * @param opts - limits and policy.
 * @returns the raw page, or `null` for non-HTML content types (crawl path).
 * @throws on network/HTTP/size/SSRF failures.
 */
export async function fetchPage(url: string, opts: FetchPageOptions): Promise<RawPage | null> {
  await assertAddressAllowed(url, opts.allowPrivate)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${opts.timeoutMs} ms`)), opts.timeoutMs)
  const onOuterAbort = () => controller.abort(new Error('aborted'))
  opts.signal?.addEventListener('abort', onOuterAbort, { once: true })
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': opts.userAgent,
        accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
      },
    })
    const finalUrl = response.url.length > 0 ? response.url : url
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
    const body = Buffer.from(await response.arrayBuffer())
    if (body.byteLength > opts.maxBodyBytes) {
      throw new Error(`response exceeds ${opts.maxBodyBytes} bytes for ${url}`)
    }
    const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
    const isHtml = contentType.includes('text/html') || contentType.includes('application/xhtml')
    if (contentType !== '' && !isHtml && !(opts.acceptText === true && contentType.includes('text/'))) {
      return null
    }
    return { url, finalUrl, status: response.status, html: body.toString('utf8') }
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onOuterAbort)
  }
}
