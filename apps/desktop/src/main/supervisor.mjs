import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { isAbsolute, resolve } from 'node:path'
import { lstat, rm, realpath } from 'node:fs/promises'
import { workspaceDirectory, validWorkspaceId } from './workspaces/paths.mjs'
import { atomicPrivateJSON, bindWorkspace, childEnvironment, publicStatus, PROTOCOL_VERSION, workspaceIdentity } from './runtime.mjs'

const wait = ms => new Promise(done => setTimeout(done, ms))
const SHUTDOWN_DIAGNOSTIC_EVENTS = new Set([
    'stop-requested', 'stop-succeeded', 'stop-failed', 'tools-drain-requested', 'tools-drain-ack',
    'engine-stop-failed', 'engine-stopped-ack', 'child-exit', 'blocked-engine-exit',
    'child-already-exited', 'child-stop-requested', 'child-stop-wait-settled', 'child-stop-verdict', 'children-stop-verdict',
])

export async function candidatePort() {
    const server = createServer()
    await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done) })
    const port = server.address().port
    await new Promise((done, fail) => server.close(error => error ? fail(error) : done()))
    return port
}

export class RuntimeSupervisor extends EventEmitter {
    constructor({ bundle, root, identity, appStoreBuild = false, launch = spawn, fetcher = fetch, port = candidatePort, startupTimeout = 60000, stopTimeout = 35000 }) {
        super()
        Object.assign(this, { bundle, root, identity, appStoreBuild, launch, fetcher, port, startupTimeout, stopTimeout })
        // Engine drains include a 25-second isolated-screen close plus final worker cleanup.
        // Wait for their acknowledgement without treating a legitimate drain as a failure.
        this.children = new Set()
        this.status = publicStatus('stopped')
        this.operation = null
        this.stopping = false
        this.shutdownEvents = []
        this.shutdownDiagnosticWrites = Promise.resolve()
    }

    shutdownDiagnostic(event, child, { timeout = false, confirmed = null, force = false } = {}) {
        if (!SHUTDOWN_DIAGNOSTIC_EVENTS.has(event)) return
        // A fixed projection only: never serialize ChildProcess, runtime, errors, paths,
        // argv, provider data or environment. Keep late exits after a failed Quit too.
        const runtime = this.runtime
        const row = {
            event,
            launchNonce: typeof runtime?.launchNonce === 'string' && /^[a-f0-9-]{36}$/i.test(runtime.launchNonce) ? runtime.launchNonce : null,
            workspaceId: validWorkspaceId(runtime?.workspaceId) ? runtime.workspaceId : null,
            role: child?.desktopRole === 'engine' ? 'engine' : child?.desktopRole === 'ui' ? 'ui' : null,
            exitCode: Number.isSafeInteger(child?.exitCode) ? child.exitCode : null,
            signalCode: typeof child?.signalCode === 'string' && /^SIG[A-Z0-9]{1,12}$/.test(child.signalCode) ? child.signalCode : null,
            shutdownFailed: child?.shutdownFailed === true,
            stopRequested: child?.stopRequested === true,
            stoppedAck: child?.stoppedAcknowledged === true,
            sameRuntimeToolsAck: !!runtime && this.toolsDrainedRuntime === runtime,
            unconfirmedEngineExit: this.unconfirmedEngineExit === true,
            timeout: timeout === true,
            confirmed: typeof confirmed === 'boolean' ? confirmed : null,
            force: force === true,
        }
        this.shutdownEvents.push(row)
        this.shutdownEvents = this.shutdownEvents.slice(-64)
        const snapshot = { version: 1, events: [...this.shutdownEvents] }
        this.shutdownDiagnosticWrites = this.shutdownDiagnosticWrites.then(async () => {
            if (typeof this.root !== 'string' || !isAbsolute(this.root)) return
            const root = await realpath(this.root), info = await lstat(root)
            if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) return
            if (runtime?.installRoot && root !== runtime.installRoot) return
            const file = resolve(root, 'shutdown-diagnostics.json')
            try {
                const existing = await lstat(file)
                if (!existing.isFile() || existing.isSymbolicLink() || existing.uid !== process.getuid?.()) return
            } catch (error) { if (error.code !== 'ENOENT') return }
            await atomicPrivateJSON(file, snapshot)
        }).catch(() => {}) // Diagnostics must never change shutdown success or failure.
    }

    publish(state, message = '') {
        this.status = publicStatus(state, message)
        this.emit('status', this.status)
    }

    spawnOwned(args, env, launchNonce, role = 'engine') {
        const startup = this.startupAbort
        const child = this.launch(this.bundle.nodePath, args, { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], detached: false })
        child.desktopRole = role
        this.children.add(child)
        child.stdout?.resume()
        child.stderr?.resume()
        child.on('message', value => {
            if (!launchNonce || value?.launchNonce !== launchNonce) return
            if (value.type === 'stop-failed') { child.shutdownFailed = true; this.shutdownDiagnostic('engine-stop-failed', child) }
            if (value.type === 'stopped') { child.shutdownFailed = false; child.stoppedAcknowledged = true; this.shutdownDiagnostic('engine-stopped-ack', child) }
        })
        child.on('error', () => { child.launchFailed = true; if (!this.cleaning && !this.stopping) startup?.abort() })
        child.once('exit', () => {
            // A late failed exit after a Quit timeout must not disappear with
            // the ChildProcess. UI cleanup cannot attest this engine's writers.
            if (child.desktopRole === 'engine' && child.stopRequested
                && (child.shutdownFailed || child.exitCode !== 0 || child.signalCode !== null)) this.unconfirmedEngineExit = true
            this.shutdownDiagnostic('child-exit', child)
            this.children.delete(child)
            if (!this.cleaning && !this.stopping && this.status.state === 'starting') startup?.abort()
            if (!this.stopping && this.status.state === 'ready') {
                this.publish('error', 'A local service stopped. Retry to restart the app services.')
                void this.stop({ preserveError: true }).catch(() => {})
            }
        })
        return child
    }

    startFor(workspaceId, metadata = {}) {
        if (!validWorkspaceId(workspaceId)) return Promise.reject(new Error('Invalid workspace identity'))
        if (this.operation && this.workspaceId !== workspaceId) return Promise.reject(new Error('Another workspace is starting'))
        if (this.runtime && this.runtime.workspaceId !== workspaceId) return Promise.reject(new Error('Close the active workspace before starting another'))
        this.workspaceId = workspaceId
        this.workspaceMetadata = metadata
        return this.start()
    }

    start() {
        if (this.unconfirmedEngineExit) return Promise.reject(new Error('Engine cleanup was not confirmed'))
        if (this.operation) return this.operation
        if (this.status.state === 'ready') return Promise.resolve(this.runtime)
        this.operation = this.startServices().finally(() => { this.operation = null })
        return this.operation
    }

    async startServices() {
        this.stopping = false
        this.publish('starting', 'Starting your local workspace…')
        const workspaceId = this.workspaceId ?? 1
        const installRoot = await realpath(this.root)
        const engineRoot = await bindWorkspace(installRoot, this.identity, workspaceId)
        const dataRoot = workspaceId === 1 ? installRoot : workspaceDirectory(installRoot, workspaceId)
        const identity = workspaceIdentity(this.identity, workspaceId)
        for (let attempt = 0; attempt < 3; attempt++) {
            this.startupAbort = new AbortController()
            try {
                const uiPort = await this.port()
                let enginePort = await this.port()
                while (enginePort === uiPort) enginePort = await this.port()
                const runtime = {
                    protocolVersion: PROTOCOL_VERSION, launchNonce: randomUUID(), buildId: this.bundle.buildId,
                    workspaceId, installId: identity.installId, installRoot, dataRoot, engineRoot,
                    app: { origin: `http://127.0.0.1:${uiPort}`, sessionToken: randomBytes(32).toString('hex') },
                    engine: { origin: `http://127.0.0.1:${enginePort}`, apiKey: identity.engineApiKey },
                }
                const runtimeFile = resolve(this.root, 'runtime.json')
                await atomicPrivateJSON(runtimeFile, runtime)
                const shared = { ...childEnvironment(), RERUN_DESKTOP_APP: '1', RERUN_DESKTOP_DATA_DIR: dataRoot, RERUN_DESKTOP_RUNTIME_FILE: runtimeFile, RERUN_DESKTOP_SECRET_KEY: identity.encryptionKey, RERUN_DESKTOP_WORKSPACE_ID: String(workspaceId), RERUN_DESKTOP_INSTALL_ROOT: installRoot, RERUN_DESKTOP_INSTALL_DIR: installRoot, RERUN_DESKTOP_ENGINE_ROOT: engineRoot, RERUN_DESKTOP_WORKSPACE_NAME: this.workspaceMetadata?.name || 'My workspace', RERUN_DESKTOP_WORKSPACE_ICON: this.workspaceMetadata?.iconCatalogId || '', RERUN_DESKTOP_ADMISSIONS_FROZEN: this.workspaceMetadata?.frozen ? '1' : '0' }
                if (this.appStoreBuild) shared.RERUN_DESKTOP_APP_STORE = '1'
                const ui = this.spawnOwned([this.bundle.uiHost], { ...shared, RERUN_DESKTOP_UI_ROOT: this.bundle.uiRoot, RERUN_DESKTOP_RENAME_HELPER: this.bundle.renameHelperPath, RERUN_DESKTOP_PDF_HELPER: this.bundle.pdfHelperPath, RERUN_DESKTOP_PDF_TEXT_HELPER: this.bundle.pdfTextHelperPath, PORT: String(uiPort), HOSTNAME: '127.0.0.1' }, undefined, 'ui')
                await this.waitForHealth(ui, `${runtime.app.origin}/api/desktop/health`, { Cookie: `rerun-desktop-session=${runtime.app.sessionToken}` }, runtime)
                const engine = this.spawnOwned([this.bundle.engineEntry, 'desktop-run'], {
                    ...shared, RERUN_HOST: '127.0.0.1', RERUN_PORT: String(enginePort), RERUN_API_KEY: identity.engineApiKey,
                    RERUN_DATA_DIR: engineRoot, RERUN_HUB_BASE_URL: runtime.app.origin, RERUN_DESKTOP: 'off',
                    // App Sandbox can host the services. Its children cannot start the
                    // separate Seatbelt profiles used by these subscription and command runners.
                    ...(!this.appStoreBuild && {
                        RERUN_DESKTOP_CODEX_RUNNER: this.bundle.codexPath,
                        RERUN_DESKTOP_CLAUDE_RUNNER: this.bundle.claudePath,
                        RERUN_DESKTOP_CLAUDE_SANDBOX: this.bundle.claudeSandboxPath,
                        RERUN_DESKTOP_GROK_BUILD_RUNNER: this.bundle.grokBuildPath,
                        RERUN_DESKTOP_KIMI_CODE_RUNNER: this.bundle.kimiCodePath,
                        RERUN_DESKTOP_SUBSCRIPTION_SANDBOX: this.bundle.subscriptionSandboxPath,
                        RERUN_DESKTOP_SUBSCRIPTION_LOGIN_SANDBOX: this.bundle.subscriptionLoginSandboxPath,
                    }),
                    RERUN_DESKTOP_RENAME_HELPER: this.bundle.renameHelperPath,
                }, runtime.launchNonce)
                const ready = await this.waitForEngine(engine, runtime)
                if (!ready) throw new Error('The engine did not acknowledge its launch')
                await this.waitForHealth(engine, `${runtime.engine.origin}/health`, { Authorization: `Bearer ${runtime.engine.apiKey}` }, runtime)
                await this.waitForHealth(ui, `${runtime.app.origin}/api/desktop/health`, { Cookie: `rerun-desktop-session=${runtime.app.sessionToken}` }, runtime)
                if (this.startupAbort.signal.aborted || [ui, engine].some(child => child.exitCode !== null || child.signalCode !== null || child.launchFailed)) throw new Error('A service exited during startup')
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
        while (Date.now() < deadline && !this.stopping && !this.startupAbort.signal.aborted) {
            if (child.exitCode !== null || child.signalCode !== null || child.launchFailed) throw new Error('Service exited during startup')
            try {
                const response = await this.fetcher(url, { headers, signal: AbortSignal.any([AbortSignal.timeout(1500), this.startupAbort.signal]), redirect: 'error' })
                const body = response.ok ? await response.json() : null
                if (body?.status === 'ready' && body.protocolVersion === PROTOCOL_VERSION && body.launchNonce === runtime.launchNonce && body.buildId === runtime.buildId && body.workspaceId === runtime.workspaceId) return
            } catch {}
            await wait(100)
        }
        throw new Error('Service readiness timed out')
    }

    waitForEngine(child, runtime) {
        return new Promise((done, fail) => {
            const signal = this.startupAbort.signal
            const cleanup = () => { clearTimeout(timer); child.off('message', message); child.off('exit', exited); child.off('error', exited); signal.removeEventListener('abort', exited) }
            const message = value => {
                if (value?.type === 'ready' && value.protocolVersion === PROTOCOL_VERSION && value.launchNonce === runtime.launchNonce && value.buildId === runtime.buildId) { cleanup(); done(true) }
            }
            const exited = () => { cleanup(); fail(new Error('Engine exited before readiness')) }
            const timer = setTimeout(() => { cleanup(); fail(new Error('Engine readiness timed out')) }, this.startupTimeout)
            child.on('message', message)
            child.once('exit', exited)
            child.once('error', exited)
            signal.addEventListener('abort', exited, { once: true })
            if (signal.aborted) exited()
        })
    }

    async stopChildren(force = true) {
        if (this.unconfirmedEngineExit && !force) { this.shutdownDiagnostic('blocked-engine-exit'); return false }
        this.cleaning = true
        let confirmed = !this.unconfirmedEngineExit
        const owned = [...this.children].reverse()
        for (const child of owned) {
            if (child.exitCode !== null || child.signalCode !== null) { this.shutdownDiagnostic('child-already-exited', child); continue }
            const exited = new Promise(done => child.once('exit', done))
            child.stopRequested = true
            this.shutdownDiagnostic('child-stop-requested', child, { force })
            if (child.connected) child.send({ type: 'stop' }, () => {})
            else child.kill('SIGTERM')
            let timer, timeout = false
            await Promise.race([exited, new Promise(done => { timer = setTimeout(() => { timeout = true; done() }, this.stopTimeout) })])
            clearTimeout(timer)
            this.shutdownDiagnostic('child-stop-wait-settled', child, { timeout, force })
            if (child.exitCode === null && child.signalCode === null) {
                confirmed = false
                this.shutdownDiagnostic('child-stop-verdict', child, { timeout, confirmed: false, force })
                // An ordinary Quit can retry a still-owned service. Force killing
                // its parent would discard custody of detached native workers.
                if (!force) break
                child.kill('SIGKILL')
                await exited
            }
            // ui-host requests Next's graceful SIGTERM handler. After draining its
            // HTTP server Next exits with 128 + SIGTERM (143), not zero. Accept
            // that exit only here, after an explicit stop and authenticated tool
            // drain for this launch; a raw signal or engine failure still fails.
            const gracefulUiExit = child.desktopRole === 'ui' && child.exitCode === 143
                && this.runtime && this.toolsDrainedRuntime === this.runtime
            if (child.shutdownFailed || (child.exitCode !== 0 && !gracefulUiExit) || child.signalCode !== null) confirmed = false
            this.shutdownDiagnostic('child-stop-verdict', child, { timeout, confirmed, force })
            this.children.delete(child)
            if (!confirmed && !force) break
        }
        this.cleaning = false
        this.shutdownDiagnostic('children-stop-verdict', undefined, { confirmed, force })
        return confirmed
    }

    async admissions(action, requestId) {
        const runtime = this.runtime
        if (!runtime) return true
        if (this.admissionCounter?.runtime !== runtime) this.admissionCounter = { runtime, sequence: 0 }
        const sequence = ++this.admissionCounter.sequence
        if (!Number.isSafeInteger(sequence)) throw new Error('Workspace admission sequence is exhausted')
        const response = await this.fetcher(`${runtime.app.origin}/api/desktop/internal/workspaces`, {
            method: 'POST', headers: { Authorization: `Bearer ${runtime.engine.apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ action, launchNonce: runtime.launchNonce, expectedWorkspaceId: runtime.workspaceId, requestId, sequence }),
            signal: AbortSignal.timeout(8000), redirect: 'error',
        })
        const body = response.ok ? await response.json() : null
        if (this.runtime !== runtime || body?.ok !== true || body.launchNonce !== runtime.launchNonce || body.workspaceId !== runtime.workspaceId || body.frozen !== (action === 'freeze') || body.sequence !== sequence || body.requestId !== requestId) throw new Error('Workspace admission change was not confirmed')
        return true
    }

    async saveDrainingDraft(agentId, body, signal) {
        const runtime = this.runtime
        if (!runtime || typeof agentId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(agentId)
            || typeof body !== 'string' || Buffer.byteLength(body) > 256 * 1024) throw new Error('Invalid pending draft save')
        signal.throwIfAborted()
        const reply = await this.fetcher(`${runtime.app.origin}/api/desktop/agents/${agentId}/draft`, {
            method: 'PUT', redirect: 'error', signal,
            headers: { Authorization: `Bearer ${runtime.engine.apiKey}`, 'X-Rerun-Launch-Nonce': runtime.launchNonce, 'Content-Type': 'application/json' },
            body,
        })
        const result = { status: reply.status, body: await reply.text() }
        signal.throwIfAborted()
        if (this.runtime !== runtime) throw new Error('The draft workspace changed')
        return result
    }

    async confirmToolsStopped(runtime) {
        // The UI owns detached local MCP groups. Obtain its explicit drain result
        // while both services are alive; killing a parent alone proves nothing.
        this.shutdownDiagnostic('tools-drain-requested')
        const response = await this.fetcher(`${runtime.app.origin}/api/desktop/internal/mcp`, {
            method: 'POST', headers: { Authorization: `Bearer ${runtime.engine.apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'shutdown' }), signal: AbortSignal.timeout(8000), redirect: 'error',
        })
        const result = response.ok ? await response.json() : null
        if (result?.stopped !== true) throw new Error('Local program cleanup was not confirmed')
        this.toolsDrainedRuntime = runtime
        this.shutdownDiagnostic('tools-drain-ack')
    }

    async prepareWorkspaceRecovery() {
        // Recovery may begin after the old HTTP listeners have closed. Retry the
        // owned process barrier first; its exact-runtime tool-drain ACK remains
        // valid because that UI registry was irreversibly closed by shutdown.
        // A fresh supervisor has no owned services and needs no HTTP admission.
        await this.stop()
    }

    async stop({ preserveError = false } = {}) {
        this.shutdownDiagnostic('stop-requested')
        this.stopping = true
        this.startupAbort?.abort()
        if (!preserveError) this.publish('stopping', 'Closing local services…')
        try {
            if (this.runtime && this.toolsDrainedRuntime !== this.runtime) await this.confirmToolsStopped(this.runtime)
            if (!await this.stopChildren(false)) throw new Error('Local service cleanup was not confirmed')
            await rm(resolve(this.root, 'runtime.json'), { force: true })
            this.shutdownDiagnostic('stop-succeeded', undefined, { confirmed: true })
            await this.shutdownDiagnosticWrites
            this.runtime = null
            if (!preserveError) this.publish('stopped')
        } catch (error) {
            // Retain custody when a live engine cannot acknowledge cleanup, including
            // after service death. Retrying must not force-kill its parent and lose writers.
            if (preserveError) await this.stopChildren(false)
            this.shutdownDiagnostic('stop-failed', undefined, { confirmed: false })
            await this.shutdownDiagnosticWrites
            this.stopping = false
            this.publish('error', 'A local program or service could not confirm it stopped. Quit was cancelled. Try again before reopening the workspace.')
            throw error
        }
    }
}
