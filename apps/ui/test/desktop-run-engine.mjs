import { fork } from 'node:child_process'
import { createServer } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

/** @type {(index: number) => string} */
const defaultReply = () => 'A completed local run.'
/** @type {(index: number) => Array<{ id: string; name: string; input: unknown }>} */
const noToolCalls = () => []

export async function disposableRunEngine(dataRoot, appOrigin = 'http://127.0.0.1:3189', { replyForRequest = defaultReply, toolCallsForRequest = noToolCalls } = {}) {
    const apiKey = randomBytes(32).toString('hex')
    const encryptionKey = randomBytes(32).toString('hex')
    const runtimeFile = resolve(dataRoot, 'runtime.json')
    const engineRoot = resolve(dataRoot, 'workspaces/1/engine')
    const home = resolve(dataRoot, 'home')
    await Promise.all([mkdir(engineRoot, { recursive: true }), mkdir(home, { recursive: true })])
    let child, runtime, releaseReply
    let notifyProvider
    const providerStarted = new Promise(resolve => { notifyProvider = resolve })
    const providerMessages = []
    const providerModels = []
    const providerTools = []
    const waiting = []
    const provider = createServer(async (req, res) => {
        // This disposable callback server owns no MCP processes. The real engine
        // still requires an authenticated drain acknowledgement during shutdown.
        if (req.url === '/api/desktop/internal/mcp' && req.method === 'POST') {
            if (req.headers.authorization !== `Bearer ${apiKey}`) return res.writeHead(401).end()
            const bytes = []
            for await (const chunk of req) bytes.push(chunk)
            const body = JSON.parse(Buffer.concat(bytes))
            if (body.action !== 'shutdown') return res.writeHead(400).end()
            return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ stopped: true }))
        }
        if (req.url !== '/v1/chat/completions' || req.method !== 'POST') return res.writeHead(404).end()
        const body = []
        for await (const piece of req) body.push(piece)
        const payload = JSON.parse(Buffer.concat(body))
        providerMessages.push(payload.messages)
        providerModels.push(payload.model ?? null)
        providerTools.push(payload.tools ?? [])
        const requestNumber = providerMessages.length
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const chunk = (delta, finishReason = null, usage) => res.write(`data: ${JSON.stringify({ id: 'local-completion', object: 'chat.completion.chunk', created: 1, model: 'qa-local', choices: [{ index: 0, delta, finish_reason: finishReason }], ...(usage && { usage }) })}\n\n`)
        chunk({ role: 'assistant', content: '' })
        releaseReply = () => {
            releaseReply = undefined
            if (res.destroyed || res.writableEnded) return
            chunk({ content: replyForRequest(requestNumber) })
            const calls = toolCallsForRequest(requestNumber)
            if (calls.length) chunk({ tool_calls: calls.map((call, index) => ({ index, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) } })) })
            chunk({}, calls.length ? 'tool_calls' : 'stop', { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 })
            res.end('data: [DONE]\n\n')
        }
        notifyProvider()
        for (const item of waiting.filter(item => item.count <= providerMessages.length)) item.resolve()
    })
    await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))
    // Always use an owned ephemeral endpoint, never a fixed port another local
    // app may occupy. Existing callers' origin argument is retained for compatibility.
    appOrigin = `http://127.0.0.1:${provider.address().port}`
    const providerOrigin = `${appOrigin}/v1`
    const engineEntry = resolve(import.meta.dirname, '../../engine/dist/cli/bin.js')
    async function start() {
        const reservation = createServer()
        await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve))
        const port = reservation.address().port
        await new Promise(resolve => reservation.close(resolve))
        runtime = { protocolVersion: /** @type {1} */ (1), launchNonce: randomUUID(), buildId: 'run-history-acceptance', workspaceId: /** @type {1} */ (1), dataRoot,
            app: { origin: appOrigin, sessionToken: randomBytes(32).toString('hex') }, engine: { origin: `http://127.0.0.1:${port}`, apiKey } }
        await writeFile(runtimeFile, JSON.stringify(runtime), { mode: 0o600 })
        const env = Object.fromEntries(['PATH', 'TMPDIR', 'LANG'].filter(k => process.env[k]).map(k => [k, process.env[k]]))
        // Root supplies the already built native helper for isolated filesystem
        // lease/recovery checks. No live profile or credentials enter this fixture.
        if (process.env.RERUN_DESKTOP_RENAME_HELPER) env.RERUN_DESKTOP_RENAME_HELPER = process.env.RERUN_DESKTOP_RENAME_HELPER
        Object.assign(env, { HOME: home, RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_SECRET_KEY: encryptionKey, RERUN_DESKTOP_RUNTIME_FILE: runtimeFile,
            RERUN_DATA_DIR: engineRoot, RERUN_PORT: String(port), RERUN_HOST: '127.0.0.1', RERUN_API_KEY: apiKey, RERUN_HUB_BASE_URL: appOrigin, RERUN_LOG_LEVEL: 'error' })
        let output = ''
        child = fork(engineEntry, ['desktop-run'], { execArgv: [], env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
        for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk.toString()).slice(-8000) })
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`Engine startup timed out: ${output}`)) }, 20000)
            child.once('error', error => { clearTimeout(timer); reject(error) })
            child.once('exit', code => { clearTimeout(timer); reject(new Error(`Engine exited ${code}: ${output}`)) })
            child.on('message', message => { if (message.type === 'ready') { clearTimeout(timer); resolve() } })
        })
        await writeFile(resolve(dataRoot, 'engine-startup.log'), output)
        return runtime
    }
    async function stop() {
        if (!child || child.exitCode !== null) return
        const active = child
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => { active.kill('SIGKILL'); reject(new Error('Engine shutdown timed out')) }, 10000)
            active.once('exit', code => {
                clearTimeout(timer)
                if (code === 0) resolve()
                else reject(new Error(`Engine shutdown code ${code}`))
            })
            active.send({ type: 'stop' })
        })
    }
    return { start, stop, providerOrigin, providerStarted, providerMessages, providerModels, providerTools,
        waitForProviderRequest: count => providerMessages.length >= count ? Promise.resolve() : new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`Local provider request ${count} did not arrive`)), 10000)
            waiting.push({ count, resolve: () => { clearTimeout(timer); resolve() } })
        }),
        finishReply: () => releaseReply?.(), get runtime() { return runtime },
        async close() {
            try { releaseReply?.(); await stop() }
            finally { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)) }
        } }
}
