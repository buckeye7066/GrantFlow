import { readFile } from 'fs/promises'
import mammoth from 'mammoth'

export async function extractDocxText(filePath) {
  const buffer = await readFile(filePath)
  const result = await mammoth.extractRawText({ buffer })
  return result.value || ''
}
