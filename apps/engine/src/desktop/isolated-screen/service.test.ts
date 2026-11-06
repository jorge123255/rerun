import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { containerRunArgs } from './docker-args.js'
import type { DockerClient, DockerImage, DockerVersion, ListedScreen } from './docker-cli.js'
import { decodeFrame } from './frame.js'
import { containerLabels, containerName, LABEL_GENERATION, volumeLabels, volumeName } from './identity.js'
import { HUMAN_DRIVING } from './input.js'
import { createIsolatedScreenService, type IsolatedScreenDeps } from './service.js'
import type { IsolatedScreenService, ScreenOwner, ScreenTarget, ViewerMode } from './types.js'
import { createDesktopGuestShellService } from '../guest-shell/service.js'
import { createDesktopGuestShellTransport } from '../guest-shell/transport.js'
import type { DesktopGuestShellReceipt } from '../guest-shell/types.js'

const owner: ScreenOwner = { engineAgentId: 'coworker1', launchNonce: '11111111-1111-4111-8111-111111111111' }
const otherOwner: ScreenOwner = { engineAgentId: 'coworker2', launchNonce: owner.launchNonce }
const nextNonce = '22222222-2222-4222-8222-222222222222'
const oldNonce = '99999999-9999-4999-8999-999999999999'
const generation = 'ab'.repeat(16)

type ExecCall = { name: string; command: string[]; body: Record<string, unknown> }
type StreamCall = { name: string; command: string[]; duplex: PassThrough }

class FakeDocker implements DockerClient {
    versionKind: DockerVersion = { kind: 'ok', os: 'linux', arch: 'arm64' }
    imageKind: DockerImage = { kind: 'present', architecture: 'arm64' }
    containers = new Map<string, { state: string; labels: Record<string, string> }>()
    volumes = new Map<string, { labels: Record<string, string> }>()
    runs: string[][] = []
    removedContainers: string[] = []
    removedVolumes: string[] = []
    createdVolumes: string[] = []
    execs: ExecCall[] = []
    streams: StreamCall[] = []
    rows: ListedScreen[] | null = null
    versionCalls = 0
    imageCalls = 0
    listCalls = 0
    inspectMode: 'ok' | 'container-down' | 'volume-down' = 'ok'
    pingReady = true
    width = 1920
    height = 1080
    locationUrl: string | null = 'https://example.com/page'
    locationFails = false
    emptyShot = false
    badGeometry = false
    foreground = { app: 'browser', windowId: '123' }
    launchers: { terminal: boolean; files: boolean } | undefined
    failReason: unknown = undefined
    failRefusal = true
    holdOps = new Set<string>()
    onHold: (() => void) | null = null
    beforeStream: ((command: readonly string[]) => Promise<void> | void) | null = null
    afterRun: ((name: string) => void) | null = null
    execHook: ((body: Record<string, unknown>) => void) | null = null
    guestShellCancelReply: Record<string, unknown> | undefined
    bytes = 0

    version(signal: AbortSignal): Promise<DockerVersion> {
        this.versionCalls += 1
        if (signal.aborted) return Promise.reject(abortErr())
        return Promise.resolve(this.versionKind)
    }

    image(signal: AbortSignal): Promise<DockerImage> {
        this.imageCalls += 1
        if (signal.aborted) return Promise.reject(abortErr())
        return Promise.resolve(this.imageKind)
    }

    inspectContainer(name: string): Promise<Awaited<ReturnType<DockerClient['inspectContainer']>>> {
        if (this.inspectMode === 'container-down') return Promise.resolve({ status: 'unreachable' })
        const found = this.containers.get(name)
        if (!found) return Promise.resolve({ status: 'missing' })
        return Promise.resolve({ status: 'found', state: found.state, labels: found.labels })
    }

    inspectVolume(name: string): Promise<Awaited<ReturnType<DockerClient['inspectVolume']>>> {
        if (this.inspectMode === 'volume-down') return Promise.resolve({ status: 'unreachable' })
        const found = this.volumes.get(name)
        if (!found) return Promise.resolve({ status: 'missing' })
        return Promise.resolve({ status: 'found', labels: found.labels })
    }

    createVolume(next: ScreenOwner): Promise<void> {
        const name = volumeName(next.engineAgentId)
        this.createdVolumes.push(name)
        this.volumes.set(name, { labels: volumeLabels(next) })
        return Promise.resolve()
    }

    run(args: readonly string[]): Promise<void> {
        const copy = [...args]
        this.runs.push(copy)
        const name = copy[copy.indexOf('--name') + 1] ?? ''
        const labels: Record<string, string> = {}
        for (let index = 0; index < copy.length; index += 1) {
            if (copy[index] !== '--label') continue
            const raw = copy[index + 1] ?? ''
            const split = raw.indexOf('=')
            labels[raw.slice(0, split)] = raw.slice(split + 1)
        }
        this.containers.set(name, { state: 'running', labels })
        this.afterRun?.(name)
        return Promise.resolve()
    }

    removeContainer(name: string): Promise<void> {
        this.removedContainers.push(name)
        this.containers.delete(name)
        return Promise.resolve()
    }

    removeVolume(name: string): Promise<void> {
        this.removedVolumes.push(name)
        this.volumes.delete(name)
        return Promise.resolve()
    }

    listScreens(): Promise<ListedScreen[]> {
        this.listCalls += 1
        if (this.rows) return Promise.resolve(this.rows)
        return Promise.resolve([...this.containers].map(([name, container]) => ({
            name,
            engineAgentId: container.labels['com.rerun.engineAgentId'] ?? '',
            launchNonce: container.labels['com.rerun.launchNonce'] ?? '',
            sessionGeneration: container.labels['com.rerun.sessionGeneration'] ?? '',
            managed: container.labels['com.rerun.desktop.managed'] ?? '',
            state: container.state,
        })))
    }

    exec(name: string, command: readonly string[], input: Buffer, signal: AbortSignal): Promise<Buffer> {
        const body = decodeFrame(input).value as Record<string, unknown>
        this.execs.push({ name, command: [...command], body })
        this.execHook?.(body)
        if (signal.aborted) return Promise.reject(abortErr())
        if (this.holdOps.has(String(body.op))) {
            return new Promise((_resolve, reject) => {
                const fail = () => reject(abortErr())
                if (signal.aborted) { fail(); return }
                signal.addEventListener('abort', fail, { once: true })
                this.onHold?.()
            })
        }
        return Promise.resolve(this.reply(body))
    }

    async execStream(name: string, command: readonly string[], signal: AbortSignal): Promise<PassThrough> {
        if (signal.aborted) throw abortErr()
        const duplex = new PassThrough()
        this.streams.push({ name, command: [...command], duplex })
        await this.beforeStream?.(command)
        return duplex
    }

    seed(next: ScreenOwner, sessionGeneration: string, state: string): void {
        this.containers.set(containerName(next.engineAgentId), { state, labels: containerLabels(next, sessionGeneration) })
        this.volumes.set(volumeName(next.engineAgentId), { labels: volumeLabels(next) })
    }

    private reply(body: Record<string, unknown>): Buffer {
        if (this.failReason !== undefined && body.op === 'navigate') {
            const reason = this.failReason
            this.failReason = undefined
            return encodeFailure(reason, this.failRefusal)
        }
        if (body.op === 'ping') {
            if (!this.pingReady) return encodeFailure('starting', true)
            return encodeOk({ ready: true, width: this.width, height: this.height, ...(this.launchers ? { launchers: this.launchers } : {}) })
        }
        if (body.op === 'foreground') return encodeOk(this.foreground)
        if (body.op === 'focus-browser') { this.foreground = { app: 'browser', windowId: '123' }; return encodeOk({}) }
        if (body.op === 'screenshot') {
            if (this.badGeometry) return encodeOk({ width: 'wide' }, Buffer.from([1]))
            return encodeOk({ width: this.width, height: this.height }, this.emptyShot ? Buffer.alloc(0) : Buffer.from([1, 2, 3, 4]))
        }
        if (body.op === 'navigate') {
            const url = String(body.url)
            return encodeOk({ pageOptionsVersion: 1, status: 200, finalUrl: url, text: 'Hello', html: '<p>secret</p>', truncated: false, links: body.links ? [{ href: 'https://example.com/a', text: 'A' }] : [], linksTruncated: false, htmlBytes: 0, screenshotBytes: 0, screenshotWidth: 0, screenshotHeight: 0, exportErrors: [] })
        }
        if (body.op === 'guest-shell' || body.op === 'guest-shell-inspect') return encodeOk({ requestId: body.commandId, status: 'done', stdout: 'ok', stderr: '', exitCode: 0, durationMs: 1 })
        if (body.op === 'guest-shell-cancel') return encodeOk(this.guestShellCancelReply ?? { requestId: body.commandId, drained: true })
        if (body.op === 'location') {
            if (this.locationFails) return encodeFailure('no tab', false)
            return encodeOk({ url: this.locationUrl })
        }
        return encodeOk({})
    }
}

function abortErr(): Error {
    return Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
}

function encodeOk(value: Record<string, unknown>, binary = Buffer.alloc(0)): Buffer {
    return encodeFrame({ ok: true, ...value }, binary)
}

function encodeFailure(reason: unknown, refusal: boolean): Buffer {
    return encodeFrame({ ok: false, reason, refusal })
}

function encodeFrame(value: unknown, binary: Buffer = Buffer.alloc(0)): Buffer {
    const body = Buffer.from(JSON.stringify(value))
    const header = Buffer.alloc(8)
    header.writeUInt32BE(body.length, 0)
    header.writeUInt32BE(binary.length, 4)
    return Buffer.concat([header, body, binary])
}

function harness(options: Partial<IsolatedScreenDeps> = {}): { docker: FakeDocker; service: IsolatedScreenService; sleeps: number[]; encoded: Array<{ width: number; height: number }> } {
    const docker = new FakeDocker()
    const sleeps: number[] = []
    const encoded: Array<{ width: number; height: number }> = []
    const service = createIsolatedScreenService({
        docker,
        authorizeInput: async () => {},
        encodeJpeg: async (_png, width, height) => {
            encoded.push({ width, height })
            return Buffer.from('jpeg')
        },
        randomBytes: size => {
            const buf = Buffer.alloc(size)
            buf[size - 1] = ++docker.bytes
            return buf
        },
        sleep: async ms => { sleeps.push(ms) },
        readyAttempts: 4,
        ...options,
    })
    return { docker, service, sleeps, encoded }
}

async function boot(box = harness()) {
    const signal = new AbortController().signal
    const screen = await box.service.ensure(owner, signal)
    return { ...box, signal, screen, target: screen.target }
}

it('running inspection refuses absent/stopped guests without creating or restarting them', async () => {
    const box = harness(), signal = new AbortController().signal
    await expect(box.service.running(owner, signal)).rejects.toThrow()
    expect(box.docker.containers.size).toBe(0)
    const screen = await box.service.ensure(owner, signal)
    expect((await box.service.running(owner, signal)).target).toEqual(screen.target)
    box.docker.containers.get(containerName(owner.engineAgentId))!.state = 'exited'
    await expect(box.service.running(owner, signal)).rejects.toThrow()
    expect(box.docker.containers.get(containerName(owner.engineAgentId))!.state).toBe('exited')
})

describe('isolated screen prerequisites', () => {
    it('reports a missing image without starting a container', async () => {
        const { docker, service } = harness()
        docker.imageKind = { kind: 'missing' }
        const signal = new AbortController().signal
        await expect(service.status(owner, signal)).resolves.toEqual({ available: false, prerequisite: 'image-missing', state: 'absent' })
        await expect(service.ensure(owner, signal)).rejects.toMatchObject({ kind: 'prerequisite', message: 'The isolated screen image rerun-desktop-guest:round34 is not built.' })
        expect(docker.runs).toEqual([])
        expect(docker.createdVolumes).toEqual([])
    })

    it('distinguishes a stopped daemon from a missing image', async () => {
        const { docker, service } = harness()
        docker.versionKind = { kind: 'unreachable' }
        const signal = new AbortController().signal
        await expect(service.status(owner, signal)).resolves.toEqual({ available: false, prerequisite: 'daemon-unreachable', state: 'absent' })
        expect(docker.imageCalls).toBe(0)
        docker.versionKind = { kind: 'missing' }
        await expect(service.ensure(owner, signal)).rejects.toMatchObject({ message: 'Docker is not installed.' })
    })

    it('refuses a docker engine that is not linux/arm64 before it inspects the image', async () => {
        const { docker, service } = harness()
        docker.versionKind = { kind: 'ok', os: 'linux', arch: 'amd64' }
        const signal = new AbortController().signal
        await expect(service.ensure(owner, signal)).rejects.toMatchObject({ kind: 'prerequisite', message: 'Docker is not a linux/arm64 engine.' })
        expect(docker.imageCalls).toBe(0)
        docker.versionKind = { kind: 'ok', os: 'darwin', arch: 'arm64' }
        await expect(service.status(owner, signal)).resolves.toMatchObject({ prerequisite: 'docker-wrong-arch' })
    })

    it('accepts an aarch64 image and rejects an amd64 image', async () => {
        const arm = harness()
        arm.docker.imageKind = { kind: 'present', architecture: 'aarch64' }
        const signal = new AbortController().signal
        await expect(arm.service.ensure(owner, signal)).resolves.toMatchObject({ width: 1280, height: 720 })
        const wrong = harness()
        wrong.docker.imageKind = { kind: 'present', architecture: 'amd64' }
        await expect(wrong.service.ensure(owner, signal)).rejects.toMatchObject({ message: 'The isolated screen image is not arm64.' })
        expect(wrong.docker.runs).toEqual([])
    })

    it('does not delete a container or volume that lacks this coworker label', async () => {
        const { docker, service } = harness()
        const signal = new AbortController().signal
        docker.containers.set(containerName(owner.engineAgentId), { state: 'running', labels: { other: '1' } })
        await expect(service.ensure(owner, signal)).rejects.toMatchObject({ kind: 'conflict', message: 'A container or volume already uses this screen name without Rerun labels.' })
        expect(docker.removedContainers).toEqual([])
        const volumeOnly = harness()
        volumeOnly.docker.volumes.set(volumeName(owner.engineAgentId), { labels: { other: '1' } })
        await expect(volumeOnly.service.ensure(owner, signal)).rejects.toMatchObject({ kind: 'conflict' })
        expect(volumeOnly.docker.removedVolumes).toEqual([])
        expect(volumeOnly.docker.createdVolumes).toEqual([])
    })

    it('reports an unreachable volume without calling it a missing image', async () => {
        const { docker, service } = harness()
        docker.inspectMode = 'volume-down'
        await expect(service.status(owner, new AbortController().signal)).resolves.toMatchObject({ prerequisite: 'daemon-unreachable' })
        expect(docker.imageCalls).toBe(1)
    })
})

describe('isolated screen lifecycle', () => {
    it('starts one labeled guest and reuses its generation', async () => {
        const box = await boot()
        expect(box.screen).toMatchObject({ width: 1280, height: 720 })
        expect(box.target.sessionGeneration).toMatch(/^[a-f0-9]{32}$/)
        const args = box.docker.runs[0] ?? []
        expect(args).toEqual(containerRunArgs(owner, box.target.sessionGeneration))
        for (const banned of ['--platform', '--publish', '--privileged', '--network', '-p', '-v', '--volume', 'pull']) expect(args).not.toContain(banned)
        const flat = args.join('\n')
        for (const banned of ['docker.sock', '/Users/', 'type=bind']) expect(flat).not.toContain(banned)
        expect(box.docker.createdVolumes).toEqual([volumeName(owner.engineAgentId)])
        const again = await box.service.ensure(owner, box.signal)
        expect(again.target.sessionGeneration).toBe(box.target.sessionGeneration)
        expect(box.docker.runs).toHaveLength(1)
        const status = await box.service.status(owner, box.signal)
        expect(status).toEqual({ available: true, prerequisite: 'ready', state: 'running' })
        const text = JSON.stringify(status)
        for (const banned of ['5900', '5901', 'sock', '127.0.0.1', '/Users', 'token', 'password', 'http']) expect(text).not.toContain(banned)
    })

    it('is available before the guest exists and reports docker state', async () => {
        const { docker, service } = harness()
        const signal = new AbortController().signal
        await expect(service.status(owner, signal)).resolves.toEqual({ available: true, prerequisite: 'ready', state: 'absent' })
        docker.seed(owner, generation, 'created')
        await expect(service.status(owner, signal)).resolves.toMatchObject({ state: 'starting', available: true })
        docker.containers.get(containerName(owner.engineAgentId))!.state = 'exited'
        await expect(service.status(owner, signal)).resolves.toMatchObject({ state: 'stopped' })
    })

    it('replaces a guest for a new engine launch and keeps the profile volume', async () => {
        const box = await boot()
        const first = box.target.sessionGeneration
        const again = await box.service.ensure({ ...owner, launchNonce: nextNonce }, box.signal)
        expect(again.target.sessionGeneration).not.toBe(first)
        expect(box.docker.removedContainers).toEqual([containerName(owner.engineAgentId)])
        expect(box.docker.removedVolumes).toEqual([])
        expect(box.docker.createdVolumes).toEqual([volumeName(owner.engineAgentId)])
    })

    it('does not reuse a generation remembered only by a previous process', async () => {
        const box = await boot()
        const restarted = createIsolatedScreenService({
            docker: box.docker,
            encodeJpeg: async () => Buffer.from('jpeg'),
            randomBytes: size => {
                const buf = Buffer.alloc(size)
                buf[size - 1] = 90
                return buf
            },
            sleep: async () => undefined,
            readyAttempts: 2,
        })
        const screen = await restarted.ensure(owner, box.signal)
        expect(screen.target.sessionGeneration).not.toBe(box.target.sessionGeneration)
        expect(box.docker.runs).toHaveLength(2)
        expect(box.docker.removedVolumes).toEqual([])
        expect(box.docker.createdVolumes).toHaveLength(1)
    })

    it('removes the exact container when startup is cancelled', async () => {
        const { docker, service } = harness()
        const controller = new AbortController()
        docker.execHook = body => { if (body.op === 'ping') controller.abort() }
        await expect(service.ensure(owner, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
        expect(docker.removedContainers).toEqual([containerName(owner.engineAgentId)])
        expect(docker.removedVolumes).toEqual([])
        expect(docker.createdVolumes).toEqual([volumeName(owner.engineAgentId)])
        expect(docker.containers.size).toBe(0)
    })

    it('removes a guest that exits and keeps the profile', async () => {
        const { docker, service } = harness()
        docker.afterRun = name => { docker.containers.get(name)!.state = 'exited' }
        await expect(service.ensure(owner, new AbortController().signal)).rejects.toMatchObject({ kind: 'closed', message: 'The screen did not start.' })
        expect(docker.removedContainers).toEqual([containerName(owner.engineAgentId)])
        expect(docker.removedVolumes).toEqual([])
        expect(docker.volumes.has(volumeName(owner.engineAgentId))).toBe(true)
    })

    it('removes a guest that never becomes ready and keeps the profile', async () => {
        const { docker, service, sleeps } = harness({ readyAttempts: 2 })
        docker.pingReady = false
        await expect(service.ensure(owner, new AbortController().signal)).rejects.toMatchObject({ message: 'The screen did not start.' })
        expect(sleeps).toEqual([200, 200])
        expect(docker.removedContainers).toHaveLength(1)
        expect(docker.removedVolumes).toEqual([])
    })

    it('does not remove a guest when docker disappears during startup', async () => {
        const { docker, service } = harness()
        docker.afterRun = () => { docker.inspectMode = 'container-down' }
        await expect(service.ensure(owner, new AbortController().signal)).rejects.toMatchObject({ kind: 'prerequisite', message: 'Docker is not running.' })
        expect(docker.removedContainers).toEqual([])
        expect(docker.containers.size).toBe(1)
    })

    it('stops the container for this generation and keeps the volume', async () => {
        const box = await boot()
        await box.service.stop(box.target, box.signal)
        expect(box.docker.removedContainers).toEqual([containerName(owner.engineAgentId)])
        expect(box.docker.removedVolumes).toEqual([])
        await expect(box.service.act(box.target, { action: 'screenshot' }, box.signal)).rejects.toMatchObject({ kind: 'stale', message: 'This screen session is no longer current.' })
    })

    it('does not remove a container whose generation or labels changed', async () => {
        const stale = await boot()
        stale.docker.containers.get(containerName(owner.engineAgentId))!.labels[LABEL_GENERATION] = generation
        await expect(stale.service.stop(stale.target, stale.signal)).resolves.toBeUndefined()
        expect(stale.docker.removedContainers).toEqual([])
        const foreign = await boot()
        foreign.docker.containers.get(containerName(owner.engineAgentId))!.labels = { other: '1' }
        await expect(foreign.service.stop(foreign.target, foreign.signal)).rejects.toMatchObject({ kind: 'conflict' })
        expect(foreign.docker.removedContainers).toEqual([])
        await expect(foreign.service.act(foreign.target, { action: 'screenshot' }, foreign.signal)).rejects.toMatchObject({ kind: 'stale' })
    })

    it('dispose removes the container and the profile only when both labels match', async () => {
        const box = await boot()
        await box.service.dispose(owner, box.signal)
        expect(box.docker.removedContainers).toEqual([containerName(owner.engineAgentId)])
        expect(box.docker.removedVolumes).toEqual([volumeName(owner.engineAgentId)])
        const conflict = harness()
        conflict.docker.containers.set(containerName(owner.engineAgentId), { state: 'running', labels: { other: '1' } })
        await expect(conflict.service.dispose(owner, new AbortController().signal)).rejects.toMatchObject({ kind: 'conflict' })
        expect(conflict.docker.removedContainers).toEqual([])
        const profile = await boot()
        profile.docker.volumes.get(volumeName(owner.engineAgentId))!.labels = { other: '1' }
        await expect(profile.service.dispose(owner, profile.signal)).rejects.toMatchObject({ kind: 'conflict' })
        expect(profile.docker.removedContainers).toEqual([containerName(owner.engineAgentId)])
        expect(profile.docker.removedVolumes).toEqual([])
        await expect(profile.service.dispose(owner, profile.signal)).rejects.toMatchObject({ kind: 'conflict' })
        expect(profile.docker.volumes.has(volumeName(owner.engineAgentId))).toBe(true)
    })
})

describe('isolated screen actions', () => {
    it('navigates over http and drops page html', async () => {
        const box = await boot()
        const page = await box.service.navigate(box.target, { url: 'https://example.com/hello', links: true }, box.signal)
        expect(page).toEqual({ status: 200, finalUrl: 'https://example.com/hello', text: 'Hello', truncated: false, links: [{ href: 'https://example.com/a', text: 'A' }], wall: null, outcome: 'ok', linksTruncated: false })
        expect(page).not.toHaveProperty('html')
        const before = box.docker.execs.length
        for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'about:blank', 'chrome://settings', 'https://user:pass@example.com/', 'http://.evil', 'http://a..b']) {
            await expect(box.service.navigate(box.target, { url }, box.signal)).rejects.toMatchObject({ kind: 'refused', message: 'Open an http or https page.' })
        }
        expect(box.docker.execs).toHaveLength(before)
    })

    it('hides guest reasons that could carry a path or address', async () => {
        const box = await boot()
        const cases: Array<[unknown, string]> = [
            ['no page', 'no page'],
            ['see http://example.com', 'The screen action failed.'],
            ['look /Users/me', 'The screen action failed.'],
            ['docker.sock', 'The screen action failed.'],
            ['a\\b', 'The screen action failed.'],
            ['café', 'The screen action failed.'],
            ['', 'The screen action failed.'],
            ['x'.repeat(201), 'The screen action failed.'],
        ]
        for (const [reason, message] of cases) {
            box.docker.failReason = reason
            await expect(box.service.navigate(box.target, { url: 'https://example.com/' }, box.signal)).rejects.toMatchObject({ message })
        }
    })

    it('returns jpeg bytes and maps a click into framebuffer pixels', async () => {
        const box = await boot()
        const shot = await box.service.act(box.target, { action: 'screenshot' }, box.signal)
        expect(Buffer.isBuffer(shot.image)).toBe(true)
        expect(shot).toMatchObject({ mediaType: 'image/jpeg', width: 1280, height: 720 })
        expect(shot.image.equals(Buffer.from('jpeg'))).toBe(true)
        expect(String(shot.image)).not.toContain('/Users')
        expect(box.encoded.at(-1)).toEqual({ width: 1280, height: 720 })
        await box.service.act(box.target, { action: 'left_click', coordinate: [10, 20] }, box.signal)
        const click = box.docker.execs.map(call => call.body).find(body => body.action === 'click')
        expect(click).toMatchObject({ op: 'input', button: 'left', x: 15, y: 30 })
        expect(box.docker.execs.every(call => call.command.join(' ') === 'rerun-rpc' && call.name === containerName(owner.engineAgentId))).toBe(true)
        expect(box.sleeps).toEqual([600])
    })

    it('waits on the host and types in bounded chunks', async () => {
        const box = await boot()
        await box.service.act(box.target, { action: 'wait' }, box.signal)
        expect(box.sleeps).toEqual([1000])
        box.sleeps.length = 0
        await box.service.act(box.target, { action: 'type', text: 'a'.repeat(50) }, box.signal)
        const typed = box.docker.execs.map(call => call.body).filter(body => body.action === 'type').map(body => body.text)
        expect(typed).toEqual(['a'.repeat(40), 'a'.repeat(10)])
        expect(box.sleeps).toEqual([600])
    })

    it('cancels a wait without removing the profile or the container', async () => {
        const controller = new AbortController()
        const { docker, service } = harness({
            sleep: async (ms, signal) => {
                if (ms === 1000) controller.abort()
                if (signal.aborted) throw abortErr()
            },
        })
        const signal = new AbortController().signal
        const screen = await service.ensure(owner, signal)
        await expect(service.act(screen.target, { action: 'wait' }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
        expect(docker.removedContainers).toEqual([])
        expect(docker.removedVolumes).toEqual([])
    })

    it('refuses a screenshot that has no picture', async () => {
        const box = await boot()
        box.docker.emptyShot = true
        await expect(box.service.act(box.target, { action: 'screenshot' }, box.signal)).rejects.toMatchObject({ kind: 'closed', message: 'The screenshot could not be taken.' })
        box.docker.emptyShot = false
        box.docker.badGeometry = true
        await expect(box.service.act(box.target, { action: 'screenshot' }, box.signal)).rejects.toMatchObject({ message: 'The screenshot could not be taken.' })
        await expect(box.service.act(box.target, { action: 'left_click' }, box.signal)).rejects.toMatchObject({ kind: 'refused' })
    })
})

describe('isolated screen control', () => {
    it('keeps model hands off while a person holds the lease', async () => {
        const box = await boot()
        const lease = await box.service.startTakeover(box.target, box.signal)
        expect((await box.service.status(owner, box.signal)).state).toBe('human')
        const before = box.docker.execs.length
        await expect(box.service.act(box.target, { action: 'screenshot' }, box.signal)).rejects.toMatchObject({ kind: 'refused', message: HUMAN_DRIVING })
        await expect(box.service.navigate(box.target, { url: 'https://example.com/' }, box.signal)).rejects.toMatchObject({ message: HUMAN_DRIVING })
        expect(box.docker.execs).toHaveLength(before)
        await expect(box.service.startTakeover(box.target, box.signal)).rejects.toMatchObject({ message: 'The user is already driving this screen.' })
        await expect(box.service.finishTakeover(box.target, { token: 'f'.repeat(32) }, box.signal)).rejects.toMatchObject({ message: 'That takeover is no longer current.' })
        await expect(box.service.finishTakeover(box.target, lease, box.signal)).resolves.toEqual({ url: 'https://example.com/page' })
        expect((await box.service.status(owner, box.signal)).state).toBe('running')
        box.docker.locationUrl = 'file:///tmp/x'
        const again = await box.service.startTakeover(box.target, box.signal)
        await expect(box.service.finishTakeover(box.target, again, box.signal)).resolves.toEqual({ url: null })
        box.docker.locationFails = true
        const third = await box.service.startTakeover(box.target, box.signal)
        await expect(box.service.finishTakeover(box.target, third, box.signal)).resolves.toEqual({ url: null })
    })

    it('drops an in-flight model action when a person takes over', async () => {
        const box = await boot()
        let entered!: () => void
        const started = new Promise<void>(resolve => { entered = resolve })
        box.docker.holdOps.add('screenshot')
        box.docker.onHold = entered
        const acting = box.service.act(box.target, { action: 'screenshot' }, box.signal)
        const failed = expect(acting).rejects.toMatchObject({ message: HUMAN_DRIVING, kind: 'refused' })
        await started
        const lease = await box.service.startTakeover(box.target, box.signal)
        await failed
        expect(box.docker.execs.some(call => call.body.op === 'release')).toBe(true)
        expect(lease.token).toMatch(/^[a-f0-9]{32}$/)
    })

    it('does not take a screenshot after the person grabs the screen during settle', async () => {
        let service!: IsolatedScreenService
        let target!: ScreenTarget
        let pending: Promise<unknown> | undefined
        const docker = new FakeDocker()
        const signal = new AbortController().signal
        service = createIsolatedScreenService({
            docker,
            authorizeInput: async () => {},
            encodeJpeg: async () => Buffer.from('jpeg'),
            randomBytes: size => Buffer.alloc(size, 4),
            sleep: async ms => {
                if (ms === 600 && !pending) pending = service.startTakeover(target, signal)
                // The action must unwind before takeover obtains the owner lock.
                if (pending) throw new DOMException('Aborted', 'AbortError')
            },
            readyAttempts: 2,
        })
        target = (await service.ensure(owner, signal)).target
        await expect(service.act(target, { action: 'left_click', coordinate: [10, 20] }, signal)).rejects.toMatchObject({ message: HUMAN_DRIVING })
        await pending
        const ops = docker.execs.map(call => call.body.op)
        expect(ops).toContain('input')
        expect(ops).toContain('release')
        expect(ops).not.toContain('screenshot')
    })

    it('watches through the view-only command and drives only with a lease', async () => {
        const box = await boot()
        await expect(box.service.withViewer(box.target, 'drive', box.signal, async () => 'driven')).rejects.toMatchObject({ message: 'Take over the screen before driving it.' })
        expect(box.docker.streams).toHaveLength(0)
        await expect(box.service.withViewer(box.target, 'viewOnly' as ViewerMode, box.signal, async () => 1)).rejects.toMatchObject({ message: 'That screen action is not available.' })
        const lease = await box.service.startTakeover(box.target, box.signal)
        let watchStream!: PassThrough
        let driveStream!: PassThrough
        let releaseWatch!: () => void
        let releaseDrive!: () => void
        const watchReady = new Promise<void>(resolve => { releaseWatch = resolve })
        const driveReady = new Promise<void>(resolve => { releaseDrive = resolve })
        let openWatch!: () => void
        let openDrive!: () => void
        const watchOpened = new Promise<void>(resolve => { openWatch = resolve })
        const driveOpened = new Promise<void>(resolve => { openDrive = resolve })
        const watching = box.service.withViewer(box.target, 'watch', box.signal, async stream => {
            watchStream = stream as PassThrough
            openWatch()
            await watchReady
            return 'watch'
        })
        await watchOpened
        const driving = box.service.withViewer(box.target, 'drive', box.signal, async stream => {
            driveStream = stream as PassThrough
            openDrive()
            await driveReady
            return 'drive'
        })
        await driveOpened
        expect(box.docker.streams.map(stream => stream.command)).toEqual([['rerun-vnc', 'watch'], ['rerun-vnc', 'drive']])
        await box.service.finishTakeover(box.target, lease, box.signal)
        expect(driveStream.destroyed).toBe(true)
        expect(watchStream.destroyed).toBe(false)
        releaseWatch()
        releaseDrive()
        await expect(watching).resolves.toBe('watch')
        await expect(driving).resolves.toBe('drive')
    })

    it('closes a watch stream when the callback returns or the screen stops', async () => {
        const box = await boot()
        let seen!: PassThrough
        await expect(box.service.withViewer(box.target, 'watch', box.signal, async stream => {
            seen = stream as PassThrough
            throw new Error('viewer failed')
        })).rejects.toThrow('viewer failed')
        expect(seen.destroyed).toBe(true)
        let release!: () => void
        const gate = new Promise<void>(resolve => { release = resolve })
        let opened!: () => void
        const ready = new Promise<void>(resolve => { opened = resolve })
        let live!: PassThrough
        const pending = box.service.withViewer(box.target, 'watch', box.signal, async stream => {
            live = stream as PassThrough
            opened()
            await gate
        })
        await ready
        await box.service.stop(box.target, box.signal)
        expect(live.destroyed).toBe(true)
        release()
        await pending
    })

    it('rejects a drive whose lease ended before the stream is handed over', async () => {
        const box = await boot()
        const lease = await box.service.startTakeover(box.target, box.signal)
        let connected = false
        box.docker.beforeStream = async command => {
            if (command[1] === 'drive') await box.service.finishTakeover(box.target, lease, box.signal)
        }
        await expect(box.service.withViewer(box.target, 'drive', box.signal, async () => { connected = true })).rejects.toMatchObject({ message: 'Take over the screen before driving it.' })
        expect(connected).toBe(false)
        expect(box.docker.streams[0]?.duplex.destroyed).toBe(true)
    })

    it('rejects a viewer whose signal is already aborted', async () => {
        const box = await boot()
        const controller = new AbortController()
        controller.abort()
        await expect(box.service.withViewer(box.target, 'watch', controller.signal, async () => 1)).rejects.toMatchObject({ name: 'AbortError' })
        expect(box.docker.streams).toHaveLength(0)
        const late = new AbortController()
        box.docker.beforeStream = () => { late.abort() }
        await expect(box.service.withViewer(box.target, 'watch', late.signal, async () => 1)).rejects.toMatchObject({ name: 'AbortError' })
        expect(box.docker.streams[0]?.duplex.destroyed).toBe(true)
    })
})

describe('isolated screen ownership', () => {
    it('reconcile stops only guests from another launch', async () => {
        const { docker, service } = harness()
        docker.seed({ ...owner, launchNonce: oldNonce }, generation, 'running')
        docker.seed(otherOwner, generation, 'running')
        docker.rows = [
            { name: `rerun-screen-${'cd'.repeat(16)}`, engineAgentId: owner.engineAgentId, launchNonce: oldNonce, sessionGeneration: generation, managed: '1', state: 'running' },
            { name: containerName(owner.engineAgentId), engineAgentId: owner.engineAgentId, launchNonce: oldNonce, sessionGeneration: generation, managed: '1', state: 'running' },
            { name: containerName(otherOwner.engineAgentId), engineAgentId: otherOwner.engineAgentId, launchNonce: otherOwner.launchNonce, sessionGeneration: generation, managed: '1', state: 'running' },
        ]
        const signal = new AbortController().signal
        await expect(service.reconcile(owner.launchNonce, signal)).resolves.toEqual({ stopped: 1, skipped: 1, prerequisite: 'ready' })
        expect(docker.removedContainers).toEqual([containerName(owner.engineAgentId)])
        expect(docker.removedVolumes).toEqual([])
        expect(docker.containers.has(containerName(otherOwner.engineAgentId))).toBe(true)
    })

    it('shutdown removes owned guests even when the image is missing', async () => {
        const { docker, service } = harness()
        docker.seed(owner, generation, 'running')
        docker.seed(otherOwner, generation, 'running')
        docker.imageKind = { kind: 'missing' }
        docker.imageCalls = 0
        const signal = new AbortController().signal
        await expect(service.shutdown(signal)).resolves.toMatchObject({ stopped: 2, prerequisite: 'ready' })
        expect(docker.imageCalls).toBe(0)
        expect(docker.removedVolumes).toEqual([])
        expect(docker.containers.size).toBe(0)
    })

    it('reconcile and shutdown report a missing docker without throwing', async () => {
        const { docker, service } = harness()
        docker.versionKind = { kind: 'missing' }
        const signal = new AbortController().signal
        await expect(service.shutdown(signal)).resolves.toEqual({ stopped: 0, skipped: 0, prerequisite: 'docker-missing' })
        expect(docker.listCalls).toBe(0)
        docker.versionCalls = 0
        await expect(service.reconcile('bad nonce', signal)).rejects.toMatchObject({ kind: 'refused', message: 'The screen owner is not valid.' })
        expect(docker.versionCalls).toBe(0)
    })

    it('skips a listed guest whose inspect no longer matches', async () => {
        const { docker, service } = harness()
        docker.rows = [
            { name: containerName(owner.engineAgentId), engineAgentId: owner.engineAgentId, launchNonce: oldNonce, sessionGeneration: generation, managed: '1', state: 'running' },
        ]
        const signal = new AbortController().signal
        await expect(service.shutdown(signal)).resolves.toEqual({ stopped: 0, skipped: 1, prerequisite: 'ready' })
        expect(docker.removedContainers).toEqual([])
    })
})

describe('isolated screen defaults', () => {
    it('selects the production docker callbacks without calling them for status', async () => {
        const docker = new FakeDocker()
        const service = createIsolatedScreenService({ docker })
        await expect(service.status(owner, new AbortController().signal)).resolves.toMatchObject({ prerequisite: 'ready', available: true })
        const screen = await service.ensure(owner, new AbortController().signal)
        expect(screen.width).toBe(1280)
        expect(screen.target.sessionGeneration).toMatch(/^[a-f0-9]{32}$/)
    })

    it('sleeps only when the wait is longer than zero', async () => {
        const docker = new FakeDocker()
        const service = createIsolatedScreenService({
            docker,
            encodeJpeg: async () => Buffer.from('jpeg'),
            randomBytes: () => Buffer.alloc(16, 7),
        })
        const signal = new AbortController().signal
        const screen = await service.ensure(owner, signal)
        await service.act(screen.target, { action: 'wait', duration: 0 }, signal)
        await service.act(screen.target, { action: 'wait', duration: 0.001 }, signal)
        expect(docker.execs.filter(call => call.body.op === 'screenshot')).toHaveLength(2)
    })
})

describe('root integration lifecycle regressions', () => {
    it('retries an interrupted Stop and treats repeated Stop as a safe no-op', async () => {
        const box = await boot()
        box.docker.inspectMode = 'container-down'
        await expect(box.service.stop(box.target, box.signal)).rejects.toMatchObject({kind:'prerequisite'})
        await expect(box.service.act(box.target,{action:'screenshot'},box.signal)).rejects.toMatchObject({kind:'stale'})
        box.docker.inspectMode = 'ok'
        await box.service.stop(box.target,box.signal)
        await box.service.stop(box.target,box.signal)
        expect(box.docker.removedContainers).toHaveLength(1)
    })
    it('drains a pending start before acknowledging shutdown and closes admission', async () => {
        const {docker,service}=harness()
        let entered!:()=>void
        const started=new Promise<void>(resolve=>{entered=resolve})
        docker.holdOps.add('ping');docker.onHold=entered
        const work=service.ensure(owner,AbortSignal.timeout(3000))
        const failed=expect(work).rejects.toMatchObject({name:'AbortError'})
        await started
        await service.shutdown(AbortSignal.timeout(3000));await failed
        expect(docker.containers.size).toBe(0)
        await expect(service.ensure(owner,AbortSignal.timeout(1000))).rejects.toMatchObject({name:'AbortError'})
    })
    it('does not reuse a generation whose guest cancellation could not be confirmed',async()=>{
        const box=await boot();let entered!:()=>void
        const started=new Promise<void>(resolve=>{entered=resolve})
        box.docker.holdOps.add('navigate');box.docker.onHold=entered
        box.docker.execHook=body=>{if(body.op==='cancel')throw new Error('no ack')}
        const controller=new AbortController()
        const work=box.service.navigate(box.target,{url:'https://example.com'},controller.signal)
        const failed=expect(work).rejects.toThrow(/confirm cancellation/)
        await started;controller.abort();await failed
        await expect(box.service.startTakeover(box.target,box.signal)).rejects.toMatchObject({kind:'stale'})
        await box.service.stop(box.target,box.signal)
        expect(box.docker.containers.size).toBe(0)
    })
})

describe('concrete launcher and foreground admission', () => {
    it('checks each actual foreground before model input and forwards its identity for a guest-side recheck', async () => {
        const admitted: string[] = []
        let allowed = 'browser'
        const box = await boot(harness({ authorizeInput: async (_target, app) => { admitted.push(app); if (app !== allowed) throw new Error('permission off') } }))
        box.docker.foreground = { app: 'terminal', windowId: '567' }
        await expect(box.service.act(box.target, { action: 'key', text: 'Return' }, box.signal)).rejects.toThrow('permission off')
        expect(box.docker.execs.some(call => call.body.op === 'input')).toBe(false)
        allowed = 'terminal'
        await box.service.act(box.target, { action: 'key', text: 'Return' }, box.signal)
        expect(box.docker.execs.find(call => call.body.op === 'input')?.body.expectedForeground).toEqual({ app: 'terminal', windowId: '567' })
        expect(admitted).toEqual(['terminal', 'terminal'])
    })
    it('refuses unverifiable or missing foreground authority without an input effect', async () => {
        const box = await boot()
        box.docker.foreground = { app: 'unknown', windowId: '123' }
        await expect(box.service.act(box.target, { action: 'left_click', coordinate: [10, 20] }, box.signal)).rejects.toThrow('foreground app')
        const unavailable = await boot(harness({ authorizeInput: undefined }))
        await expect(unavailable.service.act(unavailable.target, { action: 'left_click', coordinate: [10, 20] }, unavailable.signal)).rejects.toThrow('authority')
        expect(box.docker.execs.some(call => call.body.op === 'input')).toBe(false)
        expect(unavailable.docker.execs.some(call => call.body.op === 'input')).toBe(false)
    })
    it('brings the existing browser back to the foreground after an isolated app and checks permission before focusing', async () => {
        let allowed = false
        const box = await boot(harness({ authorizeInput: async () => { if (!allowed) throw new Error('permission off') } }))
        box.docker.foreground = { app: 'terminal', windowId: '567' }
        await expect(box.service.openBrowser(box.target, box.signal)).rejects.toThrow('permission off')
        expect(box.docker.execs.some(call => call.body.op === 'focus-browser')).toBe(false)
        allowed = true
        expect((await box.service.openBrowser(box.target, box.signal)).mediaType).toBe('image/jpeg')
        expect(box.docker.foreground.app).toBe('browser')
        expect(box.docker.runs).toHaveLength(1)
    })
    it('uses the existing generation/action lease for launcher RPC and never dispatches after takeover', async () => {
        const box = await boot()
        await box.service.withLauncherControl(box.target, box.signal, async (control, signal) => {
            await control.guest({ op: 'computer-launcher', app: 'files', mode: 'launch', operationId: 'a'.repeat(64), fingerprint: 'b'.repeat(64) }, signal)
            expect((await control.capture(signal)).mediaType).toBe('image/jpeg')
        })
        const count = box.docker.execs.filter(call => call.body.op === 'computer-launcher').length
        const lease = await box.service.startTakeover(box.target, box.signal)
        await expect(box.service.withLauncherControl(box.target, box.signal, async () => 1)).rejects.toThrow(HUMAN_DRIVING)
        expect(box.docker.execs.filter(call => call.body.op === 'computer-launcher')).toHaveLength(count)
        await box.service.finishTakeover(box.target, lease, box.signal)
        await box.service.stop(box.target, box.signal)
        await expect(box.service.withLauncherControl(box.target, box.signal, async () => 1)).rejects.toThrow('no longer current')
    })
    it('guards each human input under its exact lease with current foreground permission', async () => {
        let permitted = true
        const box = await boot(harness({ authorizeInput: async (_target, app) => { if (!permitted || app !== 'terminal') throw new Error('foreground denied') } }))
        box.docker.foreground = { app: 'terminal', windowId: '567' }
        await box.service.startTakeover(box.target, box.signal)
        await box.service.withViewer(box.target, 'drive', box.signal, async stream => {
            stream.on('error', () => {})
            const write = (bytes: Buffer) => new Promise<void>((resolve, reject) => stream.write(bytes, error => error ? reject(error) : resolve()))
            await write(Buffer.concat([Buffer.from('RFB 003.008\n'), Buffer.from([1, 1])]))
            await write(Buffer.from([4, 1, 0, 0, 0, 0, 0, 65]))
            permitted = false
            await expect(write(Buffer.from([4, 1, 0, 0, 0, 0, 0, 66]))).rejects.toThrow('foreground denied')
        })
        expect(box.docker.execs.filter(call => call.body.op === 'foreground')).toHaveLength(2)
        expect(box.docker.streams[0]?.duplex.destroyed).toBe(true)
    })
    it('reports only capabilities acknowledged by the running guest without creating another guest', async () => {
        const box = await boot()
        expect((await box.service.status(owner, box.signal)).launchers).toBeUndefined()
        box.docker.launchers = { terminal: true, files: false }
        expect((await box.service.status(owner, box.signal)).launchers).toEqual({ terminal: true, files: false })
        expect(box.docker.runs).toHaveLength(1)
    })
})

describe('reviewed isolated installation control', () => {
    it('requires fresh authority under the shared lease and sends only fixed guest fields', async () => {
        const box = await boot()
        let allowed = false
        const body = { mode: 'install' as const, operationId: 'a'.repeat(64), workspaceFingerprint: 'b'.repeat(64), packages: ['left-pad@1.2.3'] }
        await expect(box.service.toolInstall(box.target, body, box.signal, async () => { if (!allowed) throw new Error('permission revoked') })).rejects.toThrow('permission revoked')
        expect(box.docker.execs.filter(call => call.body.op === 'tool-install')).toHaveLength(0)
        allowed = true
        await box.service.toolInstall(box.target, body, box.signal, async () => {})
        expect(box.docker.execs.find(call => call.body.op === 'tool-install')?.body).toMatchObject({ op: 'tool-install', ...body })
        await box.service.startTakeover(box.target, box.signal)
        await expect(box.service.toolInstall(box.target, body, box.signal, async () => {})).rejects.toThrow(HUMAN_DRIVING)
    })
    it('drains the entire exact guest after an interrupted submitted installation', async () => {
        const box = await boot(), abort = new AbortController()
        box.docker.holdOps.add('tool-install')
        let submitted!: () => void
        const started = new Promise<void>(resolve => { submitted = resolve })
        box.docker.onHold = submitted
        const effect = box.service.toolInstall(box.target, { mode: 'install', operationId: 'a'.repeat(64), workspaceFingerprint: 'b'.repeat(64), packages: ['left-pad@1.2.3'] }, abort.signal, async () => {})
        await started; abort.abort()
        await expect(effect).rejects.toThrow()
        expect(box.docker.removedContainers).toContain(containerName(owner.engineAgentId))
        expect(box.docker.containers.has(containerName(owner.engineAgentId))).toBe(false)
    })
})

describe('isolated command native authority and drain', () => {
    const command = { op: 'guest-shell', commandId: 'a'.repeat(32), workspaceFingerprint: 'b'.repeat(64), fingerprint: 'c'.repeat(64), command: 'printf ok', cwd: '', timeoutMs: 1000 }
    it('checks permission inside the native mutation lock before sending the command', async () => {
        const box = await boot()
        await expect(box.service.guestShell(box.target, command, box.signal, async () => { throw new Error('grant revoked') })).rejects.toThrow('grant revoked')
        expect(box.docker.execs.filter(item => item.body.op === 'guest-shell')).toHaveLength(0)
        await box.service.guestShell(box.target, command, box.signal, async () => {})
        await box.service.guestShell(box.target, { op: 'guest-shell-inspect', commandId: command.commandId, workspaceFingerprint: command.workspaceFingerprint }, box.signal, async () => {})
        const calls = box.docker.execs.filter(item => String(item.body.op).startsWith('guest-shell'))
        expect(calls[0].body.commandId).toBe(calls[1].body.commandId)
        expect(calls[0].body.requestId).not.toBe(calls[1].body.requestId)
    })
    it('inspection bypasses only the mutation lock, and confirmed Stop keeps the command receipt reachable', async () => {
        const box = await boot(), controller = new AbortController()
        box.docker.holdOps.add('guest-shell')
        let submitted!: () => void
        const started = new Promise<void>(resolve => { submitted = resolve }); box.docker.onHold = submitted
        const task = box.service.guestShell(box.target, command, controller.signal, async () => {})
        await started
        expect((await box.service.guestShell(box.target, { op: 'guest-shell-inspect', commandId: command.commandId, workspaceFingerprint: command.workspaceFingerprint }, box.signal, async () => {})).requestId).toBe(command.commandId)
        controller.abort(); await expect(task).rejects.toThrow()
        expect(box.docker.execs.filter(item => item.body.op === 'guest-shell-cancel')).toHaveLength(1)
        expect(box.docker.removedContainers).toEqual([])
        expect((await box.service.running(owner, box.signal)).target).toEqual(box.target)
    })
    it.each([true, false])('records Stop across the real host/native transport boundary only when command drain is acknowledged: %s', async acknowledged => {
        const box = await boot(), controller = new AbortController()
        const requestId = '11111111-1111-4111-8111-111111111111'
        const base = { agentId: owner.engineAgentId, sessionId: 'shell-session', runId: 'shell-run', toolCallId: 'shell-call', requestId }
        const guest = { ...box.target, workspaceFingerprint: command.workspaceFingerprint }
        const receipts = new Map<string, DesktopGuestShellReceipt>()
        const deps = {
            authority: async () => guest,
            store: {
                read: async (id: string) => receipts.get(id) ?? null,
                begin: async (_request: unknown, receipt: DesktopGuestShellReceipt) => { receipts.set(receipt.requestId, receipt); return 'execute' as const },
                complete: async (_identity: unknown, receipt: DesktopGuestShellReceipt) => { receipts.set(receipt.requestId, receipt) },
            },
            transport: createDesktopGuestShellTransport((identity, body, signal) => box.service.guestShell(identity.guest, body, signal, async () => {})),
        }
        const shell = createDesktopGuestShellService(deps)
        box.docker.holdOps.add('guest-shell')
        if (!acknowledged) box.docker.guestShellCancelReply = { requestId: requestId.replaceAll('-', ''), drained: false }
        let submitted!: () => void
        const started = new Promise<void>(resolve => { submitted = resolve }); box.docker.onHold = submitted
        const pending = shell.execute(base, { command: 'sleep 30', timeoutMs: 60000, cwd: '' }, controller.signal)
        await started
        expect(receipts.get(requestId)?.status).toBe('interrupted')
        controller.abort()
        const receipt = await pending
        expect(receipt.status).toBe(acknowledged ? 'cancelled' : 'interrupted')
        expect(receipts.get(requestId)).toEqual(receipt)
        expect(box.docker.execs.filter(item => item.body.op === 'guest-shell')).toHaveLength(1)
        if (acknowledged) {
            expect(box.docker.removedContainers).toEqual([])
            const cancellations = box.docker.execs.filter(item => item.body.op === 'guest-shell-cancel')
            expect(cancellations).toHaveLength(2) // Native drain, then host receipt confirmation.
            for (const call of cancellations) expect(call.body.commandId).toBe(requestId.replaceAll('-', ''))
            // Reopening the host service must read its confirmed receipt without restarting a guest.
            await box.service.stop(box.target, box.signal)
            const calls = box.docker.execs.length, starts = box.docker.runs.length
            const reopened = createDesktopGuestShellService({ ...deps, authority: async () => { throw new Error('Guest is stopped') } })
            expect(await reopened.inspect(base, box.signal)).toEqual(receipt)
            expect(box.docker.execs).toHaveLength(calls)
            expect(box.docker.runs).toHaveLength(starts)
        } else {
            expect(box.docker.removedContainers).toContain(containerName(owner.engineAgentId))
            expect(box.docker.removedContainers).not.toContain(containerName(otherOwner.engineAgentId))
        }
    })
    it('rejects a stale target before cancellation can reach a replacement guest', async () => {
        const box = await boot(); await box.service.stop(box.target, box.signal)
        const replacement = await box.service.ensure(owner, box.signal)
        await expect(box.service.guestShell(box.target, { op: 'guest-shell-cancel', commandId: command.commandId, workspaceFingerprint: command.workspaceFingerprint }, box.signal, async () => {})).rejects.toThrow()
        expect(box.docker.execs.filter(item => item.body.op === 'guest-shell-cancel')).toHaveLength(0)
        expect((await box.service.running(owner, box.signal)).target).toEqual(replacement.target)
    })
})
