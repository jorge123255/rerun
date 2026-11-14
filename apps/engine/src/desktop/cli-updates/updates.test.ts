import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bindDesktopCliUpdates, type DesktopCliUpdatePorts } from './updates.js'
import { cliSources, newerCliVersion } from './sources.js'

const mac = process.platform === 'darwin' && process.arch === 'arm64'
const variables = Object.values(cliSources).map(source => source.variable)
const saved = new Map(variables.map(name => [name, process.env[name]]))
let root: string, bundled: string, idle: boolean, served: Map<string, { status?: number; body: string | Buffer }>

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
function vendorKimi(version: string, binary = `kimi ${version}`, checksum = sha256(binary)) {
    served.set('https://code.kimi.com/kimi-code/latest', { body: `${version}\n` })
    served.set(`https://code.kimi.com/kimi-code/binaries/${version}/manifest.json`, { body: JSON.stringify({ platforms: { 'darwin-arm64': { filename: 'kimi-code-darwin-arm64', checksum } } }) })
    served.set(`https://code.kimi.com/kimi-code/binaries/${version}/kimi-code-darwin-arm64`, { body: binary })
}
function bind(overrides: Partial<DesktopCliUpdatePorts> = {}) {
    return bindDesktopCliUpdates(root, {
        fetch: async url => { const hit = served.get(url); return hit ? new Response(hit.body, { status: hit.status ?? 200 }) : new Response('', { status: 404 }) },
        verifySignature: async () => {},
        // The stand-in tools are text files that hold their own version.
        probe: async (_tool, runner) => /\d+\.\d+\.\d+/.exec(readFileSync(runner, 'utf8'))?.[0] ?? null,
        idle: () => idle, now: () => Date.parse('2026-11-14T12:00:00Z'), pollMs: 5, ...overrides,
    })
}
const kimi = async (updates: ReturnType<typeof bind>) => (await updates.status()).tools.find(tool => tool.tool === 'kimi-code')!
const settled = async (updates: ReturnType<typeof bind>, state: string) => {
    await vi.waitFor(async () => expect((await kimi(updates)).state).toBe(state), { timeout: 5000 })
    return kimi(updates)
}

beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'rerun-cli-updates-')))
    mkdirSync(join(root, 'bundle'))
    bundled = join(root, 'bundle', 'kimi')
    writeFileSync(bundled, 'kimi 2.5.2')
    chmodSync(bundled, 0o755)
    for (const name of variables) delete process.env[name]
    process.env.RERUN_DESKTOP_KIMI_CODE_RUNNER = bundled
    idle = true
    served = new Map()
})
afterEach(() => {
    for (const [name, value] of saved) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
    rmSync(root, { recursive: true, force: true })
})

describe.skipIf(!mac)('desktop CLI updates', () => {
    it('lists only the tools this build carries and notices a newer vendor version', async () => {
        vendorKimi('2.5.3')
        const updates = bind()
        expect((await updates.status()).tools.map(tool => tool.tool)).toEqual(['kimi-code'])
        const status = (await updates.action({ action: 'check' })).tools[0]
        expect(status).toMatchObject({ current: '2.5.2', source: 'built-in', latest: '2.5.3', state: 'available', pending: null, error: null })
    })

    it('downloads, verifies and switches new replies to the vendor version', async () => {
        vendorKimi('2.5.3')
        const updates = bind()
        await updates.action({ action: 'update', tool: 'kimi-code' })
        const status = await settled(updates, 'current')
        const runner = join(root, 'cli-tools', 'kimi-code', '2.5.3', 'runner')
        expect(status).toMatchObject({ current: '2.5.3', source: 'updated', latest: '2.5.3' })
        expect(process.env.RERUN_DESKTOP_KIMI_CODE_RUNNER).toBe(runner)
        expect(readFileSync(runner, 'utf8')).toBe('kimi 2.5.3')
    })

    it('waits for running replies before switching', async () => {
        vendorKimi('2.5.3')
        idle = false
        const updates = bind()
        await updates.action({ action: 'update', tool: 'kimi-code' })
        expect(await settled(updates, 'waiting')).toMatchObject({ current: '2.5.2', pending: '2.5.3' })
        expect(process.env.RERUN_DESKTOP_KIMI_CODE_RUNNER).toBe(bundled)
        idle = true
        expect(await settled(updates, 'current')).toMatchObject({ current: '2.5.3', source: 'updated' })
    })

    it('keeps the built-in copy when the download does not match the vendor checksum', async () => {
        vendorKimi('2.5.3', 'kimi 2.5.3', sha256('something else'))
        const updates = bind()
        await updates.action({ action: 'update', tool: 'kimi-code' })
        expect(await settled(updates, 'failed')).toMatchObject({ current: '2.5.2', source: 'built-in', error: 'verification' })
        expect(process.env.RERUN_DESKTOP_KIMI_CODE_RUNNER).toBe(bundled)
        expect(existsSync(join(root, 'cli-tools', 'kimi-code', '2.5.3'))).toBe(false)
    })

    it('refuses a download the vendor did not sign', async () => {
        vendorKimi('2.5.3')
        const updates = bind({ verifySignature: async () => { throw new Error('not signed') } })
        await updates.action({ action: 'update', tool: 'kimi-code' })
        expect(await settled(updates, 'failed')).toMatchObject({ error: 'verification', source: 'built-in' })
        expect(process.env.RERUN_DESKTOP_KIMI_CODE_RUNNER).toBe(bundled)
    })

    it('refuses a download that does not report the version it was published as', async () => {
        vendorKimi('2.5.3', 'kimi 9.9.9')
        const updates = bind()
        await updates.action({ action: 'update', tool: 'kimi-code' })
        expect(await settled(updates, 'failed')).toMatchObject({ error: 'start', source: 'built-in' })
    })

    it('uses the downloaded version again after a restart, and the built-in copy once it fails its checks', async () => {
        vendorKimi('2.5.3')
        const first = bind()
        await first.action({ action: 'update', tool: 'kimi-code' })
        await settled(first, 'current')
        process.env.RERUN_DESKTOP_KIMI_CODE_RUNNER = bundled
        const second = bind()
        expect(await settled(second, 'current')).toMatchObject({ current: '2.5.3', source: 'updated' })
        expect(process.env.RERUN_DESKTOP_KIMI_CODE_RUNNER).toBe(join(root, 'cli-tools', 'kimi-code', '2.5.3', 'runner'))
        process.env.RERUN_DESKTOP_KIMI_CODE_RUNNER = bundled
        const third = bind({ verifySignature: async () => { throw new Error('changed on disk') } })
        expect(await settled(third, 'failed')).toMatchObject({ current: '2.5.2', source: 'built-in' })
        expect(process.env.RERUN_DESKTOP_KIMI_CODE_RUNNER).toBe(bundled)
    })

    it('takes up an update again that was under way when the app closed', async () => {
        vendorKimi('2.5.3')
        let release!: () => void
        const held = new Promise<void>(resolve => { release = resolve })
        const first = bind({ verifySignature: () => held })
        await first.action({ action: 'update', tool: 'kimi-code' })
        await vi.waitFor(async () => expect((await kimi(first)).step).toBe('verify'), { timeout: 5000 })
        expect(JSON.parse(readFileSync(join(root, 'cli-tools', 'state.json'), 'utf8')).tools['kimi-code'].requested).toBe(true)
        first.stop()
        release()
        process.env.RERUN_DESKTOP_KIMI_CODE_RUNNER = bundled
        const second = bind()
        expect(await settled(second, 'current')).toMatchObject({ current: '2.5.3', source: 'updated' })
        expect(JSON.parse(readFileSync(join(root, 'cli-tools', 'state.json'), 'utf8')).tools['kimi-code'].requested).toBeUndefined()
    })

    it('reports how much of the download has arrived, and keeps a failure across a restart', async () => {
        vendorKimi('2.5.3')
        const seen: (number | null)[] = []
        const updates = bind({ verifySignature: async () => { seen.push((await kimi(updates)).progress); throw new Error('not signed') } })
        const started = (await updates.action({ action: 'update', tool: 'kimi-code' })).tools[0]!
        expect(started).toMatchObject({ state: 'downloading', step: 'download' })
        expect(await settled(updates, 'failed')).toMatchObject({ step: null, progress: null, error: 'verification' })
        expect(await settled(bind(), 'failed')).toMatchObject({ error: 'verification', source: 'built-in' })
    })

    it('goes back to the built-in copy on request', async () => {
        vendorKimi('2.5.3')
        const updates = bind()
        await updates.action({ action: 'update', tool: 'kimi-code' })
        await settled(updates, 'current')
        await updates.action({ action: 'revert', tool: 'kimi-code' })
        expect(await settled(updates, 'available')).toMatchObject({ current: '2.5.2', latest: '2.5.3', source: 'built-in' })
        expect(process.env.RERUN_DESKTOP_KIMI_CODE_RUNNER).toBe(bundled)
    })

    it('reports a vendor that cannot be reached without losing the current version', async () => {
        const updates = bind()
        expect((await updates.action({ action: 'check' })).tools[0]).toMatchObject({ current: '2.5.2', latest: null, state: 'current' })
        await updates.action({ action: 'update', tool: 'kimi-code' })
        expect(await settled(updates, 'failed')).toMatchObject({ error: 'offline' })
    })
})

describe('vendor sources', () => {
    const fetchOf = (pages: Record<string, unknown>) => async (url: string) => url in pages ? new Response(typeof pages[url] === 'string' ? pages[url] as string : JSON.stringify(pages[url])) : new Response('', { status: 404 })
    const context = { claudeSdk: '0.3.322' }
    const sum = 'a'.repeat(64)

    it('marks a Claude version the vendor has not tested with this app', async () => {
        const base = 'https://downloads.claude.ai/claude-code-releases'
        const manifest = (tested: string[]) => ({ platforms: { 'darwin-arm64': { checksum: sum } }, sdkCompat: { testedWrapperVersions: tested } })
        expect(await cliSources.claude.latest(fetchOf({ [`${base}/latest`]: '2.1.325', [`${base}/2.1.325/manifest.json`]: manifest(['0.3.322']) }), context))
            .toEqual({ version: '2.1.325', url: `${base}/2.1.325/darwin-arm64/claude`, sha256: sum, tested: true })
        expect((await cliSources.claude.latest(fetchOf({ [`${base}/latest`]: '2.2.0', [`${base}/2.2.0/manifest.json`]: manifest(['0.4.0']) }), context)).tested).toBe(false)
    })

    it('takes Codex from the npm package for this Mac, pinned by its integrity', async () => {
        const registry = 'https://registry.npmjs.org/@openai/codex', integrity = `${'A'.repeat(86)}==`
        const release = await cliSources.codex.latest(fetchOf({ [`${registry}/latest`]: { version: '0.169.0' }, [`${registry}/0.169.0-darwin-arm64`]: { dist: { tarball: `${registry}/-/codex-0.169.0-darwin-arm64.tgz`, integrity: `sha512-${integrity}` } } }), context)
        expect(release).toMatchObject({ version: '0.169.0', sha512: integrity, members: { 'package/vendor/aarch64-apple-darwin/bin/codex': 'bin/codex' } })
        await expect(cliSources.codex.latest(fetchOf({ [`${registry}/latest`]: { version: '0.169.0' }, [`${registry}/0.169.0-darwin-arm64`]: { dist: { tarball: 'https://example.com/codex.tgz', integrity: `sha512-${integrity}` } } }), context)).rejects.toThrow()
    })

    it('refuses a Devin manifest that points away from its own download host', async () => {
        const url = 'https://static.devin.ai/cli/current/manifest.json'
        const manifest = (download: string) => ({ version: '3000.12.58', platforms: { 'aarch64-apple-darwin': { url: download, sha256: sum } } })
        expect((await cliSources.devin.latest(fetchOf({ [url]: manifest('https://static.devin.ai/cli/3000.12.58/devin-3000.12.58-aarch64-apple-darwin.tar.gz') }), context)).members).toEqual({ 'bin/devin': 'runner' })
        await expect(cliSources.devin.latest(fetchOf({ [url]: manifest('https://example.com/devin.tar.gz') }), context)).rejects.toThrow()
    })

    it('rejects a version pointer that is not a version', async () => {
        await expect(cliSources['grok-build'].latest(fetchOf({ 'https://x.ai/cli/stable': '<html>' }), context)).rejects.toThrow()
        expect(await cliSources['grok-build'].latest(fetchOf({ 'https://x.ai/cli/stable': '1.0.78\n' }), context)).toEqual({ version: '1.0.78', url: 'https://x.ai/cli/grok-1.0.78-macos-aarch64' })
    })

    it('orders versions by their numbers', () => {
        expect(newerCliVersion('2.5.3', '2.5.2')).toBe(true)
        expect(newerCliVersion('2.5.2', '2.5.2')).toBe(false)
        expect(newerCliVersion('2.10.0', '2.9.9')).toBe(true)
        expect(newerCliVersion('3000.12.57', '3000.12.58')).toBe(false)
        expect(newerCliVersion('1.2.3-beta.1', '1.2.3')).toBe(false)
    })
})
