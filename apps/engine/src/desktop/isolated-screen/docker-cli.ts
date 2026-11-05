import { existsSync } from 'node:fs'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { Duplex, type Readable, type Writable } from 'node:stream'
import {
    LIST_SCREEN_ARGS,
    VERSION_ARGS,
    execArgs,
    imageInspectArgs,
    inspectContainerArgs,
    inspectVolumeArgs,
    removeContainerArgs,
    removeVolumeArgs,
    volumeCreateArgs,
    assertSafeRunArgs,
} from './docker-args.js'
import { BINARY_MAX, JSON_MAX } from './frame.js'
import { abortError, IsolatedScreenRefusal, throwIfAborted } from './refusal.js'
import type { ScreenOwner } from './types.js'

export type DockerVersion = { kind: 'ok'; os: string; arch: string } | { kind: 'missing' } | { kind: 'unreachable' }
export type DockerImage = { kind: 'present'; architecture: string } | { kind: 'missing' } | { kind: 'unreachable' }
export type InspectedContainer = { status: 'missing' } | { status: 'unreachable' } | { status: 'found'; id?: string; state: string; labels: Record<string, string> }
export type InspectedVolume = { status: 'missing' } | { status: 'unreachable' } | { status: 'found'; labels: Record<string, string> }
export type ListedScreen = {
    name: string
    engineAgentId: string
    launchNonce: string
    sessionGeneration: string
    managed: string
    state: string
}

export type DockerClient = {
    version(signal: AbortSignal): Promise<DockerVersion>
    image(signal: AbortSignal): Promise<DockerImage>
    inspectContainer(name: string, signal: AbortSignal): Promise<InspectedContainer>
    inspectVolume(name: string, signal: AbortSignal): Promise<InspectedVolume>
    createVolume(owner: ScreenOwner, signal: AbortSignal): Promise<void>
    run(args: readonly string[], signal: AbortSignal): Promise<void>
    removeContainer(name: string, signal: AbortSignal): Promise<void>
    removeVolume(name: string, signal: AbortSignal): Promise<void>
    listScreens(signal: AbortSignal): Promise<ListedScreen[]>
    exec(name: string, command: readonly string[], input: Buffer, signal: AbortSignal): Promise<Buffer>
    execStream(name: string, command: readonly string[], signal: AbortSignal): Promise<Duplex>
}

type Collected = { code: number | null; stdout: Buffer; stderr: Buffer; error?: NodeJS.ErrnoException; tooLarge: boolean }
const STDOUT_CAP = BINARY_MAX + JSON_MAX + 8
const STDERR_CAP = 65_536

export function parseVersion(stdout: string): { os: string; arch: string } | null {
    const [os, arch] = stdout.trim().split(/\s+/)
    if (!os || !arch) return null
    return { os, arch }
}

export function parseLabels(payload: string): Record<string, string> {
    const text = payload.trim()
    if (text === '' || text === 'null') return {}
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const labels: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'string') labels[key] = value
    }
    return labels
}

export function parseContainerInspect(stdout: string): { id?: string; state: string; labels: Record<string, string> } | null {
    try {
        const text = stdout.trim()
        const tab = text.indexOf('\t')
        if (tab <= 0) return null
        const rest = text.slice(tab + 1), end = rest.lastIndexOf('\t')
        return end < 0 ? { state: text.slice(0, tab), labels: parseLabels(rest) } : { state: text.slice(0, tab), labels: parseLabels(rest.slice(0, end)), id: rest.slice(end + 1) }
    } catch {
        return null
    }
}

export function parseScreenList(stdout: string): ListedScreen[] {
    const rows: ListedScreen[] = []
    for (const line of stdout.split('\n')) {
        if (!line.trim()) continue
        const [name, engineAgentId, launchNonce, sessionGeneration, managed, state] = line.split('\t')
        if (!name || !state) continue
        rows.push({
            name: name.replace(/^\//, ''),
            engineAgentId: engineAgentId ?? '',
            launchNonce: launchNonce ?? '',
            sessionGeneration: sessionGeneration ?? '',
            managed: managed ?? '',
            state,
        })
    }
    return rows
}

export function isDockerMiss(stderr: string): boolean {
    return /no such (object|container|volume|image)/i.test(stderr)
}

function dockerExecutable() {
    if (process.env.RERUN_DESKTOP_APP === '1' && process.platform === 'darwin') {
        const app = '/Applications/Docker.app/Contents/Resources/bin/docker'
        if (existsSync(app)) return app
    }
    return 'docker'
}

function collect(args: readonly string[], signal: AbortSignal, input?: Buffer): Promise<Collected> {
    throwIfAborted(signal)
    const child = spawn(dockerExecutable(), [...args], { shell: false, stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessByStdio<Writable, Readable, Readable>
    return new Promise(resolve => {
        const out: Buffer[] = []
        const err: Buffer[] = []
        let stdoutBytes = 0
        let stderrBytes = 0
        let tooLarge = false
        let settled = false
        const finish = (result: Collected) => {
            if (settled) return
            settled = true
            signal.removeEventListener('abort', onAbort)
            resolve(result)
        }
        const onAbort = () => {
            child.kill('SIGKILL')
        }
        signal.addEventListener('abort', onAbort, { once: true })
        child.stdout.on('data', chunk => {
            const piece = Buffer.from(chunk as Buffer)
            stdoutBytes += piece.length
            if (stdoutBytes > STDOUT_CAP) {
                tooLarge = true
                child.kill('SIGKILL')
                return
            }
            out.push(piece)
        })
        child.stderr.on('data', chunk => {
            if (stderrBytes > STDERR_CAP) return
            const piece = Buffer.from(chunk as Buffer)
            stderrBytes += piece.length
            err.push(piece)
        })
        child.stdin.on('error', () => {})
        child.on('error', error => finish({ code: null, stdout: Buffer.concat(out), stderr: Buffer.concat(err), error: error as NodeJS.ErrnoException, tooLarge }))
        child.on('close', code => finish({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err), tooLarge }))
        if (input && input.length > 0) child.stdin.end(input)
        else child.stdin.end()
    })
}

function prerequisiteError(result: Collected): IsolatedScreenRefusal | null {
    if (result.error?.code === 'ENOENT') return new IsolatedScreenRefusal('Docker is not installed.', 'prerequisite')
    if (result.error) return new IsolatedScreenRefusal('Docker is not running.', 'prerequisite')
    return null
}

export function createDockerCli(): DockerClient {
    return {
        async version(signal) {
            const result = await collect([...VERSION_ARGS], signal)
            throwIfAborted(signal)
            if (result.error?.code === 'ENOENT') return { kind: 'missing' }
            if (result.error || result.code !== 0 || result.tooLarge) return { kind: 'unreachable' }
            const parsed = parseVersion(result.stdout.toString('utf8'))
            return parsed ? { kind: 'ok', os: parsed.os, arch: parsed.arch } : { kind: 'unreachable' }
        },
        async image(signal) {
            const result = await collect(imageInspectArgs(), signal)
            throwIfAborted(signal)
            if (result.error || result.code === null || result.tooLarge) return { kind: 'unreachable' }
            if (result.code !== 0) return isDockerMiss(result.stderr.toString('utf8')) ? { kind: 'missing' } : { kind: 'unreachable' }
            const architecture = result.stdout.toString('utf8').trim()
            return architecture ? { kind: 'present', architecture } : { kind: 'unreachable' }
        },
        async inspectContainer(name, signal) {
            const result = await collect(inspectContainerArgs(name), signal)
            throwIfAborted(signal)
            if (result.error || result.code === null || result.tooLarge) return { status: 'unreachable' }
            if (result.code !== 0) return isDockerMiss(result.stderr.toString('utf8')) ? { status: 'missing' } : { status: 'unreachable' }
            const parsed = parseContainerInspect(result.stdout.toString('utf8'))
            return parsed ? { status: 'found', ...parsed } : { status: 'unreachable' }
        },
        async inspectVolume(name, signal) {
            const result = await collect(inspectVolumeArgs(name), signal)
            throwIfAborted(signal)
            if (result.error || result.code === null || result.tooLarge) return { status: 'unreachable' }
            if (result.code !== 0) return isDockerMiss(result.stderr.toString('utf8')) ? { status: 'missing' } : { status: 'unreachable' }
            try {
                return { status: 'found', labels: parseLabels(result.stdout.toString('utf8')) }
            } catch {
                return { status: 'unreachable' }
            }
        },
        async createVolume(owner, signal) {
            const result = await collect(volumeCreateArgs(owner), signal)
            throwIfAborted(signal)
            const prerequisite = prerequisiteError(result)
            if (prerequisite) throw prerequisite
            if (result.tooLarge || result.code !== 0) throw new IsolatedScreenRefusal('The screen profile could not be kept.', 'closed')
        },
        async run(args, signal) {
            assertSafeRunArgs(args)
            const result = await collect(args, signal)
            throwIfAborted(signal)
            const prerequisite = prerequisiteError(result)
            if (prerequisite) throw prerequisite
            if (result.tooLarge || result.code !== 0) throw new IsolatedScreenRefusal('The screen did not start.', 'closed')
        },
        async removeContainer(name, signal) {
            const result = await collect(removeContainerArgs(name), signal)
            throwIfAborted(signal)
            const prerequisite = prerequisiteError(result)
            if (prerequisite) throw prerequisite
            if (result.code !== 0) throw new IsolatedScreenRefusal('The screen did not stop.', 'closed')
        },
        async removeVolume(name, signal) {
            const result = await collect(removeVolumeArgs(name), signal)
            throwIfAborted(signal)
            const prerequisite = prerequisiteError(result)
            if (prerequisite) throw prerequisite
            if (result.code !== 0) throw new IsolatedScreenRefusal('The screen profile could not be removed.', 'closed')
        },
        async listScreens(signal) {
            const result = await collect([...LIST_SCREEN_ARGS], signal)
            throwIfAborted(signal)
            const prerequisite = prerequisiteError(result)
            if (prerequisite) throw prerequisite
            if (result.tooLarge || result.code !== 0) throw new IsolatedScreenRefusal('Docker is not running.', 'prerequisite')
            return parseScreenList(result.stdout.toString('utf8'))
        },
        async exec(name, command, input, signal) {
            const result = await collect(execArgs(name, command), signal, input)
            throwIfAborted(signal)
            if (result.tooLarge) throw new IsolatedScreenRefusal('The screen response is too large.', 'closed')
            const prerequisite = prerequisiteError(result)
            if (prerequisite) throw prerequisite
            if (result.code !== 0) throw new IsolatedScreenRefusal('The screen action failed.', 'closed')
            return result.stdout
        },
        async execStream(name, command, signal) {
            throwIfAborted(signal)
            const child = spawn(dockerExecutable(), execArgs(name, command), { shell: false, stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessByStdio<Writable, Readable, Readable>
            child.stderr.resume()
            const stream = Duplex.from({ writable: child.stdin, readable: child.stdout })
            const kill = () => {
                if (!child.killed) child.kill('SIGKILL')
            }
            const onAbort = () => {
                kill()
                stream.destroy(abortError(signal))
            }
            signal.addEventListener('abort', onAbort, { once: true })
            child.on('error', error => {
                signal.removeEventListener('abort', onAbort)
                const code = (error as NodeJS.ErrnoException).code
                stream.destroy(new IsolatedScreenRefusal(code === 'ENOENT' ? 'Docker is not installed.' : 'Docker is not running.', 'prerequisite'))
            })
            child.on('close', () => signal.removeEventListener('abort', onAbort))
            stream.on('error', () => {})
            stream.on('close', kill)
            return Promise.resolve(stream)
        },
    }
}
