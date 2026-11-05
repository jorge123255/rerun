import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { DockerClient } from './docker-cli.js'
import { decodeFrame, encodeFrame } from './frame.js'
import { volumeLabels } from './identity.js'
import { createIsolatedScreenService } from './service.js'
import type { ScreenExportArtifact, ScreenNavigationExport } from './types.js'

function fixture(pageOverride: Record<string, unknown> = {}) {
    let container: { labels: Record<string, string> } | null = null
    let volume: { labels: Record<string, string> } | null = null
    const calls: Record<string, unknown>[] = []
    const html = Buffer.from('<p>rendered fixture</p>')
    const docker: DockerClient = {
        version: async () => ({ kind: 'ok', os: 'linux', arch: 'arm64' }),
        image: async () => ({ kind: 'present', architecture: 'arm64' }),
        inspectContainer: async () => container ? { status: 'found', state: 'running', labels: container.labels } : { status: 'missing' },
        inspectVolume: async () => volume ? { status: 'found', labels: volume.labels } : { status: 'missing' },
        createVolume: async owner => { volume = { labels: volumeLabels(owner) } },
        run: async args => {
            const labels: Record<string, string> = {}
            for (let i = 0; i < args.length; i++) if (args[i] === '--label') {
                const pair = args[i + 1]!, at = pair.indexOf('='); labels[pair.slice(0, at)] = pair.slice(at + 1)
            }
            container = { labels }
        },
        removeContainer: async () => { container = null },
        removeVolume: async () => { volume = null },
        listScreens: async () => [],
        execStream: async () => { throw new Error('fixture has no viewer') },
        exec: async (_name, _command, input, signal) => {
            signal.throwIfAborted()
            const body = decodeFrame(input).value as Record<string, unknown>; calls.push(body)
            if (body.op === 'ping') return encodeFrame({ ok: true, width: 1920, height: 1080 })
            if (body.op === 'navigate') {
                const status = typeof pageOverride.status === 'number' ? pageOverride.status : 200
                const hasData = body.exportHtml && status >= 200 && status < 400
                return encodeFrame({ ok: true, pageOptionsVersion: 1, status, finalUrl: body.url, text: 'rendered fixture', html: '<p>rendered fixture</p>', truncated: false,
                    links: body.links ? [{ href: 'https://example.com/next', text: 'Next' }] : [], linksTruncated: false, htmlBytes: hasData ? html.length : 0, screenshotBytes: 0,
                    screenshotWidth: 0, screenshotHeight: 0, exportErrors: [], ...pageOverride }, hasData ? html : Buffer.alloc(0))
            }
            return encodeFrame({ ok: true })
        },
    }
    const service = createIsolatedScreenService({ docker })
    const owner = { engineAgentId: randomUUID(), launchNonce: randomUUID() }
    const signal = new AbortController().signal
    return { service, owner, signal, calls }
}

const saved = (artifacts: ScreenExportArtifact[]) => ({ status: 'saved' as const, files: artifacts.map(item => ({ kind: item.kind, path: item.path, sha256: item.sha256, byteLength: item.bytes.length })) })

describe('isolated navigation export boundary', () => {
    it('keeps navigation without file authority and restores explicitly requested links', async () => {
        const f = fixture(), { target } = await f.service.ensure(f.owner, f.signal)
        const page = await f.service.navigate(target, { url: 'https://example.com', links: true, timeoutMs: 120_000 }, f.signal)
        expect(page.links).toHaveLength(1); expect(page.exports).toBeUndefined()
        expect(f.calls.at(-1)).toMatchObject({ op: 'navigate', links: true, timeoutMs: 120_000, screenshot: false, exportHtml: false })
        await expect(f.service.navigate(target, { url: 'https://example.com', screenshotPath: 'page.png' }, f.signal)).rejects.toThrow('write authority')
    })

    it('publishes exact validated bytes and returns only the acknowledged receipt', async () => {
        const f = fixture(), { target } = await f.service.ensure(f.owner, f.signal)
        const exporter: ScreenNavigationExport = { htmlPath: 'page.browser.html.txt', publish: async (artifacts, signal) => { signal.throwIfAborted(); return saved(artifacts) } }
        const page = await f.service.navigate(target, { url: 'https://example.com' }, f.signal, exporter)
        expect(page.exports?.status).toBe('saved')
        expect(page.exports?.files[0]).toMatchObject({ path: 'page.browser.html.txt', kind: 'rendered-html' })
        expect(page.exports?.files).toHaveLength(2)
        expect(JSON.stringify(page)).not.toContain('<p>')
        expect(f.calls.at(-1)).not.toHaveProperty('screenshotPath')
        const invalid = await f.service.navigate(target, { url: 'https://example.com' }, f.signal, { ...exporter, publish: async () => ({ status: 'saved', files: [] }) })
        expect(invalid.exports).toMatchObject({ status: 'unknown', files: [] })
    })

    it('human takeover cancels a pending export and never returns stale saved output', async () => {
        const f = fixture(), { target } = await f.service.ensure(f.owner, f.signal)
        let entered!: () => void
        const ready = new Promise<void>(resolve => { entered = resolve })
        const work = f.service.navigate(target, { url: 'https://example.com' }, f.signal, {
            htmlPath: 'page.browser.html.txt',
            publish: async (_artifacts, signal) => { entered(); return new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }) }) },
        })
        const rejected = expect(work).rejects.toThrow()
        await ready
        await f.service.startTakeover(target, f.signal)
        await rejected
    })

    it('keeps HTTP failure and bot-wall outcomes without calling the publisher', async () => {
        for (const override of [{ status: 500 }, { status: 403, text: 'Just a moment', html: '<title>Just a moment...</title>' }]) {
            const f = fixture(override), { target } = await f.service.ensure(f.owner, f.signal)
            const publish = vi.fn(async (artifacts: ScreenExportArtifact[]) => saved(artifacts))
            const page = await f.service.navigate(target, { url: 'https://example.com' }, f.signal, { htmlPath: 'page.browser.html.txt', publish })
            expect(page.outcome).toBe(override.status === 500 ? 'failed' : 'blocked')
            expect(page.exports).toMatchObject({ status: 'refused', files: [] })
            expect(publish).not.toHaveBeenCalled()
        }
    })

    it('acknowledges HTML only when a requested screenshot fails, and reports the partial failure', async () => {
        const f = fixture({ exportErrors: [{ kind: 'screenshot', code: 'too-large' }] }), { target } = await f.service.ensure(f.owner, f.signal)
        const page = await f.service.navigate(target, { url: 'https://example.com', screenshotPath: 'page.png' }, f.signal, {
            htmlPath: 'page.browser.html.txt', publish: async artifacts => saved(artifacts),
        })
        expect(page.exports).toMatchObject({ status: 'unknown', failure: 'capture-failed' })
        expect(page.exports?.files.map(file => file.kind)).toEqual(['rendered-html', 'page-metadata'])
    })

    it('refuses corrupt lengths/old guests and preserves real timeout errors', async () => {
        for (const override of [{ htmlBytes: 999 }, { pageOptionsVersion: undefined }, { ok: false, reason: 'The page took too long.' }]) {
            const f = fixture(override), { target } = await f.service.ensure(f.owner, f.signal)
            const publish = vi.fn(async (artifacts: ScreenExportArtifact[]) => saved(artifacts))
            await expect(f.service.navigate(target, { url: 'https://example.com' }, f.signal, { htmlPath: 'page.browser.html.txt', publish })).rejects.toThrow()
            expect(publish).not.toHaveBeenCalled()
        }
    })

    it('Stop/replacement invalidates the old publication and cannot return saved output into the new generation', async () => {
        const f = fixture(), { target } = await f.service.ensure(f.owner, f.signal)
        let entered!: () => void
        const ready = new Promise<void>(resolve => { entered = resolve })
        const work = f.service.navigate(target, { url: 'https://example.com' }, f.signal, { htmlPath: 'page.browser.html.txt',
            publish: async (_artifacts, signal) => { entered(); return new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }) }) },
        })
        const rejected = expect(work).rejects.toThrow()
        await ready; await f.service.stop(target, f.signal); await rejected
        const replacement = await f.service.ensure(f.owner, f.signal)
        expect(replacement.target.sessionGeneration).not.toBe(target.sessionGeneration)
        await expect(f.service.navigate(target, { url: 'https://example.com' }, f.signal)).rejects.toThrow('no longer current')
    })
})
