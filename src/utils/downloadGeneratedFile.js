export function downloadGeneratedFile(file) {
  const content = String(file?.content ?? '')
  const name = String(file?.name || 'grantflow-export.txt').replace(/[\\/]+/g, '-')
  const mediaType = String(file?.media_type || 'text/plain')
  const blob = new Blob([content], { type: `${mediaType};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}
