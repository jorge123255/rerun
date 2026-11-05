import { afterEach, expect, test, vi } from 'vitest'
import {
    DESKTOP_IMAGE_ATTACHMENT_MAX_BYTES,
    DESKTOP_IMAGE_ATTACHMENT_MAX_FILES,
    DESKTOP_IMAGE_ATTACHMENT_TOTAL_MAX_BYTES,
    DESKTOP_IMAGE_UPLOAD_ACCEPT,
    desktopImageCanPreviewLocally,
    desktopImageFilesFromDataTransfer,
    desktopImageKindForName,
    desktopImageKindIsConverted,
    desktopImageMediaType,
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

test('image kinds come from the extension and still formats convert while text is not an image', () => {
    expect(desktopImageKindForName('a.png')).toBe('png')
    expect(desktopImageKindForName('a.JPG')).toBe('jpeg')
    expect(desktopImageKindForName('a.jpeg')).toBe('jpeg')
    expect(desktopImageKindForName('a.webp')).toBe('webp')
    expect(desktopImageKindForName('a.gif')).toBe('gif')
    expect(desktopImageKindForName('a.AVIF')).toBe('avif')
    expect(desktopImageKindForName('a.ico')).toBe('ico')
    expect(desktopImageKindForName('a.bmp')).toBe('bmp')
    expect(desktopImageKindForName('a.svg')).toBe('svg')
    expect(desktopImageKindForName('a.txt')).toBeNull()
    expect(desktopImageKindForName('a.png.exe')).toBeNull()
    expect(desktopImageKindForName('a.svg.txt')).toBeNull()
})

test('preflight accepts real magic bytes in order and refuses wrong magic, bad names, and oversize', async () => {
    const png = file('one.png')
    const jpeg = file('two.jpg', JPEG_HEAD)
    const webp = file('three.webp', WEBP_HEAD)
    const fake = file('fake.png', JPEG_HEAD)
    const gif = file('still.gif', new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))
    const svg = file('icon.svg', new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>'))
    const bmp = file('picture.bmp', new Uint8Array([0x42, 0x4d, 0, 0, 0, 0]))
    const ico = file('icon.ico', new Uint8Array([0, 0, 1, 0, 1, 0]))
    const avif = file('photo.avif', new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]))
    const doc = file('notes.txt', new Uint8Array([0x41, 0x42]))
    const huge = file('big.png', PNG_HEAD, DESKTOP_IMAGE_ATTACHMENT_MAX_BYTES + 1)
    const hidden = file('.secret.png')
    const result = await preflightDesktopImages({ files: [png, fake, jpeg, gif, svg, bmp, ico, avif, doc, huge, hidden, webp], attached: [], pending: [] })
    expect(result.blockers).toEqual([])
    expect(result.accepted).toEqual([png, jpeg, gif, svg])
    expect(result.rejected.map(item => item.file.name)).toEqual(['fake.png', 'picture.bmp', 'icon.ico', 'photo.avif', 'notes.txt', 'big.png', '.secret.png', 'three.webp'])
    expect(result.rejected[0]!.reason).toContain('PNG')
    expect(result.rejected.at(-1)!.reason).toContain('4 images')
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

test('the accept list covers the direct and converted still formats', () => {
    for (const extension of ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.ico', '.bmp', '.svg']) {
        expect(DESKTOP_IMAGE_UPLOAD_ACCEPT).toContain(extension)
    }
    expect(DESKTOP_IMAGE_ATTACHMENT_MAX_FILES).toBe(4)
})

test('converted formats map to a PNG snapshot and SVG is never decoded by the client', async () => {
    expect(desktopImageMediaType('svg')).toBe('image/png')
    expect(desktopImageMediaType('gif')).toBe('image/png')
    expect(desktopImageMediaType('avif')).toBe('image/png')
    expect(desktopImageMediaType('png')).toBe('image/png')
    expect(desktopImageKindIsConverted('webp')).toBe(false)
    expect(desktopImageKindIsConverted('bmp')).toBe(true)
    expect(desktopImageCanPreviewLocally('webp')).toBe(true)
    expect(desktopImageCanPreviewLocally('ico')).toBe(false)

    const bitmap = vi.fn()
    vi.stubGlobal('createImageBitmap', bitmap)
    const svg = file('icon.svg', new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>'))
    const result = await preflightDesktopImages({ files: [svg], attached: [], pending: [] })
    expect(result.accepted).toEqual([svg])
    expect(bitmap).not.toHaveBeenCalled()
})
