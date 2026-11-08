import { File as NodeFile } from 'node:buffer'
import { expect, test } from 'vitest'
import { planFxAttachmentBatch, formatFxAttachmentRejections } from './attachment-overflow'
import { preflightDesktopUploads } from '../composer-upload'
import { planDesktopDocumentAdd } from '../document-attachments/plan-document-add'
const file = (name: string, text = 'fixture') => new NodeFile([text], name) as unknown as File
test('more than fourteen candidates all reach real per-kind admission, which retains admissible text and names overflow', async () => {
    const files = [file('bad.txt', '\0'), ...Array.from({ length: 15 }, (_, i) => file(`note-${i}-世界.md`))]
    const groups = planFxAttachmentBatch(files)
    expect(groups.flatMap(group => group.files)).toEqual(files)
    const result = await preflightDesktopUploads({ files: groups[0].files, attachedPaths: [], attachedSizes: new Map(), pending: [] })
    expect(result.accepted.map(f => f.name)).toEqual(files.slice(1, 11).map(f => f.name))
    const lines = formatFxAttachmentRejections(result.rejected.map(row => ({ name: row.file.name, message: row.reason })))
    expect(lines).toHaveLength(6); expect(lines.join('\n')).toContain('note-14-世界.md')
    expect(lines[0]).toContain('bad.txt')
})
test('mixed candidates preserve contiguous order and never steal another kind’s capacity', () => {
    const files = [file('a.txt'), file('a.PNG'), ...Array.from({ length: 13 }, (_, i) => file(`document-${i}.pdf`)), file('later.md')]
    const groups = planFxAttachmentBatch(files)
    expect(groups.map(g => g.kind)).toEqual(['text', 'image', 'document', 'text'])
    expect(groups.flatMap(g => g.files)).toEqual(files)
    const documents = planDesktopDocumentAdd({ files: groups[2].files, attachedCount: 0, attachedBytes: 0, canRetainOne: () => true })
    expect(documents.accepts).toHaveLength(10)
    expect(formatFxAttachmentRejections(documents.rejects.map(row => ({ name: row.file.name, message: row.message }))).join(' ')).toContain('document-12.pdf')
    expect(groups[3].files[0]).toBe(files[files.length - 1])
})
test('unknown existing attachment sizes remain a blocker and no candidate is claimed imported', async () => {
    const candidates = planFxAttachmentBatch([file('keep.md')])
    const result = await preflightDesktopUploads({ files: candidates[0].files, attachedPaths: ['old.md'], attachedSizes: new Map(), pending: [] })
    expect(result.accepted).toEqual([]); expect(result.blockers).toHaveLength(1)
    expect(candidates[0]).not.toHaveProperty('accepted')
    expect(formatFxAttachmentRejections([{ name: 'name\nline.md', message: 'Full' }])[0]).toBe('"name\\nline.md": Full')
})
