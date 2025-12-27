import mammoth from 'mammoth'

/**
 * Extract text from DOCX files
 */
export async function extractTextFromDocx(buffer) {
  try {
    const result = await mammoth.extractRawText({ buffer })
    return {
      text: result.value,
      error: null,
    }
  } catch (error) {
    return {
      text: '',
      error: error.message,
    }
  }
}

export default extractTextFromDocx
