import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

test('managed UI quit closes unused connections while draining an active response', { timeout: 5000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'rerun-ui-host-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'server.js'), `
    const { createServer } = require('node:http')
    const server = createServer((req, res) => {
      res.setHeader('Content-Length', 4)
      if (req.url === '/hold') {
        res.write('one')
        const release = message => {
          if (message?.type !== 'release') return
          process.off('message', release)
          res.end('!')
        }
        process.on('message', release)
        return
      }
      res.end('done')
    })
    server.on('connection', () => process.send('accepted'))
    process.on('SIGTERM', () => {
      server.close(() => process.exit(143))
      process.send('stopping')
    })
    server.listen(Number(process.env.PORT), '127.0.0.1', () => process.send('ready'))
  `)
  const reservation = createServer().listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const { port } = reservation.address()
  await new Promise(resolve => reservation.close(resolve))
  const child = fork(new URL('../src/main/ui-host.mjs', import.meta.url), {
    env: { PORT: String(port), RERUN_DESKTOP_UI_ROOT: root, RERUN_DESKTOP_RUNTIME_FILE: join(root, 'runtime.json') },
  })
  const exited = once(child, 'exit')
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exited
  })
  assert.equal((await once(child, 'message'))[0], 'ready')

  async function openSocket() {
    const accepted = once(child, 'message')
    const socket = connect(port, '127.0.0.1')
    t.after(() => socket.destroy())
    await once(socket, 'connect')
    assert.equal((await accepted)[0], 'accepted')
    return socket
  }

  async function readThrough(socket, ending) {
    let result = ''
    while (!result.endsWith(ending)) result += (await once(socket, 'data'))[0].toString()
    return result
  }
  const idle = await openSocket()
  const partial = await openSocket()
  partial.write('GET / HTTP/1.1\r\n')

  const reused = await openSocket()
  const initialResponse = readThrough(reused, 'done')
  reused.write('GET / HTTP/1.1\r\nHost: localhost\r\n\r\n')
  assert.match(await initialResponse, /200 OK/)
  reused.write('GET / HTTP/1.1\r\n')

  const active = await openSocket()
  const firstChunk = readThrough(active, 'one')
  active.write('GET /hold HTTP/1.1\r\nHost: localhost\r\n\r\n')
  assert.match(await firstChunk, /200 OK/)

  const closed = Promise.all([idle, partial, reused].map(socket => once(socket, 'close')))
  const activeClosed = once(active, 'close')
  const stopping = once(child, 'message')
  child.send({ type: 'stop' })
  assert.equal((await stopping)[0], 'stopping')
  await closed
  assert.equal(active.destroyed, false)
  assert.equal(child.exitCode, null)

  const lastChunk = once(active, 'data')
  child.send({ type: 'release' })
  assert.equal((await lastChunk)[0].toString(), '!')
  await activeClosed
  assert.deepEqual(await exited, [143, null])
})
