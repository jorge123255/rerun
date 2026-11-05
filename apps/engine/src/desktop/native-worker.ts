import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { lstat, mkdir, mkdtemp, opendir, readdir, realpath, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { WebSocket, WebSocketServer } from 'ws'
import { desktopCodexGrantsOf } from '@rerun/contracts'
import { dataDir } from '../config/paths.js'
import { readAgentConfig } from '../agents/loader.js'
import type { RunContext } from '../runtime/context.js'
import {captureNativeBaseline,captureNativeChanges,type NativeBaseline,type NativeWritebackBundle} from './native-writeback/capture.js'
import {stopNativeProcess} from './native-writeback/stop.js'
import { snapshotWorkspaceText } from './workspace-read.js'

const MAX_FRAME = 512 * 1024
const MAX_TRANSFER = 4 * 1024 * 1024
const MAX_LIFE = 120_000
const liveWorkers=new Set<()=>Promise<void>>()

/** Retain failed drains independently of run settlement so Quit cannot confuse a
 * saved cancelled run with proof that its native writers have exited. */
export async function stopAllDesktopNativeWorkers():Promise<void>{
    const stopped=await Promise.allSettled([...liveWorkers].map(close=>close()))
    if(stopped.some(result=>result.status==='rejected'))throw new Error('Native worker cleanup was not confirmed')
}

export type DesktopNativeWorker = { cwd: string; url: string; close: () => Promise<void>; finish: () => Promise<void> }
export type NativeWritebackHooks={authorizeCapture:(ctx:RunContext)=>Promise<void>;persist:(bundle:NativeWritebackBundle)=>Promise<void>}

function inside(root: string, path: unknown): boolean {
    if (typeof path !== 'string') return false
    try {
        const local = path.startsWith('file:') ? fileURLToPath(path) : path
        const rel = relative(root, local)
        return isAbsolute(local) && rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel)
    } catch { return false }
}

// The initial snapshot has fresh single-link files, and the worker Seatbelt forbids creating
// either kind of link. Also check the full path before each file RPC, including partial creates.
async function scratchTarget(root: string, input: unknown, leaf: 'any' | 'file' | 'directory') {
    if (typeof input !== 'string' || !inside(root, input)) return false
    const target = input.startsWith('file:') ? fileURLToPath(input) : input
    const parts = relative(root, target).split(sep).filter(Boolean)
    if (parts.length === 0) return leaf !== 'file'
    if (parts.length > 16 || parts.some(part => part.startsWith('.') || part.length > 255 || /[\\\p{Cc}]/u.test(part))) return false
    let path = root
    for (const [index, part] of parts.entries()) {
        path = join(path, part)
        try {
            const stat = await lstat(path)
            if (stat.isSymbolicLink()) return false
            if (index < parts.length - 1) { if (!stat.isDirectory()) return false }
            else if (stat.isDirectory()) return leaf !== 'file'
            else return leaf !== 'directory' && stat.isFile() && stat.nlink === 1 && stat.size <= 64 * 1024
        } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' }
    }
    return true
}

function textEdit(data: unknown): boolean {
    if (typeof data !== 'string' || data.length > 88_000 || data.length % 4) return false
    const bytes = Buffer.from(data, 'base64')
    if (bytes.length > 64 * 1024 || bytes.includes(0) || bytes.toString('base64') !== data) return false
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return true } catch { return false }
}

async function admit(method: string, params: Record<string, unknown>, root: string, shell: boolean, edit: boolean) {
    if (['initialize', 'initialized', 'environmentConfig/read'].includes(method)) return true
    if (method === 'fs/getMetadata') return scratchTarget(root, params.path, 'any')
    if (method === 'fs/readFile') return scratchTarget(root, params.path, 'file')
    if (method === 'fs/readDirectory') return scratchTarget(root, params.path, 'directory')
    if (method === 'fs/writeFile') return edit && textEdit(params.dataBase64) && scratchTarget(root, params.path, 'file')
    if (method === 'fs/remove') return edit && params.recursive === false && scratchTarget(root, params.path, 'file')
    if (method === 'fs/createDirectory') return edit && scratchTarget(root, params.path, 'directory')
    if (!shell) return false
    if (['process/terminate', 'process/read', 'process/write'].includes(method)) return true
    if (method !== 'process/start' || !await scratchTarget(root, params.cwd, 'directory')) return false
    const argv = params.argv
    return Array.isArray(argv) && argv.every(arg => typeof arg === 'string') && argv.length > 1 && ['/bin/bash', '/bin/zsh', '/bin/sh'].includes(argv[0])
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

export async function createDesktopNativeWorker(ctx: RunContext, writeback?:NativeWritebackHooks): Promise<DesktopNativeWorker> {
    if (process.platform !== 'darwin' || process.env.RERUN_DESKTOP_APP !== '1') throw new Error('Native commands require the Mac desktop app.')
    const launcher = process.env.RERUN_DESKTOP_CODEX_RUNNER
    if (!launcher || !isAbsolute(launcher)) throw new Error('The packaged native command runner is unavailable.')
    const { workspaceRead: includeFiles, shell, workspaceWrite: edit } = desktopCodexGrantsOf(ctx.agent.config.tools)
    if (!shell && !edit) throw new Error('Native commands and temporary edits are off for this coworker.')
    const active = async () => {
        ctx.abortSignal?.throwIfAborted()
        const config = await readAgentConfig(ctx.agent.id)
        const grants = desktopCodexGrantsOf(config.tools)
        if ((shell && !grants.shell) || (edit && !grants.workspaceWrite) || (includeFiles && !grants.workspaceRead)) throw new Error('Native command access changed for this coworker.')
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
    const children=new Set<ChildProcessWithoutNullStreams>()
    const stops=new Map<ChildProcessWithoutNullStreams,Promise<void>>()
    function stopProcess(child:ChildProcessWithoutNullStreams){
        let stopped=stops.get(child)
        if(!stopped){stopped=stopNativeProcess(child);stops.set(child,stopped);void stopped.catch(()=>{if(stops.get(child)===stopped)stops.delete(child)})}
        return stopped
    }
    let baseline:NativeBaseline|undefined
    let capture=false
    let writersStopped=false,cleanupFailed=false
    let closed = false, cleanup: Promise<void> | undefined
    let expires: NodeJS.Timeout | undefined, revoke: NodeJS.Timeout | undefined
    let transfer = 0
    function close(): Promise<void> {
        if (cleanup && !(cleanupFailed&&!writersStopped)) return cleanup
        if(cleanupFailed){cleanup=undefined;cleanupFailed=false;capture=false}
        closed = true
        clearTimeout(expires)
        clearInterval(revoke)
        ctx.abortSignal?.removeEventListener('abort', abort)
        for (const [ws, child] of workers) { ws.terminate(); stopProcess(child) }
        websocket.close()
        server.closeAllConnections()
        server.close()
        cleanup = (async()=>{
            await Promise.all([...children].map(stopProcess))
            writersStopped=true
            liveWorkers.delete(close)
            if(capture && baseline && writeback){
                await writeback.authorizeCapture(ctx)
                const bundle=await captureNativeChanges(ctx,cwd,baseline)
                if(bundle.files.length)await writeback.persist(bundle)
            }
            await rm(dir,{recursive:true,force:true,maxRetries:4,retryDelay:50})
        })()
        void cleanup.catch(()=>{cleanupFailed=true})
        return cleanup
    }
    const abort = () => { void close().catch(() => {}) }
    liveWorkers.add(close)
    try {
        await mkdir(cwd, { mode: 0o700 })
        await mkdir(state, { mode: 0o700 })
        if (includeFiles) await snapshotWorkspaceText(ctx, cwd, active)
        await active()
        if(writeback && includeFiles && edit){await writeback.authorizeCapture(ctx);baseline=await captureNativeBaseline(ctx,cwd,active)}
        server.on('upgrade', (req, socket, head) => {
            if (closed || workers.size || req.url !== secret || req.headers.origin) { socket.destroy(); return }
            websocket.handleUpgrade(req, socket, head, ws => websocket.emit('connection', ws))
        })
        websocket.on('connection', ws => {
            const child = spawn('/bin/sh', ['-c', 'ulimit -f 4096 && ulimit -t 12 && ulimit -n 192 && exec /usr/bin/sandbox-exec "$@"', 'rerun-worker', '-D', 'BINARY=' + binary, '-D', 'STATE=' + state, '-D', 'SCRATCH=' + cwd,
                '-f', policy, binary, 'exec-server', '--listen', 'stdio://'], {
                cwd, detached: true, env: { HOME: state, CODEX_HOME: state, TMPDIR: state, PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' }, stdio: ['pipe', 'pipe', 'pipe'],
            })
            children.add(child)
            workers.set(ws, child)
            child.stderr.resume()
            child.on('error', abort)
            child.stdin.on('error', () => ws.terminate())
            child.once('exit', () => ws.terminate())
            ws.on('error', () => ws.terminate())
            ws.once('close', () => { workers.delete(ws); stopProcess(child) })
            let sequence = Promise.resolve()
            function enqueue(bytes: number, operation: () => void | Promise<void>) {
                transfer += bytes
                if (closed || transfer > MAX_TRANSFER) { abort(); return }
                sequence = sequence.then(async () => {
                    await active()
                    if (!closed && ws.readyState === WebSocket.OPEN) await operation()
                }).catch(abort)
            }
            ws.on('message', data => {
                const text = data.toString()
                enqueue(Buffer.byteLength(text), async () => {
                    const message = JSON.parse(text) as { method: string; params?: Record<string, unknown>; id?: unknown }
                    const params = message.params ?? {}
                    if (!await admit(message.method, params, cwd, shell, edit)) {
                        if (message.id !== undefined) ws.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32001, message: 'This operation is unavailable in the command snapshot.' } }))
                        return
                    }
                    if (message.method === 'process/start') {
                        params.env = { HOME: state, TMPDIR: state, PATH: '/usr/bin:/bin', TERM: 'dumb', LANG: 'en_US.UTF-8' }
                        params.arg0 = null
                    }
                    if (!closed) child.stdin.write(JSON.stringify(message) + '\n')
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
        return { cwd, url: `ws://127.0.0.1:${address.port}${secret}`, close, finish:()=>{if(!closed)capture=true;return close()} }
    } catch (error) { await close(); throw error }
}
