import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function repoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
}

export function todayStamp(date = new Date()) {
  const yyyy = String(date.getFullYear())
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

export function artifactsDir(root, stamp = todayStamp()) {
  return path.join(root, 'artifacts', stamp)
}

