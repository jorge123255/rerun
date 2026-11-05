import { describe, expect, it } from 'vitest'
import { faviconUrl, logoLinkImageUrl, readLogoLink, siteDomain } from './workspace-logo-link'

// The original parser classification, desktop-side: a path ending in an image extension is the
// logo itself, anything else is a site whose favicon becomes the logo. Format acceptance beyond
// classification (PNG/JPEG/WebP only) is the preview's job, so the parser keeps the original
// svg|gif|ico extensions to still read them as image links.
describe('readLogoLink site-vs-image classification', () => {
    it('reads a bare site domain', () => {
        expect(readLogoLink('acme.com')).toEqual({ kind: 'site', domain: 'acme.com' })
    })
    it('reads a full site URL as its domain', () => {
        expect(readLogoLink('https://www.acme.com/pricing')).toEqual({ kind: 'site', domain: 'acme.com' })
    })
    it('reads an http site URL as its domain', () => {
        expect(readLogoLink('http://acme.com')).toEqual({ kind: 'site', domain: 'acme.com' })
    })
    it('normalizes a trailing dot and upper case', () => {
        expect(readLogoLink('WWW.Acme.COM.')).toEqual({ kind: 'site', domain: 'acme.com' })
    })
    it('keeps the subdomain TLD shape for multi-level domains', () => {
        expect(readLogoLink('acme.co.uk')).toEqual({ kind: 'site', domain: 'acme.co.uk' })
    })
    it('reads a direct image link through unchanged', () => {
        expect(readLogoLink('https://acme.com/logo.png')).toEqual({ kind: 'image', url: 'https://acme.com/logo.png' })
    })
    it('is case-insensitive over the image extension', () => {
        expect(readLogoLink('https://acme.com/LOGO.PNG')).toEqual({ kind: 'image', url: 'https://acme.com/LOGO.PNG' })
    })
    it('reads the other original image extensions as image links', () => {
        expect(readLogoLink('https://acme.com/logo.jpeg')?.kind).toBe('image')
        expect(readLogoLink('https://acme.com/logo.svg')?.kind).toBe('image')
        expect(readLogoLink('https://acme.com/logo.webp')?.kind).toBe('image')
        expect(readLogoLink('https://acme.com/favicon.ico')?.kind).toBe('image')
        expect(readLogoLink('https://acme.com/logo.gif')?.kind).toBe('image')
    })
    it('reads nothing for a bare label, a short TLD, whitespace or an empty field', () => {
        for (const value of ['', '   ', 'acme', 'acme.c', 'localhost', 'a b.com']) {
            expect(readLogoLink(value)).toBeNull()
        }
    })
    it('refuses a non-http(s) image link', () => {
        expect(readLogoLink('ftp://acme.com/logo.png')).toBeNull()
    })
    it('keeps credentials out of the classified image url so the server can still refuse them', () => {
        expect(readLogoLink('https://user:pass@acme.com/logo.png')).toEqual({ kind: 'image', url: 'https://user:pass@acme.com/logo.png' })
    })
})

describe('siteDomain', () => {
    it('normalizes scheme, www, case and trailing dot', () => {
        expect(siteDomain('https://www.ACME.com/pricing')).toBe('acme.com')
        expect(siteDomain('www.acme.com')).toBe('acme.com')
        expect(siteDomain('acme.com.')).toBe('acme.com')
    })
    it('refuses labels, private names and IP literals', () => {
        for (const value of ['acme', 'acme.c', 'localhost', '127.0.0.1', '192.168.1.1']) {
            expect(siteDomain(value)).toBeNull()
        }
    })
})

describe('faviconUrl and logoLinkImageUrl', () => {
    it('asks the original Google favicon service at 128px for a site', () => {
        expect(faviconUrl('acme.com')).toBe('https://www.google.com/s2/favicons?sz=128&domain=acme.com')
        expect(logoLinkImageUrl({ kind: 'site', domain: 'acme.com' })).toBe('https://www.google.com/s2/favicons?sz=128&domain=acme.com')
    })
    it('passes a direct image link through unchanged', () => {
        expect(logoLinkImageUrl({ kind: 'image', url: 'https://acme.com/logo.png' })).toBe('https://acme.com/logo.png')
    })
})
