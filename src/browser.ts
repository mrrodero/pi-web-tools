/**
 * The headless-Chromium renderer for `web_render`: one lazily-launched
 * Playwright browser shared across calls, closed at session shutdown.
 * The SSRF guard runs pre-navigation (the same wave-1 scope as
 * dsh-web-tools' browser guard).
 * @module pi-web-tools/browser
 */

import type { Browser } from 'playwright'
import { assertAddressAllowed } from './ssrf.ts'
import { extractTitle, htmlToMarkdown } from './markdown.ts'

let browserPromise: Promise<Browser> | undefined

function getBrowser(): Promise<Browser> {
  browserPromise ??= (async () => {
    const { chromium } = await import('playwright')
    return chromium.launch({ headless: true })
  })()
  return browserPromise
}

/**
 * Render one page in headless Chromium and return the full rendered HTML.
 *
 * @param url - the absolute http(s) URL.
 * @param timeoutMs - navigation timeout.
 * @param allowPrivate - SSRF policy.
 * @param signal - optional cancellation signal (closes the page early).
 * @returns the rendered HTML, the page title, and the final URL.
 */
export async function renderHtml(
  url: string,
  timeoutMs: number,
  allowPrivate: boolean,
  signal?: AbortSignal,
): Promise<{ html: string; title: string; finalUrl: string }> {
  await assertAddressAllowed(url, allowPrivate)
  const browser = await getBrowser()
  const page = await browser.newPage()
  const onAbort = () => void page.close().catch(() => undefined)
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    page.on('dialog', dialog => void dialog.dismiss().catch(() => undefined))
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
    // Give SPAs a short grace period to settle their client-side render.
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined)
    if (response !== null && response.status() >= 400) {
      throw new Error(`HTTP ${response.status()} for ${url}`)
    }
    const html = await page.content()
    return {
      html,
      title: (await page.title().catch(() => '')) || extractTitle(html),
      finalUrl: page.url(),
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    await page.close().catch(() => undefined)
  }
}

/**
 * Render one page and convert it to markdown (the `web_render` surface).
 *
 * @param url - the absolute http(s) URL.
 * @param timeoutMs - navigation timeout.
 * @param maxChars - cap on the returned markdown (chars).
 * @param allowPrivate - SSRF policy.
 * @param signal - optional cancellation signal.
 * @returns the capped markdown, the page title, and the final URL.
 */
export async function renderPage(
  url: string,
  timeoutMs: number,
  maxChars: number,
  allowPrivate: boolean,
  signal?: AbortSignal,
): Promise<{ markdown: string; title: string; finalUrl: string }> {
  const rendered = await renderHtml(url, timeoutMs, allowPrivate, signal)
  const markdown = htmlToMarkdown(rendered.html)
  return {
    markdown: markdown.slice(0, maxChars),
    title: rendered.title,
    finalUrl: rendered.finalUrl,
  }
}

/** Close the shared browser (idempotent; called at session shutdown). */
export async function closeBrowser(): Promise<void> {
  if (browserPromise === undefined) return
  const browser = await browserPromise.catch(() => undefined)
  browserPromise = undefined
  await browser?.close().catch(() => undefined)
}
