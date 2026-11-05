import { expect, test } from 'vitest'
import { desktopPdfFindMessage, desktopPdfTextOf, desktopPdfTextRunSlice, findDesktopPdfText, parseDesktopPdfTextExtract, type DesktopPdfTextPage } from './pdf-text'

function page(overrides: Partial<DesktopPdfTextPage> = {}): DesktopPdfTextPage {
    return {
        page: 1, rotation: 0, crop: { x: 0, y: 0, width: 612, height: 792 }, pageWidth: 612, pageHeight: 792,
        text: 'Alpha one', runs: [{ start: 0, end: 5, x: 0.1, y: 0.2, w: 0.2, h: 0.03 }], ...overrides,
    }
}
const rotated = (): DesktopPdfTextPage => ({
    page: 2, rotation: 90, crop: { x: 36, y: 36, width: 540, height: 720 }, pageWidth: 720, pageHeight: 540,
    text: 'Alpha two', runs: [{ start: 0, end: 5, x: 0.25, y: 0.3, w: 0.2, h: 0.04 }],
})
const scanned = (): DesktopPdfTextPage => ({
    page: 1, rotation: 0, crop: { x: 0, y: 0, width: 612, height: 792 }, pageWidth: 612, pageHeight: 792, text: '', runs: [],
})
function body(pages: DesktopPdfTextPage[], extra: Record<string, unknown> = {}) {
    return { pageCount: pages.length, truncated: false, reason: '', pages, ...extra }
}

test('accepts upright, rotated-cropped, and scanned pages and rejects geometry that is not the displayed crop', () => {
    const upright = page()
    expect(parseDesktopPdfTextExtract(body([upright, rotated()]))).toMatchObject({ pageCount: 2, pages: [upright, rotated()] })
    expect(parseDesktopPdfTextExtract(body([scanned()]))).toMatchObject({ pages: [{ text: '', runs: [] }] })
    const decimal = page({ crop: { x: 0, y: 0, width: 612.5, height: 792 }, pageWidth: 612.5 })
    expect(parseDesktopPdfTextExtract(body([decimal]))?.pages[0]?.pageWidth).toBe(612.5)
    const turned = JSON.parse(JSON.stringify(rotated())) as DesktopPdfTextPage
    turned.page = 1
    turned.pageWidth = 540
    turned.pageHeight = 720
    const badRotation = JSON.parse(JSON.stringify(body([page()]))) as { pages: { rotation: number }[] }
    badRotation.pages[0]!.rotation = 45
    expect(parseDesktopPdfTextExtract(body([turned]))).toBeNull()
    expect(parseDesktopPdfTextExtract(badRotation)).toBeNull()
    for (const value of [
        body([page({ runs: [{ start: 0, end: 5, x: 1.2, y: 0.2, w: 0.2, h: 0.03 }] })]),
        body([page({ runs: [{ start: 0, end: 4, x: 0.1, y: 0.2, w: 0.1, h: 0.03 }, { start: 3, end: 5, x: 0.2, y: 0.2, w: 0.1, h: 0.03 }] })]),
        body([page({ text: 'A\0B', runs: [] })]),
        body([page()], { truncated: true, reason: '' }),
        body([page()], { reason: 'text' }),
        { ...body([page()]), extra: true },
        body([page()], { pageCount: 2 }),
    ]) expect(parseDesktopPdfTextExtract(value)).toBeNull()
    expect(parseDesktopPdfTextExtract(body([page({ text: '   ', runs: [] })], { pageCount: 4, truncated: true, reason: 'pages' }))?.reason).toBe('pages')
})

test('binds text to the open identity and lexical pdf path', () => {
    const value = { ...body([page(), rotated()]), identity: '8:1', path: 'docs/report.pdf' }
    expect(desktopPdfTextOf(value, '8:1', 'docs/report.pdf')?.path).toBe('docs/report.pdf')
    expect(desktopPdfTextOf(value, '1:1', 'docs/report.pdf')).toBeNull()
    expect(desktopPdfTextOf({ ...value, path: '/docs/report.pdf' }, '8:1', 'docs/report.pdf')).toBeNull()
    expect(desktopPdfTextOf(value, '8:1', '../report.pdf')).toBeNull()
    expect(desktopPdfTextOf(value, '8:1', 'docs/report.txt')).toBeNull()
})

test('folds only ASCII letters, skips whitespace, and stops at 500 non-overlapping matches', () => {
    const pages = [page(), rotated()]
    expect(findDesktopPdfText(pages, 'ALPHA')).toEqual({ matches: [{ page: 1, start: 0, end: 5 }, { page: 2, start: 0, end: 5 }], limited: false })
    expect(findDesktopPdfText(pages, '   ')).toEqual({ matches: [], limited: false })
    expect(findDesktopPdfText([page({ text: 'aaaa', runs: [] })], 'aa').matches).toEqual([{ page: 1, start: 0, end: 2 }, { page: 1, start: 2, end: 4 }])
    const many = findDesktopPdfText([page({ text: 'a'.repeat(800), runs: [] })], 'a')
    expect(many.limited).toBe(true)
    expect(many.matches).toHaveLength(500)
    const dotted = page({ text: 'İ', runs: [{ start: 0, end: 1, x: 0.1, y: 0.1, w: 0.1, h: 0.02 }] })
    expect(findDesktopPdfText([dotted], 'İ').matches).toEqual([{ page: 1, start: 0, end: 1 }])
})

test('splits a partial run in proportion and keeps a whole run exact', () => {
    const run = page().runs[0]!
    expect(desktopPdfTextRunSlice(run, 0, 5)).toEqual({ x: 0.1, y: 0.2, w: 0.2, h: 0.03 })
    const partial = desktopPdfTextRunSlice(run, 0, 3)
    expect(partial?.x).toBe(0.1)
    expect(partial?.w).toBeCloseTo(0.12, 10)
    expect(desktopPdfTextRunSlice(run, 5, 9)).toBeNull()
})

test('distinguishes scanned pages, a partial extract, no matches, and a page that is not on screen', () => {
    const ready = { phase: 'ready' as const, error: '', searchable: true, truncated: false, aligned: true, pagePresent: true, query: 'Alpha', matchCount: 2, matchIndex: 1, limited: false }
    expect(desktopPdfFindMessage({ ...ready, phase: 'loading' })).toEqual({ count: '', message: 'Reading PDF text…' })
    expect(desktopPdfFindMessage({ ...ready, searchable: false, query: 'Alpha', matchCount: 0 })).toEqual({ count: '', message: 'No searchable text' })
    expect(desktopPdfFindMessage({ ...ready, searchable: false, truncated: true, query: 'Alpha', matchCount: 0 }).message).toBe('Search covers only part of this PDF.')
    expect(desktopPdfFindMessage({ ...ready, matchCount: 0 }).message).toBe('No matches')
    expect(desktopPdfFindMessage({ ...ready, matchCount: 0, truncated: true }).message).toBe('No matches. Search covers only part of this PDF.')
    expect(desktopPdfFindMessage(ready)).toEqual({ count: '2 of 2', message: '' })
    expect(desktopPdfFindMessage({ ...ready, limited: true, matchCount: 500 }).count).toBe('2 of 500+')
    expect(desktopPdfFindMessage({ ...ready, aligned: false }).message).toBe('This page’s text does not match the displayed page.')
    expect(desktopPdfFindMessage({ ...ready, phase: 'error', error: 'Send this PDF to preview again.' }).message).toBe('Send this PDF to preview again.')
})
