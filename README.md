# pi-web-tools

Locally hosted, API-free web capabilities for [pi](https://github.com/earendil-works/pi):
web search, fetching, headless rendering, bounded crawling, and a local corpus
index — no keys, no quotas, no SaaS.

A pi extension (TypeScript, loaded directly by pi's jiti runtime — no build
step) that registers five tools:

| Tool | What it does |
| --- | --- |
| `web_search` | Live web search through a self-hosted [SearXNG](https://docs.searxng.org/) instance |
| `web_fetch` | Fetch a page to markdown (plain HTTP, or rendered), auto-indexed into the local corpus |
| `web_render` | Render a page in headless Chromium (Playwright) and return readable markdown, auto-indexed |
| `web_crawl` | Crawl a same-domain site (robots.txt-respecting, rate-limited); every page extracted to markdown and indexed |
| `local_search` | Search the local corpus (lexical FTS5 BM25, semantic MiniLM embeddings, or RRF-fused hybrid) |

Plus a `/webtools` command (corpus size, model state, config paths).

## Shared corpus

The index is one SQLite file (`node:sqlite`, WAL) with a schema **identical
to [`dsh-web-tools`](https://github.com/mrrodero/dsh-web-tools)** — the two
harnesses can share one corpus: pages fetched in pi are `local_search`-able
from the DeepSeek Harness and vice versa. Defaults point at
`~/.dsh/data/web-index/index.db` and the MiniLM model directory; override
with `config.json` or `PI_WEB_TOOLS_INDEX_DB`.

- Pages are deduped by URL (latest index wins); content is chunked (~800
  chars, paragraph-aware) for embedding.
- The embedding model (`all-MiniLM-L6-v2`, 384-dim, ONNX) is used if present
  (downloaded on first use otherwise); any failure degrades search to
  lexical-only — the model is an enhancement, never a dependency.
- One writer at a time per file: don't run two harnesses writing the same
  index simultaneously (WAL makes concurrent *reads* fine).

## Install

```sh
git clone https://github.com/mrrodero/pi-web-tools
cd pi-web-tools
npm install          # pulls playwright (browsers are NOT auto-downloaded)
```

Point Playwright at an existing browser if you don't want a fresh download:

```sh
npx playwright install chromium
```

Load the extension. Pi loads anything in `~/.pi/agent/extensions/` — either
symlink/junction this repo there, or run pi with a flag:

```sh
pi --extension ./pi-web-tools/index.ts
```

For a permanent install (Windows):

```sh
cmd /c mklink /J "%USERPROFILE%\.pi\agent\extensions\web-tools" "C:\path\to\pi-web-tools"
```

Then restart pi (or `/reload`).

## Configuration

Precedence: built-in defaults → optional `config.json` in the package root
(gitignored) → environment variables.

```jsonc
// config.json (all fields optional)
{
  "searxngBaseURL": "http://192.168.144.120:8888",  // empty disables web_search
  "indexDbPath": "~/.dsh/data/web-index/index.db",  // shared with dsh-web-tools
  "modelDir": "~/.dsh/data/web-index/models",
  "userAgent": "pi-web-tools/0.1.0",
  "allowPrivateNetworks": false,   // true: fetch/render/crawl may hit LAN/loopback
  "fetchTimeoutMs": 30000,
  "maxBodyBytes": 5242880,
  "defaultMaxChars": 100000,
  "renderTimeoutMs": 60000,
  "crawl": { "maxPages": 50, "maxDepth": 3, "delayMs": 500 }
}
```

Environment overrides: `PI_WEB_TOOLS_SEARXNG_URL`, `PI_WEB_TOOLS_INDEX_DB`.

**Security:** fetch/render/crawl run a pre-navigation SSRF guard that blocks
loopback/private/link-local targets by default (`allowPrivateNetworks: true`
disables the check — e.g. when crawling a self-hosted site on the LAN).

## Development

```sh
npm test               # pure-function unit tests (vitest; no network, no model)
npm run check          # tsc --noEmit
npm run integration    # live: SearXNG + shared index + HTTP fetch + Chromium render
```

Requires Node ≥ 24 (built-in `node:sqlite`).

## Relationship to dsh-web-tools

Ported from `@deepseek-ai/dsh-web-tools` (MIT, same author): the SearXNG
provider, the turndown/cheerio extraction, the robots.txt engine, the crawl
engine, and the FTS5 + MiniLM index are the same implementations, reshaped
from dsh plugin modules into a single pi extension. The dsh bundle keeps its
harness-specific seams (provider registration, cordis patch rows); this
package owns no dsh dependencies.

## License

MIT — see [LICENSE](LICENSE).
