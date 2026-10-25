---
name: web-tools
description: Web capability tools — web_search (SearXNG), web_fetch, web_render (headless Chromium), web_crawl, and local_search over the local corpus. Use when a task needs live web results, a page's content, a JavaScript-heavy page, an entire site ingested, or answers from pages fetched in past sessions.
---

# web-tools

Five tools from the `pi-web-tools` extension. All backends are local/self-hosted: SearXNG for search, Playwright Chromium for rendering, one SQLite corpus shared with the DeepSeek Harness (`~/.dsh/data/web-index/index.db`).

## Choosing a tool

- **`local_search` first** when the question might already be answered by material fetched or crawled in past sessions — it is free, instant, and needs no network. It answers from the shared corpus, not the current conversation.
- **`web_search`** for live discovery. It returns titles, URLs, snippets — never full content. Use `timeRange: "day"|"month"|"year"` for recent events; `categories: "news"` or `"it"` to steer.
- **`web_fetch`** once you have a URL and want its content as markdown. Plain HTTP is the default and right for static pages; set `render: true` when the page is JavaScript-heavy and the plain fetch comes back empty or skeletal.
- **`web_render`** when a page specifically needs the browser (interactive, SPA, dynamically loaded). Slower than `web_fetch`; do not use it as the default.
- **`web_crawl`** to ingest a whole site (docs, a small project) in one call. Every successful page lands in the corpus; follow up with `local_search` instead of re-reading pages.

## Behavior notes

- `web_fetch`, `web_render`, and `web_crawl` **auto-index** into the local corpus (fire-and-forget). The corpus grows as you work; `local_search` reflects it immediately.
- The SSRF guard blocks loopback/private targets by default. If a fetch of a LAN address is blocked, that is the guard — tell the user rather than working around it.
- Search results are snippets. When a claim needs verification, fetch the source page; cite the URL you actually read, not the search hit.
- `/webtools` (user command) prints corpus size, model state, and config paths when diagnosing these tools.
