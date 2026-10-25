/**
 * The shared HTML→markdown converter for fetched and rendered pages:
 * turndown with GitHub-flavored tables/strikethrough
 * (`@joplin/turndown-plugin-gfm`). The style options are fixed model-facing
 * presentation, not deployment tunables. The `remove` rule drops
 * non-content elements wholesale — turndown's default keeps their text.
 * The instance is stateless across `turndown()` calls and safe to share.
 *
 * Ported from `@deepseek-ai/dsh-web-tools` (MIT).
 * @module pi-web-tools/markdown
 */

import { gfm } from '@joplin/turndown-plugin-gfm'
import TurndownService from 'turndown'

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
})
turndown.use(gfm)
// Turndown 7's default `li` rule pads the marker with three spaces
// (`-   item`); the model-facing convention is a single space.
turndown.addRule('listItem', {
  filter: 'li',
  replacement(content, node, options) {
    const parent = node.parentNode
    let prefix: string
    if (parent !== null && parent.nodeName === 'OL' && parent instanceof Element) {
      const start = parent.getAttribute('start')
      const index = Array.prototype.indexOf.call(parent.children, node)
      prefix = `${start !== null && start !== '' ? Number(start) + index : index + 1}.`
    } else {
      prefix = options.bulletListMarker ?? '-'
    }
    const isParagraph = /\n$/u.test(content)
    const body = content.replace(/^\n+|\n+$/gu, '') + (isParagraph ? '\n' : '')
    const indented = body.replace(/\n/gu, `\n${' '.repeat(prefix.length + 1)}`)
    return `${prefix} ${indented}${node.nextSibling !== null ? '\n' : ''}`
  },
})
turndown.addRule('removeNonVisibleContent', {
  filter(node) {
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED', 'NAV', 'HEADER', 'FOOTER', 'ASIDE'].includes(node.nodeName)) return true
    if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden')?.toLowerCase() === 'true') return true
    if (node.nodeName === 'INPUT' && node.getAttribute('type')?.toLowerCase() === 'hidden') return true
    const declarations = node.getAttribute('style')?.split(';') ?? []
    return declarations.some(declaration => {
      const separator = declaration.indexOf(':')
      if (separator === -1) return false
      const property = declaration.slice(0, separator).trim().toLowerCase()
      const value = declaration.slice(separator + 1).trim().toLowerCase().replace(/\s*!important\s*$/u, '')
      return (property === 'display' && value === 'none')
        || (property === 'visibility' && (value === 'hidden' || value === 'collapse'))
    })
  },
  replacement() {
    return ''
  },
})

/**
 * Convert HTML to model-facing markdown.
 *
 * @param html - the HTML to convert.
 * @returns the markdown text.
 */
export function htmlToMarkdown(html: string): string {
  return turndown.turndown(html)
}

/**
 * Extract a page title from HTML (the first `<title>` element's text).
 *
 * @param html - the HTML to scan.
 * @returns the trimmed title text, or `''` when absent.
 */
export function extractTitle(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/iu.exec(html)
  return match?.[1]?.replace(/\s+/gu, ' ').trim() ?? ''
}
