// Non-conflicting port allocation. We NEVER kill an unknown process to obtain a
// port — if a candidate port is busy we move to the next free one. A bound app
// we didn't start is left strictly alone.
import net from 'node:net'

// Probe a single port for availability by attempting to listen on it.
function tryListen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => srv.close(() => resolve(true)))
    srv.listen(port, host)
  })
}

/**
 * Find `count` free ports starting at `base`. Skips any busy port (never kills
 * its owner). Throws only if the whole scan window is exhausted.
 */
export async function allocatePorts(count = 1, { base = 34000, windowSize = 500, host = '127.0.0.1' } = {}) {
  const found = []
  for (let p = base; p < base + windowSize && found.length < count; p++) {
    // eslint-disable-next-line no-await-in-loop
    if (await tryListen(p, host)) found.push(p)
  }
  if (found.length < count) throw new Error(`could not allocate ${count} free ports in [${base}, ${base + windowSize})`)
  return found
}
