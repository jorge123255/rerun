import { subscribe } from 'node:diagnostics_channel'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.env.RERUN_DESKTOP_UI_ROOT
if (!root || !process.send || !process.env.RERUN_DESKTOP_RUNTIME_FILE) throw new Error('UI host requires a managed desktop launch')
const port = Number(process.env.PORT)
const requestsBySocket = new Map()
const observedServers = new WeakSet()
let stopping = false

// Next drains its HTTP server on SIGTERM. Node's idle sweep can miss sockets
// that have connected but have not submitted a complete request.
subscribe('net.server.socket', ({ socket }) => {
  if (socket.localAddress !== '127.0.0.1' || socket.localPort !== port) return
  if (stopping) {
    socket.destroySoon()
    return
  }
  const server = socket.server
  if (!observedServers.has(server)) {
    observedServers.add(server)
    for (const event of ['upgrade', 'connect']) {
      // Leave upgraded connections with their existing protocol handler.
      if (server.listenerCount(event)) {
        server.prependListener(event, (_request, upgradedSocket) => requestsBySocket.delete(upgradedSocket))
      }
    }
  }
  requestsBySocket.set(socket, 0)
  socket.once('close', () => requestsBySocket.delete(socket))
})

subscribe('http.server.request.start', ({ response, socket }) => {
  const pending = requestsBySocket.get(socket)
  if (pending === undefined) return
  requestsBySocket.set(socket, pending + 1)
  const settle = () => {
    response.off('finish', settle)
    response.off('close', settle)
    const remaining = requestsBySocket.get(socket)
    if (remaining === undefined) return
    requestsBySocket.set(socket, remaining - 1)
    if (stopping && remaining === 1) socket.destroySoon()
  }
  response.once('finish', settle)
  response.once('close', settle)
})

const stop = () => {
  if (stopping) return
  stopping = true
  process.kill(process.pid, 'SIGTERM')
  for (const [socket, pending] of requestsBySocket) {
    if (pending === 0) socket.destroySoon()
  }
}
process.once('disconnect', stop)
process.on('message', message => { if (message?.type === 'stop') stop() })
process.chdir(root)
await import(pathToFileURL(resolve(root, 'server.js')).href)
