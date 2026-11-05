export const DESKTOP_PDF_TEXT_MAX_STDOUT = 2 * 1024 * 1024
export const DESKTOP_PDF_TEXT_MAX_RESPONSE = DESKTOP_PDF_TEXT_MAX_STDOUT + 4096
export const DESKTOP_PDF_TEXT_MAX_PAGES = 10_000
export const DESKTOP_PDF_TEXT_MAX_CHARS = 500_000
export const DESKTOP_PDF_TEXT_MAX_PAGE_CHARS = 100_000
export const DESKTOP_PDF_TEXT_MAX_RUNS = 8_000
export const DESKTOP_PDF_TEXT_MAX_PAGE_RUNS = 2_000
export const DESKTOP_PDF_TEXT_MAX_QUERY = 200
export const DESKTOP_PDF_TEXT_MAX_MATCHES = 500
const MAX_CROP_ORIGIN = 200_000
const MAX_POINT = 14_400
const IDENTITY = /^\d{1,24}:\d{1,24}$/
const REASONS = ['text', 'runs', 'pages', 'output'] as const

export type DesktopPdfTextReason = '' | (typeof REASONS)[number]
export type DesktopPdfTextRun = { start: number; end: number; x: number; y: number; w: number; h: number }
export type DesktopPdfTextCrop = { x: number; y: number; width: number; height: number }
export type DesktopPdfTextPage = {
    page: number
    rotation: 0 | 90 | 180 | 270
    crop: DesktopPdfTextCrop
    pageWidth: number
    pageHeight: number
    text: string
    runs: DesktopPdfTextRun[]
}
export type DesktopPdfTextExtract = {
    pageCount: number
    truncated: boolean
    reason: DesktopPdfTextReason
    pages: DesktopPdfTextPage[]
}
export type DesktopPdfTextDocument = DesktopPdfTextExtract & { identity: string; path: string }
export type DesktopPdfTextMatch = { page: number; start: number; end: number }

export function desktopPdfSamePointSize(left: number, right: number): boolean {
    if (!Number.isFinite(left) || !Number.isFinite(right)) return false
    const scale = Math.max(Math.abs(left), Math.abs(right), 1)
    return Math.abs(left - right) <= scale * 1e-4
}

function record(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    return value as Record<string, unknown>
}

function sameKeys(value: object, expected: readonly string[]): boolean {
    const keys = Object.keys(value)
    return keys.length === expected.length && expected.every(key => Object.prototype.hasOwnProperty.call(value, key))
}

function finite(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value)
}

function safeInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value)
}

function rotationOf(value: unknown): 0 | 90 | 180 | 270 | null {
    if (value === 0 || value === 90 || value === 180 || value === 270) return value
    return null
}

function unit(value: unknown): value is number {
    return finite(value) && value >= 0 && value <= 1
}

function cropOf(value: unknown): DesktopPdfTextCrop | null {
    const crop = record(value)
    if (!crop || !sameKeys(crop, ['x', 'y', 'width', 'height'])) return null
    if (!finite(crop.x) || !finite(crop.y) || !finite(crop.width) || !finite(crop.height)) return null
    if (Math.abs(crop.x) > MAX_CROP_ORIGIN || Math.abs(crop.y) > MAX_CROP_ORIGIN) return null
    if (crop.width <= 0 || crop.height <= 0 || crop.width > MAX_POINT || crop.height > MAX_POINT) return null
    return { x: crop.x, y: crop.y, width: crop.width, height: crop.height }
}

function runsOf(value: unknown, textLength: number): DesktopPdfTextRun[] | null {
    if (!Array.isArray(value) || value.length > DESKTOP_PDF_TEXT_MAX_PAGE_RUNS) return null
    const runs: DesktopPdfTextRun[] = []
    let previous = 0
    for (const item of value) {
        const run = record(item)
        if (!run || !sameKeys(run, ['start', 'end', 'x', 'y', 'w', 'h'])) return null
        if (!safeInteger(run.start) || !safeInteger(run.end)) return null
        if (run.start < previous || run.end <= run.start || run.end > textLength) return null
        if (!unit(run.x) || !unit(run.y) || !unit(run.w) || !unit(run.h) || !(run.w > 0) || !(run.h > 0)) return null
        if (run.x + run.w > 1 + 1e-4 || run.y + run.h > 1 + 1e-4) return null
        runs.push({ start: run.start, end: run.end, x: run.x, y: run.y, w: run.w, h: run.h })
        previous = run.end
    }
    return runs
}

function pageOf(value: unknown, expectedPage: number): DesktopPdfTextPage | null {
    const page = record(value)
    if (!page || !sameKeys(page, ['page', 'rotation', 'crop', 'pageWidth', 'pageHeight', 'text', 'runs'])) return null
    const rotation = rotationOf(page.rotation)
    if (page.page !== expectedPage || rotation === null) return null
    const crop = cropOf(page.crop)
    if (!crop || !finite(page.pageWidth) || !finite(page.pageHeight)) return null
    if (page.pageWidth <= 0 || page.pageHeight <= 0 || page.pageWidth > MAX_POINT || page.pageHeight > MAX_POINT) return null
    const sideways = rotation === 90 || rotation === 270
    const expectedWidth = sideways ? crop.height : crop.width
    const expectedHeight = sideways ? crop.width : crop.height
    if (!desktopPdfSamePointSize(page.pageWidth, expectedWidth) || !desktopPdfSamePointSize(page.pageHeight, expectedHeight)) return null
    if (typeof page.text !== 'string' || page.text.length > DESKTOP_PDF_TEXT_MAX_PAGE_CHARS || page.text.includes('\0')) return null
    const runs = runsOf(page.runs, page.text.length)
    if (!runs) return null
    return { page: expectedPage, rotation, crop, pageWidth: page.pageWidth, pageHeight: page.pageHeight, text: page.text, runs }
}

/** Accept only a bounded extract whose displayed size is the crop after rotation. */
export function parseDesktopPdfTextExtract(value: unknown): DesktopPdfTextExtract | null {
    const body = record(value)
    if (!body || !sameKeys(body, ['pageCount', 'truncated', 'reason', 'pages'])) return null
    if (!safeInteger(body.pageCount) || body.pageCount < 1 || body.pageCount > DESKTOP_PDF_TEXT_MAX_PAGES) return null
    if (typeof body.truncated !== 'boolean' || typeof body.reason !== 'string' || !Array.isArray(body.pages)) return null
    if (body.pages.length < 1 || body.pages.length > body.pageCount) return null
    if (body.truncated) {
        if (!(REASONS as readonly string[]).includes(body.reason)) return null
    } else if (body.reason !== '' || body.pages.length !== body.pageCount) return null
    const pages: DesktopPdfTextPage[] = []
    let chars = 0
    let runs = 0
    for (let index = 0; index < body.pages.length; index++) {
        const page = pageOf(body.pages[index], index + 1)
        if (!page) return null
        chars += page.text.length
        runs += page.runs.length
        if (chars > DESKTOP_PDF_TEXT_MAX_CHARS || runs > DESKTOP_PDF_TEXT_MAX_RUNS) return null
        pages.push(page)
    }
    return { pageCount: body.pageCount, truncated: body.truncated, reason: body.reason as DesktopPdfTextReason, pages }
}

export function lexicalDesktopPdfPath(path: string): string | null {
    if (typeof path !== 'string' || path.length < 1 || path.length > 4096) return null
    if (path.includes('\0') || path.includes('\\') || path.startsWith('/')) return null
    const kept: string[] = []
    for (const part of path.split('/')) {
        if (part === '' || part === '.') continue
        if (part === '..') return null
        kept.push(part)
    }
    const name = kept[kept.length - 1]
    if (!name || kept.length > 64 || !/\.pdf$/i.test(name)) return null
    return kept.join('/')
}

/** Bind an extract to the open file. A different identity or path is discarded. */
export function desktopPdfTextOf(value: unknown, openIdentity: string | undefined, openPath: string): DesktopPdfTextDocument | null {
    const body = record(value)
    const open = lexicalDesktopPdfPath(openPath)
    if (!body || !open || typeof body.identity !== 'string' || typeof body.path !== 'string') return null
    if (!IDENTITY.test(body.identity) || body.path !== open || lexicalDesktopPdfPath(body.path) !== open) return null
    if (openIdentity !== undefined && (!IDENTITY.test(openIdentity) || body.identity !== openIdentity)) return null
    const extract = parseDesktopPdfTextExtract({ pageCount: body.pageCount, truncated: body.truncated, reason: body.reason, pages: body.pages })
    if (!extract) return null
    return { ...extract, identity: body.identity, path: open }
}

function fold(value: string): string {
    let out = ''
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index)
        out += code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : value[index]!
    }
    return out
}

/** ASCII case-fold only, so a match index stays a UTF-16 offset into the extracted text. */
export function findDesktopPdfText(pages: readonly Pick<DesktopPdfTextPage, 'page' | 'text'>[], query: string): { matches: DesktopPdfTextMatch[]; limited: boolean } {
    const folded = fold(query).trim()
    if (!folded) return { matches: [], limited: false }
    const needle = folded.slice(0, DESKTOP_PDF_TEXT_MAX_QUERY)
    const matches: DesktopPdfTextMatch[] = []
    for (const page of pages) {
        const haystack = fold(page.text)
        let from = 0
        while (from <= haystack.length - needle.length) {
            const at = haystack.indexOf(needle, from)
            if (at < 0) break
            matches.push({ page: page.page, start: at, end: at + needle.length })
            if (matches.length >= DESKTOP_PDF_TEXT_MAX_MATCHES) return { matches, limited: true }
            from = at + needle.length
        }
    }
    return { matches, limited: false }
}

export function desktopPdfTextSearchable(pages: readonly { text: string }[]): boolean {
    return pages.some(page => /[^\s]/.test(page.text))
}

/** A partial-word hit splits the run in proportion to its UTF-16 span. A whole run is exact. */
export function desktopPdfTextRunSlice(run: DesktopPdfTextRun, start: number, end: number, rotation = 0): { x: number; y: number; w: number; h: number } | null {
    const from = Math.max(run.start, start)
    const to = Math.min(run.end, end)
    if (to <= from || run.end <= run.start) return null
    const span = run.end - run.start
    const offset = (from - run.start) / span, length = (to - from) / span
    if (rotation === 90) return { x: run.x, y: run.y + run.h * offset, w: run.w, h: run.h * length }
    if (rotation === 180) return { x: run.x + run.w * (1 - offset - length), y: run.y, w: run.w * length, h: run.h }
    if (rotation === 270) return { x: run.x, y: run.y + run.h * (1 - offset - length), w: run.w, h: run.h * length }
    return { x: run.x + run.w * offset, y: run.y, w: run.w * length, h: run.h }
}

export function desktopPdfFindMessage(input: {
    phase: 'hidden' | 'loading' | 'error' | 'ready'
    error: string
    searchable: boolean
    truncated: boolean
    aligned: boolean
    pagePresent: boolean
    query: string
    matchCount: number
    matchIndex: number
    limited: boolean
}): { count: string; message: string } {
    if (input.phase === 'loading') return { count: '', message: 'Reading PDF text…' }
    if (input.phase === 'error') return { count: '', message: input.error.trim() ? input.error : 'Could not read this PDF’s text.' }
    if (input.phase !== 'ready') return { count: '', message: '' }
    const partial = 'Search covers only part of this PDF.'
    const count = input.matchCount > 0 ? `${(input.matchIndex % input.matchCount) + 1} of ${input.matchCount}${input.limited ? '+' : ''}` : ''
    if (!input.searchable) return { count: '', message: input.truncated ? partial : 'No searchable text' }
    if (!input.pagePresent) return { count, message: input.truncated ? partial : 'This page’s text does not match the displayed page.' }
    if (!input.aligned) return { count, message: 'This page’s text does not match the displayed page.' }
    if (input.query.trim() && input.matchCount === 0) return { count: '', message: input.truncated ? `No matches. ${partial}` : 'No matches' }
    return { count, message: input.truncated ? partial : '' }
}
