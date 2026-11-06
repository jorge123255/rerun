import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { createClaudePlanProcessAdapter, createFileClaudePlanCredentialCustody } from './claude-plan.mjs'

const identity = { agentId: 'agent', sessionId: 'session', runId: 'run', toolCallId: 'tool', credentialRevision: '1' }
const input = { message: 'Hello', model: 'claude-sonnet-4-6', thinking: 'adaptive' }

function child(pid = 42) {
    const value = new EventEmitter()
    value.pid = pid
    value.exitCode = null
    value.signalCode = null
    value.stdout = new PassThrough()
    value.stderr = new PassThrough()
    value.kills = []
    value.kill = signal => { value.kills.push(signal); return true }
    return value
}

test('file custody persists only inside the application-managed home', async () => {
    const home = await mkdtemp(join(tmpdir(), 'claude-plan-'))
    const custody = createFileClaudePlanCredentialCustody(home)
    await custody.save('agent', { accessToken: 'access', refreshToken: 'refresh', expiresAt: 1000 })
    expect((await custody.load('agent')).accessToken).toBe('access')
    expect(JSON.parse(await readFile(join(home, 'credentials.json'), 'utf8')).refreshToken).toBe('refresh')
    await custody.clear('agent')
    expect(await custody.load('agent')).toBeNull()
    await rm(home, { recursive: true, force: true })
})

test('process adapter probes the real CLI and maps JSONL with explicit credential loading', async () => {
    const spawned = []
    const spawn = (command, args, options) => {
        const value = child()
        spawned.push({ command, args, options, child: value })
        queueMicrotask(() => {
            value.stdout.end(`${JSON.stringify({ type: 'text-delta', text: 'Hello' })}\n${JSON.stringify({ type: 'tool-call', toolCallId: 'call', toolName: 'fs_read', input: { path: 'a.md' } })}\n${JSON.stringify({ type: 'finish', finishReason: 'stop' })}\n`)
            value.emit('exit', 0, null)
        })
        return value
    }
    const custody = { load: async () => ({ accessToken: 'access', refreshToken: 'refresh', expiresAt: 1000 }), save: async () => ({ revision: '1' }), clear: async () => {} }
    const adapter = createClaudePlanProcessAdapter({ command: '/usr/bin/claude', argsForChat: () => ['--print'], homeDir: '/fixture/claude-home', credentialCustody: custody, spawn })
    const availability = await adapter.probe(new AbortController().signal)
    expect(availability.state).toBe('ready')
    const events = []
    for await (const event of adapter.dispatch(identity, input, new AbortController().signal)) events.push(event)
    expect(events.map(event => event.type)).toEqual(['text-delta', 'tool-call', 'finish'])
    expect(spawned[1].options.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('access')
    expect(spawned[1].options.env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN).toBe('refresh')
    expect(spawned[1].options.detached).toBe(true)
})

test('stop terminates only the exact owned process group', async () => {
    const value = child(77)
    const spawn = () => value
    const originalKill = process.kill
    const groups = []
    process.kill = (pid, signal) => {
        groups.push([pid, signal])
        queueMicrotask(() => value.emit('exit', 0, 'SIGTERM'))
        return true
    }
    try {
        const adapter = createClaudePlanProcessAdapter({ command: '/usr/bin/claude', argsForChat: () => ['--print'], homeDir: '/fixture/claude-home', credentialCustody: { load: async () => ({ accessToken: 'access' }) }, spawn, stopGraceMs: 1 })
        const pending = adapter.dispatch(identity, input, new AbortController().signal)
        await pending.next()
        await adapter.stop(identity)
        expect(groups).toContainEqual([-77, 'SIGTERM'])
    } finally { process.kill = originalKill }
})
