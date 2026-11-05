import { describe, expect, it } from 'vitest'
import { formatScreenPage, boundPage, safePageLink } from './page.js'
import { parseGuestNavigation, LINKS_BYTES_MAX } from './navigation-protocol.js'
import { navigationOptions } from './exports.js'

const fixture = () => ({ ok: true, pageOptionsVersion: 1, status: 200, finalUrl: 'https://example.com/redirected', text: 'Rendered', html: '<p>Rendered</p>',
    truncated: false, links: [], linksTruncated: false, htmlBytes: 0, screenshotBytes: 0, screenshotWidth: 0, screenshotHeight: 0, exportErrors: [] })

describe('strict browser navigation protocol and original notes', () => {
    it('refuses old guests, extra fields, truthy options and non-integer bounds', () => {
        for (const value of [{ ...fixture(), pageOptionsVersion: undefined }, { ...fixture(), cookies: 'must not surface' }, { ...fixture(), truncated: 'yes' }, { ...fixture(), screenshotWidth: 1.5 }]) {
            expect(() => parseGuestNavigation(value)).toThrow()
        }
        expect(() => navigationOptions({ url: 'https://example.com', links: 'yes' } as never)).toThrow()
        expect(() => navigationOptions({ url: 'https://example.com', hostPath: '/tmp/anything' } as never)).toThrow()
        expect(() => parseGuestNavigation({ ...fixture(), exportErrors: [{ kind: 'screenshot', code: 'invented-success' }] })).toThrow()
    })

    it('preserves final HTTP URL, ordered unique links and caps labels/counts', () => {
        expect(parseGuestNavigation(fixture()).finalUrl).toBe('https://example.com/redirected')
        const links = Array.from({ length: 302 }, (_, index) => ({ href: `https://example.com/${index}`, text: `  ${'a'.repeat(100)}   ` }))
        links.splice(1, 0, { href: links[0]!.href, text: 'duplicate' })
        const page = boundPage({ ...fixture(), links }, 'https://example.com', true)
        expect(page.links).toHaveLength(300)
        expect(page.links[1]?.href).toBe('https://example.com/1')
        expect(page.links.every(item => item.text.length <= 80)).toBe(true)
        const huge = Array.from({ length: 300 }, (_, index) => ({ href: `https://example.com/${index}/${'x'.repeat(1900)}`, text: 'label' }))
        expect(Buffer.byteLength(JSON.stringify(huge))).toBeGreaterThan(LINKS_BYTES_MAX)
        expect(() => parseGuestNavigation({ ...fixture(), links: huge })).toThrow()
    })

    it('refuses credentials/internal transport destinations and suppresses wall links', () => {
        for (const url of ['https://user:secret@example.com', 'http://127.0.0.1:9222/json/list', 'http://localhost:5900', 'http://localhost.:9222', 'http://[::ffff:127.0.0.1]:9222', 'http://host.docker.internal:7070']) {
            expect(safePageLink(url)).toBe(false)
            expect(() => parseGuestNavigation({ ...fixture(), finalUrl: url })).toThrow()
        }
        const page = boundPage({ ...fixture(), text: 'Just a moment', html: '<title>Just a moment...</title>', links: [{ href: 'https://example.com', text: 'hidden' }] }, 'https://example.com')
        expect(page.wall).not.toBeNull(); expect(page.links).toEqual([])
        expect(formatScreenPage(page, 'https://example.com', true)).toContain('Blocked by Cloudflare')
    })

    it('prints original Links and save notes only for acknowledged files, including partial failure', () => {
        const page = boundPage(fixture(), 'https://example.com')
        expect(formatScreenPage(page, 'https://example.com', true)).toContain('Links:\nnone')
        page.exports = { status: 'unknown', failure: 'storage-full', files: [{ kind: 'rendered-html', path: 'page.browser.html.txt', sha256: 'a'.repeat(64), byteLength: 10 }] }
        const text = formatScreenPage(page, 'https://example.com', false)
        expect(text).toContain('Saved whole: page.browser.html.txt')
        expect(text).toContain('storage-full'); expect(text).not.toContain('screenshot saved')
        page.exports = { status: 'unknown', failure: 'transport', files: [] }
        expect(formatScreenPage(page, 'https://example.com', false)).not.toContain('Saved whole:')
    })
})
