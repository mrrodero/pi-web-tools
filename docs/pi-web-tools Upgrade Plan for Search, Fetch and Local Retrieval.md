# pi-web-tools: Upgrade Plan for Search, Fetch and Local Retrieval

Prepared 2 November 2026 for mrrodero/pi-web-tools. Based on the public README, package.json and index.ts, plus an excerpt of your SearXNG logs. The src/ directory could not be inspected, so implementation details are inferred; items marked (verify) must be checked against the code. Bracketed numbers refer to the Sources list at the end.

## 1. Summary

pi-web-tools already has a sound base: self-hosted SearXNG, Playwright rendering, FTS5 + dense retrieval fused with RRF, an SSRF guard, graceful degradation and a corpus shared with dsh-web-tools. This plan upgrades it on five axes:

1. **Search resilience:** survive captchas, blocks and timeouts, and report them honestly to the model.
2. **Context efficiency:** keep bulk page text out of the model’s context and pull in only what is needed.
3. **Retrieval quality:** reranking, a better multilingual embedder, contextual chunks.
4. **Orchestration:** a budgeted search pipeline that reads pages, not just snippets.
5. **Security and evaluation:** contain prompt injection, and measure every upgrade against a baseline.

Every upgrade ships behind a config flag so it can be ablated.

## 2. Diagnosis

### 2.1 What the SearXNG logs show

| Log signal | Likely cause | Action |
| --- | --- | --- |
| DuckDuckGo CAPTCHA (wt-wt) (suspended\_time=0), then an IndexError at duckduckgo.py:500 | A captcha wave since late August; one reporter traced it to header and TLS fingerprint mismatches \[16\]. The engine suspends itself for zero seconds \[17\], so SearXNG retries it on every query. The IndexError means the captcha check passed but parsing failed, and parse errors do not suspend an engine \[20\]. | Update the image; treat DDG as best-effort; rest it from the harness |
| Qwant Access denied (suspended\_time=180), again about 70 s later | Qwant ships disabled upstream \[20\] and is widely reported as blocked \[18\]. Two Qwant variants per search double the cost. | Remove |
| Yahoo, Qwant, Wikipedia engine timeout, plus add\_unresponsive\_engine after close | Engines outlasting the global deadline. Wikipedia is the outlier: one reporter’s Wikipedia engines kept working while others failed \[18\], so suspect local DNS, IPv6 or egress, or timeouts that are too tight. | Test from the container’s network namespace; raise timeouts |
| limiter.toml missing; X-Forwarded-For nor X-Real-IP header is set | The limiter is installed only when server.limiter or public\_instance is set \[23\]. On a private instance it can throttle your own harness: in one test it allowed 4 JSON requests per hour per IP and returned 429 on the fifth \[22\]. | Disable the limiter; keep the port LAN-only |
| ahmia, torch cannot register | Onion engines that need Tor | Remove |
| Many engines hit per search (ddg, qwant, yahoo, each twice) | Wide fan-out multiplies what each upstream sees from your IP. One third-party setup found that default settings sent every query to about 57 engines \[24\]. | Curate with keep\_only |

Two caveats:

- **Volume is not the main cause.** Your excerpt shows about three searches in two minutes, so pacing alone will not unblock DDG or Qwant. Pacing protects the engines that still work: Brave reportedly blocks after a few consecutive searches \[16\].
- **Engine health is per-IP and shifts week to week.** A reporter on 18 October had DDG working while Brave and Qwant failed \[18\], the reverse of your pattern. The harness must adapt at runtime rather than rely on a fixed engine list.

### 2.2 Gaps in the repository

1. **No rerank stage.** Retrieval stops at BM25 + MiniLM fused with RRF.
2. **High context cost.** defaultMaxChars is 100000, about twice pi’s own 50 KB tool-output guideline \[1\], and whole pages go into context.
3. **Dated, English-only embedder.** MiniLM-L6-v2 will serve non-English content poorly.
4. **Chunks lose context.** Plain 800-character paragraphs carry no title or heading path.
5. **Search is disconnected from reading.** Results look like snippets, with no fan-out budget, dedupe or per-domain cap (verify).
6. **Silent failure modes.** JS shells, consent walls, paywalls and challenge pages may be returned as if they were content, and a captcha-induced empty result looks like no results (verify).
7. **Security.** The SSRF guard is described as pre-navigation (verify redirects, DNS rebinding and Playwright subrequests); there is no hidden-text stripping; and the shared corpus lets one poisoned page persist into the other harness.

## 3. Do today (no code)

1. **Update the SearXNG image.** The DDG fix arrived with the curl-impersonation work in the image \[20\]. Some users still see captchas afterwards \[17\], so do not depend on DDG.
2. **Disable the limiter and confirm LAN-only exposure.** You listen on \[::\]:8888, which means all interfaces. If the port is reachable beyond your LAN, strangers’ queries leave from your IP and damage its reputation.
3. **Curate engines** with the YAML below.
4. **Diagnose the timeouts** from the container’s network namespace: `docker run --rm --network container:<searxng> curlimages/curl -4 -s -o /dev/null -w '%{time_namelookup} %{time_connect} %{time_total}' https://en.wikipedia.org/`, then repeat with `-6`.
5. **Drop stale outgoing keys.** SearXNG’s HTTP client is now curl\_cffi, so pool\_maxsize and keepalive\_expiry do nothing \[21\]. Leave useragent\_suffix empty for scraped engines: one operator removed a bot-identifying suffix because it labelled every request as automated \[24\], although the docs say contact details can help with some engines \[27\].

```yaml
use_default_settings:
  engines:
    keep_only: [brave, bing, duckduckgo, wikipedia, wikidata, github, stackoverflow, arxiv]  # verify names at /config
server:
  limiter: false
search:
  formats: [html, json]
outgoing:
  request_timeout: 4.0
  max_request_timeout: 10.0   # the harness timeout must exceed this
engines:
  - name: bing
    disabled: false           # ships disabled upstream
  - name: duckduckgo
    weight: 0.5               # best-effort
  - name: wikipedia
    timeout: 6.0
```

Engines marked inactive cannot be revived with disabled: false. In one release Startpage and Mojeek were inactive because of proof-of-work captchas \[24\].

## 4. Roadmap

| Phase | Goal | Effort | Exit criterion |
| --- | --- | --- | --- |
| 0 | Evaluation harness and frozen baseline | 2–3 d | Baseline numbers committed |
| S | Search resilience | 4–5 d | Engine health visible; blocked is never reported as no results; evals stable under captcha weather |
| 1 | Fetch quality, context efficiency, tiered fetch | 5–6 d | Fewer tokens returned per fetch at equal answer accuracy; challenge pages never returned as content |
| 2 | Retrieval quality | 5–7 d | Better success@5 and nDCG@10 than baseline |
| 3 | Search orchestration | 3–4 d | Search plus read in one call; fewer upstream requests per answered query |
| 4 | Hardening and context hygiene | 3–4 d | SSRF and injection tests pass; old web results re-hydratable |
| 5 | Stretch | open | Per item |

Efforts are rough solo-developer estimates. Every exit criterion is relative to the Phase 0 baseline and must not regress tokens or latency.

## 5. Phase 0: measure first

Without this, claims of improvement cannot be verified. Put the following in tests/eval/:

- **Retrieval set:** about 60 queries covering known-item lookups, technical docs, fresh news, long-tail and non-English, each with labelled relevant URLs.
- **Extraction set:** about 50 saved HTML pages across page types, with hand-trimmed main content. WCXB, a benchmark of 2,008 pages across seven page types, is a ready source to sample from \[11\]; check its dataset licence.
- **End-to-end set:** about 30 questions run headless through pi (print or JSON mode), recording accuracy, input tokens, tool calls and latency.
- **Judging:** use an LLM from a different family than the agent, grading each result 0, 1 or 2 as one SearXNG MCP author did on 100 queries \[12\].
- **Record and replay SERP fixtures** so captcha weather does not pollute benchmark runs, and log engine state with every run.
- **Tracing:** a JSONL trace per tool call, a /webtools stats command, and an ablation runner driven by the config flags.

## 6. Phase S: search resilience

**Design stance:** avoid triggers, detect blocks, degrade honestly, then escalate.

**S1. Tiered engine set.**

- Tier A: scraped general engines (Brave, Bing, DDG), paced and best-effort.
- Tier B: structured-API engines (Wikipedia, GitHub, Stack Exchange, arXiv and similar) that rarely captcha. They are not immune: one user’s Wikidata showed access denied \[16\].
- Tier C: small-index engines.
- Route by query intent so code, papers and facts mostly skip Tier A.

**S2. EnginePool in the harness (src/search/pool.ts).**

- **Budgets:** per-engine token buckets, starting around one request per 2–5 s for scraped engines. One third-party setup paced scraped engines at roughly 0.15–0.5 requests per second and reported 70% on-topic results versus 0 of 10 before; that is a single measurement in their own environment \[24\]. Tune from your own ledger.
- **Health:** circuit-breaker states (healthy, degraded, resting) driven by SearXNG’s unresponsive\_engines field. SearXNG’s own suspension defaults are 24 h for captcha and access denied and 1 h for too many requests \[19\]; start there and probe with one low-priority request when a rest expires. Timeouts get short rests; three consecutive parse errors get one longer rest.
- **Engine list:** when naming engines, omit categories, because SearXNG queries the union of the two \[24\].
- **Retries:** transient errors only, once, with jitter. Another project does not retry rate limits, since the same address is unlikely to get a different answer \[25\].
- **No budget left:** skip SearXNG and fall back to local\_search rather than waiting.
- **State:** persist in the sidecar DB so restarts do not forget bans. The harness timeout to SearXNG must exceed max\_request\_timeout.

**S3. Honest results.** Add a search\_health field to every web\_search result (see section 12) and tell the model in promptGuidelines that blocked is not the same as no results.

**S4. Fallbacks, in order.**

1. A second SearXNG on a different egress (searxngBaseURLs\[\] with failover). A datacenter egress may draw harsher DDG checks \[16\].
2. local\_search over the corpus.
3. A last-resort browser SERP via Playwright, with human-in-the-loop captcha solving in TUI mode only.

**S5. Observability.**

- /webtools engines shows state, last error, next retry and a 24-hour success rate from a sidecar ledger.
- /webtools doctor checks the SearXNG version, search.formats, limiter state, DNS and IPv4/IPv6 timings, and sends one probe per engine.

**S6. Deliberately out of scope:** CAPTCHA-solving services, stealth-fingerprint stacks and residential proxy pools. They are an arms race with ongoing maintenance and often conflict with site terms; one agent-search project itself notes there is no reliable free equivalent \[25\]. Fewer upstream requests, better engine choice and honest failure reporting are the cheaper wins.

## 7. Phase 1: fetch quality, context efficiency, tiered fetch

**1.1 Spool, do not dump.** web\_fetch returns a compact envelope: title, canonical URL, language, date, token estimate, heading outline with offsets, a lead of about 1.5k characters, a doc\_id and a cache path. A new web\_read(doc\_id, query, section, offset, limit) returns only what is asked for, and the cached markdown is also greppable with pi’s built-in read and grep. This follows the idea behind Anthropic’s dynamic filtering, which lets the model filter web results before they reach context and reported about 11% better accuracy with 24% fewer input tokens \[7\]. Pi’s own truncation pattern points the model at a temp file in the same way \[1\]. Add a focus parameter for a one-shot fetch that returns the top-k passages using the Phase 2 retriever.

**1.2 Content negotiation.** Send Accept: text/markdown with text/html at lower priority, and use markdown directly when the server returns it. Cloudflare’s Markdown for Agents converts pages on request and reports token counts in a response header, but only zones that enabled it respond that way \[8\]. Treat it as opportunistic, and probe /llms.txt on docs hosts.

**1.3 Extraction chain.**

1. Sanitize first: remove hidden, aria-hidden, off-screen and comment content.
2. Run Defuddle (a more forgiving Readability alternative that also extracts schema.org metadata \[9\]) or Readability with linkedom.
3. Fall back to the current cheerio and turndown path when the output is thin.
4. Add a JS-shell detector that escalates to Playwright through a render flag (auto, never or always) on web\_fetch; web\_render stays as an alias.
5. Choose the extractor by your Phase 0 extraction score. Heuristic extractors have a ceiling: on MinerU’s benchmark Readability and Trafilatura score about 0.65 and 0.64 ROUGE-N F1 versus about 0.90 for its fine-tuned small-model extractor \[10\], and neural extractors need GPU inference \[11\], so that belongs in Phase 5.

**1.4 Content-type router.** PDFs through a pdf.js-based library with page markers, plain text and JSON, GitHub blob to raw, and arXiv abstract to full text where available.

**1.5 Typed statuses.** ok, js\_required, paywalled, blocked, consent\_wall, challenge, rate\_limited, not\_found, non\_text, each with a suggested next action, so the model does not reason over junk or loop.

**1.6 Tiered fetch against bot protection.** Escalate only when a block is detected.

- **T0:** plain HTTP with negotiated markdown.
- **T1:** a TLS-impersonating client. Antibot systems keep fingerprint databases that classify typical Node HTTP clients as suspicious \[26\]. impit offers a fetch-compatible API with browser-style TLS fingerprints through native Node bindings \[26\]; check its maintenance before adopting it. One agent-search project uses the same tiering, escalating to impersonation only on a detected challenge \[25\]. Keep robots.txt and pacing in force.
- **T2:** Playwright with a persistent per-host profile, kept separate from your daily browser. When ctx.mode is tui, a human can solve a challenge in a headed window; otherwise return the typed status.
- **T3:** alternates (site API, Wayback availability), or a typed challenge status with a suggested next step.
- **Challenge detector:** status 403, 429 or 503, challenge headers such as Cloudflare’s cf-mitigated (verify), interstitial titles, captcha widgets and a low text-to-HTML ratio.
- **Host circuit breaker:** per-host token bucket (already planned), Retry-After handling, and a rest period after repeated challenges.

**1.7 Caching.** Conditional GET with ETag and Last-Modified, and per-host pacing.

## 8. Phase 2: retrieval quality

Keep the shared schema untouched. Put new derived data (chunk\_embeddings with chunk\_id, model\_id, dim, vec) in a sidecar DB so dsh-web-tools keeps working. Run embedding in a background queue so web\_fetch returns fast and write contention is avoided.

**2.1 Structure-aware chunks with a contextual header.**

- Split on headings and keep code blocks and tables atomic.
- Use roughly 200–400 tokens per chunk, store character offsets, and support neighbour expansion of one chunk either side.
- Prepend Title > H2 > H3 · domain · date to the text used for both FTS and embedding. This is a deterministic, zero-LLM cousin of contextual retrieval. Anthropic’s LLM-generated variant reported about 35% fewer top-20 retrieval failures from contextual embeddings alone, about 49% adding contextual BM25, and about 67% with reranking \[6\].

**2.2 Embedder swap.** Benchmark three candidates on your golden set:

- Qwen3-Embedding-0.6B (Apache 2.0): 70.47 on MTEB English v2 with 32K context. EmbeddingGemma-300m: 69.67 with 768 dimensions and a 2,048-token window \[2\].
- jina-embeddings-v5-text-small (677M parameters): 67.0 on MMTEB and 71.7 on MTEB English \[3\]. Check its licence.
- Store model\_id and dim, use Matryoshka truncation if supported, and keep the MiniLM column until dsh-web-tools catches up.

**2.3 Reranker.** Rerank the top 50 from RRF down to the top 8. BGE Reranker v2-m3, mxbai-rerank-large-v2 and Qwen3-Reranker are Apache 2.0, while jina-reranker-v3.5’s weights are CC-BY-NC-4.0 \[4\]. Jina’s 0.6B v3.5 reports 63.20 nDCG@10 on BEIR \[5\]. Start with an int8 ONNX bge-reranker-v2-m3, since it is a plain classification head and easy in onnxruntime-node, then compare Qwen3-Reranker-0.6B and Jina on your own set. Lazy-load it and degrade gracefully, as the embedder already does.

**2.4 Authority guard.** Reranking can hurt navigational queries. One SearXNG MCP found that pure reranking hurt known-item lookups and added a guard that keeps top-3 results near their original rank \[12\]. Copy that idea.

**2.5 Result shaping.** Group by URL, cap per domain, apply MMR, show fetched\_at with a stale flag, and cite as doc\_id#chunk.

**2.6 FTS5 check (verify).** Use unicode61 with remove\_diacritics 2, drop the Porter stemmer for non-English content, and weight title and heading columns in bm25().

**2.7 sqlite-vec.** Defer it until brute-force similarity is measurably slow; your corpus is likely small.

## 9. Phase 3: search orchestration

web\_search becomes a pipeline: normalise the query, route by intent to an engine subset, ask the EnginePool for budget, query SearXNG, canonicalise URLs (strip tracking parameters), dedupe, fuse variants with RRF, optionally read the top results, apply the authority guard, and return a compact result.

- **Adaptive fan-out:** send one query first. Issue a variant (at most two) only when coverage is low or the reranker’s top score is weak. Cap upstream requests per tool call and per minute, and serialise SERP calls with jittered spacing.
- **Parameters:** variants, category (omitted whenever engines are named), time\_range, language (detected from the query by default), site and depth.
- **depth read:** fetch the top N results, rerank passages and return the best passages per result, so search then fetch collapses into one call.
- **Caches:** a short-TTL SERP cache (shorter for news) and a negative cache for resting engines.
- **Tool count stays at five:** web\_search, web\_fetch (absorbing web\_render), web\_read, web\_crawl and local\_search.
- **Prompt guidance:** write promptSnippet and promptGuidelines that name each tool explicitly, because pi appends guidelines flat \[1\]. Teach the loop: local\_search first for seen topics, then web\_search with depth read, then web\_read, then cite by doc\_id.

## 10. Phase 4: hardening and context hygiene

- **SSRF:** resolve DNS once and pin the IP, re-validate every redirect hop, apply the guard to all Playwright subrequests with context.route, and allow only http and https.
- **Provenance and injection:** wrap results in a labelled untrusted-data envelope. Spotlighting goes further by interleaving control tokens through untrusted content rather than only fencing its boundaries \[13\]. Strip hidden text, and add heuristic injection flags in a warnings field without presenting them as complete detection.
- **Taint gate in pi:** the dangerous combination is an agent that reads untrusted content while holding private data and an outbound channel \[13\]. Pi has bash, so add a tool\_call hook: once a web result is in the turn, egress-capable or destructive bash commands need ctx.ui.confirm, and in no-UI modes they are blocked.
- **Corpus trust:** add a trust column defaulting to untrusted, wrap local\_search output the same way, and add /webtools purge by domain. Long-term stores ingest the same untrusted content, so an injection can persist across sessions \[15\].
- **Context hygiene:** use pi’s context event to replace old web results with one-line stubs plus a doc\_id for re-reading, and preserve the source registry in custom compaction \[1\]. Add compact renderResult output and onUpdate progress.
- **Browser profile:** scope the persistent profile per host, never auto-fill credentials, and keep the SSRF route guard on.

## 11. Phase 5: stretch

- LLM-generated contextual retrieval for pages you pin.
- A quarantined summarizer (a summarize flag) that calls a small model with no tools through ctx.modelRegistry. CaMeL’s dual-LLM pattern uses a privileged planner and a quarantined model without tool access for untrusted data \[14\].
- An optional small-model HTML extractor for hard pages, accepting its GPU requirement \[10\]\[11\].
- Query-guided best-first crawling with sitemap discovery.
- Screenshot or accessibility-tree output for visual pages.

## 12. Interface sketches

Use a variants array instead of a string-or-array union, because pi notes that Type.Union does not work well across providers \[1\].

```ts
// web_search
Type.Object({
  query: Type.String(),
  variants: Type.Optional(Type.Array(Type.String(), { maxItems: 2 })),
  category: Type.Optional(StringEnum(['general','news','it','science'] as const)),
  time_range: Type.Optional(StringEnum(['day','month','year'] as const)),
  language: Type.Optional(Type.String()),
  site: Type.Optional(Type.String()),
  depth: Type.Optional(StringEnum(['snippets','read'] as const)),
})
// web_fetch: { url, render: auto|never|always, focus?, max_tokens? }
// web_read:  { doc_id, query?, section?, offset?, limit? }

// added to every web_search result
search_health: {
  status: 'full' | 'partial' | 'degraded' | 'blocked',
  planned: string[], answered: string[],
  failed: { engine: string; reason: 'captcha'|'rate_limit'|'denied'|'timeout'|'parse'; retry_after_s?: number }[],
  advice?: string   // e.g. 2 of 4 general engines answered; absence is unconfirmed
}
```

Example web\_fetch envelope:

```text
[W3] Title - docs.example.com - 2026-09-14 - en - ~6.2k tokens - status: ok
Outline: 1 Install (0) / 2 Config (1.9k) / 3 API (4.1k) ...
Lead: ...
doc_id: w3f9a1  cached: ~/.pi/web-cache/w3f9a1.md
Next: web_read(doc_id, query=...) or grep the cached file
```

## 13. Risks and decisions

- **Licences:** jina-reranker-v3.5 weights are non-commercial and Gemma has its own terms. Check both, and the jina-embeddings-v5 licence, before adopting them.
- **CPU latency:** 0.6B-class models are heavier than MiniLM. Measure, then use int8, a smaller model or the background queue.
- **Schema:** the sidecar is safest. You own both repositories, so a coordinated schema bump is the alternative.
- **Engine weather is non-stationary:** SearXNG engines break and recover week to week. Build for adaptation and re-run the Phase 0 evaluation after every SearXNG update.
- **Out of scope:** paid search APIs, vector DB servers, default LLM-based extraction, CAPTCHA-solving services, and adding more tools. Consolidate rather than add.

## 14. Verify first

1. The SearXNG version (docker inspect or the instance footer) and whether the image is current.
2. server.limiter, public\_instance, and whether Valkey is configured.
3. Whether the SearXNG host egresses via a home line or a VPN or datacenter; this sets how aggressive pacing must be.
4. An HTML dump from a DDG parse failure.
5. In the repository: SSRF scope (redirects, DNS rebinding, Playwright subrequests), FTS tokenizer, default output caps, how failures are surfaced, and whether web\_search already uses SearXNG’s unresponsive\_engines field.

## 15. Sources

1. pi extensions documentation: https://pi-docs-8a7.pages.dev/extensions/
2. FutureAGI, embedding model comparison (MTEB, October 2026): https://futureagi.com/blog/best-embedding-models-2025/
3. Jina, jina-embeddings-v5-text: https://jina.ai/news/jina-embeddings-v5-text-distilling-4b-quality-into-sub-1b-multilingual-embeddings/
4. FutureAGI, best rerankers for RAG in 2026: https://futureagi.com/blog/best-rerankers-for-rag-2026/
5. Jina, jina-reranker-v3.5: https://jina.ai/models/jina-reranker-v3.5/
6. Anthropic, Introducing Contextual Retrieval: https://www.anthropic.com/news/contextual-retrieval
7. Anthropic, improved web search with dynamic filtering: https://claude.com/blog/improved-web-search-with-dynamic-filtering
8. Cloudflare, Markdown for Agents: https://developers.cloudflare.com/fundamentals/reference/markdown-for-agents
9. Defuddle: https://github.com/kepano/defuddle
10. MinerU-HTML benchmark: https://pypi.org/project/mineru-html/
11. WCXB web content extraction benchmark: https://arxiv.org/html/2605.21097v1
12. searxng-jev-mcp (reranking evaluation and authority guard): https://glama.ai/mcp/servers/arashbehmand/searxng-jev-mcp
13. Arcjet, defending against indirect prompt injection: https://arcjet.com/learn/indirect-prompt-injection-agentic-workflows
14. Defeating Prompt Injections by Design (CaMeL) review: https://liner.com/review/defeating-prompt-injections-by-design
15. Containing indirect prompt injection in tool-using agents: https://www.trackr.live/?p=570
16. SearXNG issue 6596, DuckDuckGo captcha: https://github.com/searxng/searxng/issues/6596
17. SearXNG issue 6779, DuckDuckGo captcha on every request: https://github.com/searxng/searxng/issues/6779
18. SearXNG issue 6866, most common engines fail: https://github.com/searxng/searxng/issues/6866
19. SearXNG docs, search settings: https://docs.searxng.org/admin/settings/settings\_search.html
20. SSD Nodes, which SearXNG engines to enable and disable: https://www.ssdnodes.com/learn/searxng-engines-to-enable-and-disable
21. SSD Nodes, routing SearXNG engine requests through a proxy: https://www.ssdnodes.com/learn/searxng-route-engine-requests-through-a-proxy
22. WZ-IT, SearXNG self-hosting (limiter behaviour): https://wz-it.com/en/knowledge/ki/searxng-self-hosting/
23. SearXNG limiter source (mirror): https://gitea.zaclys.com/zaclys/searxng/src/branch/master/searx/limiter.py
24. Accelerate pull request 99, SearXNG engine curation and per-engine pacing: https://github.com/mishleyotis/Accelerate/pull/99
25. websearch-skill: https://pypi.org/project/websearch-skill/
26. impit browser impersonation: https://blog.apify.com/impit-browser-impersonation-made-simple/ and https://github.com/apify/impit/wiki
27. SearXNG docs, outgoing settings: https://docs.searxng.org/admin/settings/settings\_outgoing.html
