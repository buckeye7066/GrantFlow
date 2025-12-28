import pdfParse from 'pdf-parse'

/**
 * Extract text from PDF files
 */
export async function extractTextFromPdf(buffer) {
  try {
    const data = await pdfParse(buffer)
    return {
      text: data.text,
      pages: data.numpages,
      error: null,
    }
  } catch (error) {
    return {
      text: '',
      pages: 0,
      error: error.message,
    }
  }
}

export default extractTextFromPdf
import { readFile } from 'fs/promises'
import pdfParse from 'pdf-parse'

export async function extractPdfText(filePath) {
  const data = await readFile(filePath)
  const result = await pdfParse(data)
  return result?.text ?? ''
}
