import { createWorker } from 'tesseract.js'

let workerPromise = null

async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const worker = await createWorker()
      await worker.loadLanguage('eng')
      await worker.initialize('eng')
      return worker
    })()
  }
  return workerPromise
}

export async function extractImageText(filePath) {
  const worker = await getWorker()
  const { data } = await worker.recognize(filePath)
  return data?.text ?? ''
}

export async function shutdownOcr() {
  if (workerPromise) {
    const worker = await workerPromise
    await worker.terminate()
    workerPromise = null
  }
}
