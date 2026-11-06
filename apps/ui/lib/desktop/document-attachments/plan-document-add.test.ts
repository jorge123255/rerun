import { expect, it } from 'vitest'
import { DESKTOP_DOCUMENT_MAX_BYTES, DESKTOP_DOCUMENT_MAX_FILES, DESKTOP_DOCUMENT_TOTAL_MAX_BYTES } from '@rerun/contracts'
import { planDesktopDocumentAdd, summarizeDesktopDocumentAddError, type DesktopDocumentAddOutcome } from './plan-document-add'

const file = (name: string, size: number) =>
    ({ name, size, type: 'application/pdf' }) as File

const alwaysRetain = () => true

it('accepts an ordered mix and rejects empty/oversized neighbors without dropping eligible siblings', () => {
    const { accepts, rejects } = planDesktopDocumentAdd({
        files: [file('ok.pdf', 100), file('empty.pdf', 0), file('big.pdf', DESKTOP_DOCUMENT_MAX_BYTES + 1), file('also.pdf', 50)],
        attachedCount: 0,
        attachedBytes: 0,
        canRetainOne: alwaysRetain,
    })
    expect(accepts.map(f => f.name)).toEqual(['ok.pdf', 'also.pdf'])
    expect(rejects.map(r => [r.file.name, r.reason])).toEqual([
        ['empty.pdf', 'empty'],
        ['big.pdf', 'too-large'],
    ])
})

it('rejects later files when document count capacity is already full, keeping earlier accepts', () => {
    const { accepts, rejects } = planDesktopDocumentAdd({
        files: [file('a.pdf', 1), file('b.pdf', 1), file('c.pdf', 1)],
        attachedCount: DESKTOP_DOCUMENT_MAX_FILES - 1,
        attachedBytes: 0,
        canRetainOne: alwaysRetain,
    })
    expect(accepts.map(f => f.name)).toEqual(['a.pdf'])
    expect(rejects.every(r => r.reason === 'capacity-files')).toBe(true)
    expect(rejects.map(r => r.file.name)).toEqual(['b.pdf', 'c.pdf'])
})

it('rejects a file that would exceed total bytes but still accepts a later smaller sibling that fits', () => {
    const near = DESKTOP_DOCUMENT_TOTAL_MAX_BYTES - 10
    const { accepts, rejects } = planDesktopDocumentAdd({
        files: [file('large.pdf', 20), file('tiny.pdf', 5)],
        attachedCount: 0,
        attachedBytes: near,
        canRetainOne: alwaysRetain,
    })
    expect(rejects.map(r => [r.file.name, r.reason])).toEqual([['large.pdf', 'capacity-bytes']])
    expect(accepts.map(f => f.name)).toEqual(['tiny.pdf'])
})

it('surfaces retain-full per file when the retain buffer cannot take the next accept', () => {
    const { accepts, rejects } = planDesktopDocumentAdd({
        files: [file('one.pdf', 10), file('two.pdf', 10)],
        attachedCount: 0,
        attachedBytes: 0,
        canRetainOne: (_file, accepting) => accepting.length === 0,
    })
    expect(accepts.map(f => f.name)).toEqual(['one.pdf'])
    expect(rejects.map(r => [r.file.name, r.reason])).toEqual([['two.pdf', 'retain-full']])
})

it('summary says Nothing was attached only when every outcome is a reject', () => {
    const allReject: DesktopDocumentAddOutcome[] = [
        { status: 'rejected', name: 'empty.pdf', byteLength: 0, reason: 'empty', message: 'empty.pdf is empty.' },
        { status: 'rejected', name: 'big.pdf', byteLength: 9, reason: 'too-large', message: 'big.pdf is larger than 16 MB.' },
    ]
    expect(summarizeDesktopDocumentAddError(allReject)).toMatch(/Nothing was attached\.$/)
    const mixed: DesktopDocumentAddOutcome[] = [
        { status: 'attached', name: 'ok.pdf', byteLength: 1, attachmentId: 'id', position: 0 },
        ...allReject,
    ]
    const mixedError = summarizeDesktopDocumentAddError(mixed)
    expect(mixedError).toContain('empty.pdf is empty.')
    expect(mixedError).not.toMatch(/Nothing was attached/)
    expect(summarizeDesktopDocumentAddError([{ status: 'attached', name: 'ok.pdf', byteLength: 1, attachmentId: 'id', position: 0 }])).toBeNull()
})
