/**
 * Local corpus search: FTS5 BM25 (lexical), in-JS KNN over chunk
 * embeddings (semantic), and their Reciprocal-Rank-Fusion merge (hybrid).
 * At wave-1 scale (tens of thousands of chunks) the in-memory KNN is
 * sub-second; a vector extension is the wave-2 upgrade.
 *
 * Ported from `@deepseek-ai/dsh-web-tools` (MIT).
 * @module pi-web-tools/search
 */

import type { DatabaseSync } from 'node:sqlite'
import type { InferenceSession } from 'onnxruntime-node'
import { cosine, embed, ensureModel } from './model.ts'
import { storeDatabase } from './store.ts'

/** The search modes. */
export type LocalSearchMode = 'lexical' | 'semantic' | 'hybrid'

/** One local search hit (a page, with its best-matching evidence). */
export interface LocalSearchHit {
  /** The page URL. */
  readonly url: string
  /** The page title (empty when absent). */
  readonly title: string
  /** The page hostname. */
  readonly domain: string
  /** The fused relevance score (RRF; higher is better). */
  readonly score: number
  /** A short content snippet around the best match. */
  readonly snippet: string
}

/** The result of one local search. */
export interface LocalSearchResult {
  /** The mode that produced the hits. */
  readonly mode: LocalSearchMode
  readonly hits: LocalSearchHit[]
  readonly modelReady: boolean
  readonly elapsedMs: number
}

/** RRF smoothing constant (the standard k=60). */
export const RRF_K = 60

/**
 * Build an FTS5 MATCH expression from one query: each whitespace term is
 * double-quoted (internal quotes doubled) and terms are OR-joined, so
 * arbitrary user text is safe and multi-term queries match any term.
 *
 * @param query - the raw query text.
 * @returns the MATCH expression, or `undefined` when the query has no terms.
 */
export function ftsMatchQuery(query: string): string | undefined {
  const terms = query.split(/\s+/u).filter(term => term.length > 0)
  if (terms.length === 0) return undefined
  return terms.map(term => `"${term.replace(/"/gu, '""')}"`).join(' OR ')
}

/**
 * Fuse per-query page rankings with Reciprocal Rank Fusion.
 *
 * @param rankings - per-query ranked page-URL lists (best first).
 * @param k - the smoothing constant.
 * @returns page URL → fused score (higher is better).
 */
export function rrf(rankings: readonly (readonly string[])[], k = RRF_K): Map<string, number> {
  const scores = new Map<string, number>()
  for (const ranking of rankings) {
    ranking.forEach((pageUrl, rank) => {
      scores.set(pageUrl, (scores.get(pageUrl) ?? 0) + 1 / (k + rank + 1))
    })
  }
  return scores
}

/**
 * Search the local corpus.
 *
 * @param input - the queries, result cap, and retrieval mode.
 * @returns the ranked hits (empty when the corpus is empty or no mode matches).
 */
export async function searchLocal(input: {
  queries: readonly string[]
  maxResults: number
  mode: LocalSearchMode
}): Promise<LocalSearchResult> {
  const started = performance.now()
  const db = await storeDatabase()
  const perQuery = Math.max(1, Math.ceil(input.maxResults * 2))
  const rankings: string[][] = []

  // Warm the model before deciding: in a fresh process `modelReadyNow()` is
  // false until the first `ensureModel()`, which would silently demote a
  // hybrid query to lexical. Loading is cached; failures stay lexical.
  let session: Awaited<ReturnType<typeof ensureModel>> = null
  if (input.mode === 'semantic' || input.mode === 'hybrid') {
    session = await ensureModel()
  }

  for (const query of input.queries) {
    if (input.mode === 'lexical' || input.mode === 'hybrid') {
      rankings.push(await lexicalRanking(db, query, perQuery))
    }
    if ((input.mode === 'semantic' || input.mode === 'hybrid') && session !== null) {
      rankings.push(await semanticRanking(db, session, query, perQuery))
    }
  }

  const scores = rrf(rankings)
  const top = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, input.maxResults)
  const hits = await buildHits(db, top, input.queries)
  return {
    mode: input.mode,
    hits,
    modelReady: session !== null,
    elapsedMs: Math.round(performance.now() - started),
  }
}

/** Rank pages by FTS5 BM25 for one query (empty on no match or FTS error). */
async function lexicalRanking(db: DatabaseSync, query: string, limit: number): Promise<string[]> {
  const match = ftsMatchQuery(query)
  if (match === undefined) return []
  try {
    const rows = db
      .prepare('SELECT url FROM page_fts WHERE page_fts MATCH ? ORDER BY bm25(page_fts) LIMIT ?')
      .all(match, limit) as Array<{ url: string }>
    return rows.map(row => row.url)
  } catch {
    return []
  }
}

/** Rank pages by cosine similarity over chunk embeddings for one query. */
async function semanticRanking(
  db: DatabaseSync,
  session: InferenceSession,
  query: string,
  limit: number,
): Promise<string[]> {
  const vector = await embed(session, query)
  const rows = db
    .prepare('SELECT page_url, embedding FROM chunks WHERE embedding IS NOT NULL')
    .all() as Array<{ page_url: string; embedding: Uint8Array }>
  const scored: Array<{ url: string; similarity: number }> = []
  for (const row of rows) {
    const vec = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4)
    scored.push({ url: row.page_url, similarity: cosine(vector, vec) })
  }
  scored.sort((a, b) => b.similarity - a.similarity)
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of scored) {
    if (seen.has(entry.url)) continue
    seen.add(entry.url)
    out.push(entry.url)
    if (out.length >= limit) break
  }
  return out
}

/** Assemble the final hits with titles, domains, and snippets. */
async function buildHits(
  db: DatabaseSync,
  top: Array<[string, number]>,
  queries: readonly string[],
): Promise<LocalSearchHit[]> {
  const hits: LocalSearchHit[] = []
  for (const [url, score] of top) {
    const page = db.prepare('SELECT title, domain, content FROM pages WHERE url = ?').get(url) as
      | { title: string; domain: string; content: string }
      | undefined
    if (page === undefined) continue
    hits.push({
      url,
      title: page.title,
      domain: page.domain,
      score,
      snippet: snippetFor(page.content, queries),
    })
  }
  return hits
}

/** A short content window around the first matched query term. */
function snippetFor(content: string, queries: readonly string[]): string {
  const lower = content.toLowerCase()
  for (const query of queries) {
    for (const term of query.toLowerCase().split(/\s+/u)) {
      if (term.length === 0) continue
      const at = lower.indexOf(term)
      if (at !== -1) {
        const start = Math.max(0, at - 80)
        const end = Math.min(content.length, at + term.length + 160)
        return `${start > 0 ? '…' : ''}${content.slice(start, end)}${end < content.length ? '…' : ''}`
      }
    }
  }
  return content.slice(0, 240)
}
