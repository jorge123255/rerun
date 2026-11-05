import { describe, expect, it } from 'vitest'
import { assertHttpUrl, boundPage, publicUrl } from './page.js'
import { IsolatedScreenRefusal } from './refusal.js'

const requested = 'https://example.com/start'

describe('page bounds', () => {
    it('allows http(s) and rejects every other navigation', () => {
        expect(assertHttpUrl(requested)).toBe(requested)
        expect(publicUrl('HTTP://example.com/A')).toBe('HTTP://example.com/A')
        for (const url of ['', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'about:blank', 'chrome://settings', 'http://user:pass@example.com', `https://example.com/${'a'.repeat(2048)}`, 'https://example.com/\n']) {
            expect(publicUrl(url)).toBeNull()
            expect(() => assertHttpUrl(url)).toThrow(IsolatedScreenRefusal)
        }
        expect(publicUrl('http://.evil')).toBeNull()
        expect(publicUrl('http://a..b')).toBeNull()
    })

    it('drops html, caps text and links, and keeps a short bot wall', () => {
        const links = Array.from({ length: 301 }, (_, index) => ({ href: `https://example.com/${index}`, text: `  ${'n'.repeat(90)}  ` }))
        links.push({ href: 'file:///tmp/a', text: 'nope' })
        const page = boundPage({
            status: 200,
            finalUrl: 'javascript:alert(1)',
            text: 'Just a moment',
            html: '<title>Just a moment...</title>SECRET_HTML',
            truncated: false,
            links,
        }, requested)
        expect(page.wall).toEqual({ provider: 'Cloudflare', clearsByItself: true })
        expect(page.links).toEqual([])
        expect(page.finalUrl).toBe(requested)
        expect(page.status).toBe(200)
        expect(JSON.stringify(page)).not.toContain('SECRET_HTML')
        expect('html' in page).toBe(false)
    })

    it('does not call a long page a wall and keeps only http links', () => {
        const page = boundPage({
            status: 12.5,
            finalUrl: 'https://example.com/next',
            text: `${'x'.repeat(3001)}`,
            html: '<title>Just a moment...</title>',
            links: [{ href: 'https://example.com/ok', text: '  spaced   name  ' }, { href: 'notaurl', text: 'no' }, null, { href: 'https://example.com/two' }],
        }, requested)
        expect(page.wall).toBeNull()
        expect(page.status).toBe(0)
        expect(page.links).toEqual([{ href: 'https://example.com/ok', text: 'spaced name' }, { href: 'https://example.com/two', text: '' }])
        expect(page.truncated).toBe(false)
        const long = boundPage({ text: 'y'.repeat(50_001), html: '', status: -1 }, requested)
        expect(long.text.length).toBe(50_000)
        expect(long.truncated).toBe(true)
        expect(long.status).toBe(0)
        const many = Array.from({ length: 301 }, (_, index) => ({ href: `https://example.com/${index}`, text: 'n'.repeat(90) }))
        const capped = boundPage({ text: 'page', html: '', links: many, status: 200, finalUrl: requested }, requested)
        expect(capped.links).toHaveLength(300)
        expect(capped.links[0]?.text.length).toBe(80)
    })
})
