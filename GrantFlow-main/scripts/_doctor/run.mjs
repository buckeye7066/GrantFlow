import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

export function ensureDir(dirPath) {
  if (!dirPath) return
  fs.mkdirSync(dirPath, { recursive: true })
}

export function writeFile(filePath, contents) {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, contents, 'utf8')
}

export function runCommand(command, args = [], { cwd, env, logFile, label, timeoutMs } = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const child = spawn(command, args, {
      cwd,
      env,
      shell: true,
      windowsHide: true,
    })

    let timeout = null
    if (timeoutMs && Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timeout = setTimeout(() => {
        try { child.kill('SIGTERM') } catch {}
      }, timeoutMs)
    }

    let stream = null
    if (logFile) {
      ensureDir(path.dirname(logFile))
      stream = fs.createWriteStream(logFile, { flags: 'a' })
      stream.write(
        `\n\n===== ${label || command} =====\n` +
          `cwd=${cwd || process.cwd()}\n` +
          `cmd=${command} ${args.join(' ')}\n` +
          `startedAt=${new Date(startedAt).toISOString()}\n`,
      )
      child.stdout.pipe(stream, { end: false })
      child.stderr.pipe(stream, { end: false })
    }

    child.on('close', (code, signal) => {
      if (timeout) clearTimeout(timeout)
      if (stream) {
        stream.write(
          `\n----- finished: ${label || command} -----\n` +
            `exitCode=${code}\n` +
            `signal=${signal || ''}\n` +
            `durationMs=${Date.now() - startedAt}\n`,
        )
        try { stream.end() } catch {}
      }
      resolve({ code, signal })
    })
  })
}

