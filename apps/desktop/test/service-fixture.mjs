import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'

const runtime = JSON.parse(await readFile(process.env.RERUN_DESKTOP_RUNTIME_FILE, 'utf8'))
const engine = process.env.FIXTURE_KIND === 'engine'
const origin = engine ? runtime.engine.origin : runtime.app.origin
const server = createServer((request, response) => {
    const auth = engine ? request.headers.authorization === `Bearer ${runtime.engine.apiKey}` : request.headers.cookie === `rerun-desktop-session=${runtime.app.sessionToken}`
    response.setHeader('Content-Type', 'application/json')
    response.statusCode = auth ? 200 : 401
    response.end(JSON.stringify(auth ? { status: 'ready', protocolVersion: 1, launchNonce: process.env.FIXTURE_BAD_NONCE ? 'wrong-nonce' : runtime.launchNonce, buildId: runtime.buildId, workspaceId: 1 } : { error: 'Unauthorized' }))
})
server.listen(Number(new URL(origin).port), '127.0.0.1', () => {
    if (engine) process.send?.({ type: 'ready', protocolVersion: 1, launchNonce: runtime.launchNonce, buildId: runtime.buildId })
})
const stop = () => server.close(() => process.exit(0))
process.on('message', message => { if (message?.type === 'stop') stop() })
process.on('disconnect', stop)
