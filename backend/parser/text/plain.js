import { readFile } from 'fs/promises'

export async function extractPlainText(filePath) {
  const buffer = await readFile(filePath, 'utf8')
  return typeof buffer === 'string' ? buffer : buffer.toString()
}
