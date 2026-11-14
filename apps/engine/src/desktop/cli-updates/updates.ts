import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { once } from 'node:events'
import { finished } from 'node:stream/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { DESKTOP_CLI_TOOLS, type DesktopCliTool, type DesktopCliToolStatus, type DesktopCliUpdateAction, type DesktopCliUpdates } from '@rerun/contracts'
import { activeRunCount } from '../../runtime/run-control.js'
import { DESKTOP_CLAUDE_SDK_VERSION } from '../claude-plan/runtime.js'
import { cliSources, newerCliVersion, type CliFetch, type CliRelease } from './sources.js'

const run = promisify(execFile)
const CHECK_EVERY_MS = 6 * 60 * 60_000
const DOWNLOAD_LIMIT = 1024 * 1024 * 1024
const VERSION = /^\d+\.\d+\.\d+(-[A-Za-z0-9.]+)?$/
type Failure = NonNullable<DesktopCliToolStatus['error']>
class CliUpdateError extends Error { constructor(readonly reason: Failure) { super(reason) } }

type Stored = { version: 1; tools: Partial<Record<DesktopCliTool, { active?: string; staged?: string; latest?: string; tested?: boolean; checkedAt?: string }>> }
/** A switch in progress. `version` null means going back to the copy shipped inside the app. */
type Job = { phase: 'downloading' | 'waiting'; version: string | null }

export type DesktopCliUpdatePorts = {
    fetch: CliFetch
    /** Rejects unless Apple's check says the file is intact and signed by that team. */
    verifySignature(path: string, teamId: string): Promise<void>
    /** Asks the tool for its version without network or access to personal files. */
    probe(tool: DesktopCliTool, runner: string, scratch: string): Promise<string | null>
    idle(): boolean
    now(): number
    pollMs: number
}

// The tool only has to print its version: no network, no writes outside a scratch folder, and no
// reading of the person's files.
const PROBE_POLICY = '(version 1)(allow default)(deny network*)(deny file-write*)' +
    '(deny file-read-data (subpath "/Users") (subpath "/Volumes"))' +
    '(allow file-read-data (literal (param "BINARY")) (subpath (param "HOME")))' +
    '(allow file-write* (subpath (param "HOME")) (literal "/dev/null"))'

async function probe(tool: DesktopCliTool, runner: string, scratch: string) {
    const home = await realpath(await mkdtemp(join(scratch, '.probe-')))
    try {
        let stdout: string
        if (cliSources[tool].probe === 'codex-launcher') {
            await Promise.all(['state', 'tmp'].map(name => mkdir(join(home, name), { mode: 0o700 })))
            ;({ stdout } = await run(runner, ['--version'], { env: { RERUN_CODEX_PROFILE: home, RERUN_MAC_HOME: userInfo().homedir }, timeout: 20_000 }))
        } else {
            ;({ stdout } = await run('/usr/bin/sandbox-exec', ['-D', `BINARY=${runner}`, '-D', `HOME=${home}`, '-p', PROBE_POLICY, runner, '--version'],
                { cwd: home, env: { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: home, LANG: 'en_US.UTF-8' }, timeout: 20_000 }))
        }
        return /\d+\.\d+\.\d+(-[A-Za-z0-9.]+)?/.exec(stdout)?.[0] ?? null
    } catch {
        return null
    } finally {
        await rm(home, { recursive: true, force: true })
    }
}

const defaults: DesktopCliUpdatePorts = {
    fetch: url => fetch(url, { signal: AbortSignal.timeout(15 * 60_000), headers: { 'User-Agent': 'rerun-desktop' } }),
    verifySignature: async (path, teamId) => { await run('/usr/bin/codesign', ['--verify', '--strict', `-R=anchor apple generic and certificate leaf[subject.OU] = "${teamId}"`, path]) },
    probe,
    idle: () => activeRunCount() === 0,
    now: () => Date.now(),
    pollMs: 1500,
}

/**
 * Keeps the plan tools (Claude, Codex, Kimi, Grok, Devin) current. A newer version is downloaded
 * from its vendor, checked against the vendor's checksum and Developer ID signature, asked for its
 * version, and only then started for new replies, and only while no reply is running.
 */
export function bindDesktopCliUpdates(installRoot: string, overrides: Partial<DesktopCliUpdatePorts> = {}) {
    const ports = { ...defaults, ...overrides }
    // Resolved in restore(): a data folder reached through a link is compared by its real path.
    let root = join(installRoot, 'cli-tools')
    const builtIn = new Map<DesktopCliTool, string>()
    const builtInVersions = new Map<DesktopCliTool, Promise<string | null>>()
    const jobs = new Map<DesktopCliTool, Job>()
    const errors = new Map<DesktopCliTool, Failure>()
    let stored: Stored = { version: 1, tools: {} }
    let ready: Promise<void> | undefined, checking: Promise<void> | undefined, stopped = false, lastFailedCheck = 0

    const entry = (tool: DesktopCliTool) => stored.tools[tool] ??= {}
    const versionDirectory = (tool: DesktopCliTool, version: string) => join(root, tool, version)
    const save = async () => {
        const temp = join(root, `state.${randomUUID()}.tmp`)
        await writeFile(temp, JSON.stringify(stored), { mode: 0o600, flag: 'wx' })
        await rename(temp, join(root, 'state.json'))
    }

    async function ownedExecutable(path: string) {
        const info = await lstat(path)
        if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0 || await realpath(path) !== path) throw new CliUpdateError('verification')
    }
    /** The runner of a downloaded version, after checking again that it is what the vendor signed. */
    async function verified(tool: DesktopCliTool, version: string, directory = versionDirectory(tool, version)) {
        const source = cliSources[tool]
        if (!VERSION.test(version)) throw new CliUpdateError('verification')
        for (const file of new Set([source.runner, ...source.signed, ...(source.companions?.files.map(name => join(source.companions!.directory, name)) ?? [])])) await ownedExecutable(join(directory, file))
        for (const file of source.signed) await ports.verifySignature(join(directory, file), source.teamId).catch(() => { throw new CliUpdateError('verification') })
        return join(directory, source.runner)
    }

    async function untilIdle() {
        while (!ports.idle()) {
            if (stopped) throw new CliUpdateError('start')
            await delay(ports.pollMs)
        }
        if (stopped) throw new CliUpdateError('start')
    }
    /** Points new replies at a version, or at the built-in copy. Never called while a reply runs. */
    async function use(tool: DesktopCliTool, version: string | null) {
        const runner = version ? await verified(tool, version) : builtIn.get(tool)!
        process.env[cliSources[tool].variable] = runner
        const state = entry(tool)
        delete state.staged
        if (version) state.active = version
        else delete state.active
        await save()
    }

    async function download(release: CliRelease, directory: string) {
        const response = await ports.fetch(release.url).catch(() => { throw new CliUpdateError('offline') })
        if (!response.ok || !response.body) throw new CliUpdateError('download')
        const file = join(directory, 'download'), sha256 = createHash('sha256'), sha512 = createHash('sha512')
        const out = createWriteStream(file, { mode: 0o600, flags: 'wx' })
        let size = 0
        try {
            for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
                size += chunk.length
                if (size > DOWNLOAD_LIMIT || stopped) throw new CliUpdateError('download')
                sha256.update(chunk)
                sha512.update(chunk)
                if (!out.write(chunk)) await once(out, 'drain')
            }
            out.end()
            await finished(out)
        } catch (error) {
            out.destroy()
            throw error instanceof CliUpdateError ? error : new CliUpdateError('download')
        }
        if (release.sha256 && sha256.digest('hex') !== release.sha256) throw new CliUpdateError('verification')
        if (release.sha512 && sha512.digest('base64') !== release.sha512) throw new CliUpdateError('verification')
        return file
    }

    async function install(tool: DesktopCliTool, release: CliRelease) {
        const source = cliSources[tool]
        await mkdir(join(root, tool), { recursive: true, mode: 0o700 })
        const work = await realpath(await mkdtemp(join(root, tool, '.incoming-')))
        try {
            const file = await download(release, work)
            const target = join(work, 'version')
            await mkdir(target, { mode: 0o755 })
            const place = async (from: string, to: string) => {
                const info = await lstat(from).catch(() => null)
                if (!info?.isFile()) throw new CliUpdateError('verification')
                await mkdir(dirname(join(target, to)), { recursive: true, mode: 0o755 })
                await rename(from, join(target, to))
                await chmod(join(target, to), 0o755)
            }
            if (release.members) {
                const unpacked = join(work, 'unpacked')
                await mkdir(unpacked, { mode: 0o700 })
                await run('/usr/bin/tar', ['-xzf', file, '--no-same-owner', '-C', unpacked], { timeout: 5 * 60_000 }).catch(() => { throw new CliUpdateError('download') })
                for (const [from, to] of Object.entries(release.members)) await place(join(unpacked, from), to)
            } else await place(file, source.runner)
            if (source.companions) {
                // The app's own launcher and sandbox rules stay the ones this build shipped with.
                const from = dirname(builtIn.get(tool)!)
                for (const name of source.companions.files) {
                    const to = join(target, source.companions.directory, name)
                    await copyFile(join(from, name), to)
                    await chmod(to, (await lstat(join(from, name))).mode & 0o755)
                }
            }
            const runner = await verified(tool, release.version, target)
            if (await ports.probe(tool, runner, work) !== release.version) throw new CliUpdateError('start')
            const final = versionDirectory(tool, release.version)
            await rm(final, { recursive: true, force: true })
            await rename(target, final)
        } finally {
            await rm(work, { recursive: true, force: true })
        }
    }

    async function check(force = false) {
        if (!force && lastFailedCheck && ports.now() - lastFailedCheck < 10 * 60_000) return
        checking ??= (async () => {
            let failed = false
            await Promise.all([...builtIn.keys()].map(async tool => {
                try {
                    const release = await cliSources[tool].latest(ports.fetch, { claudeSdk: DESKTOP_CLAUDE_SDK_VERSION })
                    Object.assign(entry(tool), { latest: release.version, checkedAt: new Date(ports.now()).toISOString() })
                    if (release.tested === undefined) delete entry(tool).tested
                    else entry(tool).tested = release.tested
                } catch {
                    failed = true
                }
            }))
            lastFailedCheck = failed ? ports.now() : 0
            await save().catch(() => {})
        })().finally(() => { checking = undefined })
        await checking
    }

    function begin(tool: DesktopCliTool, work: () => Promise<void>) {
        errors.delete(tool)
        void work().catch(error => { errors.set(tool, error instanceof CliUpdateError ? error.reason : 'download') }).finally(() => { jobs.delete(tool) })
    }
    function update(tool: DesktopCliTool) {
        jobs.set(tool, { phase: 'downloading', version: stored.tools[tool]?.latest ?? null })
        begin(tool, async () => {
            const release = await cliSources[tool].latest(ports.fetch, { claudeSdk: DESKTOP_CLAUDE_SDK_VERSION }).catch(() => { throw new CliUpdateError('offline') })
            if (release.tested === false) throw new CliUpdateError('start')
            jobs.set(tool, { phase: 'downloading', version: release.version })
            if (stored.tools[tool]?.active !== release.version) {
                await install(tool, release)
                entry(tool).staged = release.version
                await save()
                jobs.set(tool, { phase: 'waiting', version: release.version })
                await untilIdle()
                await use(tool, release.version)
            }
        })
    }
    function revert(tool: DesktopCliTool) {
        jobs.set(tool, { phase: 'waiting', version: null })
        begin(tool, async () => {
            await untilIdle()
            await use(tool, null)
        })
    }

    async function restore() {
        if (process.platform !== 'darwin' || process.arch !== 'arm64') return
        for (const tool of DESKTOP_CLI_TOOLS) {
            const path = process.env[cliSources[tool].variable]
            if (path && isAbsolute(path)) builtIn.set(tool, path)
        }
        if (!builtIn.size) return
        await mkdir(root, { recursive: true, mode: 0o700 })
        root = await realpath(root)
        try {
            const value = JSON.parse(await readFile(join(root, 'state.json'), 'utf8'))
            if (value?.version === 1 && value.tools && typeof value.tools === 'object') stored = value
        } catch {
            // No update was ever installed, or the record is unreadable: the built-in copies are used.
        }
        for (const tool of builtIn.keys()) {
            const state = stored.tools[tool]
            const wanted = state?.staged ?? state?.active
            if (wanted) {
                jobs.set(tool, { phase: 'waiting', version: wanted })
                begin(tool, async () => {
                    await untilIdle()
                    try { await use(tool, wanted) }
                    catch (error) {
                        // A copy that no longer passes its checks is dropped; replies stay on the built-in one.
                        delete entry(tool).active
                        delete entry(tool).staged
                        await save()
                        throw error
                    }
                })
            }
            const keep = new Set([state?.active, state?.staged])
            for (const name of await readdir(join(root, tool)).catch(() => [])) {
                if (!keep.has(name)) await rm(join(root, tool, name), { recursive: true, force: true })
            }
        }
    }

    function builtInVersion(tool: DesktopCliTool) {
        let version = builtInVersions.get(tool)
        if (!version) builtInVersions.set(tool, version = ports.probe(tool, builtIn.get(tool)!, root).catch(() => null))
        return version
    }
    async function status(): Promise<DesktopCliUpdates> {
        await (ready ??= restore())
        const tools: DesktopCliToolStatus[] = []
        for (const tool of builtIn.keys()) {
            const state = stored.tools[tool] ?? {}, job = jobs.get(tool), error = errors.get(tool) ?? null
            const current = state.active ?? await builtInVersion(tool)
            const latest = state.latest ?? null
            const behind = !!latest && (!current || newerCliVersion(latest, current))
            tools.push({
                tool, current, source: state.active ? 'updated' : 'built-in', latest, checkedAt: state.checkedAt ?? null,
                state: job ? job.phase : error ? 'failed' : behind ? (state.tested === false ? 'untested' : 'available') : 'current',
                pending: job ? job.version ?? await builtInVersion(tool) : null,
                error: job ? null : error,
            })
        }
        const stale = tools.some(tool => !tool.checkedAt || ports.now() - Date.parse(tool.checkedAt) > CHECK_EVERY_MS)
        if (stale && !stopped) void check().catch(() => {})
        return { tools }
    }

    return {
        restore: () => (ready ??= restore()),
        status,
        async action(action: DesktopCliUpdateAction): Promise<DesktopCliUpdates> {
            await (ready ??= restore())
            if (action.action === 'check') await check(true)
            else if (builtIn.has(action.tool) && !jobs.has(action.tool)) {
                if (action.action === 'update') update(action.tool)
                else if (stored.tools[action.tool]?.active || stored.tools[action.tool]?.staged) revert(action.tool)
            }
            return status()
        },
        stop() { stopped = true },
    }
}
