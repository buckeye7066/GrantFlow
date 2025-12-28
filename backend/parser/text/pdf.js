import { readFile } from 'fs/promises'
import pdfParse from 'pdf-parse'

export async function extractPdfText(filePath) {
  const data = await readFile(filePath)
  const result = await pdfParse(data)
  return result?.text ?? ''
}
