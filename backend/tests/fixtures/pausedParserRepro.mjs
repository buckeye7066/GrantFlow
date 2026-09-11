// Child-process fixture for fetchGlobalsInstall.test.js. Reproduces
// nodejs/undici#5360: a response body that is never read pauses the HTTP/1
// parser, and the server's FIN then reaches parser.finish() while paused. On
// Node's bundled undici 7.29.0 (Linux) that kills the process.
//
// Every stage is printed, and a guard exits 2 naming the last stage reached,
// so a stall is reported as a stall instead of a bare child timeout.
import '../../installFetchGlobals.js'
import { createServer } from 'node:net'
import { fetch as undiciFetch } from 'undici'

const started = Date.now()
let lastStage = 'start'
const stage = (name) => {
  lastStage = name
  console.log(`stage=${name} ms=${Date.now() - started}`)
}

console.log(`installed=${globalThis.fetch === undiciFetch}`)

const guard = setTimeout(() => {
  console.log(`stalled after stage=${lastStage}`)
  process.exit(2)
}, 20_000)

const BODY = Buffer.alloc(64 * 1024, 0x61)
const server = createServer((socket) => {
  socket.once('data', () => {
    stage('server_received_request')
    socket.write(`HTTP/1.1 200 OK\r\nContent-Length: ${BODY.length}\r\nConnection: close\r\n\r\n`)
    socket.write(BODY)
    socket.end()
    stage('server_sent_fin')
  })
})

server.listen(0, '127.0.0.1', async () => {
  const { port } = server.address()
  stage('fetch_started')
  const response = await fetch(`http://127.0.0.1:${port}/`)
  stage(`fetch_resolved_${response.status}`)
  void response
  await new Promise((resolve) => setTimeout(resolve, 1000))
  console.log('no crash')
  // The unread response keeps its socket open until the server side times out;
  // the parser has already survived the FIN, so end the child here.
  clearTimeout(guard)
  server.close()
  process.exit(0)
})
