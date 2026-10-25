/**
 * pi-web-tools — web capability extension for pi.
 *
 * Registers five tools, all backed by locally-hosted, API-free
 * infrastructure (no keys, no quotas, no SaaS):
 *
 * - `web_search`  — live web search through a self-hosted SearXNG instance
 * - `web_fetch`   — fetch a page to markdown (plain HTTP or rendered), auto-indexed
 * - `web_render`  — render a page in headless Chromium to markdown, auto-indexed
 * - `web_crawl`   — bounded same-domain BFS crawl (robots.txt-respecting), indexed
 * - `local_search`— lexical/semantic/hybrid search over the local corpus
 *
 * The corpus is one SQLite file (schema-compatible with dsh-web-tools), so
 * pages fetched in pi are searchable from the DeepSeek Harness and vice
 * versa.
 * @module pi-web-tools
 */

import { Type } from '@earendil-works/pi-ai'
import { defineTool, type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { closeBrowser, renderHtml, renderPage } from './browser.ts'
import { crawl, type CrawlOptions, type PageFetcher } from './crawl.ts'
import { loadConfig } from './config.ts'
import { extractPage } from './extract.ts'
import { fetchPage } from './fetcher.ts'
import { configureModelDir } from './model.ts'
import { searchLocal } from './search.ts'
import { searchSearxng } from './searxng.ts'
import { closeIndexStore, configureStorePath, indexPage, indexStats } from './store.ts'
import { normalizeUrl } from './urls.ts'

export default function webToolsExtension(pi: ExtensionAPI): void {
  const config = loadConfig()
  configureStorePath(config.indexDbPath)
  configureModelDir(config.modelDir)

  const openWorld = { readOnlyHint: true, openWorldHint: true }

  pi.registerTool(defineTool({
    name: 'web_search',
    label: 'Web Search',
    description:
      'Search the web through a self-hosted SearXNG instance. Returns ranked results with titles, URLs, and snippets. '
      + 'Use timeRange for recent events and categories to steer the search (e.g. "general,news", "it", "science").',
    annotations: openWorld,
    parameters: Type.Object({
      query: Type.String({ description: 'The search query' }),
      categories: Type.Optional(Type.String({ description: 'SearXNG categories, comma-separated (e.g. "general,news")' })),
      language: Type.Optional(Type.String({ description: 'Language code (e.g. "en", "all")' })),
      timeRange: Type.Optional(
        Type.Union([Type.Literal('day'), Type.Literal('month'), Type.Literal('year')], {
          description: 'Restrict results to the last day, month, or year',
        }),
      ),
      maxResults: Type.Optional(Type.Number({ minimum: 1, maximum: 10, description: 'Result cap (default 8)' })),
    }),
    async execute(_toolCallId, params, signal) {
      const hits = await searchSearxng(config.searxngBaseURL, params.query, {
        categories: params.categories,
        language: params.language,
        timeRange: params.timeRange,
        maxResults: params.maxResults ?? 8,
        signal,
      })
      if (hits.length === 0) {
        return {
          content: [{ type: 'text', text: 'No results for: ' + params.query }],
          details: { count: 0, query: params.query },
        }
      }
      const text = hits
        .map((hit, index) => {
          const lines = [`${index + 1}. ${hit.title || hit.url}`]
          lines.push(`   ${hit.url}`)
          lines.push(`   ${hit.snippet}`)
          if (hit.publishedAt !== undefined) lines.push(`   published: ${hit.publishedAt}`)
          return lines.join('\n')
        })
        .join('\n\n')
      return {
        content: [{ type: 'text', text }],
        details: { count: hits.length, query: params.query },
      }
    },
  }))

  pi.registerTool(defineTool({
    name: 'web_fetch',
    label: 'Web Fetch',
    description:
      'Fetch a web page and convert it to markdown; the page is also indexed into the local corpus for later local_search. '
      + 'Plain HTTP by default; set render:true for JavaScript-heavy or interactive pages (slower, headless Chromium).',
    annotations: openWorld,
    parameters: Type.Object({
      url: Type.String({ description: 'Absolute http(s) URL' }),
      render: Type.Optional(Type.Boolean({ description: 'Render with headless Chromium (for JavaScript-heavy pages)' })),
      maxChars: Type.Optional(Type.Number({ minimum: 1000, description: 'Markdown cap in chars' })),
    }),
    async execute(_toolCallId, params, signal) {
      const maxChars = params.maxChars ?? config.defaultMaxChars
      let markdown: string
      let title = ''
      let finalUrl = params.url
      let rendered = false

      if (params.render === true) {
        rendered = true
        const page = await renderPage(params.url, config.renderTimeoutMs, maxChars, config.allowPrivateNetworks, signal)
        markdown = page.markdown
        title = page.title
        finalUrl = page.finalUrl
      } else {
        const page = await fetchPage(params.url, {
          userAgent: config.userAgent,
          timeoutMs: config.fetchTimeoutMs,
          maxBodyBytes: config.maxBodyBytes,
          allowPrivate: config.allowPrivateNetworks,
          acceptText: true,
          signal,
        })
        if (page === null) throw new Error(`not fetchable: unsupported or non-text content type for ${params.url}`)
        finalUrl = page.finalUrl
        const extracted = extractPage(page.html, page.finalUrl, maxChars)
        markdown = extracted.markdown
        title = extracted.title
      }

      void indexPage({ url: finalUrl, title, markdown, fetchedAt: new Date().toISOString() }).catch(() => undefined)

      const truncated = markdown.length >= maxChars
      const text = [
        `URL: ${finalUrl}`,
        title !== '' ? `TITLE: ${title}` : null,
        '---',
        markdown,
        truncated ? `[truncated at ${maxChars} chars]` : null,
      ]
        .filter((line): line is string => line !== null)
        .join('\n')
      return {
        content: [{ type: 'text', text }],
        details: { url: params.url, finalUrl, title, chars: markdown.length, truncated, rendered, indexed: true },
      }
    },
  }))

  pi.registerTool(defineTool({
    name: 'web_render',
    label: 'Web Render',
    description:
      'Render a page in headless Chromium and return readable markdown; the page is also indexed into the local corpus. '
      + 'Use for JavaScript-heavy, interactive, or dynamically-loaded pages that plain web_fetch mangles.',
    annotations: openWorld,
    parameters: Type.Object({
      url: Type.String({ description: 'Absolute http(s) URL' }),
      maxChars: Type.Optional(Type.Number({ minimum: 1000, description: 'Markdown cap in chars' })),
      timeoutMs: Type.Optional(Type.Number({ minimum: 5000, description: 'Navigation timeout in ms' })),
    }),
    async execute(_toolCallId, params, signal) {
      const maxChars = params.maxChars ?? config.defaultMaxChars
      const page = await renderPage(params.url, params.timeoutMs ?? config.renderTimeoutMs, maxChars, config.allowPrivateNetworks, signal)
      void indexPage({ url: page.finalUrl, title: page.title, markdown: page.markdown, fetchedAt: new Date().toISOString() }).catch(() => undefined)

      const text = [
        `URL: ${page.finalUrl}`,
        page.title !== '' ? `TITLE: ${page.title}` : null,
        '---',
        page.markdown,
      ]
        .filter((line): line is string => line !== null)
        .join('\n')
      return {
        content: [{ type: 'text', text }],
        details: { url: params.url, finalUrl: page.finalUrl, title: page.title, chars: page.markdown.length, indexed: true },
      }
    },
  }))

  pi.registerTool(defineTool({
    name: 'web_crawl',
    label: 'Web Crawl',
    description:
      'Crawl a site: bounded same-domain BFS with robots.txt policy and a polite delay. Every successful page is '
      + 'extracted to markdown and indexed into the local corpus (queryable with local_search). Use to ingest a whole '
      + 'documentation site or small project into the corpus in one call.',
    annotations: openWorld,
    parameters: Type.Object({
      url: Type.String({ description: 'Seed URL (the crawl stays on its domain)' }),
      maxPages: Type.Optional(Type.Number({ minimum: 1, description: 'Page cap (default from config)' })),
      maxDepth: Type.Optional(Type.Number({ minimum: 0, description: 'Link depth cap from the seed (default from config)' })),
      render: Type.Optional(Type.Boolean({ description: 'Render each page in headless Chromium (slower; for JS-heavy sites)' })),
    }),
    async execute(_toolCallId, params, signal) {
      const seed = normalizeUrl(params.url)
      const options: CrawlOptions = {
        maxPages: params.maxPages ?? config.crawl.maxPages,
        maxDepth: params.maxDepth ?? config.crawl.maxDepth,
        delayMs: config.crawl.delayMs,
        maxPageChars: config.defaultMaxChars,
        userAgent: config.userAgent,
      }
      const fetcher: PageFetcher = params.render === true
        ? async (url, sig) => {
          const page = await renderHtml(url, config.renderTimeoutMs, config.allowPrivateNetworks, sig)
          return { url, finalUrl: page.finalUrl, status: 200, html: page.html }
        }
        : (url, sig) => fetchPage(url, {
          userAgent: options.userAgent,
          timeoutMs: config.fetchTimeoutMs,
          maxBodyBytes: config.maxBodyBytes,
          allowPrivate: config.allowPrivateNetworks,
          signal: sig,
        })
      const onIndex = (page: { url: string; title: string; markdown: string }): Promise<void> =>
        indexPage({ url: page.url, title: page.title, markdown: page.markdown, fetchedAt: new Date().toISOString() })

      const result = await crawl(seed, options, fetcher, onIndex, signal)
      const ok = result.pages.filter(page => page.error === undefined)
      const failed = result.pages.length - ok.length

      const lines = [
        `Crawled ${ok.length} pages (${result.totalChars.toLocaleString()} chars) from ${result.seed}`
        + (failed > 0 ? `; ${failed} failed` : '')
        + (result.truncated ? '; page cap reached' : ''),
        'All successful pages are indexed in the local corpus.',
        '',
      ]
      const listed = ok.slice(0, 30)
      lines.push(...listed.map((page, index) =>
        `${index + 1}. [d${page.depth}] ${page.title || page.url} — ${page.url}`,
      ))
      if (ok.length > listed.length) lines.push(`… and ${ok.length - listed.length} more (query with local_search)`)

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        details: { seed: result.seed, pages: ok.length, failed, totalChars: result.totalChars, truncated: result.truncated },
      }
    },
  }))

  pi.registerTool(defineTool({
    name: 'local_search',
    label: 'Local Search',
    description:
      'Search the local corpus — pages this agent has fetched or crawled (shared with the DeepSeek Harness). '
      + 'Answers from material already in context of past sessions, at no network cost. '
      + 'Modes: lexical (BM25), semantic (MiniLM embeddings), hybrid (RRF fusion, default).',
    annotations: { readOnlyHint: true },
    parameters: Type.Object({
      query: Type.String({ description: 'The search query' }),
      mode: Type.Optional(
        Type.Union(
          [Type.Literal('lexical'), Type.Literal('semantic'), Type.Literal('hybrid')],
          { description: 'Retrieval mode (default hybrid)' },
        ),
      ),
      maxResults: Type.Optional(Type.Number({ minimum: 1, maximum: 20, description: 'Result cap (default 8)' })),
    }),
    async execute(_toolCallId, params) {
      const result = await searchLocal({
        queries: [params.query],
        maxResults: params.maxResults ?? 8,
        mode: params.mode ?? 'hybrid',
      })
      if (result.hits.length === 0) {
        return {
          content: [{ type: 'text', text: `No local matches for: ${params.query}\n(try web_search for live results, or web_fetch/web_crawl to grow the corpus)` }],
          details: { count: 0, mode: result.mode, modelReady: result.modelReady, elapsedMs: result.elapsedMs },
        }
      }
      const header = result.modelReady === false ? '(embedding model unavailable — lexical results only)\n\n' : ''
      const text = header + result.hits
        .map((hit, index) => {
          const lines = [`${index + 1}. ${hit.title || hit.url} (${hit.domain}, score ${hit.score.toFixed(3)})`]
          lines.push(`   ${hit.url}`)
          if (hit.snippet !== '') lines.push(`   ${hit.snippet}`)
          return lines.join('\n')
        })
        .join('\n\n')
      return {
        content: [{ type: 'text', text }],
        details: { count: result.hits.length, mode: result.mode, modelReady: result.modelReady, elapsedMs: result.elapsedMs },
      }
    },
  }))

  pi.registerCommand('webtools', {
    description: 'pi-web-tools status: corpus size, model state, config paths',
    handler: async (_args, ctx) => {
      try {
        const stats = await indexStats()
        ctx.ui.notify(
          `pi-web-tools: ${stats.pages} pages / ${stats.chunks} chunks (${stats.embeddedChunks} embedded) `
          + `@ ${stats.dbPath}\nmodel: ${stats.modelReady ? 'loaded' : 'not loaded'} | searxng: ${config.searxngBaseURL || 'not configured'}`,
          'info',
        )
      } catch (error) {
        ctx.ui.notify(`pi-web-tools status failed: ${String(error)}`, 'error')
      }
    },
  })

  pi.on('session_shutdown', async (_event, _ctx) => {
    await closeBrowser()
    await closeIndexStore()
  })
}
