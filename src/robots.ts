/**
 * A compact hand-rolled robots.txt parser: fetch, parse, and decide.
 * Supports the common subset — `User-agent`, `Allow`, `Disallow`, `*`
 * wildcards, and the `$` end anchor. Unreachable or erroring robots.txt
 * files mean "no restrictions" (the crawl proceeds; this matches the common
 * crawler convention).
 *
 * Ported from `@deepseek-ai/dsh-web-tools` (MIT).
 * @module pi-web-tools/robots
 */

/** One parsed rule group (one or more user-agent lines followed by rules). */
export interface RobotsRuleGroup {
  readonly userAgents: string[]
  readonly allow: string[]
  readonly disallow: string[]
}

/** A parsed robots.txt policy. */
export interface RobotsPolicy {
  readonly groups: readonly RobotsRuleGroup[]
}

/** The empty policy: no restrictions. */
export const EMPTY_POLICY: RobotsPolicy = { groups: [] }

/**
 * Fetch and parse the robots.txt for the seed's origin.
 *
 * @param seedUrl - the normalized seed URL (its origin owns the robots.txt).
 * @param userAgent - the user agent the crawl identifies as.
 * @param signal - optional cancellation signal.
 * @returns the parsed policy, or {@link EMPTY_POLICY} when unreachable.
 */
export async function fetchRobots(
  seedUrl: string,
  userAgent: string,
  signal: AbortSignal | undefined,
): Promise<RobotsPolicy> {
  const robotsUrl = new URL('robots.txt', seedUrl)
  try {
    const response = await fetch(robotsUrl.toString(), {
      signal: signal ?? null,
      headers: { 'User-Agent': userAgent },
    })
    if (!response.ok) return EMPTY_POLICY
    const text = await response.text()
    return parseRobots(text)
  } catch {
    return EMPTY_POLICY
  }
}

/**
 * Parse robots.txt text into a policy.
 *
 * @param text - the raw robots.txt content.
 * @returns the parsed policy.
 */
export function parseRobots(text: string): RobotsPolicy {
  const groups: RobotsRuleGroup[] = []
  let current: RobotsRuleGroup | undefined
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const separator = line.indexOf(':')
    if (separator === -1) continue
    const field = line.slice(0, separator).trim().toLowerCase()
    const value = line.slice(separator + 1).trim()
    if (field === 'user-agent') {
      current = { userAgents: [value], allow: [], disallow: [] }
      groups.push(current)
    } else if (current !== undefined) {
      if (field === 'allow') current.allow.push(value)
      else if (field === 'disallow') current.disallow.push(value)
    }
  }
  return { groups }
}

/**
 * Decide whether the crawl may fetch `url` under `policy`.
 *
 * A group applies when any of its user-agent tokens is a case-insensitive
 * substring of the crawler's user agent (per the robots.txt convention).
 * Among the matching groups, the longest matching pattern wins, and within
 * a group `Allow` beats `Disallow` of equal length (the standard
 * most-specific-rule resolution).
 *
 * @param url - the absolute URL to check.
 * @param policy - the parsed policy.
 * @param userAgent - the crawler's user agent.
 * @returns true when fetching is allowed (default when no rule matches).
 */
export function robotsAllowed(url: string, policy: RobotsPolicy, userAgent: string): boolean {
  let target: string
  try {
    const parsed = new URL(url)
    target = parsed.pathname + parsed.search
  } catch {
    return false
  }
  const agent = userAgent.toLowerCase()
  let best: { length: number; allowed: boolean } | undefined
  for (const group of policy.groups) {
    // `*` applies to every crawler; other tokens are case-insensitive substrings.
    if (!group.userAgents.some(token => token === '*' || (token !== '' && agent.includes(token.toLowerCase())))) continue
    for (const pattern of group.disallow) {
      const match = matchPattern(pattern, target)
      if (match !== undefined && (best === undefined || match > best.length)) {
        best = { length: match, allowed: false }
      }
    }
    for (const pattern of group.allow) {
      const match = matchPattern(pattern, target)
      if (match !== undefined && (best === undefined || match >= best.length)) {
        best = { length: match, allowed: true }
      }
    }
  }
  return best === undefined || best.allowed
}

/**
 * Match a robots.txt pattern against a path(+query) target.
 *
 * @param pattern - the robots pattern (`*` wildcard, optional `$` anchor).
 * @param target - the URL path plus query string.
 * @returns the pattern's length when it matches, else `undefined`.
 */
function matchPattern(pattern: string, target: string): number | undefined {
  if (pattern === '') return undefined
  let body = pattern
  let explicitEnd = false
  if (body.endsWith('$')) {
    body = body.slice(0, -1)
    explicitEnd = true
  }
  const escaped = body
    .replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    .replace(/\\\*/gu, '[^]*')
  // Robots patterns match from the start of the path; an explicit `$`
  // anchors the end, otherwise the pattern is a prefix match.
  const source = explicitEnd ? `^${escaped}$` : `^${escaped}`
  try {
    return new RegExp(source).test(target) ? pattern.length : undefined
  } catch {
    return undefined
  }
}
