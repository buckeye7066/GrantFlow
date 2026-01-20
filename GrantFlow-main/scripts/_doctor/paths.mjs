import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function repoRoot() {
  const here = path.dirname(fileURLToPath(import.meta.url))
  // scripts/_doctor -> scripts -> repo root
  return path.resolve(here, '..', '..')
}

export function todayStamp(date = new Date()) {
  const yyyy = String(date.getFullYear())
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

export function artifactsDir(root, stamp) {
  return path.join(root, 'artifacts', 'local', stamp)
}
