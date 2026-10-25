/**
 * pi-web-tools configuration.
 *
 * Defaults describe a single-machine setup that shares the dsh-web-tools
 * corpus (a self-hosted SearXNG on the LAN, the SQLite index and the MiniLM
 * model under `~/.dsh/data/web-index/`). Override order: built-in defaults,
 * then an optional `config.json` next to this package root, then the
 * `PI_WEB_TOOLS_*` environment variables.
 * @module pi-web-tools/config
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface CrawlConfig {
  /** Default cap on crawled pages per run. */
  maxPages: number
  /** Default cap on link depth from the seed. */
  maxDepth: number
  /** Polite delay between page fetches (ms). */
  delayMs: number
}

/** Resolved configuration (defaults, file overrides, env overrides). */
export interface WebToolsConfig {
  /** SearXNG instance base URL; empty disables `web_search`. */
  searxngBaseURL: string
  /** SQLite corpus database path (shared with dsh-web-tools by default). */
  indexDbPath: string
  /** Directory holding `all-MiniLM-L6-v2.onnx` and `vocab.txt`. */
  modelDir: string
  /** `User-Agent` sent for HTTP fetches and crawls. */
  userAgent: string
  /** When true, fetch/render/crawl may reach loopback/private/link-local addresses. */
  allowPrivateNetworks: boolean
  /** HTTP fetch timeout (ms). */
  fetchTimeoutMs: number
  /** Cap on a fetched response body (bytes). */
  maxBodyBytes: number
  /** Default cap on tool-facing markdown (chars). */
  defaultMaxChars: number
  /** Browser navigation timeout (ms). */
  renderTimeoutMs: number
  crawl: CrawlConfig
}

/** Built-in defaults (see the module doc for the shared-corpus rationale). */
export const DEFAULTS: WebToolsConfig = {
  searxngBaseURL: 'http://192.168.144.120:8888',
  indexDbPath: join(homedir(), '.dsh', 'data', 'web-index', 'index.db'),
  modelDir: join(homedir(), '.dsh', 'data', 'web-index', 'models'),
  userAgent: 'pi-web-tools/0.1.0',
  allowPrivateNetworks: false,
  fetchTimeoutMs: 30_000,
  maxBodyBytes: 5 * 1024 * 1024,
  defaultMaxChars: 100_000,
  renderTimeoutMs: 60_000,
  crawl: { maxPages: 50, maxDepth: 3, delayMs: 500 },
}

/** The package root (the directory holding `index.ts` and `package.json`). */
function packageRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)))
}

/** Load the config: built-in defaults, `config.json`, then env vars. */
export function loadConfig(): WebToolsConfig {
  const config: WebToolsConfig = structuredClone(DEFAULTS)
  const configPath = join(packageRoot(), 'config.json')
  if (existsSync(configPath)) {
    try {
      const overrides = JSON.parse(readFileSync(configPath, 'utf8')) as Partial<WebToolsConfig>
      Object.assign(config, overrides)
      if (overrides.crawl !== undefined) Object.assign(config.crawl, overrides.crawl)
    } catch (error) {
      console.warn(`[pi-web-tools] ignoring unreadable config.json (${String(error)})`)
    }
  }
  if (process.env.PI_WEB_TOOLS_SEARXNG_URL !== undefined) {
    config.searxngBaseURL = process.env.PI_WEB_TOOLS_SEARXNG_URL
  }
  if (process.env.PI_WEB_TOOLS_INDEX_DB !== undefined) {
    config.indexDbPath = process.env.PI_WEB_TOOLS_INDEX_DB
  }
  return config
}
