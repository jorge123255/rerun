import { expect, test } from 'vitest'
import { THUMB_IMAGE_MAX_BYTES, THUMB_TEXT_MAX_BYTES } from '@/lib/files/preview'

import {
    DESKTOP_FILES_TEXT_HEAD_CHARS,
    desktopFilesImageThumbUrl,
    desktopFilesTextHead,
    desktopFilesWantsTextThumb,
    isReservedDesktopFilesName,
} from './model'

const base = '/api/desktop/agents/alice/files'
const file = (name: string, size: number, type: 'file' | 'dir' = 'file') => ({ name, type, size })

test('reserved aliases stay out and ordinary hidden names stay', () => {
    expect(isReservedDesktopFilesName('internal.rerun.box')).toBe(true)
    expect(isReservedDesktopFilesName('INTERNAL.RERUN.notes')).toBe(true)
    expect(isReservedDesktopFilesName('.rerun-skill-lock')).toBe(true)
    expect(isReservedDesktopFilesName('.RERUN-SKILL-tmp')).toBe(true)
    expect(isReservedDesktopFilesName('.env')).toBe(false)
    expect(isReservedDesktopFilesName('.gitignore')).toBe(false)
    expect(isReservedDesktopFilesName('notes.md')).toBe(false)
    expect(isReservedDesktopFilesName('.rerun-edit-abc')).toBe(false)
})

test('an image thumb is the desktop image route under the original size cap', () => {
    expect(desktopFilesImageThumbUrl(base, 'photo.png', undefined, 100)).toBe(`${base}/image?path=photo.png`)
    expect(desktopFilesImageThumbUrl(base, 'shots/photo.png', '12:34', 100)).toBe(`${base}/image?path=shots%2Fphoto.png&identity=12%3A34`)
    expect(desktopFilesImageThumbUrl(base, 'photo.png', undefined, THUMB_IMAGE_MAX_BYTES)).toBe(`${base}/image?path=photo.png`)
    expect(desktopFilesImageThumbUrl(base, 'photo.png', undefined, THUMB_IMAGE_MAX_BYTES + 1)).toBeNull()
    expect(desktopFilesImageThumbUrl(base, 'photo.png', undefined, 0)).toBeNull()
    expect(desktopFilesImageThumbUrl(base, 'notes.md', undefined, 100)).toBeNull()
    expect(desktopFilesImageThumbUrl('https://example.com/api/desktop/agents/alice/files', 'photo.png', undefined, 100)).toBeNull()
    expect(desktopFilesImageThumbUrl(`${base}?hidden=1`, 'photo.png', undefined, 100)).toBeNull()
})

test('a text head is the first original slice, and a refusal is empty', () => {
    expect(desktopFilesTextHead({ content: 'hello' }, true)).toBe('hello')
    expect(desktopFilesTextHead({ content: 'x'.repeat(DESKTOP_FILES_TEXT_HEAD_CHARS + 40) }, true)).toHaveLength(DESKTOP_FILES_TEXT_HEAD_CHARS)
    expect(desktopFilesTextHead({ content: 'secret', conflict: true }, true)).toBe('')
    expect(desktopFilesTextHead({ content: 'secret', error: 'That path is outside this coworker’s workspace.' }, true)).toBe('')
    expect(desktopFilesTextHead({ error: 'Could not preview this file.' }, false)).toBe('')
    expect(desktopFilesTextHead(null, true)).toBe('')
    expect(desktopFilesTextHead({ content: 12 }, true)).toBe('')
})

test('text thumbs are small text files only', () => {
    expect(desktopFilesWantsTextThumb(file('notes.md', 12))).toBe(true)
    expect(desktopFilesWantsTextThumb(file('index.ts', THUMB_TEXT_MAX_BYTES))).toBe(true)
    expect(desktopFilesWantsTextThumb(file('index.ts', THUMB_TEXT_MAX_BYTES + 1))).toBe(false)
    expect(desktopFilesWantsTextThumb(file('empty.md', 0))).toBe(false)
    expect(desktopFilesWantsTextThumb(file('photo.png', 12))).toBe(false)
    expect(desktopFilesWantsTextThumb(file('clip.mp4', 12))).toBe(false)
    expect(desktopFilesWantsTextThumb(file('song.mp3', 12))).toBe(false)
    expect(desktopFilesWantsTextThumb(file('doc.pdf', 12))).toBe(false)
    expect(desktopFilesWantsTextThumb(file('bundle.zip', 12))).toBe(false)
    expect(desktopFilesWantsTextThumb(file('docs', 12, 'dir'))).toBe(false)
})
