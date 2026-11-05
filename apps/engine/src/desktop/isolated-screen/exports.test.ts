import { describe, expect, it } from 'vitest'
import { decodePageExports, exportPath, EXPORT_HTML_MAX, navigationOptions } from './exports.js'
import { boundPage } from './page.js'

const signal = () => new AbortController().signal
const html = Buffer.from('<!doctype html><script>fetch("https://example.invalid")</script><p>rendered</p>')
const paths = { html: 'browser-fixture.browser.html.txt', screenshot: 'capture.png' }

describe('bounded isolated browser exports (source cases; root executes)', () => {
    it('preserves the original optional links and positive 120000ms ceiling', () => {
        expect(navigationOptions({ url: 'https://example.com' })).toEqual({ timeoutMs: 30_000, links: false, screenshot: false })
        expect(navigationOptions({ url: 'https://example.com', timeoutMs: 120_000, links: true, screenshotPath: 'page.png' })).toEqual({ timeoutMs: 120_000, links: true, screenshot: true })
        for (const timeoutMs of [0, -1, 120_001, 1.5, NaN]) expect(() => navigationOptions({ url: 'https://example.com', timeoutMs })).toThrow()
        const raw = { text: 'page', links: [{ href: 'https://example.com/a', text: 'A' }, { href: 'https://example.com/a', text: 'duplicate' }] }
        expect(boundPage(raw, 'https://example.com', false).links).toEqual([])
        expect(boundPage(raw, 'https://example.com', true).links).toHaveLength(1)
    })

    it('refuses host paths, hidden paths, traversal and active HTML destinations', () => {
        for (const path of ['/tmp/page.png', '../page.png', 'a/../page.png', 'a//page.png', '.rerun/page.png', 'a\\page.png', 'page.png\n', 'page.jpg']) {
            expect(() => exportPath(path, 'screenshot')).toThrow()
        }
        expect(() => exportPath('page.html', 'rendered-html')).toThrow()
        expect(exportPath(paths.html, 'rendered-html')).toBe(paths.html)
    })

    it('returns exact UTF-8 HTML bytes only as an inert text artifact', async () => {
        const artifacts = await decodePageExports({ htmlBytes: html.length, screenshotBytes: 0 }, html, { html: paths.html }, signal())
        expect(artifacts).toMatchObject([{ kind: 'rendered-html', mediaType: 'text/plain', path: paths.html }])
        expect(artifacts[0]?.bytes.equals(html)).toBe(true)
        expect(JSON.stringify(boundPage({ html: html.toString(), text: 'rendered' }, 'https://example.com'))).not.toContain('<script>')
    })

    it('rejects truncated, surplus, over-budget and invalid UTF-8 bytes', async () => {
        for (const [raw, data] of [
            [{ htmlBytes: html.length + 1, screenshotBytes: 0 }, html],
            [{ htmlBytes: html.length, screenshotBytes: 0 }, Buffer.concat([html, Buffer.from('extra')])],
            [{ htmlBytes: EXPORT_HTML_MAX + 1, screenshotBytes: 0 }, Buffer.alloc(EXPORT_HTML_MAX + 1)],
            [{ htmlBytes: 1, screenshotBytes: 0 }, Buffer.from([0xff])],
            [{ htmlBytes: 1, screenshotBytes: 0 }, Buffer.from([0])],
        ] as const) await expect(decodePageExports(raw, data, { html: paths.html }, signal())).rejects.toThrow()
        const stop = new AbortController(); stop.abort()
        await expect(decodePageExports({ htmlBytes: html.length, screenshotBytes: 0 }, html, { html: paths.html }, stop.signal)).rejects.toThrow()
    })

    it('validates full dimensions and decodes a PNG before publishing stripped PNG bytes', async () => {
        const { default: sharp } = await import('sharp')
        const png = await sharp({ create: { width: 2, height: 3, channels: 3, background: '#123456' } }).png().toBuffer()
        const raw = { htmlBytes: html.length, screenshotBytes: png.length, screenshotWidth: 2, screenshotHeight: 3 }
        const artifacts = await decodePageExports(raw, Buffer.concat([html, png]), paths, signal())
        expect(artifacts[1]).toMatchObject({ kind: 'screenshot', mediaType: 'image/png', width: 2, height: 3 })
        await expect(decodePageExports({ ...raw, screenshotWidth: 8193 }, Buffer.concat([html, png]), paths, signal())).rejects.toThrow()
        await expect(decodePageExports({ ...raw, screenshotHeight: 2 }, Buffer.concat([html, png]), paths, signal())).rejects.toThrow()
        await expect(decodePageExports(raw, Buffer.concat([html, png]), { html: paths.html }, signal())).rejects.toThrow()
        const trailing = Buffer.concat([png, Buffer.from('trailing')])
        await expect(decodePageExports({ ...raw, screenshotBytes: trailing.length }, Buffer.concat([html, trailing]), paths, signal())).rejects.toThrow()
    })
})
