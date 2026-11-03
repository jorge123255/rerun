import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rm } from 'node:fs/promises'
import { atomicPrivateJSON, bindWorkspace, childEnvironment, publicStatus, PROTOCOL_VERSION } from './runtime.mjs'

const wait = ms => new Promise(done => setTimeout(done, ms))
const uiHost = fileURLToPath(new URL('./ui-host.mjs', import.meta.url))

export async function candidatePort() {
    const server = createServer()
    await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done) })
    const port = server.address().port
    await new Promise((done, fail) => server.close(error => error ? fail(error) : done()))
    return port
}

export class RuntimeSupervisor extends EventEmitter {
    constructor({ bundle, root, identity, launch = spawn, fetcher = fetch, port = candidatePort, startupTimeout = 60000, stopTimeout = 10000 }) {
        super()
        Object.assign(this, { bundle, root, identity, launch, fetcher, port, startupTimeout, stopTimeout })
        this.children = new Set()
        this.status = publicStatus('stopped')
        this.operation = null
        this.stopping = false
    }

    publish(state, message = '') {
        this.status = publicStatus(state, message)
        this.emit('status', this.status)
    }

    spawnOwned(args, env) {
        const child = this.launch(this.bundle.nodePath, args, { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], detached: false })
        this.children.add(child)
        child.stdout?.resume()
        child.stderr?.resume()
        child.on('error', () => { child.launchFailed = true })
        child.once('exit', () => {
            this.children.delete(child)
            if (!this.stopping && this.status.state === 'ready') {
                this.publish('error', 'A local service stopped. Retry to restart the app services.')
                void this.stop({ preserveError: true })
            }
        })
        return child
    }

    start() {
        if (this.operation) return this.operation
        if (this.status.state === 'ready') return Promise.resolve(this.runtime)
        this.operation = this.startServices().finally(() => { this.operation = null })
        return this.operation
    }

    async startServices() {
        this.stopping = false
        this.publish('starting', 'Starting your local workspace…')
        const engineRoot = await bindWorkspace(this.root, this.identity)
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const uiPort = await this.port()
                let enginePort = await this.port()
                while (enginePort === uiPort) enginePort = await this.port()
                const runtime = {
                    protocolVersion: PROTOCOL_VERSION, launchNonce: randomUUID(), buildId: this.bundle.buildId,
                    workspaceId: 1, dataRoot: this.root,
                    app: { origin: `http://127.0.0.1:${uiPort}`, sessionToken: randomBytes(32).toString('hex') },
                    engine: { origin: `http://127.0.0.1:${enginePort}`, apiKey: this.identity.engineApiKey },
                }
                const runtimeFile = resolve(this.root, 'runtime.json')
                await atomicPrivateJSON(runtimeFile, runtime)
                const shared = { ...childEnvironment(), RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_DATA_DIR: this.root, RERUN_DESKTOP_RUNTIME_FILE: runtimeFile }
                const ui = this.spawnOwned([uiHost], { ...shared, RERUN_DESKTOP_UI_ROOT: this.bundle.uiRoot, PORT: String(uiPort), HOSTNAME: '127.0.0.1' })
                await this.waitForHealth(ui, `${runtime.app.origin}/api/desktop/health`, { Cookie: `rerun-desktop-session=${runtime.app.sessionToken}` }, runtime)
                const engine = this.spawnOwned([this.bundle.engineEntry, 'desktop-run'], {
                    ...shared, RERUN_HOST: '127.0.0.1', RERUN_PORT: String(enginePort), RERUN_API_KEY: this.identity.engineApiKey,
                    RERUN_DATA_DIR: engineRoot, RERUN_HUB_BASE_URL: runtime.app.origin, RERUN_DESKTOP: 'off',
                    RERUN_DESKTOP_SECRET_KEY: this.identity.encryptionKey,
                })
                const ready = await this.waitForEngine(engine, runtime)
                if (!ready) throw new Error('The engine did not acknowledge its launch')
                await this.waitForHealth(engine, `${runtime.engine.origin}/health`, { Authorization: `Bearer ${runtime.engine.apiKey}` }, runtime)
                this.runtime = runtime
                this.publish('ready')
                return runtime
            } catch {
                await this.stopChildren()
                if (attempt === 2 || this.stopping) {
                    await rm(resolve(this.root, 'runtime.json'), { force: true })
                    this.publish('error', 'The local services could not start. Retry, or check the bundled runtime installation.')
                    throw new Error(this.status.message)
                }
            }
        }
    }

    async waitForHealth(child, url, headers, runtime) {
        const deadline = Date.now() + this.startupTimeout
        while (Date.now() < deadline && !this.stopping) {
            if (child.exitCode !== null || child.signalCode !== null || child.launchFailed) throw new Error('Service exited during startup')
            try {
                const response = await this.fetcher(url, { headers, signal: AbortSignal.timeout(1500), redirect: 'error' })
                const body = response.ok ? await response.json() : null
                if (body?.status === 'ready' && body.protocolVersion === PROTOCOL_VERSION && body.launchNonce === runtime.launchNonce && body.buildId === runtime.buildId && body.workspaceId === 1) return
            } catch {}
            await wait(100)
        }
        throw new Error('Service readiness timed out')
    }

    waitForEngine(child, runtime) {
        return new Promise((done, fail) => {
            const cleanup = () => { clearTimeout(timer); child.off('message', message); child.off('exit', exited); child.off('error', exited) }
            const message = value => {
                if (value?.type === 'ready' && value.protocolVersion === PROTOCOL_VERSION && value.launchNonce === runtime.launchNonce && value.buildId === runtime.buildId) { cleanup(); done(true) }
            }
            const exited = () => { cleanup(); fail(new Error('Engine exited before readiness')) }
            const timer = setTimeout(() => { cleanup(); fail(new Error('Engine readiness timed out')) }, this.startupTimeout)
            child.on('message', message)
            child.once('exit', exited)
            child.once('error', exited)
        })
    }

    async stopChildren() {
        const owned = [...this.children].reverse()
        for (const child of owned) {
            if (child.exitCode !== null || child.signalCode !== null) continue
            const exited = new Promise(done => child.once('exit', done))
            if (child.connected) child.send({ type: 'stop' }, () => {})
            else child.kill('SIGTERM')
            let timer
            await Promise.race([exited, new Promise(done => { timer = setTimeout(done, this.stopTimeout) })])
            clearTimeout(timer)
            if (child.exitCode === null && child.signalCode === null) {
                child.kill('SIGKILL')
                await exited
            }
            this.children.delete(child)
        }
    }

    async stop({ preserveError = false } = {}) {
        this.stopping = true
        if (!preserveError) this.publish('stopping', 'Closing local services…')
        await this.stopChildren()
        await rm(resolve(this.root, 'runtime.json'), { force: true })
        this.runtime = null
        if (!preserveError) this.publish('stopped')
    }
}
