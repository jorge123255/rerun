import { randomBytes as cryptoRandomBytes, timingSafeEqual } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { containerRunArgs, isArm64 } from './docker-args.js'
import type { DockerClient, ListedScreen } from './docker-cli.js'
import { encodeScreenJpeg } from './encode.js'
import { decodeFrame, encodeFrame } from './frame.js'
import { assertAgentId, assertLaunchNonce, assertOwner, assertTarget, containerName, LABEL_AGENT, LABEL_GENERATION, LABEL_MANAGED, LABEL_NONCE, LABEL_ROLE, ROLE_SCREEN, sameOwnerContainer, sameOwnerVolume, volumeName } from './identity.js'
import { HUMAN_DRIVING, planAction, viewOf, type ScreenGeometry } from './input.js'
import { assertHttpUrl, boundPage, publicUrl } from './page.js'
import { decodePageExports, exportPath, navigationOptions } from './exports.js'
import { abortable } from '../web-fetch/transport.js'
import { abortError, isAbortError, IsolatedScreenRefusal, throwIfAborted } from './refusal.js'
import type { EnsuredScreen, IsolatedScreenService, ScreenComputerInput, ScreenLease, ScreenNavigate, ScreenNavigationExport, ScreenOwner, ScreenPage, ScreenPrerequisite, ScreenReconcile, ScreenRunState, ScreenShot, ScreenStatus, ScreenTakeover, ScreenTarget, ViewerMode } from './types.js'

const READY_ATTEMPTS = 150
const READY_PAUSE_MS = 200
const CONFLICT = 'A container or volume already uses this screen name without Rerun labels.'
const STALE = 'This screen session is no longer current.'
const NOT_DRIVING = 'Take over the screen before driving it.'
const ALREADY_DRIVING = 'The user is already driving this screen.'
const WRONG_LEASE = 'That takeover is no longer current.'

export type JpegEncoder = (png: Buffer, width: number, height: number) => Promise<Buffer>
export type IsolatedScreenDeps = {
    docker: DockerClient
    encodeJpeg?: JpegEncoder
    randomBytes?: (size: number) => Buffer
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>
    readyAttempts?: number
}

type Viewer = { mode: ViewerMode; destroy: () => void }
type Live = {
    generation: string
    launchNonce: string
    lease: string | null
    takingOver: boolean
    stopping?: boolean
    action: AbortController | null
    viewers: Set<Viewer>
    screen: ScreenGeometry
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
    if (ms === 0) return Promise.resolve()
    return delay(ms, undefined, { signal }).then(() => undefined)
}

function sameToken(left: string, right: string): boolean {
    const a = Buffer.from(left)
    const b = Buffer.from(right)
    return a.length === b.length && a.length > 0 && timingSafeEqual(a, b)
}

function safeReason(reason: unknown): string {
    if (typeof reason !== 'string' || reason.length === 0 || reason.length > 200) return 'The screen action failed.'
    if (/[^\x20-\x7e]/.test(reason)) return 'The screen action failed.'
    if (reason.includes('://') || reason.includes('/Users') || reason.includes('docker.sock') || reason.includes('\\')) return 'The screen action failed.'
    return reason
}

function prerequisiteText(prerequisite: ScreenPrerequisite): string {
    switch (prerequisite) {
        case 'docker-missing': return 'Docker is not installed.'
        case 'daemon-unreachable': return 'Docker is not running.'
        case 'docker-wrong-arch': return 'Docker is not a linux/arm64 engine.'
        case 'image-missing': return 'The isolated screen image rerun-desktop-guest:round29 is not built.'
        case 'image-wrong-arch': return 'The isolated screen image is not arm64.'
        case 'name-conflict': return CONFLICT
        case 'ready': return 'The screen is ready.'
    }
}

function runState(state: string, human: boolean): ScreenRunState {
    if (state === 'running') return human ? 'human' : 'running'
    if (state === 'created' || state === 'restarting') return 'starting'
    return 'stopped'
}

function createLock(): <T>(key: string, run: () => Promise<T>) => Promise<T> {
    const tails = new Map<string, Promise<void>>()
    return (key, run) => {
        const previous = tails.get(key) ?? Promise.resolve()
        const runAfter = previous.then(run, run)
        const tail = runAfter.then(() => undefined, () => undefined)
        tails.set(key, tail)
        void tail.finally(() => {
            if (tails.get(key) === tail) tails.delete(key)
        })
        return runAfter
    }
}

function absent(prerequisite: ScreenPrerequisite): ScreenStatus {
    return { available: false, prerequisite, state: 'absent' }
}

export function createIsolatedScreenService(deps: IsolatedScreenDeps): IsolatedScreenService {
    const docker = deps.docker
    const encodeJpeg = deps.encodeJpeg ?? encodeScreenJpeg
    const nextBytes = deps.randomBytes ?? cryptoRandomBytes
    const sleep = deps.sleep ?? defaultSleep
    const readyAttempts = deps.readyAttempts ?? READY_ATTEMPTS
    const lives = new Map<string, Live>()
    const lock = createLock()
    const closing = new AbortController()
    const starts = new Set<Promise<EnsuredScreen>>()
    const completedLeases = new Map<string, ScreenTakeover>()

    async function dockerEngine(signal: AbortSignal): Promise<ScreenPrerequisite> {
        const version = await docker.version(signal)
        if (version.kind === 'missing') return 'docker-missing'
        if (version.kind === 'unreachable') return 'daemon-unreachable'
        if (version.os !== 'linux' || !isArm64(version.arch)) return 'docker-wrong-arch'
        return 'ready'
    }

    function current(target: ScreenTarget): Live {
        assertTarget(target)
        const live = lives.get(target.engineAgentId)
        if (closing.signal.aborted || !live || live.stopping || live.generation !== target.sessionGeneration || live.launchNonce !== target.launchNonce) throw new IsolatedScreenRefusal(STALE, 'stale')
        return live
    }

    function drop(live: Live | undefined): void {
        if (!live) return
        live.action?.abort()
        for (const viewer of live.viewers) viewer.destroy()
        live.viewers.clear()
    }

    async function guest(name: string, body: Record<string, unknown>, signal: AbortSignal): Promise<{ value: Record<string, unknown>; binary: Buffer }> {
        const requestId = cryptoRandomBytes(16).toString('hex')
        let stdout: Buffer
        try { stdout = await docker.exec(name, ['rerun-rpc'], encodeFrame({ ...body, requestId }), signal) }
        catch (error) {
            if (signal.aborted) {
                // Killing docker exec only detaches its client. Wait for the guest to confirm
                // cancellation before allowing a human or another action onto this screen.
                try {
                    const reply = decodeFrame(await docker.exec(name, ['rerun-rpc'], encodeFrame({ op: 'cancel', requestId }), AbortSignal.timeout(15_000)))
                    if ((reply.value as { ok?: boolean }).ok !== true) throw new Error('Cancellation not acknowledged')
                } catch {
                    for (const [id, live] of lives) if (containerName(id) === name) { live.stopping = true; drop(live) }
                    throw new IsolatedScreenRefusal('The screen could not confirm cancellation. Stop it before continuing.', 'closed')
                }
            }
            throw error
        }
        const decoded = decodeFrame(stdout)
        if (!decoded.value || typeof decoded.value !== 'object' || Array.isArray(decoded.value)) throw new IsolatedScreenRefusal('The screen action failed.', 'closed')
        const record = decoded.value as Record<string, unknown>
        if (record.ok !== true) throw new IsolatedScreenRefusal(safeReason(record.reason), record.refusal === true ? 'refused' : 'closed')
        return { value: record, binary: decoded.binary }
    }

    async function action<T>(target: ScreenTarget, signal: AbortSignal, run: (live: Live, signal: AbortSignal) => Promise<T>): Promise<T> {
        const live = current(target)
        if (live.lease || live.takingOver) throw new IsolatedScreenRefusal(HUMAN_DRIVING, 'refused')
        return lock(target.engineAgentId, async () => {
        current(target)
        if (live.lease || live.takingOver) throw new IsolatedScreenRefusal(HUMAN_DRIVING, 'refused')
        const action = new AbortController()
        live.action = action
        const linked = AbortSignal.any([signal, action.signal, closing.signal])
        try {
            throwIfAborted(linked)
            const result = await run(live, linked)
            current(target)
            throwIfAborted(linked)
            return result
        } catch (error) {
            if (live.stopping) throw error
            if (signal.aborted) throw abortError(signal)
            if (live?.lease || live?.takingOver) throw new IsolatedScreenRefusal(HUMAN_DRIVING, 'refused')
            throw error
        } finally {
            if (live?.action === action) live.action = null
        }
        })
    }

    async function guestCall(target: ScreenTarget, body: Record<string, unknown>, signal: AbortSignal) {
        const live = current(target)
        throwIfAborted(signal)
        if (live.lease || live.takingOver) throw new IsolatedScreenRefusal(HUMAN_DRIVING, 'refused')
        const reply = await guest(containerName(target.engineAgentId), body, signal)
        current(target)
        throwIfAborted(signal)
        return reply
    }

    async function waitReady(name: string, signal: AbortSignal): Promise<ScreenGeometry> {
        for (let attempt = 0; attempt < readyAttempts; attempt++) {
            throwIfAborted(signal)
            const inspected = await docker.inspectContainer(name, signal)
            if (inspected.status === 'unreachable') throw new IsolatedScreenRefusal('Docker is not running.', 'prerequisite')
            if (inspected.status !== 'found') throw new IsolatedScreenRefusal('The screen did not start.', 'closed')
            if (inspected.state === 'exited' || inspected.state === 'dead') throw new IsolatedScreenRefusal('The screen did not start.', 'closed')
            if (inspected.state === 'running') {
                try {
                    const reply = await guest(name, { op: 'ping' }, signal)
                    const width = reply.value.width
                    const height = reply.value.height
                    if (typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0) return viewOf(width, height)
                } catch (error) {
                    if (isAbortError(error) || signal.aborted) throw isAbortError(error) ? error : abortError(signal)
                    if (error instanceof IsolatedScreenRefusal && error.kind === 'prerequisite') throw error
                }
            }
            await sleep(READY_PAUSE_MS, signal)
        }
        throw new IsolatedScreenRefusal('The screen did not start.', 'closed')
    }

    async function status(owner: ScreenOwner, signal: AbortSignal): Promise<ScreenStatus> {
        throwIfAborted(signal)
        assertOwner(owner)
        const engine = await dockerEngine(signal)
        if (engine !== 'ready') return absent(engine)
        const image = await docker.image(signal)
        if (image.kind === 'missing') return absent('image-missing')
        if (image.kind === 'unreachable') return absent('daemon-unreachable')
        if (!isArm64(image.architecture)) return absent('image-wrong-arch')
        const container = await docker.inspectContainer(containerName(owner.engineAgentId), signal)
        if (container.status === 'unreachable') return absent('daemon-unreachable')
        if (container.status === 'found' && !sameOwnerContainer(container.labels, owner)) return absent('name-conflict')
        const volume = await docker.inspectVolume(volumeName(owner.engineAgentId), signal)
        if (volume.status === 'unreachable') return absent('daemon-unreachable')
        if (volume.status === 'found' && !sameOwnerVolume(volume.labels, owner)) return absent('name-conflict')
        if (container.status !== 'found') return { available: true, prerequisite: 'ready', state: 'absent' }
        const live = lives.get(owner.engineAgentId)
        return { available: true, prerequisite: 'ready', state: runState(container.state, Boolean(live?.lease || live?.takingOver)) }
    }

    async function ensure(owner: ScreenOwner, signal: AbortSignal): Promise<EnsuredScreen> {
        signal = AbortSignal.any([signal, closing.signal])
        throwIfAborted(signal)
        assertOwner(owner)
        const work = lock(owner.engineAgentId, async () => {
            throwIfAborted(signal)
            const report = await status(owner, signal)
            if (report.prerequisite === 'name-conflict') throw new IsolatedScreenRefusal(CONFLICT, 'conflict')
            if (report.prerequisite !== 'ready') throw new IsolatedScreenRefusal(prerequisiteText(report.prerequisite), 'prerequisite')
            const name = containerName(owner.engineAgentId)
            const volume = volumeName(owner.engineAgentId)
            const existingVolume = await docker.inspectVolume(volume, signal)
            if (existingVolume.status === 'unreachable') throw new IsolatedScreenRefusal('Docker is not running.', 'prerequisite')
            if (existingVolume.status === 'found' && !sameOwnerVolume(existingVolume.labels, owner)) throw new IsolatedScreenRefusal(CONFLICT, 'conflict')
            if (existingVolume.status === 'missing') await docker.createVolume(owner, signal)
            const existing = await docker.inspectContainer(name, signal)
            if (existing.status === 'unreachable') throw new IsolatedScreenRefusal('Docker is not running.', 'prerequisite')
            if (existing.status === 'found' && !sameOwnerContainer(existing.labels, owner)) throw new IsolatedScreenRefusal(CONFLICT, 'conflict')
            const live = lives.get(owner.engineAgentId)
            if (existing.status === 'found' && existing.state === 'running' && live && !live.stopping && live.launchNonce === owner.launchNonce && live.generation === existing.labels[LABEL_GENERATION] && existing.labels[LABEL_NONCE] === owner.launchNonce) {
                return { target: { ...owner, sessionGeneration: live.generation }, width: live.screen.viewWidth, height: live.screen.viewHeight }
            }
            if (existing.status === 'found') await docker.removeContainer(existing.id ?? name, signal)
            drop(live)
            lives.delete(owner.engineAgentId)
            const generation = nextBytes(16).toString('hex')
            try {
                await docker.run(containerRunArgs(owner, generation), signal)
                const screen = await waitReady(name, signal)
                throwIfAborted(signal)
                lives.set(owner.engineAgentId, { generation, launchNonce: owner.launchNonce, lease: null, takingOver: false, action: null, viewers: new Set(), screen })
                return { target: { ...owner, sessionGeneration: generation }, width: screen.viewWidth, height: screen.viewHeight }
            } catch (error) {
                const cleanupSignal = AbortSignal.timeout(10_000)
                const failed = await docker.inspectContainer(name, cleanupSignal)
                if (failed.status === 'found' && sameOwnerContainer(failed.labels, owner) && failed.labels[LABEL_GENERATION] === generation && failed.labels[LABEL_NONCE] === owner.launchNonce) await docker.removeContainer(failed.id ?? name, cleanupSignal)
                lives.delete(owner.engineAgentId)
                throw error
            }
        })
        starts.add(work)
        try { return await work } finally { starts.delete(work) }
    }

    async function navigate(target: ScreenTarget, input: ScreenNavigate, signal: AbortSignal, exports?: ScreenNavigationExport): Promise<ScreenPage> {
        throwIfAborted(signal)
        const url = assertHttpUrl(input.url)
        const options = navigationOptions(input)
        if (options.screenshot && !exports) throw new IsolatedScreenRefusal('Screenshot saving requires current private Files write authority.', 'refused')
        if (exports) exportPath(exports.htmlPath, 'rendered-html')
        return action(target, AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs + 35_000)]), async (_live, linked) => {
            const reply = await guestCall(target, { op: 'navigate', url, ...options, exportHtml: !!exports }, linked)
            const page = boundPage(reply.value, url, options.links)
            if (exports && !page.wall) {
                const artifacts = await decodePageExports(reply.value, reply.binary, { html: exports.htmlPath, screenshot: input.screenshotPath }, linked)
                current(target)
                throwIfAborted(linked)
                page.exports = await abortable(exports.publish(artifacts, linked), linked)
                if (!['saved', 'unknown', 'refused', 'unavailable'].includes(page.exports.status)
                    || !Array.isArray(page.exports.files) || page.exports.files.length > artifacts.length
                    || page.exports.files.some((file, index, files) => files.findIndex(other => other.kind === file.kind) !== index
                        || !artifacts.some(item => item.kind === file.kind && item.path === file.path && item.sha256 === file.sha256 && item.bytes.length === file.byteLength))
                    || page.exports.status === 'saved' && page.exports.files.length !== artifacts.length) {
                    throw new IsolatedScreenRefusal('The browser export acknowledgement is invalid. Inspect Files before retrying.', 'closed')
                }
            } else if (exports) page.exports = { status: 'refused', files: [] }
            current(target)
            throwIfAborted(linked)
            return page
        })
    }

    async function act(target: ScreenTarget, input: ScreenComputerInput, signal: AbortSignal): Promise<ScreenShot> {
        throwIfAborted(signal)
        return action(target, signal, async (live, signal) => {
        const plan = planAction(input, live.screen)
        for (const call of plan.calls) {
            throwIfAborted(signal)
            if (live.lease || live.takingOver) throw new IsolatedScreenRefusal(HUMAN_DRIVING, 'refused')
            if (call.kind === 'wait') await sleep(call.ms, signal)
            else await guestCall(target, call.body, signal)
        }
        if (plan.settleMs > 0) await sleep(plan.settleMs, signal)
        const reply = await guestCall(target, { op: 'screenshot' }, signal)
        const width = reply.value.width
        const height = reply.value.height
        if (typeof width !== 'number' || typeof height !== 'number') throw new IsolatedScreenRefusal('The screenshot could not be taken.', 'closed')
        const screen = viewOf(width, height)
        live.screen = screen
        if (reply.binary.length === 0) throw new IsolatedScreenRefusal('The screenshot could not be taken.', 'closed')
        const image = await encodeJpeg(reply.binary, screen.viewWidth, screen.viewHeight)
        return { image, mediaType: 'image/jpeg', width: screen.viewWidth, height: screen.viewHeight }
        })
    }

    async function startTakeover(target: ScreenTarget, signal: AbortSignal): Promise<ScreenLease> {
        throwIfAborted(signal)
        const live = current(target)
        live.takingOver = true
        live.action?.abort()
        try {
            return await lock(target.engineAgentId, async () => {
                const currentLive = current(target)
                if (currentLive.lease) throw new IsolatedScreenRefusal(ALREADY_DRIVING, 'refused')
                const token = nextBytes(16).toString('hex')
                currentLive.lease = token
                try {
                    await guest(containerName(target.engineAgentId), { op: 'release' }, signal)
                } catch (error) {
                    if (currentLive.lease === token) currentLive.lease = null
                    throw error
                }
                return { token }
            })
        } finally {
            live.takingOver = false
        }
    }

    async function finishTakeover(target: ScreenTarget, lease: ScreenLease, signal: AbortSignal): Promise<ScreenTakeover> {
        throwIfAborted(signal)
        const receipt = JSON.stringify([target, lease?.token])
        const completed = completedLeases.get(receipt)
        if (completed) return completed
        const live = current(target)
        if (!live.lease || !lease || typeof lease.token !== 'string' || !sameToken(live.lease, lease.token)) throw new IsolatedScreenRefusal(WRONG_LEASE, 'refused')
        const token = live.lease
        return lock(target.engineAgentId, async () => {
            const completed = completedLeases.get(receipt)
            if (completed) return completed
            const currentLive = current(target)
            if (!currentLive.lease || !sameToken(currentLive.lease, token)) throw new IsolatedScreenRefusal(WRONG_LEASE, 'refused')
            await guest(containerName(target.engineAgentId), { op: 'release' }, signal)
            for (const viewer of currentLive.viewers) {
                if (viewer.mode === 'drive') viewer.destroy()
            }
            let url: string | null = null
            try {
                const located = await guest(containerName(target.engineAgentId), { op: 'location' }, signal)
                url = publicUrl(located.value.url)
            } catch (error) {
                // Input has been released. Record that fact even if URL inspection fails;
                // retry must never attempt to release a newer takeover.
                url = null
            } finally {
                if (currentLive.lease && sameToken(currentLive.lease, token)) {
                    currentLive.lease = null
                    currentLive.takingOver = false
                }
            }
            const result = { url }
            if (completedLeases.size >= 256) completedLeases.delete(completedLeases.keys().next().value!)
            completedLeases.set(receipt, result)
            return result
        })
    }

    async function stop(target: ScreenTarget, signal: AbortSignal): Promise<void> {
        throwIfAborted(signal)
        assertTarget(target)
        const live = currentOrNull(target)
        if (live) live.stopping = true
        drop(live)
        await lock(target.engineAgentId, async () => {
            const name = containerName(target.engineAgentId)
            const existing = await docker.inspectContainer(name, signal)
            if (existing.status === 'unreachable') throw new IsolatedScreenRefusal('Docker is not running.', 'prerequisite')
            if (existing.status === 'found' && !sameOwnerContainer(existing.labels, target)) {
                throw new IsolatedScreenRefusal(CONFLICT, 'conflict')
            }
            if (existing.status === 'found' && (existing.labels[LABEL_GENERATION] !== target.sessionGeneration || existing.labels[LABEL_NONCE] !== target.launchNonce)) {
                // The exact old target is already gone. Never stop its replacement.
                return
            }
            if (existing.status === 'found') await docker.removeContainer(existing.id ?? name, signal)
            if (lives.get(target.engineAgentId)?.generation === target.sessionGeneration) lives.delete(target.engineAgentId)
        })
    }

    async function dispose(owner: ScreenOwner, signal: AbortSignal): Promise<void> {
        throwIfAborted(signal)
        assertOwner(owner)
        const live = lives.get(owner.engineAgentId)
        if (live) live.stopping = true
        drop(live)
        await lock(owner.engineAgentId, async () => {
            const name = containerName(owner.engineAgentId)
            const volume = volumeName(owner.engineAgentId)
            const existing = await docker.inspectContainer(name, signal)
            if (existing.status === 'unreachable') throw new IsolatedScreenRefusal('Docker is not running.', 'prerequisite')
            if (existing.status === 'found' && !sameOwnerContainer(existing.labels, owner)) throw new IsolatedScreenRefusal(CONFLICT, 'conflict')
            if (existing.status === 'found') await docker.removeContainer(existing.id ?? name, signal)
            const profile = await docker.inspectVolume(volume, signal)
            if (profile.status === 'unreachable') throw new IsolatedScreenRefusal('Docker is not running.', 'prerequisite')
            if (profile.status === 'found' && !sameOwnerVolume(profile.labels, owner)) throw new IsolatedScreenRefusal(CONFLICT, 'conflict')
            if (profile.status === 'found') await docker.removeVolume(volume, signal)
            lives.delete(owner.engineAgentId)
        })
    }

    async function withViewer<T>(target: ScreenTarget, mode: ViewerMode, signal: AbortSignal, connect: (stream: Duplex) => Promise<T>): Promise<T> {
        throwIfAborted(signal)
        if (mode !== 'watch' && mode !== 'drive') throw new IsolatedScreenRefusal('That screen action is not available.', 'refused')
        const live = current(target)
        if (mode === 'drive' && !live.lease) throw new IsolatedScreenRefusal(NOT_DRIVING, 'refused')
        const lease = live.lease
        const stream = await docker.execStream(containerName(target.engineAgentId), ['rerun-vnc', mode], signal)
        const viewer: Viewer = { mode, destroy: () => stream.destroy() }
        try {
            const latest = current(target)
            if (mode === 'drive' && (!latest.lease || latest.lease !== lease)) throw new IsolatedScreenRefusal(NOT_DRIVING, 'refused')
            latest.viewers.add(viewer)
            if (signal.aborted) throw abortError(signal)
            return await connect(stream)
        } finally {
            viewer.destroy()
            currentOrNull(target)?.viewers.delete(viewer)
        }
    }

    function currentOrNull(target: ScreenTarget): Live | undefined {
        const live = lives.get(target.engineAgentId)
        if (!live || live.generation !== target.sessionGeneration || live.launchNonce !== target.launchNonce) return undefined
        return live
    }

    function ownedRow(row: ListedScreen): boolean {
        if (row.managed !== '1') return false
        try {
            assertAgentId(row.engineAgentId)
        } catch {
            return false
        }
        return containerName(row.engineAgentId) === row.name
    }

    async function stopListed(signal: AbortSignal, shouldStop: (row: ListedScreen) => boolean): Promise<ScreenReconcile> {
        const engine = await dockerEngine(signal)
        if (engine !== 'ready') return { stopped: 0, skipped: 0, prerequisite: engine }
        const rows = await docker.listScreens(signal)
        let stopped = 0
        let skipped = 0
        for (const row of rows) {
            throwIfAborted(signal)
            if (!ownedRow(row) || !shouldStop(row)) {
                if (!ownedRow(row)) skipped += 1
                continue
            }
            await lock(row.engineAgentId, async () => {
            const inspected = await docker.inspectContainer(row.name, signal)
            if (inspected.status === 'unreachable') throw new IsolatedScreenRefusal('Docker is not running. Screen cleanup could not be confirmed.', 'prerequisite')
            if (inspected.status !== 'found') {
                skipped += 1
                return
            }
            const labels = inspected.labels
            const owned = labels[LABEL_ROLE] === ROLE_SCREEN
                && labels[LABEL_MANAGED] === '1'
                && labels[LABEL_AGENT] === row.engineAgentId
                && labels[LABEL_NONCE] === row.launchNonce
                && labels[LABEL_GENERATION] === row.sessionGeneration
                && containerName(row.engineAgentId) === row.name
            if (!owned) {
                skipped += 1
                return
            }
            await docker.removeContainer(inspected.id ?? row.name, signal)
            stopped += 1
            const live = lives.get(row.engineAgentId)
            if (live && live.generation === row.sessionGeneration && live.launchNonce === row.launchNonce) {
                drop(live)
                lives.delete(row.engineAgentId)
            }
            })
        }
        return { stopped, skipped, prerequisite: 'ready' }
    }

    async function reconcile(launchNonce: string, signal: AbortSignal): Promise<ScreenReconcile> {
        throwIfAborted(signal)
        assertLaunchNonce(launchNonce)
        return stopListed(signal, row => row.launchNonce !== launchNonce)
    }

    async function shutdown(signal: AbortSignal): Promise<ScreenReconcile> {
        throwIfAborted(signal)
        closing.abort()
        for (const live of lives.values()) drop(live)
        await Promise.allSettled([...starts])
        const owned = lives.size
        const result = await stopListed(signal, () => true)
        if (owned && result.prerequisite !== 'ready') throw new IsolatedScreenRefusal('Screen cleanup could not be confirmed.', 'prerequisite')
        lives.clear()
        return result
    }

    return { status, ensure, navigate, act, startTakeover, finishTakeover, stop, withViewer, reconcile, shutdown, dispose }
}
