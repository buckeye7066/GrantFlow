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
