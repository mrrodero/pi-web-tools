/**
 * Extension harness: loads the real extension entry point with a mock
 * `ExtensionAPI`, asserts the tool surface, and invokes each tool's
 * `execute` against the live infrastructure (SearXNG, corpus, Chromium).
 * Run with: `npm run harness`.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import webToolsExtension from '../src/index.ts'

interface MockTool {
  name: string
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<{ content: Array<{ type: string; text: string }>; details?: Record<string, unknown> }>
}

const tools = new Map<string, MockTool>()
const commands = new Map<string, unknown>()
const events = new Map<string, unknown>()

const pi = {
  registerTool: (tool: MockTool) => {
    tools.set(tool.name, tool)
  },
  registerCommand: (name: string, definition: unknown) => {
    commands.set(name, definition)
  },
  on: (event: string, handler: unknown) => {
    events.set(event, handler)
  },
} as unknown as ExtensionAPI

webToolsExtension(pi)

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const expected = ['web_search', 'web_fetch', 'web_render', 'web_crawl', 'local_search']
for (const name of expected) {
  check(`tool registered: ${name}`, tools.has(name))
}
check('command registered: /webtools', commands.has('webtools'))
check('shutdown hook registered', events.has('session_shutdown'))

// web_search (live SearXNG)
{
  const result = await tools.get('web_search')!.execute('1', { query: 'hugging face gguf quantization', maxResults: 3 }, undefined, undefined, {})
  check('web_search runs', /huggingface/.test(result.content[0].text), result.content[0].text.split('\n')[0])
}

// web_fetch (plain HTTP, auto-indexed)
{
  const result = await tools.get('web_fetch')!.execute('2', { url: 'https://quotes.toscrape.com' }, undefined, undefined, {})
  check('web_fetch runs', result.content[0].text.includes('Quotes to Scrape'), `chars=${(result.details as Record<string, unknown>)?.chars}`)
}

// web_render (headless Chromium)
{
  const result = await tools.get('web_render')!.execute('3', { url: 'https://quotes.toscrape.com' }, undefined, undefined, {})
  check('web_render runs', result.content[0].text.length > 500, `chars=${(result.details as Record<string, unknown>)?.chars}`)
}

// local_search (corpus, model may be cold)
{
  const result = await tools.get('local_search')!.execute('4', { query: 'torrent tracker' }, undefined, undefined, {})
  check('local_search runs', (result.details as Record<string, unknown>)?.count !== undefined, `count=${(result.details as Record<string, unknown>)?.count}`)
}

// SSRF guard surfaces as a tool error, not a crash
{
  try {
    await tools.get('web_fetch')!.execute('5', { url: 'http://192.168.1.1/' }, undefined, undefined, {})
    check('SSRF block surfaces', false, 'was not blocked')
  } catch (error) {
    check('SSRF block surfaces', String(error).includes('private or loopback'), String(error))
  }
}

// web_crawl (tiny 2-page crawl of a static site)
{
  const result = await tools.get('web_crawl')!.execute('6', { url: 'https://quotes.toscrape.com', maxPages: 3, maxDepth: 1 }, undefined, undefined, {})
  const details = result.details as Record<string, unknown>
  check('web_crawl runs', (details.pages as number) >= 2, `pages=${details.pages}, chars=${details.totalChars}`)
}

// /webtools command handler
{
  const handler = commands.get('webtools') as { handler: (args: string, ctx: { ui: { notify: (message: string, kind: string) => void } }) => Promise<void> }
  const notified: string[] = []
  await handler.handler('', { ui: { notify: (message: string) => notified.push(message) } })
  check('/webtools reports corpus', notified.some(message => message.includes('pages')), notified[0])
}

// Shutdown hook closes browser + index
{
  const handler = events.get('session_shutdown') as (event: unknown, ctx: unknown) => Promise<void>
  await handler(undefined, undefined)
  check('shutdown hook completes', true)
}

console.log(failures === 0 ? '\nAll harness checks passed.' : `\n${failures} harness check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
