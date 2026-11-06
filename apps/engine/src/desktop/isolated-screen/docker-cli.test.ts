import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { vi } from 'vitest'

type Call = { command: string; args: string[]; shell: boolean | undefined; input: Buffer }

const state = vi.hoisted(() => ({
    calls: [] as Call[],
    code: 0,
    stdout: Buffer.alloc(0) as Buffer,
    stderr: Buffer.alloc(0) as Buffer,
    error: null as NodeJS.ErrnoException | null,
    hang: false,
    stream: false,
    streamError: null as NodeJS.ErrnoException | null,
    lastStdout: null as PassThrough | null,
    killed: false,
}))

vi.mock('node:child_process', () => ({
    spawn: (command: string, args: string[], options: { shell?: boolean }) => {
        const child = new EventEmitter()
        const stdin = new PassThrough()
        const stdout = new PassThrough()
        const stderr = new PassThrough()
        const call: Call = { command, args, shell: options.shell, input: Buffer.alloc(0) }
        state.calls.push(call)
        stdin.on('data', (chunk: Buffer) => { call.input = Buffer.concat([call.input, chunk]) })
        Object.assign(child, {
            stdin, stdout, stderr, killed: false,
            kill() {
                if (child.killed) return
                child.killed = true
                state.killed = true
                child.emit('close', null)
            },
        })
        if (state.stream) {
            state.lastStdout = stdout
            if (state.streamError) queueMicrotask(() => child.emit('error', state.streamError))
            return child
        }
        queueMicrotask(() => {
            if (state.hang) return
            if (state.error) {
                child.emit('error', state.error)
                return
            }
            if (state.stdout.length) stdout.write(state.stdout)
            stdout.end()
            if (state.stderr.length) stderr.write(state.stderr)
            stderr.end()
            child.emit('close', state.code)
        })
        return child
    },
}))

const { beforeEach, describe, expect, it } = await import('vitest')
const { createDockerCli, isDockerMiss, parseContainerInspect, parseLabels, parseScreenList, parseVersion } = await import('./docker-cli.js')
const { containerRunArgs } = await import('./docker-args.js')
const { containerName, volumeName } = await import('./identity.js')

const owner = { engineAgentId: 'coworker1', launchNonce: '11111111-1111-4111-8111-111111111111' }
const signal = () => new AbortController().signal
const client = createDockerCli()

beforeEach(() => {
    state.calls.length = 0
    state.code = 0
    state.stdout = Buffer.alloc(0)
    state.stderr = Buffer.alloc(0)
    state.error = null
    state.hang = false
    state.stream = false
    state.streamError = null
    state.lastStdout = null
    state.killed = false
})

describe('docker text', () => {
    it('parses version, labels, inspect, and list rows', () => {
        expect(parseVersion('linux arm64\n')).toEqual({ os: 'linux', arch: 'arm64' })
        expect(parseVersion('linux')).toBeNull()
        expect(parseVersion('')).toBeNull()
        expect(parseLabels('null')).toEqual({})
        expect(parseLabels('')).toEqual({})
        expect(parseLabels('[]')).toEqual({})
        expect(parseLabels('{"role":"isolated-screen","n":1}')).toEqual({ role: 'isolated-screen' })
        expect(parseContainerInspect('running\t{"role":"isolated-screen"}\n')).toEqual({ state: 'running', labels: { role: 'isolated-screen' } })
        expect(parseContainerInspect('no-tab')).toBeNull()
        expect(parseContainerInspect('running\t{')).toBeNull()
        expect(parseScreenList('/rerun-screen-abc\tcoworker1\tnonce\tgen\t1\trunning\n\nshort\n')).toEqual([
            { name: 'rerun-screen-abc', engineAgentId: 'coworker1', launchNonce: 'nonce', sessionGeneration: 'gen', managed: '1', state: 'running' },
        ])
        expect(isDockerMiss('Error: No such image: guest')).toBe(true)
        expect(isDockerMiss('No such container: x')).toBe(true)
        expect(isDockerMiss('No such volume: x')).toBe(true)
        expect(isDockerMiss('No such object: x')).toBe(true)
        expect(isDockerMiss('connection refused')).toBe(false)
    })
})

describe('docker cli', () => {
    it('asks docker with an argument array and no shell', async () => {
        state.stdout = Buffer.from('linux aarch64\n')
        await expect(client.version(signal())).resolves.toEqual({ kind: 'ok', os: 'linux', arch: 'aarch64' })
        expect(state.calls[0]).toMatchObject({ command: 'docker', shell: false, args: ['version', '--format', '{{.Server.Os}} {{.Server.Arch}}'] })
        state.stdout = Buffer.from('arm64\n')
        await expect(client.image(signal())).resolves.toEqual({ kind: 'present', architecture: 'arm64' })
    })

    it('reports a missing binary, a dead daemon, and a missing image without pulling', async () => {
        state.error = Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' })
        await expect(client.version(signal())).resolves.toEqual({ kind: 'missing' })
        state.error = Object.assign(new Error('denied'), { code: 'EACCES' })
        await expect(client.version(signal())).resolves.toEqual({ kind: 'unreachable' })
        state.error = null
        state.code = 1
        state.stderr = Buffer.from('Cannot connect')
        await expect(client.version(signal())).resolves.toEqual({ kind: 'unreachable' })
        state.code = 0
        state.stderr = Buffer.alloc(0)
        state.stdout = Buffer.from('   ')
        await expect(client.version(signal())).resolves.toEqual({ kind: 'unreachable' })
        state.code = 1
        state.stdout = Buffer.alloc(0)
        state.stderr = Buffer.from('Error: No such image: rerun-desktop-guest:round34\n')
        await expect(client.image(signal())).resolves.toEqual({ kind: 'missing' })
        state.stderr = Buffer.from('Cannot connect to the Docker daemon')
        await expect(client.image(signal())).resolves.toEqual({ kind: 'unreachable' })
        state.error = Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' })
        await expect(client.image(signal())).resolves.toEqual({ kind: 'unreachable' })
        expect(state.calls.every(call => call.args[0] !== 'pull')).toBe(true)
    })

    it('inspects, creates, lists, and removes only the named screen', async () => {
        const name = containerName(owner.engineAgentId)
        state.stdout = Buffer.from('running\t{"com.rerun.desktop.role":"isolated-screen"}\n')
        await expect(client.inspectContainer(name, signal())).resolves.toMatchObject({ status: 'found', state: 'running' })
        state.code = 1
        state.stdout = Buffer.alloc(0)
        state.stderr = Buffer.from('Error: No such container: x')
        await expect(client.inspectContainer(name, signal())).resolves.toEqual({ status: 'missing' })
        state.stderr = Buffer.from('daemon died')
        await expect(client.inspectContainer(name, signal())).resolves.toEqual({ status: 'unreachable' })
        state.code = 0
        state.stderr = Buffer.alloc(0)
        state.stdout = Buffer.from('running\t{')
        await expect(client.inspectContainer(name, signal())).resolves.toEqual({ status: 'unreachable' })
        state.stdout = Buffer.from('null\n')
        await expect(client.inspectVolume(volumeName(owner.engineAgentId), signal())).resolves.toEqual({ status: 'found', labels: {} })
        state.stdout = Buffer.from('{')
        await expect(client.inspectVolume(volumeName(owner.engineAgentId), signal())).resolves.toEqual({ status: 'unreachable' })
        state.code = 1
        state.stdout = Buffer.alloc(0)
        state.stderr = Buffer.from('Error: No such volume: x')
        await expect(client.inspectVolume(volumeName(owner.engineAgentId), signal())).resolves.toEqual({ status: 'missing' })
        state.code = 0
        state.stderr = Buffer.alloc(0)
        await client.createVolume(owner, signal())
        state.code = 1
        await expect(client.createVolume(owner, signal())).rejects.toThrow(/profile could not be kept/)
        state.code = 0
        state.stdout = Buffer.from(`${name}\t${owner.engineAgentId}\t${owner.launchNonce}\t${'ab'.repeat(16)}\t1\trunning\n`)
        await expect(client.listScreens(signal())).resolves.toHaveLength(1)
        state.code = 1
        await expect(client.listScreens(signal())).rejects.toThrow(/Docker is not running/)
        state.code = 0
        await client.removeContainer(name, signal())
        expect(state.calls.at(-1)?.args).toEqual(['rm', '-f', '--', name])
        state.code = 1
        await expect(client.removeVolume(volumeName(owner.engineAgentId), signal())).rejects.toThrow(/could not be removed/)
        state.error = Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' })
        await expect(client.removeContainer(name, signal())).rejects.toThrow(/Docker is not installed/)
    })

    it('runs the guest only when the arguments publish nothing', async () => {
        const args = containerRunArgs(owner, 'ab'.repeat(16))
        await client.run(args, signal())
        expect(state.calls.at(-1)?.args).toEqual([...args])
        expect(state.calls.at(-1)?.shell).toBe(false)
        const bad = [...args]
        bad.splice(bad.length - 1, 0, '/Users/me')
        await expect(client.run(bad, signal())).rejects.toThrow(/host mount/)
        state.code = 1
        await expect(client.run(args, signal())).rejects.toThrow(/did not start/)
    })

    it('bridges rpc and vnc without a published address', async () => {
        const name = containerName(owner.engineAgentId)
        state.stdout = Buffer.from('frame')
        await expect(client.exec(name, ['rerun-rpc'], Buffer.from('in'), signal())).resolves.toEqual(Buffer.from('frame'))
        expect(state.calls.at(-1)).toMatchObject({ shell: false, args: ['exec', '-i', '--', name, 'rerun-rpc'] })
        expect(state.calls.at(-1)?.input.equals(Buffer.from('in'))).toBe(true)
        await expect(client.exec(name, ['sh'], Buffer.alloc(0), signal())).rejects.toThrow(/not available/)
        state.code = 1
        state.stdout = Buffer.from('nope')
        await expect(client.exec(name, ['rerun-rpc'], Buffer.from('in'), signal())).rejects.toThrow(/failed/)
        state.code = 0
        state.stream = true
        const watched = await client.execStream(name, ['rerun-vnc', 'watch'], signal())
        expect(state.calls.at(-1)?.args).toEqual(['exec', '-i', '--', name, 'rerun-vnc', 'watch'])
        const received = new Promise<Buffer>(resolve => watched.once('data', resolve))
        state.lastStdout?.write(Buffer.from('RFB'))
        expect((await received).toString()).toBe('RFB')
        watched.destroy()
        await vi.waitFor(() => expect(state.killed).toBe(true))
        state.killed = false
        state.streamError = Object.assign(new Error('missing'), { code: 'ENOENT' })
        const broken = await client.execStream(name, ['rerun-vnc', 'drive'], signal())
        await expect(new Promise((_, reject) => broken.once('error', reject))).rejects.toThrow(/Docker is not installed/)
        state.streamError = Object.assign(new Error('down'), { code: 'EACCES' })
        const down = await client.execStream(name, ['rerun-vnc', 'watch'], signal())
        await expect(new Promise((_, reject) => down.once('error', reject))).rejects.toThrow(/Docker is not running/)
    })

    it('kills the docker process when the caller aborts and drops an oversized reply', async () => {
        const aborted = new AbortController()
        aborted.abort()
        await expect(client.version(aborted.signal)).rejects.toMatchObject({ name: 'AbortError' })
        expect(state.calls).toHaveLength(0)
        await expect(client.execStream(containerName(owner.engineAgentId), ['rerun-vnc', 'watch'], aborted.signal)).rejects.toMatchObject({ name: 'AbortError' })
        state.hang = true
        const controller = new AbortController()
        const pending = client.version(controller.signal)
        await Promise.resolve()
        controller.abort()
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
        expect(state.killed).toBe(true)
        state.hang = false
        state.killed = false
        state.stdout = Buffer.alloc(8 * 1024 * 1024 + 1_000_000 + 9)
        await expect(client.version(signal())).resolves.toEqual({ kind: 'unreachable' })
        state.stdout = Buffer.alloc(8 * 1024 * 1024 + 1_000_000 + 9)
        await expect(client.exec(containerName(owner.engineAgentId), ['rerun-rpc'], Buffer.from('in'), signal())).rejects.toThrow(/too large/)
        const streaming = new AbortController()
        state.stream = true
        state.stdout = Buffer.alloc(0)
        const stream = await client.execStream(containerName(owner.engineAgentId), ['rerun-vnc', 'drive'], streaming.signal)
        streaming.abort()
        expect(stream.destroyed).toBe(true)
        expect(state.killed).toBe(true)
    })
})
