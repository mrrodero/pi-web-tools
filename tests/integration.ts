/**
 * Live integration check (not part of `vitest run`): exercises the real
 * SearXNG instance, the shared corpus index, plain-HTTP fetch, and
 * headless-Chromium rendering. Run with: `npm run integration`.
 */

import { closeBrowser, renderPage } from '../src/browser.ts'
import { loadConfig } from '../src/config.ts'
import { extractPage } from '../src/extract.ts'
import { fetchPage } from '../src/fetcher.ts'
import { configureModelDir, ensureModel, modelReadyNow } from '../src/model.ts'
import { searchLocal } from '../src/search.ts'
import { searchSearxng } from '../src/searxng.ts'
import { closeIndexStore, configureStorePath, indexPage, indexStats } from '../src/store.ts'

const config = loadConfig()
configureStorePath(config.indexDbPath)
configureModelDir(config.modelDir)

let failures = 0
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

// 1. Local corpus (the shared dsh index).
const before = await indexStats()
check('index opens', true, `${before.pages} pages / ${before.chunks} chunks @ ${before.dbPath}`)
const found = await searchLocal({ queries: ['torrent tracker'], maxResults: 3, mode: 'hybrid' })
check(
  'local_search (hybrid, model cold → lexical)',
  found.hits.length > 0,
  found.hits.slice(0, 2).map(hit => hit.url).join(', '),
)

// Warm the embedding model (loads the existing ONNX, no download).
const session = await ensureModel()
check('embedding model loads', session !== null, `modelReady=${modelReadyNow()}`)
if (session !== null) {
  const semantic = await searchLocal({ queries: ['torrent tracker'], maxResults: 3, mode: 'semantic' })
  check('local_search (semantic)', semantic.hits.length > 0, semantic.hits.slice(0, 2).map(hit => hit.url).join(', '))
}

// 2. Live SearXNG search.
const live = await searchSearxng(config.searxngBaseURL, 'hugging face gguf quantization', { maxResults: 3 })
check('web_search (SearXNG)', live.hits.length > 0, live.hits[0]?.url ?? 'no hits')
// Whether upstream engines answer is theirs to decide; what this owns is that
// the health report survives the round trip: every entry names an engine and a
// reason, and provenance is attached to the hits.
check(
  'web_search engine health report',
  live.unresponsive.every(e => e.engine.length > 0 && e.reason.length > 0) &&
    live.hits.every(h => Array.isArray(h.engines)),
  live.unresponsive.map(e => `${e.engine}:${e.reason}`).join(' ') || 'no engine complaints',
)

// 3. Plain-HTTP fetch + extract + index round-trip.
const raw = await fetchPage('https://quotes.toscrape.com', {
  userAgent: config.userAgent,
  timeoutMs: config.fetchTimeoutMs,
  maxBodyBytes: config.maxBodyBytes,
  allowPrivate: true,
  acceptText: true,
})
const extracted = raw !== null ? extractPage(raw.html, raw.finalUrl, config.defaultMaxChars) : null
check('web_fetch (HTTP → markdown)', extracted !== null && extracted.markdown.length > 100, `title="${extracted?.title ?? ''}", ${extracted?.markdown.length ?? 0} chars`)
if (raw !== null && extracted !== null) {
  await indexPage({ url: raw.finalUrl, title: extracted.title, markdown: extracted.markdown, fetchedAt: new Date().toISOString() })
  const after = await indexStats()
  check('index round-trip', after.pages >= before.pages, `pages ${before.pages} → ${after.pages}`)
  const roundTrip = await searchLocal({ queries: ['famous quotes'], maxResults: 3, mode: 'lexical' })
  check('fetched page is searchable', roundTrip.hits.some(hit => hit.url === raw.finalUrl), roundTrip.hits[0]?.url ?? '')
}

// 4. Headless-Chromium render (same page; verifies the browser path end-to-end).
const rendered = await renderPage('https://quotes.toscrape.com', 30_000, config.defaultMaxChars, true)
check('web_render (Chromium)', rendered.markdown.length > 100, `title="${rendered.title}", ${rendered.markdown.length} chars`)

// 5. SSRF guard.
const { assertAddressAllowed } = await import('../src/ssrf.ts')
try {
  await assertAddressAllowed('http://192.168.1.1/admin', false)
  check('SSRF guard blocks LAN', false, 'was not blocked')
} catch (error) {
  check('SSRF guard blocks LAN', true, String(error))
}

await closeBrowser()
await closeIndexStore()
console.log(failures === 0 ? '\nAll integration checks passed.' : `\n${failures} integration check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
