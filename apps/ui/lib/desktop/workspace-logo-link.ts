// The original workspace-settings "Logo from a website or link" field, desktop-side: one input
// takes either a site whose favicon becomes the logo or a direct link to a logo file. This plain
// module is shared by the client (typing feedback) and the server (preview target, save payload),
// exactly like the original lib/workspace/logo-input.ts + lib/onboarding/site-favicon.ts pair.

export type LogoLink = { kind: 'site'; domain: string } | { kind: 'image'; url: string }

export const LOGO_MAX_BYTES = 8 * 1024 * 1024

export const NO_LOGO_FOUND = 'No logo found at this address'
export const LOGO_TOO_LARGE = 'Image is too large (max 8MB).'

// The favicon service the original website path uses: public, answers in one cached request, and
// 404s for a domain it has never seen (what lets a typo show nothing rather than a globe).
const FAVICON_SERVICE = 'https://www.google.com/s2/favicons'

// A hostname worth asking a favicon for: labels, then a letters-only TLD of at least two. This is
// deliberately stricter than the browser's own parser, which happily accepts "acme" or "localhost".
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/

// The original image-path classification, kept whole: a path ending in a known image extension is
// the logo itself, anything else is a site. The preview then rejects the formats the Mac slice
// does not store (SVG, GIF, ICO) with a clear unsupported-format message.
const IMAGE_PATH = /\.(png|jpe?g|svg|webp|gif|ico)$/i

// "https://www.acme.com/pricing", "www.acme.com" and "acme.com" all read as "acme.com". Anything
// that is not yet an address ("acme", "acme.c", an empty field) reads as null.
export function siteDomain(input: string): string | null {
    const trimmed = input.trim()
    if (!trimmed || /\s/.test(trimmed)) return null
    let host: string
    try {
        host = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`).hostname
    } catch {
        return null
    }
    host = host.toLowerCase().replace(/\.$/, '').replace(/^www\./, '')
    return HOSTNAME.test(host) ? host : null
}

// 128px for a 48px tile: the service downscales cleanly, and the smaller sizes it serves are the
// blurry 16px ico a browser tab uses.
export function faviconUrl(domain: string): string {
    return `${FAVICON_SERVICE}?sz=128&domain=${encodeURIComponent(domain)}`
}

// One field takes both a site ("acme.com", "https://acme.com/pricing") and a direct link to a logo
// file: a path ending in an image extension is the logo itself, anything else is a site whose
// favicon becomes the logo.
export function readLogoLink(input: string): LogoLink | null {
    const trimmed = input.trim()
    if (URL.canParse(trimmed)) {
        const url = new URL(trimmed)
        if (/^https?:$/.test(url.protocol) && IMAGE_PATH.test(url.pathname)) return { kind: 'image', url: trimmed }
    }
    const domain = siteDomain(trimmed)
    return domain ? { kind: 'site', domain } : null
}

export function logoLinkImageUrl(link: LogoLink): string {
    return link.kind === 'site' ? faviconUrl(link.domain) : link.url
}
