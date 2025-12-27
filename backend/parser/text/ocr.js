import Tesseract from 'tesseract.js'

/**
 * Extract text from images using OCR
 */
export async function extractTextFromImage(buffer) {
  try {
    const worker = await Tesseract.createWorker('eng')
    
    const { data } = await worker.recognize(buffer)
    
    await worker.terminate()
    
    return {
      text: data.text,
      confidence: data.confidence,
      error: null,
    }
  } catch (error) {
    return {
      text: '',
      confidence: 0,
      error: error.message,
    }
  }
}

export default extractTextFromImage
