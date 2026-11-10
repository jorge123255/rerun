import { execFile, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { chmod, copyFile, mkdtemp, readdir, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ClaudeCodeSettings } from 'ai-sdk-provider-claude-code'
import { clearCachedEnvForTests } from '../../config/env.js'
import { desktopClaudeRuntime, stopDesktopClaudeWorkers } from './runtime.js'

// Source-only authoring: root's test execution compiles the exact C helper and copies the exact
// production sandbox policy. The helper is a native Mach-O (a shell script cannot exec under
// claude-runner.sb, which denies process-exec except the BINARY literal) and speaks a tiny
// stdin/stdout protocol; it never execs, forks, writes files or touches the network, so it is a
// deterministic inert fixture for the bundled-runner boundary. All paths are realpath-canonical
// because trusted() rejects a path whose realpath differs (the /tmp -> /private/tmp link would
// otherwise break the sandbox's literal BINARY match).

type SpawnOptions = Parameters<NonNullable<ClaudeCodeSettings['spawnClaudeCodeProcess']>>[0]

const GEN_TOKEN = 'synthetic-fixture-token-generation-2'
const GEN = '2'
// Mirrors the sibling lanes' generation-2 semantics: the exact credential generation is the token
// plus the revision marker the engine would hand the spawn harness.
function harness(revision: string) {
    return {
        DISABLE_AUTO_COMPACT: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
        CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1',
        CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
        CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1',
        CLAUDE_CODE_DISABLE_WORKFLOWS: '1',
        CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
        CLAUDE_CODE_DISABLE_CRON: '1',
        RERUN_CLAUDE_CREDENTIAL_REVISION: revision,
    }
}
// Ambient SDK environment that the spawn spec must never forward into the confined child.
const AMBIENT = {
    NODE_OPTIONS: '--require=/private/evil.js',
    ANTHROPIC_API_KEY: 'ambient-key',
    CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'ambient-refresh',
    HTTPS_PROXY: 'http://attacker/',
}

let fixture: Awaited<ReturnType<typeof prepareHelperFixture>>
async function prepareHelperFixture() {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'rerun-claude-runner-')))
    const runner = join(root, 'fake-claude')
    const sandbox = join(root, 'claude-runner.sb')
    try {
        const prebuilt = process.env.RERUN_TEST_CLAUDE_HELPER
        if (prebuilt) {
            // An offline QA guest can use the exact fixture binary compiled on the host.
            await copyFile(prebuilt, runner)
            await chmod(runner, 0o700)
        } else {
            const source = fileURLToPath(new URL('./fake-claude.c', import.meta.url))
            await promisify(execFile)('/usr/bin/xcrun', ['clang', '-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', source, '-o', runner], { timeout: 30_000, maxBuffer: 16_384 })
        }
        await copyFile(fileURLToPath(new URL('../../../../../scripts/desktop/claude-runner.sb', import.meta.url)), sandbox)
        return { root, runner, sandbox, close: () => rm(root, { recursive: true, force: true }) }
    } catch (error) { await rm(root, { recursive: true, force: true }); throw error }
}
// Stubs the desktop-runtime env with a canonical temp data dir and the canonical fixture paths.
let currentData: string | undefined
async function prepare() {
    const data = await realpath(await mkdtemp(join(tmpdir(), 'rerun-claude-data-')))
    currentData = data
    vi.stubEnv('RERUN_DESKTOP_APP', '1')
    vi.stubEnv('RERUN_DATA_DIR', data)
    vi.stubEnv('RERUN_DESKTOP_CLAUDE_RUNNER', fixture.runner)
    vi.stubEnv('RERUN_DESKTOP_CLAUDE_SANDBOX', fixture.sandbox)
    clearCachedEnvForTests()
    return data
}
function deadline<T>(work: Promise<T>, what = 'bundled runner fixture'): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${what} did not finish`)), 10_000)
        work.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
    })
}
function spawnChild(runtime: ReturnType<typeof desktopClaudeRuntime>, args: string[] = [], signal: AbortSignal = new AbortController().signal) {
    const hook = runtime.settings.spawnClaudeCodeProcess
    if (!hook) throw new Error('fixture: spawn hook missing')
    return hook({ command: process.env.RERUN_DESKTOP_CLAUDE_RUNNER as string, args, cwd: runtime.settings.cwd as string, env: AMBIENT, signal }) as ChildProcessWithoutNullStreams
}
// Reads newline-terminated protocol replies in order from the filtered stdout pipe.
function reader(child: ChildProcessWithoutNullStreams) {
    let buffer = ''
    const waiters: { resolve(line: string): void; reject(error: Error): void }[] = []
    const pending: string[] = []
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
        buffer += chunk
        let index: number
        while ((index = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, index)
            buffer = buffer.slice(index + 1)
            const waiter = waiters.shift()
            if (waiter) waiter.resolve(line)
            else pending.push(line)
        }
    })
    child.stdout.on('error', (error: Error) => { for (const waiter of waiters.splice(0)) waiter.reject(error) })
    return {
        next(): Promise<string> {
            const ready = pending.shift()
            if (ready !== undefined) return Promise.resolve(ready)
            return new Promise((resolve, reject) => { waiters.push({ resolve, reject }) })
        },
    }
}
function exited(child: ChildProcessWithoutNullStreams) {
    return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
        if (child.exitCode !== null || child.signalCode !== null) resolve({ code: child.exitCode, signal: child.signalCode })
        else child.once('exit', (code, signal) => resolve({ code, signal }))
    })
}
const tokenSum = (token: string) => Buffer.from(token).reduce((sum, byte) => (sum + byte) & 0xffffffff, 0)
const generation = (token: string) => ({ revision: GEN, tokenBytes: Buffer.byteLength(token), tokenSum: tokenSum(token), hasToken: 1, ambient: 0 })

describe.skipIf(process.platform !== 'darwin')('bundled Claude runner boundary', () => {
    beforeAll(async () => { fixture = await prepareHelperFixture() }, 30_000)
    afterEach(async () => {
        await stopDesktopClaudeWorkers().catch(() => {})
        vi.unstubAllEnvs()
        clearCachedEnvForTests()
        if (currentData) { await rm(currentData, { recursive: true, force: true }); currentData = undefined }
    })
    afterAll(async () => { await fixture?.close() })

    it('refuses the gate and an untrusted bundled runner', async () => {
        await prepare()
        expect(() => desktopClaudeRuntime('other-connection', GEN_TOKEN, harness(GEN))).toThrow('Connect Claude in Settings before chatting.')
        expect(() => desktopClaudeRuntime('mac-claude', '', harness(GEN))).toThrow('Connect Claude in Settings before chatting.')
        for (const bad of ['line\nfeed', 'carriage\rreturn', 'null\0byte']) expect(() => desktopClaudeRuntime('mac-claude', bad, harness(GEN))).toThrow('Connect Claude in Settings before chatting.')
        vi.stubEnv('RERUN_DESKTOP_CLAUDE_RUNNER', 'runner')
        expect(() => desktopClaudeRuntime('mac-claude', GEN_TOKEN, harness(GEN))).toThrow('Connect Claude in Settings before chatting.')
        vi.stubEnv('RERUN_DESKTOP_CLAUDE_RUNNER', fixture.runner)
        vi.stubEnv('RERUN_DESKTOP_APP', '0')
        expect(() => desktopClaudeRuntime('mac-claude', GEN_TOKEN, harness(GEN))).toThrow('Connect Claude in Settings before chatting.')
        vi.stubEnv('RERUN_DESKTOP_APP', '1')

        const link = join(fixture.root, 'runner-link')
        await symlink(fixture.runner, link)
        vi.stubEnv('RERUN_DESKTOP_CLAUDE_RUNNER', link)
        expect(() => desktopClaudeRuntime('mac-claude', GEN_TOKEN, harness(GEN))).toThrow('The bundled Claude runtime is unavailable.')
        if (fixture.root.startsWith('/private/')) {
            vi.stubEnv('RERUN_DESKTOP_CLAUDE_RUNNER', fixture.runner.replace(/^\/private/, ''))
            expect(() => desktopClaudeRuntime('mac-claude', GEN_TOKEN, harness(GEN))).toThrow('The bundled Claude runtime is unavailable.')
            vi.stubEnv('RERUN_DESKTOP_CLAUDE_RUNNER', fixture.runner)
            vi.stubEnv('RERUN_DESKTOP_CLAUDE_SANDBOX', fixture.sandbox.replace(/^\/private/, ''))
            expect(() => desktopClaudeRuntime('mac-claude', GEN_TOKEN, harness(GEN))).toThrow('The bundled Claude runtime is unavailable.')
        }
    })

    it('sends the reopened exact credential generation to one confined child, drops ambient env, and Stop drains it', async () => {
        const data = await prepare()
        const first = desktopClaudeRuntime('mac-claude', GEN_TOKEN, harness(GEN))
        const childA = spawnChild(first)
        const readA = reader(childA)
        childA.stdin.write('ping\n')
        const probe1 = JSON.parse(await deadline(readA.next()))
        expect(probe1).toEqual(generation(GEN_TOKEN))
        // The same confined child answers again: one child holds the reopened generation.
        childA.stdin.write('ping\n')
        expect(JSON.parse(await deadline(readA.next()))).toEqual(probe1)
        const pidA = childA.pid as number
        expect(() => process.kill(-pidA, 0)).not.toThrow()
        const drained = deadline(exited(childA))
        await stopDesktopClaudeWorkers()
        expect(await drained).toEqual({ code: null, signal: 'SIGTERM' })
        expect(() => process.kill(-pidA, 0)).toThrow()
        expect(await readdir(join(data, 'claude'))).toEqual([])

        // Reopen the same exact generation: a new confined child carries it, never a replay.
        const reopened = desktopClaudeRuntime('mac-claude', GEN_TOKEN, harness(GEN))
        const childB = spawnChild(reopened)
        expect(childB.pid).not.toBe(pidA)
        const readB = reader(childB)
        childB.stdin.write('ping\n')
        expect(JSON.parse(await deadline(readB.next()))).toEqual(generation(GEN_TOKEN))
        await stopDesktopClaudeWorkers()
        expect(await readdir(join(data, 'claude'))).toEqual([])
    })

    it('drains the confined child on quit and abort-Stop; close is idempotent and removes the profile', async () => {
        const data = await prepare()
        const first = desktopClaudeRuntime('mac-claude', GEN_TOKEN, harness(GEN))
        const childA = spawnChild(first)
        const readA = reader(childA)
        childA.stdin.write('quit\n')
        expect(await deadline(exited(childA))).toEqual({ code: 0, signal: null })
        await first.close()
        expect(await readdir(join(data, 'claude'))).toEqual([])
        await first.close()
        expect(await readdir(join(data, 'claude'))).toEqual([])

        const second = desktopClaudeRuntime('mac-claude', GEN_TOKEN, harness(GEN))
        const stop = new AbortController()
        const childB = spawnChild(second, [], stop.signal)
        const readB = reader(childB)
        childB.stdin.write('ping\n')
        expect(JSON.parse(await deadline(readB.next()))).toMatchObject({ revision: GEN, ambient: 0 })
        const drained = deadline(exited(childB))
        stop.abort()
        expect(await drained).toEqual({ code: null, signal: 'SIGTERM' })
        await stopDesktopClaudeWorkers()
        expect(await readdir(join(data, 'claude'))).toEqual([])
    })

    it('redacts the credential and its encodings through both filtered pipes', async () => {
        await prepare()
        const runtime = desktopClaudeRuntime('mac-claude', GEN_TOKEN, harness(GEN))
        const child = spawnChild(runtime)
        const read = reader(child)
        let stdout = '', stderr = ''
        child.stdout.setEncoding('utf8')
        child.stdout.on('data', (chunk: string) => { stdout += chunk })
        child.stderr.setEncoding('utf8')
        child.stderr.on('data', (chunk: string) => { stderr += chunk })
        const outEnded = once(child.stdout, 'end')
        const errEnded = once(child.stderr, 'end')
        child.stdin.write('echo\n')
        expect(await deadline(read.next())).toBe('[redacted]')
        child.stdin.write('echo-b64\n')
        expect(await deadline(read.next())).toBe('[redacted]')
        child.stdin.write('echo-hex\n')
        expect(await deadline(read.next())).toBe('[redacted]')
        child.stdin.write('echo-stderr\n')
        child.stdin.write('quit\n')
        expect(await deadline(exited(child))).toEqual({ code: 0, signal: null })
        await deadline(outEnded)
        await deadline(errEnded)
        expect(stdout).toBe('[redacted]\n[redacted]\n[redacted]\n')
        expect(stderr).toBe('[redacted]\n')
        for (const variant of [GEN_TOKEN, Buffer.from(GEN_TOKEN).toString('base64'), Buffer.from(GEN_TOKEN).toString('hex'), encodeURIComponent(GEN_TOKEN)]) {
            expect(stdout + stderr).not.toContain(variant)
        }
        await runtime.close()
    })

    it('refuses a closed runtime, a foreign command, and an aborted turn without spawning a child', async () => {
        const data = await prepare()
        const runtime = desktopClaudeRuntime('mac-claude', GEN_TOKEN, harness(GEN))
        await runtime.close()
        expect(() => spawnChild(runtime)).toThrow('Claude process owner changed')
        expect(await readdir(join(data, 'claude'))).toEqual([])

        const second = desktopClaudeRuntime('mac-claude', GEN_TOKEN, harness(GEN))
        const hook = second.settings.spawnClaudeCodeProcess as (options: SpawnOptions) => unknown
        const binary = process.env.RERUN_DESKTOP_CLAUDE_RUNNER as string
        const base = { args: [] as string[], cwd: second.settings.cwd as string, env: AMBIENT, signal: new AbortController().signal }
        expect(() => hook({ ...base, command: '/usr/local/bin/claude' })).toThrow('Claude process owner changed')
        expect(() => hook({ ...base, command: binary, cwd: '/Users/person' })).toThrow('Claude process owner changed')
        const aborted = () => hook({ ...base, command: binary, signal: AbortSignal.abort() })
        let abortedError: Error | undefined
        try { aborted() } catch (error) { abortedError = error as Error }
        expect(abortedError).toBeDefined()
        expect(abortedError?.name).toBe('AbortError')
        // Nothing spawned: the failed turns left the profile untouched and close removes it.
        await stopDesktopClaudeWorkers()
        expect(await readdir(join(data, 'claude'))).toEqual([])
        // No replay: the same generation cannot be re-admitted after close.
        expect(() => spawnChild(second)).toThrow('Claude process owner changed')
        expect(await readdir(join(data, 'claude'))).toEqual([])
    })
})
