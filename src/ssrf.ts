/**
 * A minimal SSRF guard for fetch/render/crawl targets: resolve the hostname
 * and reject loopback, private, link-local, and unspecified addresses unless
 * the config allows them. Pre-navigation DNS check only (the same wave-1
 * scope as dsh-web-tools' browser guard).
 * @module pi-web-tools/ssrf
 */

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

/** True for addresses in loopback, private, link-local, or unspecified ranges. */
export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip)
  if (family === 4) {
    const parts = ip.split('.').map(Number)
    if (parts[0] === 0) return true
    if (parts[0] === 10) return true
    if (parts[0] === 127) return true
    if (parts[0] === 169 && parts[1] === 254) return true
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true
    if (parts[0] === 192 && parts[1] === 168) return true
    return false
  }
  if (family === 6) {
    const lower = ip.toLowerCase()
    if (lower === '::' || lower === '::1') return true
    if (lower.startsWith('fe80:')) return true
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(lower)
    if (mapped !== null && mapped[1] !== undefined) return isPrivateAddress(mapped[1])
    return false
  }
  return false
}

/**
 * Assert that `url` may be fetched under the private-network policy.
 *
 * @param url - the absolute URL to check.
 * @param allowPrivate - when true the check is skipped entirely.
 * @throws when the URL is invalid or resolves to a blocked address.
 */
export async function assertAddressAllowed(url: string, allowPrivate: boolean): Promise<void> {
  if (allowPrivate) return
  const host = new URL(url).hostname
  if (isIP(host) !== 0) {
    if (isPrivateAddress(host)) throw new Error(`blocked: ${host} is a private or loopback address`)
    return
  }
  const addresses = await lookup(host, { all: true })
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new Error(`blocked: ${host} resolves to a private or loopback address (${address})`)
    }
  }
}
