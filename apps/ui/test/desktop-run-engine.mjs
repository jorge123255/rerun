import { fork } from 'node:child_process'
import { createServer } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

/** @type {(index: number) => string} */
const defaultReply = () => 'A completed local run.'
/** @type {(index: number) => Array<{ id: string; name: string; input: unknown }>} */
const noToolCalls = () => []

/**
 * @param {string} dataRoot
 * @param {string} [appOrigin]
 * @param {{replyForRequest?: typeof defaultReply, initialReplyForRequest?: typeof defaultReply, toolCallsForRequest?: typeof noToolCalls, triggerCallback?: (request: Request) => Promise<Response>, emptyDocker?: boolean}} [options]
 */
export async function disposableRunEngine(dataRoot, appOrigin = 'http://127.0.0.1:3189', options = {}) {
    const { replyForRequest = defaultReply, initialReplyForRequest, toolCallsForRequest = noToolCalls, triggerCallback, emptyDocker } = options
    const apiKey = randomBytes(32).toString('hex')
    const encryptionKey = randomBytes(32).toString('hex')
    const runtimeFile = resolve(dataRoot, 'runtime.json')
    const engineRoot = resolve(dataRoot, 'workspaces/1/engine')
    const home = resolve(dataRoot, 'home')
    const installId = randomUUID()
    await Promise.all([mkdir(engineRoot, { recursive: true }), mkdir(home, { recursive: true })])
    await writeFile(resolve(engineRoot, 'desktop-owner.json'), JSON.stringify({ installId, workspaceId: 1 }), { mode: 0o600 })
    let child, runtime, releaseReply
    let output = ''
    let notifyProvider
    const providerStarted = new Promise(resolve => { notifyProvider = resolve })
    const providerMessages = []
    const providerModels = []
    const providerTools = []
    const waiting = []
    let coworkerCallEpoch
    const callbackPaths = new Set(['/api/webhooks/engine', '/api/desktop/internal/delegation', '/api/desktop/internal/mcp', '/api/desktop/internal/triggers'])
    const provider = createServer(async (req, res) => {
        if (req.method !== 'POST') return res.writeHead(404).end()
        if (callbackPaths.has(req.url)) {
            if (!runtime || req.headers.host !== new URL(appOrigin).host) return res.writeHead(403).end()
            if (req.headers.authorization !== `Bearer ${apiKey}`) return res.writeHead(401).end()
            const bytes = []
            let length = 0
            let body
            try {
                for await (const chunk of req.iterator({ destroyOnReturn: false })) {
                    length += chunk.length
                    if (length > 512_000) return res.writeHead(413).end()
                    bytes.push(chunk)
                }
                body = JSON.parse(Buffer.concat(bytes).toString('utf8'))
            } catch {
                return res.writeHead(400).end()
            }
            if (!body || typeof body !== 'object' || Array.isArray(body)) return res.writeHead(400).end()
            const acknowledge = result => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result))

            // Approval and question continuations prove the canonical conversation source
            // through the real trigger owner route, even when the conversation is ordinary chat.
            if (req.url === '/api/desktop/internal/triggers' && triggerCallback && body.event === 'desktop.trigger' && body.op === 'owner') {
                if (body.launchNonce !== runtime.launchNonce) return res.writeHead(409).end()
                const response = await triggerCallback(new Request(appOrigin + req.url, {
                    method: 'POST',
                    headers: { host: req.headers.host, authorization: req.headers.authorization, 'content-type': 'application/json' },
                    body: Buffer.concat(bytes),
                }))
                return res.writeHead(response.status, Object.fromEntries(response.headers)).end(Buffer.from(await response.arrayBuffer()))
            }

            // These chat fixtures own no coworker calls, delegations, schedules or MCP processes.
            // Acknowledge only the lifecycle operations the real engine needs for the empty stores.
            if (req.url === '/api/desktop/internal/mcp' && body.action === 'shutdown') {
                return acknowledge({ stopped: true })
            }
            if (req.url === '/api/webhooks/engine' && body.event === 'desktop.schedule.shutdown') {
                return acknowledge({ ok: true, persisted: true })
            }
            if (req.url === '/api/webhooks/engine' && body.event === 'desktop.coworker-call' && body.op === 'adopt-epoch') {
                if (body.launchNonce !== runtime.launchNonce) return res.writeHead(409).end()
                const { epoch, payload } = body
                if (typeof epoch !== 'string' || !epoch || payload?.epoch !== epoch || typeof payload?.now !== 'string') return res.writeHead(400).end()
                if (coworkerCallEpoch !== undefined && coworkerCallEpoch !== epoch) return res.writeHead(409).end()
                coworkerCallEpoch = epoch
                return acknowledge({ ok: true, result: true })
            }
            if (req.url === '/api/desktop/internal/delegation' && body.operation === 'record-list') {
                if (body.launchNonce !== runtime.launchNonce) return res.writeHead(409).end()
                if (!body.data || typeof body.data !== 'object' || Array.isArray(body.data) || Object.keys(body.data).length) return res.writeHead(400).end()
                return acknowledge({ result: [] })
            }
            return res.writeHead(404).end()
        }
        if (req.url !== '/v1/chat/completions') return res.writeHead(404).end()
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
        const initial = initialReplyForRequest?.(requestNumber)
        if (initial) chunk({ content: initial })
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
        coworkerCallEpoch = undefined
        runtime = { protocolVersion: /** @type {1} */ (1), launchNonce: randomUUID(), buildId: 'run-history-acceptance', workspaceId: /** @type {1} */ (1), dataRoot,
            app: { origin: appOrigin, sessionToken: randomBytes(32).toString('hex') }, engine: { origin: `http://127.0.0.1:${port}`, apiKey } }
        await writeFile(runtimeFile, JSON.stringify(runtime), { mode: 0o600 })
        const env = Object.fromEntries(['PATH', 'TMPDIR', 'LANG'].filter(k => process.env[k]).map(k => [k, process.env[k]]))
        // Root supplies the already built native helper for isolated filesystem
        // lease/recovery checks. No live profile or credentials enter this fixture.
        if (process.env.RERUN_DESKTOP_RENAME_HELPER) env.RERUN_DESKTOP_RENAME_HELPER = process.env.RERUN_DESKTOP_RENAME_HELPER
        Object.assign(env, { HOME: home, RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_SECRET_KEY: encryptionKey, RERUN_DESKTOP_RUNTIME_FILE: runtimeFile,
            RERUN_DATA_DIR: engineRoot, RERUN_PORT: String(port), RERUN_HOST: '127.0.0.1', RERUN_API_KEY: apiKey, RERUN_HUB_BASE_URL: appOrigin, RERUN_LOG_LEVEL: 'error' })
        output = ''
        const execArgv = emptyDocker ? ['--import', new URL('./desktop-empty-docker.mjs', import.meta.url).href] : []
        child = fork(engineEntry, ['desktop-run'], { execArgv, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
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
            const timer = setTimeout(() => { active.kill('SIGKILL'); reject(new Error(`Engine shutdown timed out: ${output}`)) }, 10000)
            active.once('exit', (code, signal) => {
                clearTimeout(timer)
                if (code === 0) resolve()
                else reject(new Error(`Engine shutdown code ${code}, signal ${signal}: ${output}`))
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
