/**
 * Cheerio-based page extraction: strip non-content elements, convert the
 * remaining DOM to markdown (the shared converter), and discover
 * same-document links for the crawl frontier.
 *
 * Ported from `@deepseek-ai/dsh-web-tools` (MIT).
 * @module pi-web-tools/extract
 */

import * as cheerio from 'cheerio'
import { htmlToMarkdown } from './markdown.ts'

/** One extracted page: title, markdown content, and absolute link targets. */
export interface ExtractedPage {
  /** The page title (empty when absent). */
  readonly title: string
  /** The extracted content as markdown, cut to the page cap. */
  readonly markdown: string
  /** True when the markdown was cut to the cap. */
  readonly truncated: boolean
  /** Absolute URLs found in the document's links. */
  readonly links: readonly string[]
}

/**
 * Extract content and links from one HTML document.
 *
 * @param html - the raw HTML body.
 * @param baseUrl - the page URL (resolves relative links).
 * @param maxChars - cap on the extracted markdown (chars).
 * @returns the extracted page.
 */
export function extractPage(html: string, baseUrl: string, maxChars: number): ExtractedPage {
  const $ = cheerio.load(html)
  // Read the title before the head is stripped from the DOM.
  const title = ($('title').first().text() ?? '').replace(/\s+/gu, ' ').trim()
  $('script, style, noscript, template, iframe, object, embed, nav, footer, aside, head').remove()
  const content = $('main, article, [role="main"], #content, .content, #main, .main').first()
  const root = content.length > 0 ? content : $('body')
  const markdown = htmlToMarkdown(root.html() ?? '')
  const truncated = markdown.length > maxChars
  const links: string[] = []
  $('a[href]').each((_index, element) => {
    const href = $(element).attr('href')
    if (href === undefined) return
    // Raw whitespace makes an href unresolvable in practice; skip it.
    if (/\s/u.test(href)) return
    try {
      links.push(new URL(href, baseUrl).toString())
    } catch {
      // Skip unresolvable hrefs.
    }
  })
  return {
    title,
    markdown: truncated ? markdown.slice(0, maxChars) : markdown,
    truncated,
    links,
  }
}
