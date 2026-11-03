import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { lstat, mkdir, mkdtemp, opendir, readdir, realpath, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { WebSocket, WebSocketServer } from 'ws'
import { desktopCodexGrantsOf } from '@rerun/contracts'
import { dataDir } from '../config/paths.js'
import { readAgentConfig } from '../agents/loader.js'
import type { RunContext } from '../runtime/context.js'
import { snapshotWorkspaceText } from './workspace-read.js'

const MAX_FRAME = 512 * 1024
const MAX_TRANSFER = 4 * 1024 * 1024
const MAX_LIFE = 120_000

export type DesktopNativeWorker = { cwd: string; url: string; close: () => Promise<void> }

function inside(root: string, path: unknown): boolean {
    if (typeof path !== 'string') return false
    try {
        const local = path.startsWith('file:') ? fileURLToPath(path) : path
        const rel = relative(root, local)
        return isAbsolute(local) && rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel)
    } catch { return false }
}

// Filesystem RPCs and native process launches are limited to this snapshot. Only the shell can
// write scratch. Raw native patch/write RPCs remain unavailable to the model.
function admit(method: string, params: Record<string, unknown>, root: string): boolean {
    if (['initialize', 'initialized', 'environmentConfig/read', 'process/terminate', 'process/read', 'process/write'].includes(method)) return true
    if (['fs/getMetadata', 'fs/readFile', 'fs/readDirectory'].includes(method)) return inside(root, params.path)
    if (method !== 'process/start' || !inside(root, params.cwd)) return false
    const argv = params.argv
    return Array.isArray(argv) && argv.every(arg => typeof arg === 'string') && argv.length > 1 && ['/bin/bash', '/bin/zsh', '/bin/sh'].includes(argv[0])
}

function stopProcess(child: ChildProcessWithoutNullStreams) {
    const pid = child.pid
    if (!pid || child.exitCode !== null || child.signalCode !== null) return
    try { process.kill(pid, 'SIGSTOP') } catch { return }
    // Native PTYs can own a separate process group. Commands cannot fork in the worker's
    // Seatbelt, so killing direct children also covers a shell that ignores termination.
    spawnSync('/usr/bin/pkill', ['-KILL', '-P', String(pid)], { stdio: 'ignore', timeout: 1500 })
    try { process.kill(-pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
}

async function runDirectory(): Promise<string> {
    const base = join(await realpath(dataDir()), 'desktop-native-workers')
    await mkdir(base, { recursive: true, mode: 0o700 })
    if (await realpath(base) !== base) throw new Error('Invalid native scratch root.')
    for (const entry of await readdir(base, { withFileTypes: true })) {
        const match = /^run-(\d+)-[A-Za-z0-9]+$/.exec(entry.name)
        if (!entry.isDirectory() || !match) continue
        try { process.kill(Number(match[1]), 0) }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') await rm(join(base, entry.name), { recursive: true, force: true })
        }
    }
    return mkdtemp(join(base, `run-${process.pid}-`))
}

// The OS also caps each file and process CPU time; this bounds runs creating many little files.
async function withinBudget(root: string) {
    let count = 0, bytes = 0
    const directories = [root]
    for (let i = 0; i < directories.length; i++) {
        const dir = await opendir(directories[i])
        for await (const entry of dir) {
            if (++count > 512) return false
            const path = join(directories[i], entry.name)
            const stat = await lstat(path)
            if (stat.isDirectory()) directories.push(path)
            else bytes += stat.size
            if (bytes > 8 * 1024 * 1024) return false
        }
    }
    return true
}

export async function createDesktopNativeWorker(ctx: RunContext): Promise<DesktopNativeWorker> {
    if (process.platform !== 'darwin' || process.env.RERUN_DESKTOP_APP !== '1') throw new Error('Native commands require the Mac desktop app.')
    const launcher = process.env.RERUN_DESKTOP_CODEX_RUNNER
    if (!launcher || !isAbsolute(launcher)) throw new Error('The packaged native command runner is unavailable.')
    const includeFiles = desktopCodexGrantsOf(ctx.agent.config.tools).workspaceRead
    const active = async () => {
        ctx.abortSignal?.throwIfAborted()
        const config = await readAgentConfig(ctx.agent.id)
        const grants = desktopCodexGrantsOf(config.tools)
        if (!grants.shell || (includeFiles && !grants.workspaceRead)) throw new Error('Native command access changed for this coworker.')
    }
    await active()
    const binDir = dirname(await realpath(launcher))
    const binary = await realpath(join(binDir, 'codex')), policy = await realpath(join(binDir, 'rerun-native-worker.sb'))
    if (dirname(binary) !== binDir || dirname(policy) !== binDir) throw new Error('Invalid packaged native runner.')
    const dir = await runDirectory()
    const cwd = join(dir, 'workspace'), state = join(dir, 'private')
    const secret = '/' + randomBytes(32).toString('hex')
    const server = createServer((_req, res) => res.writeHead(404).end())
    const websocket = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME, perMessageDeflate: false })
    const workers = new Map<WebSocket, ChildProcessWithoutNullStreams>()
    let closed = false, cleanup: Promise<void> | undefined
    let expires: NodeJS.Timeout | undefined, revoke: NodeJS.Timeout | undefined
    let transfer = 0
    function close(): Promise<void> {
        if (cleanup) return cleanup
        closed = true
        clearTimeout(expires)
        clearInterval(revoke)
        ctx.abortSignal?.removeEventListener('abort', abort)
        for (const [ws, child] of workers) { ws.terminate(); stopProcess(child) }
        websocket.close()
        server.closeAllConnections()
        server.close()
        cleanup = rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 })
        return cleanup
    }
    const abort = () => { void close().catch(() => {}) }
    try {
        await mkdir(cwd, { mode: 0o700 })
        await mkdir(state, { mode: 0o700 })
        if (includeFiles) await snapshotWorkspaceText(ctx, cwd, active)
        await active()
        server.on('upgrade', (req, socket, head) => {
            if (closed || workers.size || req.url !== secret || req.headers.origin) { socket.destroy(); return }
            websocket.handleUpgrade(req, socket, head, ws => websocket.emit('connection', ws))
        })
        websocket.on('connection', ws => {
            const child = spawn('/bin/sh', ['-c', 'ulimit -f 4096 && ulimit -t 12 && ulimit -n 192 && exec /usr/bin/sandbox-exec "$@"', 'rerun-worker', '-D', 'BINARY=' + binary, '-D', 'STATE=' + state, '-D', 'SCRATCH=' + cwd,
                '-f', policy, binary, 'exec-server', '--listen', 'stdio://'], {
                cwd, detached: true, env: { HOME: state, CODEX_HOME: state, TMPDIR: state, PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' }, stdio: ['pipe', 'pipe', 'pipe'],
            })
            workers.set(ws, child)
            child.stderr.resume()
            child.on('error', abort)
            child.stdin.on('error', () => ws.terminate())
            child.once('exit', () => ws.terminate())
            ws.on('error', () => ws.terminate())
            ws.once('close', () => { workers.delete(ws); stopProcess(child) })
            let sequence = Promise.resolve()
            function enqueue(bytes: number, operation: () => void) {
                transfer += bytes
                if (closed || transfer > MAX_TRANSFER) { abort(); return }
                sequence = sequence.then(async () => {
                    await active()
                    if (!closed && ws.readyState === WebSocket.OPEN) operation()
                }).catch(abort)
            }
            ws.on('message', data => {
                const text = data.toString()
                enqueue(Buffer.byteLength(text), () => {
                    const message = JSON.parse(text) as { method: string; params?: Record<string, unknown>; id?: unknown }
                    const params = message.params ?? {}
                    if (!admit(message.method, params, cwd)) {
                        if (message.id !== undefined) ws.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32001, message: 'This operation is unavailable in the command snapshot.' } }))
                        return
                    }
                    if (message.method === 'process/start') {
                        params.env = { HOME: state, TMPDIR: state, PATH: '/usr/bin:/bin', TERM: 'dumb', LANG: 'en_US.UTF-8' }
                        params.arg0 = null
                    }
                    child.stdin.write(JSON.stringify(message) + '\n')
                })
            })
            createInterface({ input: child.stdout }).on('line', text => enqueue(Buffer.byteLength(text), () => ws.send(text)))
        })
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject)
            server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
        })
        server.on('error', abort)
        const address = server.address()
        if (!address || typeof address === 'string') throw new Error('Could not start the native command worker.')
        ctx.abortSignal?.addEventListener('abort', abort, { once: true })
        await active()
        expires = setTimeout(abort, MAX_LIFE).unref()
        let checking = false
        revoke = setInterval(() => {
            if (checking) return
            checking = true
            void Promise.all([active(), withinBudget(cwd)]).then(([, okay]) => { if (!okay) abort() }).catch(abort).finally(() => { checking = false })
        }, 300).unref()
        return { cwd, url: `ws://127.0.0.1:${address.port}${secret}`, close }
    } catch (error) { await close(); throw error }
}
