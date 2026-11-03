import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID, createCipheriv } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { candidatePort } from '../src/main/supervisor.mjs'

const root = await mkdtemp(join(tmpdir(), 'rerun-real-engine-'))
const engineRoot = join(root, 'workspaces/1/engine')
await mkdir(engineRoot, { recursive: true })
const probePath = join(root, 'unexpected-cli-probe')
const harmlessCli = join(root, 'harmless-cli')
await writeFile(harmlessCli, '#!/bin/sh\n/usr/bin/touch "$HOME/unexpected-cli-probe"\nexit 0\n', { mode: 0o700 })
let providerCalls = 0
const hub = createServer(async (request, response) => {
    if (request.url === '/chat/completions') {
        let text = ''
        for await (const chunk of request) text += chunk
        const body = JSON.parse(text)
        assert.equal(body.tools?.length ?? 0, 0, 'desktop preview must not expose tools to the model')
        providerCalls++
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const part = { id: 'synthetic-chat', object: 'chat.completion.chunk', created: 1, model: body.model }
        response.write(`data: ${JSON.stringify({ ...part, choices: [{ index: 0, delta: { role: 'assistant', content: 'Synthetic desktop reply.' }, finish_reason: null }] })}\n\n`)
        response.write(`data: ${JSON.stringify({ ...part, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`)
        response.end('data: [DONE]\n\n')
    } else {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ ok: true }))
    }
})
hub.listen(0, '127.0.0.1')
await once(hub, 'listening')
const hubOrigin = `http://127.0.0.1:${hub.address().port}`
const apiKey = randomBytes(32).toString('hex')
const encryptionKey = randomBytes(32).toString('hex')
let child
let runtime
let stderr = ''
async function start() {
    runtime = { protocolVersion: 1, launchNonce: randomUUID(), buildId: 'synthetic-smoke', workspaceId: 1, dataRoot: root, app: { origin: hubOrigin, sessionToken: randomBytes(32).toString('hex') }, engine: { origin: `http://127.0.0.1:${await candidatePort()}`, apiKey } }
    await writeFile(join(root, 'runtime.json'), JSON.stringify(runtime), { mode: 0o600 })
    child = spawn(process.execPath, [fileURLToPath(new URL('../../engine/dist/cli/bin.js', import.meta.url)), 'desktop-run'], {
        env: { HOME: root, PATH: '/usr/bin:/bin', NODE_ENV: 'test', RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_RUNTIME_FILE: join(root, 'runtime.json'), RERUN_DATA_DIR: engineRoot, RERUN_HOST: '127.0.0.1', RERUN_PORT: new URL(runtime.engine.origin).port, RERUN_API_KEY: apiKey, RERUN_HUB_BASE_URL: hubOrigin, RERUN_DESKTOP_SECRET_KEY: encryptionKey, RERUN_DESKTOP: 'off', RERUN_CODEX_PATH: harmlessCli },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    child.stdout.resume()
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-3000) })
    await new Promise((done, fail) => {
        const timer = setTimeout(() => fail(new Error('Engine startup deadline exceeded')), 15000)
        child.once('exit', code => { clearTimeout(timer); fail(new Error(`Engine exited ${code}: ${stderr}`)) })
        child.on('message', message => {
            if (message.type === 'ready' && message.launchNonce === runtime.launchNonce) { clearTimeout(timer); done() }
        })
    })
}
async function request(path, options = {}) {
    return fetch(runtime.engine.origin + path, { ...options, headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...options.headers }, signal: AbortSignal.timeout(15000) })
}
async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    const exited = once(child, 'exit')
    child.send({ type: 'stop' })
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000)
    const [code] = await exited
    clearTimeout(timer)
    assert.equal(code, 0, stderr)
}
try {
    await start()
    assert.equal((await fetch(runtime.engine.origin + '/health')).status, 401)
    assert.equal((await request('/health', { headers: { Authorization: `Bearer ${'f'.repeat(64)}` } })).status, 401)
    assert.equal((await request('/shared/files')).status, 403)
    assert.equal((await request('/agents/import', { method: 'POST', body: '{}' })).status, 403)
    assert.equal((await request('/agents/example/schedules')).status, 403)
    const connectionResponse = await request('/connections', { method: 'POST', body: JSON.stringify({ name: 'Synthetic fixture', provider: 'openrouter', models: ['openai/gpt-4o-mini'], baseUrl: hubOrigin, keys: { OPENROUTER_API_KEY: 'example-synthetic-provider-key' } }) })
    assert.equal(connectionResponse.status, 201, await connectionResponse.clone().text())
    const connection = await connectionResponse.json()
    const rejected = await request('/connections', { method: 'POST', body: JSON.stringify({ name: 'Disallowed CLI', provider: 'codex', keys: { CODEX_OAUTH_TOKEN: 'example-cli-token' } }) })
    assert.equal(rejected.status, 400)
    const legacyId = 'legacy-codex'
    const legacyRoot = join(engineRoot, 'connections', legacyId)
    await mkdir(legacyRoot)
    const config = JSON.parse(await readFile(join(engineRoot, 'connections', connection.id, 'connection.json'), 'utf8'))
    await writeFile(join(legacyRoot, 'connection.json'), JSON.stringify({ ...config, name: 'Legacy CLI', provider: 'codex', models: ['gpt-6.1-sol'] }))
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(encryptionKey, 'hex'), iv)
    const ciphertext = Buffer.concat([cipher.update('CODEX_OAUTH_TOKEN=example-cli-token'), cipher.final()])
    await writeFile(join(legacyRoot, '.env'), 'RERUN-DESKTOP-ENV-1\n' + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64'), { mode: 0o600 })
    const listed = await (await request('/connections')).json()
    assert(!listed.connections.some(item => item.id === legacyId))
    assert.equal((await request('/connections/default', { method: 'PUT', body: JSON.stringify({ connectionId: legacyId, model: 'gpt-6.1-sol' }) })).status, 400)
    assert.equal((await request(`/connections/${legacyId}/keys`, { method: 'PATCH', body: JSON.stringify({ set: { CODEX_OAUTH_TOKEN: 'example-replacement' } }) })).status, 400)
    await assert.rejects(access(join(legacyRoot, '.codex/auth.json')))
    const created = await request('/agents', { method: 'POST', body: JSON.stringify({ config: { name: 'smoke-coworker', connectionId: connection.id, model: 'openai/gpt-4o-mini', setup: { required: false }, selfImprovement: { enabled: false, autoMemory: false }, tools: { shell: true, browser: true } }, soul: 'Reply briefly.' }) })
    assert.equal(created.status, 201, await created.clone().text())
    const agent = await created.json()
    const chat = await request(`/agents/${agent.id}/chat`, { method: 'POST', body: JSON.stringify({ message: 'This is a synthetic local test.' }) })
    assert.equal(chat.status, 200, await chat.clone().text())
    const sessionId = chat.headers.get('x-session-id')
    assert(sessionId)
    assert.match(await chat.text(), /Synthetic desktop reply/)
    assert(providerCalls >= 1)
    const file = await readFile(join(engineRoot, 'connections', connection.id, '.env'), 'utf8')
    assert(!file.includes('example-synthetic-provider-key'))
    await stop()
    await start()
    const history = await request(`/agents/${agent.id}/sessions/${sessionId}/messages`)
    assert.equal(history.status, 200)
    assert.match(await history.text(), /Synthetic desktop reply/)
    await assert.rejects(access(join(legacyRoot, '.codex/auth.json')))
    await assert.rejects(access(probePath))
    console.log(JSON.stringify({ result: 'PASS', checks: ['real-engine-startup', 'authenticated-health', 'blocked-tools-and-schedules', 'rejected-cli-creation-and-legacy-default-update', 'no-legacy-cli-probe-auth-export', 'synthetic-provider-stream', 'encrypted-provider-key', 'history-after-restart', 'graceful-quit'], externalProviderCalls: 0 }))
} finally {
    await stop()
    await new Promise(done => hub.close(done))
    await rm(root, { recursive: true, force: true })
}
