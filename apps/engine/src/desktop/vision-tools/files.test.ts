import { linkSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { clearCachedEnvForTests } from '../../config/env.js'
import { desktopVisionImageMessages, desktopVisionPathAllowed, resolveDesktopVisionImage } from './files'

const root = mkdtempSync(resolve(tmpdir(), 'desktop-vision-files-'))
process.env.RERUN_DATA_DIR = root
clearCachedEnvForTests()
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
        await png('large.png', 4800, 3600)
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

    it('refuses images reached through parent symlinks, leaf symlinks or hard links', async () => {
        const outside = resolve(root, 'other-workspace')
        mkdirSync(outside)
        const picture = resolve(outside, 'picture.png')
        await sharp({ create: { width: 40, height: 30, channels: 3, background: '#c0ffee' } }).png().toFile(picture)
        symlinkSync(outside, resolve(uploads, 'alias'), 'dir')
        symlinkSync(picture, resolve(uploads, 'leaf.png'))
        linkSync(picture, resolve(uploads, 'hard.png'))
        for (const path of ['alias/picture.png', 'leaf.png', 'hard.png']) {
            await expect(resolveDesktopVisionImage(agentId, `chat-uploads/${path}`)).rejects.toThrow('unavailable in this coworker’s workspace')
        }
    })

    it('refuses a truncated PNG with a readable header and sends intact bytes inline for CLI vision', async () => {
        const image = await sharp({ create: { width: 80, height: 60, channels: 3, background: '#c0ffee' } }).png().toBuffer()
        const truncated = image.subarray(0, Math.floor(image.length / 2))
        expect((await sharp(truncated).metadata()).width).toBe(80)
        writeFileSync(resolve(uploads, 'truncated.png'), truncated)
        writeFileSync(resolve(uploads, 'intact.png'), image)
        for (const provider of ['openai', 'codex', 'claude']) {
            const ctx = { agent: { id: agentId, resolved: { provider } } } as never
            await expect(desktopVisionImageMessages(ctx, 'chat-uploads/truncated.png', 'Describe')).rejects.toThrow('not a readable image')
            expect(await desktopVisionImageMessages(ctx, 'chat-uploads/intact.png', 'Describe')).toEqual([
                { role: 'user', content: [{ type: 'image', image, mediaType: 'image/png' }, { type: 'text', text: 'Describe' }] },
            ])
        }
    })
})
