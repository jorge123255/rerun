import { constants, mkdtempSync } from 'node:fs'
import { access, copyFile, link, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { once } from 'node:events'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import type { RunContext } from '../runtime/context.js'

const root = mkdtempSync(join(tmpdir(), 'rerun-native-worker-test-'))
vi.stubEnv('RERUN_DATA_DIR', root)
vi.stubEnv('RERUN_DESKTOP_APP', '1')
const { workspaceDir } = await import('../config/paths.js')
const { agentConfigSchema } = await import('../agents/types.js')
const { writeAgentConfig } = await import('../agents/config-write.js')
const { createDesktopNativeWorker } = await import('./native-worker.js')

const id = 'native-worker-owner', other = 'native-worker-sibling'
const grant = (read: boolean, shell: boolean, edit = false) => agentConfigSchema.parse({ name: id, tools: { desktopCodexGrants: { workspaceRead: read, shell, workspaceWrite: edit } } })
const ctx = (read: boolean, shell: boolean, controller: AbortController, edit = false) => ({ agent: { id, config: grant(read, shell, edit) }, abortSignal: controller.signal }) as RunContext
const runner = join(root, 'bin/rerun-codex')
beforeAll(async () => {
    for (const p of [join(root, 'bin'), workspaceDir(id), workspaceDir(other)]) await mkdir(p, { recursive: true })
    await writeFile(runner, 'test')
    vi.stubEnv('RERUN_DESKTOP_CODEX_RUNNER', runner)
    if (process.platform === 'darwin') {
        const require = createRequire(import.meta.url)
        const adapter = createRequire(require.resolve('ai-sdk-provider-codex-cli'))
        const codex = createRequire(adapter.resolve('@openai/codex/package.json'))
        const platform = dirname(codex.resolve('@openai/codex-darwin-arm64/package.json'))
        await copyFile(join(platform, 'vendor/aarch64-apple-darwin/bin/codex'), join(root, 'bin/codex'), constants.COPYFILE_FICLONE)
        await copyFile(new URL('../../../../scripts/desktop/native-worker.sb', import.meta.url), join(root, 'bin/rerun-native-worker.sb'))
    }
}, 20_000)
afterAll(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) })

it.runIf(process.platform === 'darwin')('copies bounded owned text as fresh files only and destroys the snapshot on abort', async () => {
    await writeAgentConfig(id, grant(true, true))
    await writeFile(join(workspaceDir(id), 'my.txt'), 'own file')
    await writeFile(join(workspaceDir(other), 'other.txt'), 'other private bytes')
    await link(join(workspaceDir(other), 'other.txt'), join(workspaceDir(id), 'hard-link'))
    await symlink(workspaceDir(other), join(workspaceDir(id), 'link-dir'))
    await writeFile(join(workspaceDir(id), '.private'), 'hidden')
    const stale = join(root, 'desktop-native-workers/run-2147483647-ABC123')
    await mkdir(stale, { recursive: true })
    const controller = new AbortController()
    const worker = await createDesktopNativeWorker(ctx(true, true, controller))
    try {
        await expect(access(stale)).rejects.toThrow()
        expect(await readFile(join(worker.cwd, 'my.txt'), 'utf8')).toBe('own file')
        for (const name of ['hard-link', 'link-dir', '.private']) await expect(access(join(worker.cwd, name))).rejects.toThrow()
        await writeFile(join(worker.cwd, 'my.txt'), 'scratch edit')
        expect(await readFile(join(workspaceDir(id), 'my.txt'), 'utf8')).toBe('own file')
        const unauthorized = new WebSocket(worker.url.replace(/[^/]+$/, 'wrong-capability'))
        await expect(once(unauthorized, 'open')).rejects.toThrow()
        controller.abort()
        await worker.close()
        await expect(access(worker.cwd)).rejects.toThrow()
    } finally { await worker.close() }
})

async function nativeCommand(ws: WebSocket, cwd: string, command: string) {
    const id = randomUUID()
    const chunks: Buffer[] = []
    return new Promise<string>((resolve, reject) => {
        function receive(data: WebSocket.RawData) {
            const frame = JSON.parse(data.toString())
            if (frame.id === id && frame.error) { ws.off('message', receive); reject(new Error(frame.error.message)); return }
            if (frame.params?.processId !== id) return
            if (frame.method === 'process/output') chunks.push(Buffer.from(frame.params.chunk, 'base64'))
            if (frame.method === 'process/closed') { ws.off('message', receive); resolve(Buffer.concat(chunks).toString()) }
        }
        ws.on('message', receive)
        ws.send(JSON.stringify({ id, method: 'process/start', params: {
            processId: id, metadata: null, argv: ['/bin/zsh', '-c', command], cwd: pathToFileURL(cwd).href,
            envPolicy: { inherit: 'all', ignoreDefaultExcludes: true, exclude: [], set: {}, includeOnly: [] },
            env: { TEST_SUPERVISOR_SECRET: 'must-not-be-inherited' }, tty: false, pipeStdin: false,
            arg0: null, sandbox: null, enforceManagedNetwork: false, managedNetwork: null,
        } }))
    })
}

it.runIf(process.platform === 'darwin')('runs a real native process in scratch without sibling, caller environment or network access', async () => {
    await writeAgentConfig(id, grant(true, true))
    await writeFile(join(workspaceDir(id), 'allowed.txt'), 'visible owner text')
    await writeFile(join(workspaceDir(other), 'private-note.txt'), 'sibling secret')
    const controller = new AbortController()
    const worker = await createDesktopNativeWorker(ctx(true, true, controller))
    try {
        const ws = new WebSocket(worker.url); await once(ws, 'open')
        const response = once(ws, 'message')
        ws.send(JSON.stringify({ id: 'init', method: 'initialize', params: { clientName: 'native-test', resumeSessionId: null } }))
        await response
        ws.send(JSON.stringify({ method: 'initialized', params: {} }))
        expect(await nativeCommand(ws, worker.cwd, 'cat allowed.txt')).toContain('visible owner text')
        expect(await nativeCommand(ws, worker.cwd, 'cat ' + JSON.stringify(join(workspaceDir(other), 'private-note.txt')))).toMatch(/not permitted|permission denied/i)
        expect(await nativeCommand(ws, worker.cwd, 'echo ${TEST_SUPERVISOR_SECRET:-private}')).toContain('private')
        expect(await nativeCommand(ws, worker.cwd, 'printf edited > transient.txt')).toBe('')
        expect(await readFile(join(worker.cwd, 'transient.txt'), 'utf8')).toBe('edited')
        await expect(access(join(workspaceDir(id), 'transient.txt'))).rejects.toThrow()
        // /dev/tcp is a shell capability in bash. The Seatbelt denies sockets even to localhost.
        const net = await import('node:net')
        const canary = net.createServer()
        canary.listen(0, '127.0.0.1'); await once(canary, 'listening')
        try {
            const addr = canary.address()
            expect(addr && typeof addr !== 'string').toBe(true)
            const port = (addr as { port: number }).port
            const connect = await nativeCommand(ws, worker.cwd, `exec /bin/bash -c 'echo x >/dev/tcp/127.0.0.1/${port}'`)
            expect(connect).toMatch(/not permitted|permission denied/i)
        } finally { canary.close() }
    } finally { await worker.close() }
}, 15_000)

it.runIf(process.platform === 'darwin')('starts an empty worker for shell-only, rejects a raw native write, and revokes the open socket', async () => {
    await writeAgentConfig(id, grant(false, true))
    const controller = new AbortController()
    const worker = await createDesktopNativeWorker(ctx(false, true, controller))
    try {
        await expect(access(join(worker.cwd, 'my.txt'))).rejects.toThrow()
        const ws = new WebSocket(worker.url)
        await once(ws, 'open')
        const send = async (method: string, params: unknown) => {
            const message = once(ws, 'message')
            ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }))
            return JSON.parse((await message)[0].toString())
        }
        expect((await send('initialize', { clientName: 'desktop-test', resumeSessionId: null })).result).toBeDefined()
        expect((await send('fs/writeFile', { path: 'file://' + join(worker.cwd, 'bad'), dataBase64: 'eA==' })).error).toBeDefined()
        await expect(access(join(worker.cwd, 'bad'))).rejects.toThrow()
        const ended = once(ws, 'close')
        await writeAgentConfig(id, grant(false, false))
        await ended
        await worker.close()
        await expect(access(worker.cwd)).rejects.toThrow()
        await expect(createDesktopNativeWorker(ctx(false, true, controller))).rejects.toThrow('changed')
    } finally { await worker.close() }
})

it.runIf(process.platform === 'darwin')('allows bounded temporary patch RPCs without shell or persistent writes, rejects aliases and revokes access', async () => {
    await writeAgentConfig(id, grant(true, false, true))
    await writeFile(join(workspaceDir(other), 'patch-private-other.txt'), 'other private bytes')
    const controller = new AbortController()
    const worker = await createDesktopNativeWorker(ctx(true, false, controller, true))
    try {
        const ws = new WebSocket(worker.url); await once(ws, 'open')
        const rpc = async (method: string, params: unknown) => {
            const wait = once(ws, 'message')
            ws.send(JSON.stringify({ id: randomUUID(), method, params }))
            return JSON.parse((await wait)[0].toString())
        }
        expect((await rpc('initialize', { clientName: 'patch-test', resumeSessionId: null })).result).toBeDefined()
        ws.send(JSON.stringify({ method: 'initialized', params: {} }))
        const file = join(worker.cwd, 'edit.md')
        const write = (target: string, data: Buffer) => rpc('fs/writeFile', { path: pathToFileURL(target).href, dataBase64: data.toString('base64'), sandbox: null })
        expect((await write(file, Buffer.from('scratch only'))).error).toBeUndefined()
        expect(await readFile(file, 'utf8')).toBe('scratch only')
        await expect(access(join(workspaceDir(id), 'edit.md'))).rejects.toThrow()
        await symlink(workspaceDir(other), join(worker.cwd, 'symlink'))
        await link(join(workspaceDir(other), 'patch-private-other.txt'), join(worker.cwd, 'alias'))
        for (const target of [join(worker.cwd, 'symlink', 'patch-private-other.txt'), join(worker.cwd, 'alias'), join(workspaceDir(other), 'patch-private-other.txt'), join(worker.cwd, '.hidden')]) {
            expect((await write(target, Buffer.from('blocked'))).error).toBeDefined()
        }
        expect((await write(file, Buffer.alloc(65 * 1024, 97))).error).toBeDefined()
        expect((await write(file, Buffer.from([0, 255]))).error).toBeDefined()
        expect((await rpc('fs/remove', { path: pathToFileURL(worker.cwd).href, recursive: true })).error).toBeDefined()
        expect((await rpc('process/start', { cwd: pathToFileURL(worker.cwd).href, argv: ['/bin/sh','-c','echo forbidden'] })).error).toBeDefined()
        expect((await rpc('fs/remove', { path: pathToFileURL(file).href, recursive: false, force: false })).error).toBeUndefined()
        await expect(access(file)).rejects.toThrow()
        expect(await readFile(join(workspaceDir(other), 'patch-private-other.txt'), 'utf8')).toBe('other private bytes')
        const ended = once(ws, 'close')
        await writeAgentConfig(id, grant(true, false, false))
        await ended
    } finally { await worker.close() }
})
