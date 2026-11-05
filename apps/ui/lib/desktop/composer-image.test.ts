import { afterEach, expect, test, vi } from 'vitest'
import {
    DESKTOP_IMAGE_ATTACHMENT_MAX_BYTES,
    DESKTOP_IMAGE_ATTACHMENT_MAX_FILES,
    DESKTOP_IMAGE_ATTACHMENT_TOTAL_MAX_BYTES,
    DESKTOP_IMAGE_UPLOAD_ACCEPT,
    desktopImageFilesFromDataTransfer,
    desktopImageKindForName,
    desktopImageProviderParts,
    desktopImageRequestAttachments,
    desktopImageSnapshotSchema,
    preflightDesktopImages,
    type DesktopImageSnapshot,
} from './composer-image'

const PNG_HEAD = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const JPEG_HEAD = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0])
const WEBP_HEAD = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])

const file = (name: string, head: Uint8Array = PNG_HEAD, size?: number, type = '') => {
    const bytes = new Uint8Array(head)
    if (size && size > bytes.length) {
        const grown = new Uint8Array(size)
        grown.set(bytes)
        return new File([grown.buffer], name, { type })
    }
    return new File([bytes.buffer], name, { type })
}
const snapshot = (over: Partial<DesktopImageSnapshot> = {}): DesktopImageSnapshot => ({
    sha256: 'a'.repeat(64), name: 'shot.png', path: 'shot.png', mediaType: 'image/png',
    width: 10, height: 10, byteLength: 100, ...over,
})

afterEach(() => vi.unstubAllGlobals())

test('image kinds come from the extension only and GIF stays unsupported', () => {
    expect(desktopImageKindForName('a.png')).toBe('png')
    expect(desktopImageKindForName('a.JPG')).toBe('jpeg')
    expect(desktopImageKindForName('a.jpeg')).toBe('jpeg')
    expect(desktopImageKindForName('a.webp')).toBe('webp')
    expect(desktopImageKindForName('a.gif')).toBeNull()
    expect(desktopImageKindForName('a.txt')).toBeNull()
    expect(desktopImageKindForName('a.png.exe')).toBeNull()
})

test('preflight accepts real magic bytes in order and refuses wrong magic, bad names, and oversize', async () => {
    const png = file('one.png')
    const jpeg = file('two.jpg', JPEG_HEAD)
    const webp = file('three.webp', WEBP_HEAD)
    const fake = file('fake.png', JPEG_HEAD)
    const gif = file('anim.gif', new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))
    const doc = file('notes.txt', new Uint8Array([0x41, 0x42]))
    const huge = file('big.png', PNG_HEAD, DESKTOP_IMAGE_ATTACHMENT_MAX_BYTES + 1)
    const hidden = file('.secret.png')
    const result = await preflightDesktopImages({ files: [png, fake, jpeg, gif, doc, huge, hidden, webp], attached: [], pending: [] })
    expect(result.blockers).toEqual([])
    expect(result.accepted).toEqual([png, jpeg, webp])
    expect(result.rejected.map(item => item.file.name)).toEqual(['fake.png', 'anim.gif', 'notes.txt', 'big.png', '.secret.png'])
    expect(result.rejected[0]!.reason).toContain('PNG')
})

test('preflight enforces the four-image cap and the 16 MiB aggregate across attached and pending', async () => {
    const attached = [snapshot({ sha256: '1'.repeat(64) }), snapshot({ sha256: '2'.repeat(64) })]
    const batch = [file('a.png'), file('b.png'), file('c.png'), file('d.png'), file('e.png')]
    const capped = await preflightDesktopImages({ files: batch, attached, pending: [{ size: 100, status: 'importing' }] })
    expect(capped.accepted).toEqual([batch[0]])
    expect(capped.rejected.slice(1).every(item => item.reason.includes('4 images'))).toBe(true)

    const result = await preflightDesktopImages({
        files: [file('a.png', PNG_HEAD, DESKTOP_IMAGE_ATTACHMENT_MAX_BYTES - 1000), file('b.png', PNG_HEAD, 2000)],
        attached: [snapshot({ byteLength: DESKTOP_IMAGE_ATTACHMENT_MAX_BYTES })],
        pending: [],
    })
    expect(result.accepted.map(item => item.name)).toEqual(['a.png'])
    expect(result.rejected.map(item => item.file.name)).toEqual(['b.png'])
    expect(result.rejected[0]!.reason).toContain('16 MiB')
})

test('the snapshot schema pins the immutable identity fields', () => {
    expect(desktopImageSnapshotSchema.safeParse(snapshot()).success).toBe(true)
    expect(desktopImageSnapshotSchema.safeParse(snapshot({ sha256: 'not-hex' })).success).toBe(false)
    expect(desktopImageSnapshotSchema.safeParse({ ...snapshot(), mediaType: 'image/gif' }).success).toBe(false)
    expect(desktopImageSnapshotSchema.safeParse(snapshot({ width: 8193 })).success).toBe(false)
    expect(desktopImageSnapshotSchema.safeParse({ ...snapshot(), extra: 1 }).success).toBe(false)
})

test('dataTransfer extraction reads items and files, dedupes, and skips non-images', () => {
    const png = file('a.png')
    const txt = file('b.txt', new Uint8Array([1]))
    const fake = { kind: 'file', getAsFile: () => png } as unknown as DataTransferItem
    const data = {
        items: [fake, { kind: 'string', getAsFile: () => null } as unknown as DataTransferItem],
        files: [png, txt] as unknown as FileList,
    } as unknown as DataTransfer
    expect(desktopImageFilesFromDataTransfer(data)).toEqual([png])
    expect(desktopImageFilesFromDataTransfer(null)).toEqual([])
})

test('request attachments and provider parts carry bytes-ready image data, never paths or URLs', () => {
    const image = snapshot()
    const requests = desktopImageRequestAttachments([{ image, dataBase64: 'aGk=' }])
    expect(requests).toEqual([{ name: 'shot.png', mediaType: 'image/png', width: 10, height: 10, byteLength: 100, sha256: image.sha256, dataBase64: 'aGk=' }])
    const parts = desktopImageProviderParts([{ name: 'shot.png', mediaType: 'image/png', data: new Uint8Array([1, 2]) }])
    expect(parts).toEqual([{ type: 'file', data: new Uint8Array([1, 2]), mediaType: 'image/png', filename: 'shot.png' }])
    expect(JSON.stringify(parts)).not.toContain('chat-images')
    expect(JSON.stringify(requests)).not.toContain('workspaces')
})

test('the accept list covers exactly the three supported types', () => {
    expect(DESKTOP_IMAGE_UPLOAD_ACCEPT).toBe('.png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp')
    expect(DESKTOP_IMAGE_ATTACHMENT_MAX_FILES).toBe(4)
})
