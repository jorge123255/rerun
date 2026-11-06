import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { desktopVisionImageMessages, desktopVisionPathAllowed, resolveDesktopVisionImage } from './files'

const root = mkdtempSync(resolve(tmpdir(), 'desktop-vision-files-'))
process.env.RERUN_DATA_DIR = root
const agentId = 'viewer'
const uploads = resolve(root, 'agents', agentId, 'workspace', 'chat-uploads')
mkdirSync(uploads, { recursive: true })
afterEach(() => { process.env.RERUN_DATA_DIR = root })

async function png(name: string, width: number, height: number) {
    const image = await sharp({ create: { width, height, channels: 3, background: '#c0ffee' } }).png().toBuffer()
    writeFileSync(resolve(uploads, name), image)
}

describe('desktop vision file confinement', () => {
    it('allows ordinary hidden assets but refuses reserved internal aliases at every depth', () => {
        expect(desktopVisionPathAllowed('chat-uploads/picture.png')).toBe(true)
        expect(desktopVisionPathAllowed('.hidden/picture.png')).toBe(true)
        for (const path of ['.rerun/private.png', 'nested/.rerun-skill/file.png', 'nested/.rerun-skill-one/file.png', 'nested/.rerun-other/file.png', '../.rerun/file.png', '/tmp/picture.png']) {
            expect(desktopVisionPathAllowed(path)).toBe(false)
        }
    })

    it('resizes a large real image and preserves a small one', async () => {
        await png('large.png', 4000, 3000)
        await png('small.png', 400, 300)
        const large = await desktopVisionImageMessages({ agent: { id: agentId, resolved: { provider: 'openai' } } } as never, 'chat-uploads/large.png', 'describe')
        const small = await desktopVisionImageMessages({ agent: { id: agentId, resolved: { provider: 'openai' } } } as never, 'chat-uploads/small.png', 'describe')
        const largePart = (large[0] as any).content[0]
        const smallPart = (small[0] as any).content[0]
        expect(largePart.mediaType).toBe('image/webp')
        expect(smallPart.mediaType).toBe('image/png')
        const { width = 0, height = 0 } = await sharp(largePart.image).metadata()
        expect(Math.max(width, height)).toBe(2048)
    })

    it('rejects a broken image and a reserved path before model work', async () => {
        writeFileSync(resolve(uploads, 'broken.png'), 'not an image')
        await expect(resolveDesktopVisionImage(agentId, 'chat-uploads/broken.png')).rejects.toThrow()
        await expect(resolveDesktopVisionImage(agentId, '.rerun/private.png')).rejects.toThrow()
    })
})
