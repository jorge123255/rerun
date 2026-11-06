import { spawn as nodeSpawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'

const MAX_PROBE_CHARS = 64_000
const STOP_GRACE_MS = 5_000

function assertHome(homeDir) {
    if (typeof homeDir !== 'string' || !homeDir.startsWith('/') || homeDir.includes('\0') || homeDir.includes('/../') throw new Error('An application-managed Claude home is required.')
}

export function createFileClaudePlanCredentialCustody(homeDir) {
    assertHome(homeDir)
    const file = join(homeDir, 'credentials.json')
    return {
        async load() {
            try {
                const value = JSON.parse(await readFile(file, 'utf8'))
                if (typeof value.accessToken !== 'string' || !value.accessToken) return null
                return value
            } catch { return null }
        },
        async save(agentId, credential) {
            if (typeof credential.accessToken !== 'string' || !credential.accessToken) throw new Error('Claude credential is invalid')
            await mkdir(dirname(file), { recursive: true, mode: 0o700 })
            const temp = `${file}.tmp`
            await writeFile(temp, JSON.stringify(credential), { mode: 0o600 })
            await chmod(temp, 0o600)
            await rename(temp, file)
            return { revision: createHash('sha256').update(JSON.stringify(credential)).digest('hex') }
        },
        async clear() { await rm(file, { force: true }) },
    }
}

function streamOf(child) {
    const chunks = []
    return { async *[Symbol.asyncIterator]() {
        for await (const chunk of child.stdout) chunks.push(chunk)
    }, text: async () => Buffer.concat(chunks).toString('utf8').slice(0, MAX_PROBE_CHARS) }
}

function publicError(error) {
    const message = (error instanceof Error ? error.message : String(error)).replace(/[^\x20-\x7e]/g, '')
    if (/https?:\/\/|\/Users|token|secret|credential|bearer/i.test(message)) return 'Claude runner failed.'
    return message.slice(0, 500) || 'Claude runner failed.'
}

function eventOf(value) {
    if (!value || typeof value !== 'object') return null
    const type = value.type
    if (type === 'text' || type === 'text-delta') return { type: 'text-delta', text: String(value.text ?? value.delta ?? '') }
    if (type === 'reasoning' || type === 'reasoning-delta') return { type: 'reasoning-delta', text: String(value.text ?? value.delta ?? '') }
    if (type === 'assistant' && value.message && typeof value.message === 'object') {
        const content = Array.isArray(value.message.content) ? value.message.content : []
        return content.flatMap(block => {
            if (block.type === 'text') return [{ type: 'text-delta', text: String(block.text ?? '') }]
            if (block.type === 'thinking') return [{ type: 'reasoning-delta', text: String(block.thinking ?? block.text ?? '') }]
            return []
        })
    }
    if (type === 'tool_call' || type === 'tool-call') {
        const toolCallId = String(value.toolCallId ?? value.id ?? value.tool_call_id ?? '')
        const toolName = String(value.toolName ?? value.name ?? '')
        return toolCallId && toolName ? { type: 'tool-call', toolCallId, toolName, input: value.input ?? value.args } : null
    }
    if (type === 'tool_result' || type === 'tool-result') {
        const toolCallId = String(value.toolCallId ?? value.id ?? value.tool_call_id ?? '')
        return toolCallId ? { type: 'tool-result', toolCallId, output: value.output ?? value.result, ...(value.isError === undefined ? {} : { isError: !!value.isError }) } : null
    }
    if (type === 'source' && typeof value.url === 'string') return { type: 'source', url: value.url, ...(value.title === undefined ? {} : { title: String(value.title) }) }
    if (type === 'usage') return { type: 'usage', usedTokens: Number(value.usedTokens ?? value.totalTokens ?? 0), ...(value.maxTokens === undefined ? {} : { maxTokens: Number(value.maxTokens) }) }
    if (type === 'error') return { type: 'error', message: publicError(value.message ?? value.error ?? 'Claude stream failed.') }
    if (type === 'result' || type === 'finish') return { type: 'finish', finishReason: value.finishReason ?? value.finish_reason ?? 'stop' }
    return null
}

export function createClaudePlanProcessAdapter({ command, argsForChat, homeDir, credentialCustody, spawn = nodeSpawn, stopGraceMs = STOP_GRACE_MS }) {
    if (typeof command !== 'string' || !command.startsWith('/') throw new Error('An absolute Claude runner path is required.')
    if (typeof argsForChat !== 'function') throw new Error('Claude chat argv mapping is required.')
    if (!credentialCustody || typeof credentialCustody.load !== 'function') throw new Error('Claude credential custody is required.')
    assertHome(homeDir)
    const children = new Map()

    async function probe(signal) {
        let child
        try {
            child = spawn(command, ['--version'], { cwd: homeDir, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] })
            const output = streamOf(child)
            const timer = setTimeout(() => child.kill('SIGTERM'), 30_000)
            try {
                const text = await output.text()
                const version = text.split('\n').find(line => line.trim())?.trim()
                if (!version) return { state: 'unavailable', message: 'Claude CLI did not return a version.', retryable: true }
                return { state: 'ready', message: 'Claude CLI is available.', retryable: false, cliVersion: version.slice(0, 100) }
            } finally { clearTimeout(timer) }
        } catch (error) {
            return { state: 'unavailable', message: publicError(error), retryable: true }
        } finally { child?.kill('SIGTERM') }
    }

    async function stop(identity) {
        const child = children.get(identity.toolCallId)
        if (!child) return
        children.delete(identity.toolCallId)
        if (child.exitCode !== null || child.signalCode !== null) return
        const exited = new Promise(resolve => child.once('exit', resolve))
        try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
        const timer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
                try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
            }
        }, stopGraceMs)
        try { await exited } finally { clearTimeout(timer) }
    }

    async function* dispatch(identity, input, signal) {
        const credential = await credentialCustody.load(identity.agentId)
        if (!credential?.accessToken) throw new Error('Claude credential is not configured.')
        const env = {
            ...process.env,
            CLAUDE_CODE_OAUTH_TOKEN: credential.accessToken,
            ...(credential.refreshToken ? { CLAUDE_CODE_OAUTH_REFRESH_TOKEN: credential.refreshToken } : {}),
            ...(credential.expiresAt === undefined ? {} : { CLAUDE_CODE_OAUTH_EXPIRES_AT: String(credential.expiresAt) }),
        }
        const child = spawn(command, argsForChat(identity, input), { cwd: homeDir, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
        children.set(identity.toolCallId, child)
        const abort = () => { void stop(identity) }
        signal.addEventListener('abort', abort, { once: true })
        try {
            const lines = createInterface({ input: child.stdout })
            try {
                for await (const line of lines) {
                    if (signal.aborted) break
                    let value
                    try { value = JSON.parse(line) } catch { continue }
                    const events = eventOf(value)
                    if (events) for (const event of events) yield event
                }
            } finally { lines.close() }
            const [code, exitSignal] = await new Promise(resolve => {
                if (child.exitCode !== null || child.signalCode !== null) return resolve([child.exitCode, child.signalCode])
                child.once('exit', (exitCode, signalCode) => resolve([exitCode, signalCode]))
            })
            if (signal.aborted) yield { type: 'finish', finishReason: 'cancelled' }
            else if (code !== 0 || exitSignal) yield { type: 'error', message: 'Claude runner exited before completing the response.' }
            else yield { type: 'finish', finishReason: 'stop' }
        } finally {
            signal.removeEventListener('abort', abort)
            children.delete(identity.toolCallId)
        }
    }

    return { probe, dispatch, stop }
}
