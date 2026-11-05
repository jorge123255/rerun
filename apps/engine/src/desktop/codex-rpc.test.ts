import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, expect, test, vi } from 'vitest'

const workers = vi.hoisted(() => ({ current: undefined as unknown }))
vi.mock('node:child_process', () => ({ spawn: vi.fn(() => workers.current) }))
vi.mock('./codex-runtime.js', () => ({ desktopCodexRuntime: () => ({ codexPath: '/fixture/codex', cwd: '/fixture', env: {} }) }))
import { CodexAuthClient } from './codex-rpc.js'

function createClient() {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() })
    workers.current = child
    return { child, client: new CodexAuthClient(() => {}, () => {}) }
}
afterEach(() => vi.useRealTimers())

test('a Keychain approval can finish after the former 30-second startup deadline', async () => {
    vi.useFakeTimers()
    const { child, client } = createClient()
    try {
        const initialized = client.initialize()
        await vi.advanceTimersByTimeAsync(31_000)
        child.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\n')
        await expect(initialized).resolves.toBeUndefined()
    } finally { client.close() }
})

test('startup timeout explains the separate Codex Keychain prompt without exposing worker output', async () => {
    vi.useFakeTimers()
    const { client } = createClient()
    try {
        const initialized = client.initialize()
        const rejected = expect(initialized).rejects.toThrow('Keychain access for Codex')
        await vi.advanceTimersByTimeAsync(120_000)
        await rejected
    } finally { client.close() }
})

test('ordinary account operations retain their shorter deadline', async () => {
    vi.useFakeTimers()
    const { client } = createClient()
    try {
        const rejected = expect(client.request('account/read', {})).rejects.toThrow('timed out while completing account/read')
        await vi.advanceTimersByTimeAsync(30_000)
        await rejected
    } finally { client.close() }
})
