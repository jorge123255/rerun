import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ calls: [] as { options: Record<string, unknown>; child: unknown }[] }))
vi.mock('node:child_process', () => ({
    fork: (_file: string, _args: unknown, options: Record<string, unknown>) => {
        const child = new EventEmitter() as EventEmitter & { pid: number; kill: () => boolean; send: (message: { type: string }, callback: (error: Error | null) => void) => void }
        child.pid = 12345
        child.kill = () => { queueMicrotask(() => child.emit('exit', null, 'SIGKILL')); return true }
        child.send = (message, callback) => {
            callback(null)
            if (message.type === 'start') queueMicrotask(() => child.emit('message', { type: 'ready' }))
            if (message.type === 'commit') queueMicrotask(() => child.emit('exit', 1, null))
        }
        state.calls.push({ options, child })
        return child
    },
}))
const { executeDesktopData } = await import('./data-executor.js')
const roots: string[] = []
afterEach(async () => { state.calls.length = 0; for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

it('never reports success or retries when the commit permission was sent but acknowledgement was lost', async () => {
    const root = await mkdtemp(join(tmpdir(), 'desktop-data-protocol-'))
    roots.push(root)
    const file = join(root, 'data.sqlite')
    await writeFile(file, '')
    const beforeCommit = vi.fn(async () => {})
    await expect(executeDesktopData(root, file, {
        kind: 'execute', hidden: [], statements: [{ sql: 'INSERT INTO notes VALUES (1)', params: [] }],
    }, { beforeCommit })).rejects.toThrow('commit outcome is unknown')
    expect(beforeCommit).toHaveBeenCalledOnce()
    expect(state.calls).toHaveLength(1)
    expect(state.calls[0].options.env).toEqual({ NODE_ENV: 'production', TZ: 'UTC' })
    expect(state.calls[0].options.execPath).toBe(process.execPath)
    expect(state.calls[0].options.stdio).toEqual(['ignore', 'ignore', 'ignore', 'ipc'])
})
