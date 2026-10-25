/**
 * URL helpers shared by the crawl engine and the SSRF guard.
 *
 * Ported from `@deepseek-ai/dsh-web-tools` (MIT).
 * @module pi-web-tools/urls
 */

/**
 * Normalize a URL for the visited set: strip the fragment, drop a trailing
 * slash on the path (except the root), and lowercase the host.
 *
 * @param url - the URL to normalize.
 * @returns the normalized URL string.
 */
export function normalizeUrl(url: string): string {
  const parsed = new URL(url)
  parsed.hash = ''
  parsed.hostname = parsed.hostname.toLowerCase()
  if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
    parsed.pathname = parsed.pathname.slice(0, -1)
  }
  return parsed.toString()
}

/**
 * The domain key for same-domain filtering: the hostname without a leading
 * `www.` (www-tolerant, per the crawl contract).
 *
 * @param url - the URL whose domain key is wanted.
 * @returns the lowercased hostname without a leading `www.`.
 */
export function domainKey(url: string): string {
  const host = new URL(url).hostname.toLowerCase()
  return host.startsWith('www.') ? host.slice(4) : host
}

/** Whether a URL is http(s) (the only schemes the crawl follows). */
export function isHttpUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}
