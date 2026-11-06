import { CARD_MAX_IMAGE_BYTES, CARD_MAX_IMAGE_TOTAL_BYTES } from '@rerun/contracts'
import { expect, test } from 'vitest'
import { DESKTOP_CARD_BINARY_MAX_BYTES, desktopFileCardOf } from './file-card'

const text = { path: 'reports/summary.md', name: 'summary.md', size: 7, scope: 'agent' as const }
const sharedText = { path: 'reports/summary.md', name: 'summary.md', size: 7, scope: 'shared' as const, identity: '4:8' }
const sharedImage = { path: 'shots/photo.png', name: 'photo.png', size: CARD_MAX_IMAGE_BYTES, scope: 'shared' as const, identity: '9:9' }
const zip = { path: 'reports/bundle.zip', name: 'bundle.zip', size: 12, scope: 'agent' as const, identity: '3:5' }

test('keeps a saved mixed card in order without a host or port', () => {
    const saved = JSON.stringify({ kind: 'file', files: [text, sharedImage, zip] })
    expect(saved).not.toContain('http')
    expect(saved).not.toContain('127.0.0.1')
    expect(desktopFileCardOf(saved)).toEqual({ kind: 'file', files: [text, sharedImage, zip] })
})

test('drops private text identity and requires it for shared text and download tiles', () => {
    expect(desktopFileCardOf({ kind: 'file', files: [{ ...text, identity: '1:1' }] })).toEqual({ kind: 'file', files: [text] })
    expect(desktopFileCardOf({ kind: 'file', files: [sharedText] })?.files[0]).toEqual(sharedText)
    expect(desktopFileCardOf({ kind: 'file', files: [{ ...sharedText, identity: undefined }] })).toBeUndefined()
    expect(desktopFileCardOf({ kind: 'file', files: [zip] })?.files[0]).toEqual(zip)
    expect(desktopFileCardOf({ kind: 'file', files: [{ path: 'reports/image.tiff', name: 'image.tiff', size: 12, scope: 'agent' }] })).toBeUndefined()
})

test('does not spend the private album budget on shared images or download tiles', () => {
    const album = Array.from({ length: 3 }, (_, index) => ({ path: `shots/${index}.png`, name: `${index}.png`, size: CARD_MAX_IMAGE_BYTES, scope: 'agent' as const, identity: `2:${index + 1}` }))
    expect(album.reduce((sum, file) => sum + file.size, 0)).toBe(CARD_MAX_IMAGE_TOTAL_BYTES)
    expect(desktopFileCardOf({ kind: 'file', files: [...album, sharedImage, zip] })?.files).toHaveLength(5)
    expect(desktopFileCardOf({ kind: 'file', files: [...album, { ...album[0], path: 'shots/extra.png', name: 'extra.png', identity: '2:9' }] })).toBeUndefined()
})

test('rejects one hostile file in the set, an empty download, and a replaced card shape', () => {
    expect(desktopFileCardOf({ kind: 'file', files: [zip, { ...text, path: '../summary.md', name: 'summary.md' }] })).toBeUndefined()
    expect(desktopFileCardOf({ kind: 'file', files: [{ ...zip, path: '/tmp/bundle.zip', name: 'bundle.zip' }] })).toBeUndefined()
    expect(desktopFileCardOf({ kind: 'file', files: [{ ...zip, path: 'http://127.0.0.1/bundle.zip', name: 'bundle.zip' }] })).toBeUndefined()
    expect(desktopFileCardOf({ kind: 'file', files: [{ ...zip, path: '.secret/bundle.zip', name: 'bundle.zip' }] })).toBeUndefined()
    expect(desktopFileCardOf({ kind: 'file', files: [{ ...zip, size: 0 }] })).toBeUndefined()
    expect(desktopFileCardOf({ kind: 'file', files: [{ ...zip, size: DESKTOP_CARD_BINARY_MAX_BYTES + 1 }] })).toBeUndefined()
    expect(desktopFileCardOf({ kind: 'file', files: [{ ...zip, name: 'other.zip' }] })).toBeUndefined()
    expect(desktopFileCardOf({ kind: 'file', files: [text, { ...zip, identity: undefined }] })).toBeUndefined()
})
