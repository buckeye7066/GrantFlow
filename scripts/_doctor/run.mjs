import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

export function writeFile(filePath, content) {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, content, 'utf8')
}

export function runCommand(command, args, options = {}) {
  const { cwd, env, logFile, label = command, timeoutMs = 0 } = options

  return new Promise((resolve, reject) => {
    let timedOut = false
    let timeout = null

    const child = spawn(command, args, {
      cwd,
      env,
      shell: true,
      windowsHide: true,
    })

    let outStream = null
    if (logFile) {
      ensureDir(path.dirname(logFile))
      outStream = fs.createWriteStream(logFile, { flags: 'a' })
      outStream.write(`\n\n===== ${label} =====\n`)
    }

    const onData = (chunk) => {
      if (outStream) outStream.write(chunk)
      else process.stdout.write(chunk)
    }

    const onErr = (chunk) => {
      if (outStream) outStream.write(chunk)
      else process.stderr.write(chunk)
    }

    child.stdout.on('data', onData)
    child.stderr.on('data', onErr)

    if (timeoutMs && timeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true
        try {
          child.kill('SIGTERM')
        } catch {}
      }, timeoutMs)
    }

    child.on('error', (err) => {
      if (timeout) clearTimeout(timeout)
      if (outStream) outStream.end()
      reject(err)
    })

    child.on('close', (code, signal) => {
      if (timeout) clearTimeout(timeout)
      if (outStream) outStream.end()
      if (timedOut) {
        const error = new Error(`${label} timed out after ${timeoutMs}ms`)
        error.code = 'TIMEOUT'
        return reject(error)
      }
      resolve({ code, signal })
    })
  })
}

