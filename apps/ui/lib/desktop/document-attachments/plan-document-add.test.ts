import { expect, it } from 'vitest'
import { DESKTOP_DOCUMENT_MAX_BYTES, DESKTOP_DOCUMENT_MAX_FILES, DESKTOP_DOCUMENT_STAGED_MAX_BYTES, DESKTOP_DOCUMENT_STAGED_TOTAL_MAX_BYTES, DESKTOP_DOCUMENT_TOTAL_MAX_BYTES, FOREMAN_AGENT_ID } from '@rerun/contracts'
import { desktopDocumentScopeHasFiles, planDesktopDocumentAdd, summarizeDesktopDocumentAddError, type DesktopDocumentAddOutcome } from './plan-document-add'

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

const MB = 1024 * 1024
it('lets only files that are saved to Files pass 16 MB, up to 100 MB each, and names the limit that applies', () => {
    const { accepts, rejects } = planDesktopDocumentAdd({
        files: [file('backup.zip', 90 * MB), file('deck.pptx', 17 * MB), file('clip.mp4', DESKTOP_DOCUMENT_STAGED_MAX_BYTES), file('huge.zip', DESKTOP_DOCUMENT_STAGED_MAX_BYTES + 1), file('scan.pdf', 17 * MB), file('talk.mp3', 20 * MB), file('photo.png', 17 * MB)],
        attachedCount: 0, attachedBytes: 0, stagedFiles: true, canRetainOne: alwaysRetain,
    })
    expect(accepts.map(f => f.name)).toEqual(['backup.zip', 'deck.pptx'])
    expect(rejects.map(r => [r.file.name, r.reason])).toEqual([['clip.mp4', 'capacity-large-bytes'], ['huge.zip', 'too-large'], ['scan.pdf', 'too-large'], ['talk.mp3', 'too-large'], ['photo.png', 'too-large']])
    expect(rejects[0]!.message).toBe('Files larger than 16 MB can be up to 200 MB in total in one message.')
    expect(rejects[1]!.message).toBe('huge.zip is 100 MB. Files saved to this coworker’s Files can be up to 100 MB.')
    expect(rejects[2]!.message).toBe('scan.pdf is 17 MB. This kind of file can be up to 16 MB; only files saved to this coworker’s Files (Office files, archives, video) can be larger.')
})
it('keeps the two totals apart: large files do not use the 48 MB, and small files do not use the 200 MB', () => {
    const attachedLargeBytes = DESKTOP_DOCUMENT_STAGED_TOTAL_MAX_BYTES - 20 * MB
    const { accepts, rejects } = planDesktopDocumentAdd({
        files: [file('small.zip', 10 * MB), file('fits.zip', 20 * MB), file('over.zip', 17 * MB), file('second.pdf', 16 * MB)],
        attachedCount: 2, attachedBytes: attachedLargeBytes + 30 * MB, attachedLargeBytes, stagedFiles: true, canRetainOne: alwaysRetain,
    })
    expect(accepts.map(f => f.name)).toEqual(['small.zip', 'fits.zip'])
    expect(rejects.map(r => [r.file.name, r.reason])).toEqual([['over.zip', 'capacity-large-bytes'], ['second.pdf', 'capacity-bytes']])
})
it('keeps 16 MB for every kind where there is no Files to save into', () => {
    expect(desktopDocumentScopeHasFiles({ agentId: 'coworker', tabUid: 'tab' })).toBe(true)
    expect(desktopDocumentScopeHasFiles({ agentId: FOREMAN_AGENT_ID, tabUid: 'chat', sessionId: 's' })).toBe(false)
    expect(desktopDocumentScopeHasFiles({ agentId: 'coworker', tabUid: `question:${'a'.repeat(64)}`, sessionId: 's' })).toBe(false)
    expect(desktopDocumentScopeHasFiles({ agentId: 'coworker', tabUid: 'tab', questionId: 'a'.repeat(64) })).toBe(false)
    const { accepts, rejects } = planDesktopDocumentAdd({ files: [file('backup.zip', 17 * MB), file('ok.zip', 16 * MB)], attachedCount: 0, attachedBytes: 0, canRetainOne: alwaysRetain })
    expect(accepts.map(f => f.name)).toEqual(['ok.zip'])
    expect(rejects.map(r => r.message)).toEqual(['backup.zip is larger than 16 MB.'])
})
