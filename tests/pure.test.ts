/**
 * Pure-function unit tests (no network, no SQLite, no model).
 */

import { describe, expect, it } from 'vitest'
import { rrf, ftsMatchQuery } from '../src/search.ts'
import { isPrivateAddress } from '../src/ssrf.ts'
import { chunkText } from '../src/store.ts'
import { domainKey, isHttpUrl, normalizeUrl } from '../src/urls.ts'
import { cosine, wordPieceTokenize, CLS_ID, SEP_ID, UNK_ID } from '../src/model.ts'
import { parseRobots, robotsAllowed, EMPTY_POLICY } from '../src/robots.ts'
import { parseUnresponsive, unresponsiveHealthNote } from '../src/searxng.ts'

describe('chunkText', () => {
  it('splits on blank lines and drops empty paragraphs', () => {
    expect(chunkText('a\n\n\nb\n\nc\n\n')).toEqual(['a', 'b', 'c'])
  })
  it('hard-splits oversized paragraphs into fixed windows', () => {
    const big = 'x'.repeat(1900)
    const chunks = chunkText(`intro\n\n${big}`)
    expect(chunks.map(chunk => chunk.length)).toEqual([5, 800, 800, 300])
  })
  it('returns empty for blank input', () => {
    expect(chunkText('')).toEqual([])
  })
})

describe('ftsMatchQuery', () => {
  it('quotes and OR-joins terms', () => {
    expect(ftsMatchQuery('hello world')).toBe('"hello" OR "world"')
  })
  it('doubles internal quotes (wrapper + doubled pair = three per side)', () => {
    expect(ftsMatchQuery('say "hi" now')).toBe('"say" OR """hi""" OR "now"')
  })
  it('returns undefined for empty queries', () => {
    expect(ftsMatchQuery('')).toBeUndefined()
    expect(ftsMatchQuery('   ')).toBeUndefined()
  })
})

describe('rrf', () => {
  it('fuses rankings so pages in both lists rank first', () => {
    const scores = rrf([['a', 'b', 'c'], ['c', 'a', 'd']])
    const order = [...scores.entries()].sort((x, y) => y[1] - x[1]).map(([url]) => url)
    expect(order.slice(0, 2).sort()).toEqual(['a', 'c'])
  })
  it('handles an empty ranking set', () => {
    expect([...rrf([]).entries()]).toEqual([])
  })
})

describe('url helpers', () => {
  it('normalizeUrl strips fragments and trailing slashes, lowercases the host', () => {
    expect(normalizeUrl('HTTPS://Example.COM/a/b/#frag')).toBe('https://example.com/a/b')
    expect(normalizeUrl('https://example.com/')).toBe('https://example.com/')
  })
  it('domainKey drops a leading www.', () => {
    expect(domainKey('https://www.example.com/x')).toBe('example.com')
    expect(domainKey('https://example.com')).toBe('example.com')
  })
  it('isHttpUrl accepts only http(s)', () => {
    expect(isHttpUrl('https://a.b/c')).toBe(true)
    expect(isHttpUrl('http://a.b/c')).toBe(true)
    expect(isHttpUrl('ftp://a.b/c')).toBe(false)
    expect(isHttpUrl('not a url')).toBe(false)
  })
})

describe('isPrivateAddress', () => {
  it('blocks loopback, private, and link-local IPv4', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.1.1', '0.0.0.0']) {
      expect(isPrivateAddress(ip)).toBe(true)
    }
  })
  it('allows public IPv4', () => {
    for (const ip of ['1.1.1.1', '8.8.8.8', '172.32.0.1', '93.184.216.34']) {
      expect(isPrivateAddress(ip)).toBe(false)
    }
  })
  it('blocks IPv6 loopback, link-local, and IPv4-mapped private', () => {
    expect(isPrivateAddress('::1')).toBe(true)
    expect(isPrivateAddress('fe80::1')).toBe(true)
    expect(isPrivateAddress('::ffff:192.168.1.1')).toBe(true)
    expect(isPrivateAddress('2606:4700::1111')).toBe(false)
  })
})

describe('wordPieceTokenize', () => {
  const vocab = new Map([
    ['[unused0]', 1],
    ['hello', 10],
    ['##lo', 11],
    ['world', 12],
    ['[unused39]', 40],
  ])
  it('frames with CLS/SEP and decomposes with ## prefixes', () => {
    expect(wordPieceTokenize('hello world', vocab)).toEqual([CLS_ID, 10, 12, SEP_ID])
  })
  it('UNKs unknown words and skips punctuation-only words', () => {
    expect(wordPieceTokenize('!! zzz', vocab)).toEqual([CLS_ID, UNK_ID, SEP_ID])
  })
})

describe('cosine', () => {
  it('is 1 for identical unit vectors, 0 for orthogonal', () => {
    const a = new Float32Array([1, 0])
    const b = new Float32Array([1, 0])
    const c = new Float32Array([0, 1])
    expect(cosine(a, b)).toBeCloseTo(1)
    expect(cosine(a, c)).toBeCloseTo(0)
  })
  it('returns 0 for length mismatch', () => {
    expect(cosine(new Float32Array([1]), new Float32Array([1, 0]))).toBe(0)
  })
})

describe('searxng engine health', () => {
  it('reads the [engine, reason] pairs current builds send', () => {
    expect(parseUnresponsive([['brave', 'access denied'], ['qwant', 'timeout']])).toEqual([
      { engine: 'brave', reason: 'access denied' },
      { engine: 'qwant', reason: 'timeout' },
    ])
  })
  it('reads the third slot newer builds add, without losing the reason', () => {
    expect(parseUnresponsive([['duckduckgo', 'captcha', 'SearxEngineCaptchaException']]))
      .toEqual([{ engine: 'duckduckgo', reason: 'captcha' }])
  })
  it('accepts bare engine names from older builds', () => {
    expect(parseUnresponsive(['mwmbl', 'mojeek'])).toEqual([
      { engine: 'mwmbl', reason: 'unresponsive' },
      { engine: 'mojeek', reason: 'unresponsive' },
    ])
  })
  it('ignores entries that name no engine, and a missing field', () => {
    expect(parseUnresponsive([['', 'timeout'], [null], 7, undefined])).toEqual([])
    expect(parseUnresponsive(undefined)).toEqual([])
  })
  it('stays silent when every engine answered, and names them otherwise', () => {
    expect(unresponsiveHealthNote([])).toBe('')
    const note = unresponsiveHealthNote([
      { engine: 'brave', reason: 'access denied' },
      { engine: 'qwant', reason: 'timeout' },
    ])
    expect(note).toContain('brave (access denied)')
    expect(note).toContain('qwant (timeout)')
  })
  it('caps the list and counts what it left out', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ engine: `e${i}`, reason: 'timeout' }))
    const note = unresponsiveHealthNote(many)
    expect(note).toContain('e5 (timeout)')
    expect(note).not.toContain('e6')
    expect(note).toContain('+3 more')
  })
})

describe('robots', () => {
  const policy = parseRobots([
    'User-agent: *',
    'Disallow: /private',
    'Allow: /private/public$',
    'Disallow: /tmp/*',
    '',
    'User-agent: pi-web-tools',
    'Disallow: /agent-only',
  ].join('\n'))

  it('allows by default', () => {
    expect(robotsAllowed('https://a.b/open', policy, 'pi-web-tools/0.1.0')).toBe(true)
    expect(robotsAllowed('https://a.b/open', EMPTY_POLICY, 'pi-web-tools/0.1.0')).toBe(true)
  })
  it('disallows prefix matches', () => {
    expect(robotsAllowed('https://a.b/private/secret', policy, 'pi-web-tools/0.1.0')).toBe(false)
    expect(robotsAllowed('https://a.b/tmp/x', policy, 'pi-web-tools/0.1.0')).toBe(false)
  })
  it('lets a specific Allow beat a shorter Disallow', () => {
    expect(robotsAllowed('https://a.b/private/public', policy, 'pi-web-tools/0.1.0')).toBe(true)
  })
  it('applies user-agent-specific groups', () => {
    expect(robotsAllowed('https://a.b/agent-only', policy, 'pi-web-tools/0.1.0')).toBe(false)
    expect(robotsAllowed('https://a.b/agent-only', policy, 'other-agent')).toBe(true)
  })
})
