import { z } from 'zod'
import { EXPORT_EDGE_MAX, EXPORT_HTML_MAX, EXPORT_PNG_MAX, EXPORT_PIXELS_MAX } from './exports.js'
import { publicUrl, safePageLink } from './page.js'
import { IsolatedScreenRefusal } from './refusal.js'

export const PAGE_OPTIONS_VERSION = 1
export const LINKS_BYTES_MAX = 160 * 1024
const failure = z.object({ kind: z.enum(['rendered-html', 'screenshot']), code: z.enum(['too-large', 'timeout', 'invalid-data', 'capture-failed']) }).strict()
const schema = z.object({
    ok: z.literal(true), pageOptionsVersion: z.literal(PAGE_OPTIONS_VERSION),
    status: z.number().int().min(0).max(599), finalUrl: z.string().max(2048),
    text: z.string().max(50_000), html: z.string().max(100_000), truncated: z.boolean(),
    links: z.array(z.object({ href: z.string().max(2048), text: z.string().max(80) }).strict()).max(300), linksTruncated: z.boolean(),
    htmlBytes: z.number().int().min(0).max(EXPORT_HTML_MAX), screenshotBytes: z.number().int().min(0).max(EXPORT_PNG_MAX),
    screenshotWidth: z.number().int().min(0).max(EXPORT_EDGE_MAX), screenshotHeight: z.number().int().min(0).max(EXPORT_EDGE_MAX),
    exportErrors: z.array(failure).max(2),
}).strict()

export function parseGuestNavigation(value: unknown) {
    const parsed = schema.safeParse(value)
    if (!parsed.success) throw new IsolatedScreenRefusal('The isolated guest page response is incompatible or invalid. Root must install the current guest.', 'closed')
    const page = parsed.data
    if (!publicUrl(page.finalUrl) || !safePageLink(page.finalUrl)
        || Buffer.byteLength(JSON.stringify(page.links)) > LINKS_BYTES_MAX
        || page.links.some(link => !safePageLink(link.href))
        || new Set(page.exportErrors.map(item => item.kind)).size !== page.exportErrors.length
        || page.htmlBytes > 0 && page.exportErrors.some(item => item.kind === 'rendered-html')
        || page.screenshotBytes > 0 && page.exportErrors.some(item => item.kind === 'screenshot')
        || page.screenshotBytes === 0 && (page.screenshotWidth !== 0 || page.screenshotHeight !== 0)
        || page.screenshotBytes > 0 && (page.screenshotWidth < 1 || page.screenshotHeight < 1 || page.screenshotWidth * page.screenshotHeight > EXPORT_PIXELS_MAX)) {
        throw new IsolatedScreenRefusal('The isolated guest page response violates its bounds.', 'closed')
    }
    return page
}
