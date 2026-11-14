import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync, readdirSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { dataDir } from '../../config/paths.js'
import { desktopSubscriptionModels, type DesktopSubscriptionProvider } from '@rerun/contracts'
import { z } from 'zod'
import { assertDesktopRunAdmission } from '../workspace-admission.js'
import { openDesktopSubscriptionCatalogRelay, openDesktopSubscriptionTurnRelay } from './device-relay.js'
import { SubscriptionAcpError } from './peer.js'
import { openDesktopSubscriptionAcpSession } from './session.js'
import { noteDesktopPlanUsage } from '../plan-usage-diagnostic.js'
import { planLimitWindowsFromGrok, planLimitWindowsFromKimi, recordPlanLimits, type GrokBilling, type KimiUsage } from '../../connections/plan-limits.js'

const runners = {
    'grok-build': {
        variable: 'RERUN_DESKTOP_GROK_BUILD_RUNNER',
        home: 'GROK_HOME',
        args: ['--no-auto-update', 'agent', 'stdio'],
        // A chat turn runs Grok with none of its own tools and no web search: the reply is text only.
        turn: ['--no-auto-update', '--tools', '', '--disable-web-search', 'agent', 'stdio'],
        login: ['--no-auto-update', 'login', '--device-auth'],
    },
    'kimi-code': {
        variable: 'RERUN_DESKTOP_KIMI_CODE_RUNNER',
        home: 'KIMI_CODE_HOME',
        args: ['acp'],
        turn: ['acp'],
        login: ['login', '--region', 'global'],
    },
    devin: {
        variable: 'RERUN_DESKTOP_DEVIN_RUNNER',
        // Devin keeps its account, settings and caches under the XDG folders; all four are private here.
        home: 'XDG_DATA_HOME',
        args: ['acp'],
        turn: ['acp'],
        // Its page shows a code to paste back, so no local listener is needed inside the sandbox.
        login: ['auth', 'login', '--force-manual-token-flow'],
    },
} as const

const unavailable = () => new Error('The subscription provider runner is unavailable.')
const shutdownUnconfirmed = () => new Error('The subscription provider runner did not stop cleanly.')
type Worker = () => Promise<void>
const workers = new Map<DesktopSubscriptionProvider, { dispose: Worker; turn: boolean }>()
let stopping = false

function ownedFile(path: string | undefined, executable = false) {
    if (!path || !isAbsolute(path)) throw unavailable()
    try {
        const info = lstatSync(path)
        if (info.isFile() && realpathSync(path) === path && info.nlink === 1 &&
            (info.mode & 0o022) === 0 && (!executable || (info.mode & 0o100) !== 0) &&
            (info.uid === 0 || info.uid === process.getuid?.())) return path
    } catch {
        // The caller gets a fixed error without local paths.
    }
    throw unavailable()
}

function bundlePaths(provider: DesktopSubscriptionProvider) {
    if (process.platform !== 'darwin' || process.arch !== 'arm64' || process.env.RERUN_DESKTOP_APP !== '1') {
        throw unavailable()
    }
    return {
        binary: ownedFile(process.env[runners[provider].variable], true),
        sandbox: ownedFile(process.env.RERUN_DESKTOP_SUBSCRIPTION_SANDBOX),
    }
}

export function desktopSubscriptionRunnerAvailable(provider: DesktopSubscriptionProvider) {
    try {
        bundlePaths(provider)
        workspaceRoot()
        return !stopping
    } catch {
        return false
    }
}

function ownedDirectory(path: string) {
    try {
        const info = lstatSync(path)
        if (info.isDirectory() && info.uid === process.getuid?.() && (info.mode & 0o077) === 0 &&
            realpathSync(path) === path) return path
    } catch {
        // Keep account paths out of errors.
    }
    throw unavailable()
}

function privateDirectory(path: string) {
    try {
        mkdirSync(path, { mode: 0o700 })
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw unavailable()
    }
    return ownedDirectory(path)
}

function workspaceRoot() {
    try {
        const root = dataDir()
        if (root === process.env.RERUN_DESKTOP_ENGINE_ROOT && isAbsolute(root) &&
            realpathSync(root) === root && lstatSync(root).isDirectory()) return root
    } catch {
        // Never fall back to the CLI's default data directory.
    }
    throw unavailable()
}

function providerDirectory(provider: DesktopSubscriptionProvider, create: boolean) {
    const root = workspaceRoot()
    const directory = create ? privateDirectory : ownedDirectory
    return directory(join(directory(join(root, 'subscription-providers')), provider))
}

function accountDirectories(profile: string) {
    return {
        profile,
        cwd: privateDirectory(join(profile, 'work')),
        home: privateDirectory(join(profile, 'home')),
        vendorHome: privateDirectory(join(profile, 'account')),
        temp: privateDirectory(join(profile, 'tmp')),
    }
}

const attemptIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function attemptPath(providerRoot: string, attemptId: string) {
    if (!attemptIdPattern.test(attemptId)) throw unavailable()
    return join(providerRoot, 'device-' + attemptId)
}

export function desktopSubscriptionDeviceLoginAvailable(provider: DesktopSubscriptionProvider) {
    try {
        ownedFile(process.env.RERUN_DESKTOP_SUBSCRIPTION_LOGIN_SANDBOX)
        return desktopSubscriptionRunnerAvailable(provider)
    } catch {
        return false
    }
}

function readApproval(provider: DesktopSubscriptionProvider) {
    try {
        const providerRoot = providerDirectory(provider, false)
        const receipt = ownedFile(join(providerRoot, 'device-approval.json'))
        const info = lstatSync(receipt)
        if (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 100) return null
        const { id } = JSON.parse(readFileSync(receipt, 'utf8'))
        if (typeof id !== 'string') return null
        return { id, receipt, providerRoot, profile: ownedDirectory(attemptPath(providerRoot, id)) }
    } catch {
        return null
    }
}

export function desktopSubscriptionDeviceApproved(provider: DesktopSubscriptionProvider) {
    return readApproval(provider) !== null
}

export function forgetDesktopSubscriptionDeviceApproval(provider: DesktopSubscriptionProvider) {
    if (workers.has(provider)) throw unavailable()
    const saved = readApproval(provider)
    if (!saved) return
    unlinkSync(saved.receipt)
    rmSync(join(saved.providerRoot, 'model-catalog.json'), { force: true })
    rmSync(saved.profile, { recursive: true, force: true })
}

export function createDesktopSubscriptionDeviceAttempt(provider: DesktopSubscriptionProvider, id: string) {
    if (!desktopSubscriptionDeviceLoginAvailable(provider) || workers.has(provider)) throw unavailable()
    const providerRoot = providerDirectory(provider, true)
    const profile = attemptPath(providerRoot, id)
    mkdirSync(profile, { mode: 0o700 })
    const account = accountDirectories(ownedDirectory(profile))
    return {
        launch(proxy: string, port: number) {
            const { binary } = bundlePaths(provider)
            const sandbox = ownedFile(process.env.RERUN_DESKTOP_SUBSCRIPTION_LOGIN_SANDBOX)
            // Devin only takes its sign-in code from a terminal: its sign-in runs on a pseudo-terminal.
            return spawnRunner(provider, { binary, sandbox }, account, runners[provider].login, { proxy, port }, false, provider === 'devin')
        },
        approve() {
            if (workers.has(provider)) throw unavailable()
            ownedDirectory(profile)
            const temp = join(providerRoot, id + '.receipt.tmp')
            writeFileSync(temp, JSON.stringify({ id }), { flag: 'wx', mode: 0o600 })
            try { linkSync(temp, join(providerRoot, 'device-approval.json')) }
            finally { unlinkSync(temp) }
        },
        discard() {
            if (workers.has(provider)) throw unavailable()
            rmSync(ownedDirectory(profile), { recursive: true, force: true })
        },
    }
}

// The packaged policy denies process creation. Only this directly owned PID can run.
async function stopChild(child: ChildProcess, exited: Promise<true>, group = false) {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
    const pid = child.pid
    // A terminal sign-in is a small group of its own: the signal goes to all of it.
    const signal = (name: NodeJS.Signals) => {
        if (!group) { child.kill(name); return }
        try { process.kill(-pid, name) } catch { child.kill(name) }
    }
    signal('SIGTERM')
    if (await Promise.race([exited, delay(600, false, { ref: false })])) return
    signal('SIGKILL')
    if (!await Promise.race([exited, delay(1_500, false, { ref: false })])) throw shutdownUnconfirmed()
}

/** Qualifies the installed runner using a workspace-owned account and an offline policy. */
export async function openOfflineDesktopSubscriptionRunner(provider: DesktopSubscriptionProvider) {
    const paths = bundlePaths(provider)
    const account = accountDirectories(providerDirectory(provider, true))
    const { child, dispose } = spawnRunner(provider, paths, account, runners[provider].args)
    child.stderr.resume()
    return openDesktopSubscriptionAcpSession({
        provider, cwd: account.cwd, channel: { input: child.stdout, output: child.stdin, dispose },
    })
}

// Kimi's login rewrites config.toml. Apply the documented global tool policy after
// login and before the first ACP session. Existing approved profiles use the same path.
const kimiTextToolPolicy = '[tools]\nenabled = ["*"]\n'
function restrictKimiTools(vendorHome: string) {
    const path = join(vendorHome, 'config.toml')
    const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    let config: string
    try {
        const info = fstatSync(file)
        if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() ||
            (info.mode & 0o022) !== 0 || info.size > 128 * 1024) throw unavailable()
        config = readFileSync(file, 'utf8')
    } finally {
        closeSync(file)
    }
    const tools = [...config.matchAll(/^[ \t]*\[\s*(?:tools|"tools"|'tools')\s*\][^\n]*$/gm)]
    if (tools.length) {
        const start = tools[0]!.index + tools[0]![0].length
        const section = config.slice(start).split(/^[ \t]*\[/m)[0]
        if (tools.length !== 1 || section?.trim() !== 'enabled = ["*"]') throw unavailable()
        return
    }
    replacePrivateFile(path, config.trimEnd() + '\n\n' + kimiTextToolPolicy)
}

function replacePrivateFile(path: string, content: string) {
    const temp = join(dirname(path), randomUUID() + '.tmp')
    writeFileSync(temp, content, { flag: 'wx', mode: 0o600 })
    try {
        renameSync(temp, path)
    } finally {
        rmSync(temp, { force: true })
    }
}

export function desktopSubscriptionChatAvailable(provider: DesktopSubscriptionProvider) {
    return desktopSubscriptionDeviceLoginAvailable(provider)
}

const catalogSchema = z.object({
    generation: z.string().regex(attemptIdPattern),
    refreshedAt: z.iso.datetime(),
    models: desktopSubscriptionModels,
})

export function readDesktopSubscriptionCatalog(provider: DesktopSubscriptionProvider) {
    if (!desktopSubscriptionDeviceLoginAvailable(provider)) return null
    const saved = readApproval(provider)
    if (!saved) return null
    try {
        const path = ownedFile(join(saved.providerRoot, 'model-catalog.json'))
        const info = lstatSync(path)
        if (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 512 * 1024) return null
        const result = catalogSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
        return result.generation === saved.id ? result : null
    } catch {
        return null
    }
}

export async function refreshDesktopSubscriptionCatalog(provider: DesktopSubscriptionProvider, signal: AbortSignal) {
    const admission = assertDesktopRunAdmission()
    const saved = readApproval(provider)
    if (!saved) throw new SubscriptionAcpError('auth-required')
    const session = await openApprovedSession(provider, saved.id, 'catalog', signal)
    const initial = session.getSelectors().find(option => option.category === 'model')
    const models = []
    try {
        if (!initial) throw new SubscriptionAcpError('selection-unavailable')
        // Devin names one model per effort. They are listed once, with the efforts as its levels.
        if (provider === 'devin') models.push(...desktopDevinModels(initial.options))
        else for (const option of initial.options) {
            const selected = await session.selectModel(option.value, signal)
            const reasoning = selected.find(selector => selector.category === 'thought_level')
            models.push({
                id: option.value,
                label: option.name,
                ...(reasoning && { reasoning: {
                    supported: reasoning.options.map(option => option.value),
                    default: reasoning.currentValue,
                } }),
            })
        }
    } finally {
        await session.close()
    }
    signal.throwIfAborted()
    assertDesktopRunAdmission(admission)
    if (stopping || readApproval(provider)?.id !== saved.id) throw new SubscriptionAcpError('auth-required')
    const result = catalogSchema.parse({ generation: saved.id, refreshedAt: new Date().toISOString(), models })
    replacePrivateFile(join(saved.providerRoot, 'model-catalog.json'), JSON.stringify(result))
    return result
}

/** Opens one confined turn for the exact approved account. No credential is exported. */
export function openDesktopSubscriptionTurn(
    provider: DesktopSubscriptionProvider,
    generation: string,
    signal?: AbortSignal,
) {
    return openApprovedSession(provider, generation, 'turn', signal)
}

const PLAN_USAGE_EVERY_MS = 5 * 60_000
const planUsageReads = new Map<DesktopSubscriptionProvider, Promise<void>>()
const planUsageAttemptedAt = new Map<DesktopSubscriptionProvider, number>()
// The global Kimi Code API, the one host besides its sign-in host that Kimi's own tool may reach here.
const KIMI_USAGE_URL = 'https://api.kimi.ai/coding/v1/usages'

/**
 * Kimi has no usage call in its tool, so the engine asks Kimi's API with the access token Kimi's
 * tool saved in its private folder (owner's decision, November 14, 2026). The token is read, sent
 * only to that API, and never kept, logged or renewed here: it lives fifteen minutes and only
 * Kimi's tool renews it, when it answers. With an expired token there is simply no new reading.
 */
export async function readDesktopKimiPlanUsage(generation: string, request: typeof fetch = fetch, now = Date.now()): Promise<void> {
    const saved = readApproval('kimi-code')
    if (!saved || saved.id !== generation) return
    try {
        const directory = ownedDirectory(join(accountDirectories(saved.profile).vendorHome, 'credentials'))
        const names = readdirSync(directory).filter(name => /^kimi-code[A-Za-z0-9_-]{0,64}\.json$/.test(name))
        if (names.length !== 1) { noteDesktopPlanUsage('kimi-code', { outcome: `sign-in-files:${names.length}` }); return }
        const file = ownedFile(join(directory, names[0]!))
        const info = lstatSync(file)
        if (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 64 * 1024) return
        const { access_token: token, expires_at: expires } = JSON.parse(readFileSync(file, 'utf8')) as { access_token?: unknown; expires_at?: unknown }
        if (typeof token !== 'string' || !token || /[\0\r\n]/.test(token) || typeof expires !== 'number') { noteDesktopPlanUsage('kimi-code', { outcome: 'sign-in-unreadable' }); return }
        if (expires * 1000 < now + 30_000) { noteDesktopPlanUsage('kimi-code', { outcome: 'sign-in-expired' }); return }
        const response = await request(KIMI_USAGE_URL, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(8000) })
        if (!response.ok) { noteDesktopPlanUsage('kimi-code', { outcome: 'endpoint-refused', status: response.status }); return }
        const body = await response.json() as KimiUsage
        const windows = planLimitWindowsFromKimi(body)
        noteDesktopPlanUsage('kimi-code', { outcome: windows.length ? 'read' : 'no-quotas', status: response.status, fields: Object.keys(body?.usages ?? body ?? {}) })
        if (readApproval('kimi-code')?.id === generation) recordPlanLimits(`mac-kimi-code-${generation}`, windows)
    } catch (error) {
        // No reading: the list keeps what it last showed.
        noteDesktopPlanUsage('kimi-code', { outcome: `failed:${(error as Error).name}` })
    }
}

function recordSubscriptionPlanUsage(provider: DesktopSubscriptionProvider, generation: string, usage: unknown) {
    if (provider === 'kimi-code') { void readDesktopKimiPlanUsage(generation); return }
    if (provider !== 'grok-build' || readApproval(provider)?.id !== generation) return
    recordPlanLimits(`mac-${provider}-${generation}`, planLimitWindowsFromGrok(usage as GrokBilling))
}

/**
 * Reads the plan usage of a signed-in subscription without sending a prompt, at most every five
 * minutes and never while the provider is answering: a reply reads it itself when it completes.
 */
export function refreshDesktopSubscriptionPlanUsage(provider: DesktopSubscriptionProvider): Promise<void> {
    if (provider === 'kimi-code') {
        const saved = readApproval(provider)
        if (!saved || stopping || Date.now() - (planUsageAttemptedAt.get(provider) ?? 0) < PLAN_USAGE_EVERY_MS) return Promise.resolve()
        planUsageAttemptedAt.set(provider, Date.now())
        return readDesktopKimiPlanUsage(saved.id)
    }
    if (provider !== 'grok-build' || stopping || workers.has(provider)) return Promise.resolve()
    const pending = planUsageReads.get(provider)
    if (pending) return pending
    if (Date.now() - (planUsageAttemptedAt.get(provider) ?? 0) < PLAN_USAGE_EVERY_MS) return Promise.resolve()
    const saved = readApproval(provider)
    if (!saved) return Promise.resolve()
    planUsageAttemptedAt.set(provider, Date.now())
    const signal = AbortSignal.timeout(20_000)
    const read = (async () => {
        const session = await openApprovedSession(provider, saved.id, 'catalog', signal, true)
        try { recordSubscriptionPlanUsage(provider, saved.id, await session.readPlanUsage(signal)) }
        finally { await session.close() }
    })().catch(() => {}).finally(() => { planUsageReads.delete(provider) })
    planUsageReads.set(provider, read)
    return read
}

async function openApprovedSession(
    provider: DesktopSubscriptionProvider,
    generation: string,
    purpose: 'catalog' | 'turn',
    signal?: AbortSignal,
    usageRead = false,
) {
    // A usage read holds the provider's one runner for a moment; a reply or model list waits it out.
    if (!usageRead) await planUsageReads.get(provider)
    const admission = assertDesktopRunAdmission()
    const assertCurrent = () => {
        signal?.throwIfAborted()
        assertDesktopRunAdmission(admission)
        const saved = readApproval(provider)
        if (!saved || saved.id !== generation) throw new SubscriptionAcpError('auth-required')
        return saved
    }
    assertCurrent()
    if (!desktopSubscriptionDeviceLoginAvailable(provider) || workers.has(provider)) throw unavailable()
    if (purpose === 'turn' && !desktopSubscriptionChatAvailable(provider)) throw unavailable()
    const { binary } = bundlePaths(provider)
    const sandbox = ownedFile(process.env.RERUN_DESKTOP_SUBSCRIPTION_LOGIN_SANDBOX)
    const relay = await (purpose === 'catalog'
        ? openDesktopSubscriptionCatalogRelay(provider)
        : openDesktopSubscriptionTurnRelay(provider))
    try {
        const account = accountDirectories(assertCurrent().profile)
        if (workers.has(provider)) throw unavailable()
        if (provider === 'kimi-code') restrictKimiTools(account.vendorHome)
        // Catalog discovery keeps the plain arguments; only a turn starts Grok without its tools.
        const { child, dispose } = spawnRunner(provider, { binary, sandbox }, account, purpose === 'turn' ? runners[provider].turn : runners[provider].args, relay, true)
        child.stderr.resume()
        return await openDesktopSubscriptionAcpSession({
            provider, cwd: account.cwd, signal, onPlanUsage: usage => recordSubscriptionPlanUsage(provider, generation, usage), beforePrompt() {
                if (purpose !== 'turn') throw unavailable()
                assertCurrent()
            },
            channel: { input: child.stdout, output: child.stdin, dispose },
        })
    } catch (error) {
        await relay.close()
        if (error instanceof SubscriptionAcpError) throw error
        signal?.throwIfAborted()
        assertDesktopRunAdmission(admission)
        throw unavailable()
    }
}

function spawnRunner(
    provider: DesktopSubscriptionProvider,
    { binary, sandbox }: ReturnType<typeof bundlePaths>,
    { profile, cwd, home, vendorHome, temp }: ReturnType<typeof accountDirectories>,
    args: readonly string[],
    relay?: { proxy: string; port: number; close?: () => Promise<void> },
    turn = false,
    terminal = false,
) {
    if (stopping || workers.has(provider)) throw unavailable()
    const definition = runners[provider]
    // `script` only lends its pseudo-terminal; the runner under it is confined exactly as without it.
    // It refuses the socket Node gives a child as its input, so `cat` hands it a plain pipe. The
    // three run as one process group, stopped together.
    const child = spawn(terminal ? '/bin/sh' : '/usr/bin/sandbox-exec', [
        ...(terminal ? ['-c', '/bin/cat | /usr/bin/script -q /dev/null "$@"', 'sh', '/usr/bin/sandbox-exec'] : []),
        '-D', `RUNNER=${binary}`, '-D', `RUNNER_DIR=${dirname(binary)}`, '-D', `PROFILE=${profile}`,
        ...(relay ? ['-D', `AUTH_RELAY=localhost:${relay.port}`] : []),
        '-f', sandbox, binary, ...args,
    ], {
        cwd,
        env: {
            PATH: '/usr/bin:/bin',
            HOME: home,
            TMPDIR: temp,
            TERM: 'dumb',
            LANG: 'en_US.UTF-8',
            TZ: 'UTC',
            NODE_ENV: 'production',
            [definition.home]: vendorHome,
            ...(provider === 'kimi-code' ? { KIMI_DISABLE_TELEMETRY: '1', KIMI_CODE_WATCH: '0' } : {}),
            ...(provider === 'devin' ? { XDG_CONFIG_HOME: join(vendorHome, 'config'), XDG_CACHE_HOME: join(vendorHome, 'cache'), XDG_STATE_HOME: join(vendorHome, 'state') } : {}),
            ...(relay ? {
                HTTPS_PROXY: relay.proxy, HTTP_PROXY: relay.proxy,
                https_proxy: relay.proxy, http_proxy: relay.proxy,
            } : {}),
        },
        shell: false,
        detached: terminal,
        stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.on('error', () => child.stdout.destroy())
    const exited = new Promise<true>(resolve => child.once('exit', () => resolve(true)))
    let draining: Promise<void> | undefined
    const dispose: Worker = () => draining ??= Promise.all([
        relay?.close?.(),
        stopChild(child, exited, terminal),
    ]).then(() => {
        if (workers.get(provider)?.dispose === dispose) workers.delete(provider)
    }).catch(error => {
        // Retain failed drains for the next service shutdown attempt.
        draining = undefined
        throw error
    })
    workers.set(provider, { dispose, turn })
    return { child, dispose }
}

export async function drainDesktopSubscriptionTurns() {
    const turns = [...workers.values()].filter(worker => worker.turn)
    await drainWorkers(turns)
}

export async function stopDesktopSubscriptionRunners() {
    stopping = true
    await drainWorkers([...workers.values()])
}

async function drainWorkers(active: readonly { dispose: Worker }[]) {
    const results = await Promise.allSettled(active.map(worker => worker.dispose()))
    if (results.some(result => result.status === 'rejected')) throw shutdownUnconfirmed()
}

const devinEfforts = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const devinVariant = /^(.+)-(low|medium|high|xhigh|max)(-fast|-lightning)?$/

/** `claude-opus-5-5` + `high` (+ `-fast`) is the id Devin's own selector uses. */
export function desktopDevinModelId(model: string, effort: string | undefined) {
    const split = model.match(/^(.+?)(-fast|-lightning)?$/)
    return effort && split ? `${split[1]}-${effort}${split[2] ?? ''}` : model
}

/** Folds Devin's per-effort model ids into one model each, its efforts listed lowest first. */
export function desktopDevinModels(options: readonly { value: string; name: string }[]) {
    const families = new Map<string, { id: string; label: string; efforts: Set<string> }>()
    const plain: { id: string; label: string }[] = []
    for (const option of options) {
        const match = option.value.match(devinVariant)
        if (!match) { plain.push({ id: option.value, label: option.name }); continue }
        const id = match[1]! + (match[3] ?? '')
        const family = families.get(id) ?? { id, label: option.name, efforts: new Set<string>() }
        // The selector names a family by its plain variant; a Fast or Lightning one says so.
        if (match[3] && !/fast|lightning/i.test(family.label)) family.label = `${option.name} ${match[3] === '-fast' ? 'Fast' : 'Lightning'}`
        family.efforts.add(match[2]!)
        families.set(id, family)
    }
    const grouped = [...families.values()].map(({ id, label, efforts }) => {
        const supported = devinEfforts.filter(effort => efforts.has(effort))
        return { id, label, reasoning: { supported: [...supported], default: supported.includes('medium') ? 'medium' : supported[0]! } }
    })
    // In Devin's own order of families first, then the models it names without an effort.
    return [...grouped, ...plain].slice(0, 512)
}
