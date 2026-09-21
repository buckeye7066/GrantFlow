// Funding APIs often return HTML. Render text, never insert source markup into
// the application's DOM. Parsing also decodes entities without double escaping.
export function sourceDescriptionText(value) {
  const source = String(value ?? '')
  if (typeof DOMParser === 'undefined') return source
  const spaced = source.replace(/<\/?(?:p|div|br|li|ul|ol|h[1-6]|tr|td)\b[^>]*>/gi, ' ')
  const document = new DOMParser().parseFromString(spaced, 'text/html')
  document.querySelectorAll('script,style,template,noscript,iframe,object').forEach(node => node.remove())
  return (document.body.textContent || '').replace(/\s+/g, ' ').trim()
}
