/**
 * The local corpus store: one SQLite file (built-in `node:sqlite`) holding
 * pages, a standalone FTS5 table for lexical search, and content chunks with
 * optional float32 embedding BLOBs for semantic search. The schema is
 * identical to dsh-web-tools', so the two harnesses can share one index
 * file (single-writer at a time; WAL makes concurrent reads fine).
 *
 * Ported from `@deepseek-ai/dsh-web-tools` (MIT).
 * @module pi-web-tools/store
 */

import { mkdirSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { dirname } from 'node:path'
import { ensureModel, embed, modelReadyNow } from './model.ts'

/** One page to store in the local corpus index. */
export interface IndexPageInput {
  /** The page URL (primary key; latest index wins). */
  readonly url: string
  /** The page title (empty when absent). */
  readonly title?: string
  /** The page content as markdown. */
  readonly markdown?: string
  /** The fetch time as an ISO-8601 string. */
  readonly fetchedAt: string
}

/** Index statistics. */
export interface IndexStats {
  readonly pages: number
  readonly chunks: number
  readonly embeddedChunks: number
  readonly dbPath: string
  readonly modelReady: boolean
}

/** The SQL schema, applied idempotently on open. */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS pages (
  url TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  fetched_at TEXT NOT NULL,
  content TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS page_fts USING fts5(
  url UNINDEXED, title, content, tokenize='unicode61'
);
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY,
  page_url TEXT NOT NULL,
  seq INTEGER NOT NULL,
  text TEXT NOT NULL,
  embedding BLOB
);
CREATE INDEX IF NOT EXISTS idx_chunks_page ON chunks(page_url);
`

let configuredPath: string | undefined
let dbPromise: Promise<DatabaseSync> | undefined

/**
 * Point the store at a database file (called once at extension load).
 * Reconfiguring closes any open handle; the store reopens lazily on next use.
 *
 * @param dbPath - the SQLite file to use.
 */
export function configureStorePath(dbPath: string): void {
  configuredPath = dbPath
  dbPromise = undefined
}

/** The configured database path (for diagnostics and stats). */
export function configuredDbPath(): string {
  return configuredPath ?? ''
}

/**
 * Open (or reuse) the database handle, applying the schema on first open.
 */
export function storeDatabase(): Promise<DatabaseSync> {
  if (configuredPath === undefined) throw new Error('store path not configured')
  dbPromise ??= openDatabase(configuredPath)
  return dbPromise
}

async function openDatabase(path: string): Promise<DatabaseSync> {
  const { DatabaseSync } = await import('node:sqlite')
  mkdirSync(dirname(path), { recursive: true })
  const handle = new DatabaseSync(path)
  handle.exec('PRAGMA journal_mode = WAL;')
  handle.exec(SCHEMA)
  return handle
}

/** Close the store (idempotent; called at session shutdown). */
export async function closeIndexStore(): Promise<void> {
  if (dbPromise === undefined) return
  const handle = await dbPromise
  dbPromise = undefined
  handle.close()
}

/**
 * Split page content into chunks on blank-line boundaries: each paragraph
 * is its own chunk, and oversized paragraphs are hard-split into ~`size`-
 * character pieces, for per-chunk embedding.
 *
 * @param text - the content to chunk.
 * @param size - the hard-split size for oversized paragraphs (chars).
 * @returns the non-empty chunks in document order.
 */
export function chunkText(text: string, size = 800): string[] {
  const chunks: string[] = []
  for (const paragraph of text.split(/\n{2,}/u)) {
    const trimmed = paragraph.trim()
    if (trimmed === '') continue
    if (trimmed.length > size) {
      for (let offset = 0; offset < trimmed.length; offset += size) {
        const piece = trimmed.slice(offset, offset + size).trim()
        if (piece !== '') chunks.push(piece)
      }
    } else {
      chunks.push(trimmed)
    }
  }
  return chunks
}

/**
 * Store one page: upsert the page row, resync its FTS row, and replace its
 * chunks (embedding each chunk when the model is loaded; lexical-only
 * otherwise). Latest index wins per URL.
 *
 * @param input - the page to store.
 */
export async function indexPage(input: IndexPageInput): Promise<void> {
  const db = await storeDatabase()
  const domain = (() => {
    try {
      return new URL(input.url).hostname
    } catch {
      return ''
    }
  })()
  const title = input.title ?? ''
  const content = input.markdown ?? ''

  db.prepare(
    'INSERT INTO pages (url, domain, title, fetched_at, content) VALUES (?, ?, ?, ?, ?) '
    + 'ON CONFLICT(url) DO UPDATE SET domain = excluded.domain, title = excluded.title, '
    + 'fetched_at = excluded.fetched_at, content = excluded.content',
  ).run(input.url, domain, title, input.fetchedAt, content)
  db.prepare('DELETE FROM page_fts WHERE url = ?').run(input.url)
  db.prepare('INSERT INTO page_fts (url, title, content) VALUES (?, ?, ?)').run(input.url, title, content)

  db.prepare('DELETE FROM chunks WHERE page_url = ?').run(input.url)
  const chunks = chunkText(content)
  const session = await ensureModel()
  const insert = db.prepare('INSERT INTO chunks (page_url, seq, text, embedding) VALUES (?, ?, ?, ?)')
  for (const [seq, text] of chunks.entries()) {
    let embedding: Uint8Array | null = null
    if (session !== null) {
      try {
        const vector = await embed(session, text)
        embedding = new Uint8Array(vector.buffer)
      } catch {
        embedding = null
      }
    }
    insert.run(input.url, seq, text, embedding)
  }
}

/**
 * Current index statistics.
 *
 * @returns the page/chunk counts, database path, and model state.
 */
export async function indexStats(): Promise<IndexStats> {
  const db = await storeDatabase()
  const pages = db.prepare('SELECT COUNT(*) AS n FROM pages').get() as { n: number }
  const chunks = db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }
  const embedded = db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE embedding IS NOT NULL').get() as { n: number }
  return {
    pages: pages.n,
    chunks: chunks.n,
    embeddedChunks: embedded.n,
    dbPath: configuredDbPath(),
    // Report state without triggering a model load.
    modelReady: modelReadyNow(),
  }
}
