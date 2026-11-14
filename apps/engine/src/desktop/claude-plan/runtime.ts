import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { lstatSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Transform } from 'node:stream'
import type { ClaudeCodeSettings } from 'ai-sdk-provider-claude-code'
import { DESKTOP_CLAUDE_CONNECTION_ID } from '@rerun/contracts'
import { dataDir } from '../../config/paths.js'

type SpawnOptions = Parameters<NonNullable<ClaudeCodeSettings['spawnClaudeCodeProcess']>>[0]
const workers = new Set<{ close(): Promise<void> }>()
export const desktopClaudeAvailable = () => process.env.RERUN_DESKTOP_APP === '1' && isAbsolute(process.env.RERUN_DESKTOP_CLAUDE_RUNNER ?? '') && isAbsolute(process.env.RERUN_DESKTOP_CLAUDE_SANDBOX ?? '')
export async function stopDesktopClaudeWorkers() {
    const results = await Promise.allSettled([...workers].map(worker => worker.close()))
    if (results.some(result => result.status === 'rejected')) throw new Error('Claude process shutdown could not be confirmed.')
}
function trusted(path: string) {
    try {
        const info = lstatSync(path)
        if (info.isFile() && !info.isSymbolicLink() && realpathSync(path) === path && [0, process.getuid?.()].includes(info.uid)) return path
    } catch {
        // Missing or unreadable bundle files should not expose their local paths.
    }
    throw new Error('The bundled Claude runtime is unavailable.')
}
/** Bound protocol lines before the SDK parses JSON; never publish a credential echo. */
export function desktopClaudeOutputFilter(token: string, totalLimit = 64 * 1024 * 1024, lineLimit = 8 * 1024 * 1024) {
    const variants = [...new Set([token, Buffer.from(token).toString('base64'), Buffer.from(token).toString('hex'), encodeURIComponent(token)])].filter(Boolean)
    let pending = Buffer.alloc(0), total = 0
    const redact = (value: Buffer) => variants.reduce((text, secret) => text.split(secret).join('[redacted]'), value.toString('utf8'))
    return new Transform({
        transform(chunk: Buffer, _encoding, done) {
            total += chunk.length
            if (total > totalLimit) { done(new Error('Claude response exceeded its limit.')); return }
            pending = Buffer.concat([pending, chunk])
            let offset: number
            while ((offset = pending.indexOf(10)) !== -1) {
                if (offset > lineLimit) { done(new Error('Claude response exceeded its limit.')); return }
                this.push(redact(pending.subarray(0, offset + 1)))
                pending = pending.subarray(offset + 1)
            }
            if (pending.length > lineLimit) { done(new Error('Claude response exceeded its limit.')); return }
            done()
        },
        flush(done) { if (pending.length) this.push(redact(pending)); pending.fill(0); done() },
        destroy(error, done) { pending.fill(0); done(error) },
    })
}
export function desktopClaudeSpawnSpec(binary: string, sandbox: string, profile: string, token: string, harness: Record<string, string>, options: SpawnOptions) {
    options.signal.throwIfAborted()
    if (options.command !== binary || options.cwd !== profile) throw new Error('Claude process owner changed')
    if (options.args.some(arg => arg === '--dangerously-skip-permissions' || arg === '--allow-dangerously-skip-permissions')) throw new Error('Claude permission bypass is unavailable')
    // Claude keeps its scratch folder under /tmp unless told otherwise; the sandbox refuses that and the process exits 1.
    return {
        command: '/usr/bin/sandbox-exec',
        args: ['-D', `PROFILE=${profile}`, '-D', `BINARY=${binary}`, '-f', sandbox, binary, ...options.args],
        cwd: profile,
        env: { ...harness, NODE_ENV: 'production' as const, PATH: '/usr/bin:/bin', HOME: profile, CLAUDE_CONFIG_DIR: profile, TMPDIR: join(profile, 'tmp'), CLAUDE_CODE_TMPDIR: join(profile, 'tmp'), LANG: 'en_US.UTF-8', CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', CLAUDE_AGENT_SDK_VERSION: '0.3.322', CLAUDE_CODE_OAUTH_TOKEN: token },
    }
}
export function desktopClaudeRuntime(connectionId: string | undefined, token: string, harness: Record<string, string>) {
    if (connectionId !== DESKTOP_CLAUDE_CONNECTION_ID || !desktopClaudeAvailable() || !token || /[\0\r\n]/.test(token)) throw new Error('Connect Claude in Settings before chatting.')
    const binary = trusted(process.env.RERUN_DESKTOP_CLAUDE_RUNNER!), sandbox = trusted(process.env.RERUN_DESKTOP_CLAUDE_SANDBOX!)
    const base = join(dataDir(), 'claude')
    mkdirSync(base, { recursive: true, mode: 0o700 })
    if (lstatSync(base).isSymbolicLink() || realpathSync(base) !== base) throw new Error('Claude profile is unavailable.')
    const profile = join(base, randomUUID())
    mkdirSync(profile, { mode: 0o700 })
    mkdirSync(join(profile, 'tmp'), { mode: 0o700 })
    const children = new Set<ChildProcessWithoutNullStreams>()
    let closed = false
    async function drain(child: ChildProcessWithoutNullStreams) {
        if (!child.pid) return
        const pid = child.pid
        const terminate = (signal: NodeJS.Signals) => { try { process.kill(-pid, signal) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error('Claude shutdown was not confirmed') } }
        terminate('SIGTERM')
        for (let i = 0; i < 30; i++) {
            try {
                process.kill(-pid, 0)
            } catch (error) {
                const { code } = error as NodeJS.ErrnoException
                if (code === 'ESRCH') {
                    children.delete(child)
                    return
                }
                // macOS can deny a group probe during exit. Only ESRCH confirms shutdown.
                if (code !== 'EPERM') throw error
            }
            if (i === 5) terminate('SIGKILL')
            await new Promise<void>(resolve => setTimeout(resolve, 100))
        }
        throw new Error('Claude process group did not exit')
    }
    const runtime = {
        async close() {
            closed = true
            const results = await Promise.allSettled([...children].map(drain))
            if (results.some(result => result.status === 'rejected')) throw new Error('Claude process shutdown was not confirmed')
            workers.delete(runtime)
            rmSync(profile, { recursive: true, force: true })
        },
        settings: {
            cwd: profile,
            pathToClaudeCodeExecutable: binary,
            settingSources: [], tools: [], strictMcpConfig: true, persistSession: false,
            permissionMode: 'dontAsk', allowDangerouslySkipPermissions: false, streamingInput: 'always',
            env: {}, logger: false, verbose: false,
            spawnClaudeCodeProcess(options: SpawnOptions) {
                if (closed) throw new Error('Claude process owner changed')
                const spec = desktopClaudeSpawnSpec(binary, sandbox, profile, token, harness, options)
                const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false, detached: true }) as ChildProcessWithoutNullStreams
                children.add(child)
                const output = desktopClaudeOutputFilter(token), diagnostic = desktopClaudeOutputFilter(token, 65536, 65536)
                child.stdout = child.stdout.pipe(output)
                child.stderr = child.stderr.pipe(diagnostic)
                output.on('error', () => { void drain(child).catch(() => {}) })
                diagnostic.on('error', () => { void drain(child).catch(() => {}) })
                // Drain diagnostics even when the provider has no logger attached.
                diagnostic.on('data', () => {})
                const stop = () => { void drain(child).catch(() => {}) }
                options.signal.addEventListener('abort', stop, { once: true })
                child.once('exit', () => { options.signal.removeEventListener('abort', stop); void drain(child).catch(() => {}) })
                child.once('error', () => { options.signal.removeEventListener('abort', stop); if (!child.pid) children.delete(child); else stop() })
                if (options.signal.aborted) stop()
                return child
            },
        } satisfies Partial<ClaudeCodeSettings>,
    }
    workers.add(runtime)
    return runtime
}
