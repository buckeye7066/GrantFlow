import { load } from 'cheerio'

function normalizeWhitespace(text) {
  return (text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

export function parseHtmlToText(html, { url } = {}) {
  const $ = load(html || '')

  // Remove common non-content
  $('script,noscript,style,nav,header,footer,svg,canvas,form,iframe').remove()

  const title = normalizeWhitespace($('title').first().text()) || 'Untitled'
  const h1 = normalizeWhitespace($('h1').first().text()) || ''
  const bodyText = normalizeWhitespace($('body').text())

  // Use a conservative cap to avoid gigantic rows in SQLite
  const lastSpace = bodyText.length > 200000 ? bodyText.lastIndexOf(' ', 200000) : -1
const extractedText = lastSpace > 0 ? bodyText.slice(0, lastSpace) : bodyText.length > 200000 ? bodyText.slice(0, 200000) : bodyText

  const links = []
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href')
    if (!href) return
    try {
      const abs = new URL(href, url).toString()
      links.push(abs)
    } catch (e) {
      console.warn(`Invalid URL in HTML parser: ${href} from ${url}`, e)
    }
  })

  return {
    contentType: 'text/html',
    title,
    h1,
    extractedText,
    links: Array.from(new Set(links)),
  }
}

