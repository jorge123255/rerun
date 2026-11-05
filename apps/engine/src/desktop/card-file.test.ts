import { mkdtempSync } from 'node:fs'
import { link, mkdir, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { CARD_MAX_AUDIO_BYTES, CARD_MAX_FILES, CARD_MAX_IMAGE_BYTES, CARD_MAX_VIDEO_BYTES, DESKTOP_ATTACHMENT_MAX_BYTES, fileCardSchema } from '@rerun/contracts'
import type { RunContext } from '../runtime/context.js'

const root = mkdtempSync(join(tmpdir(), 'rerun-mac-card-file-'))
process.env.RERUN_DATA_DIR = root
process.env.RERUN_API_KEY = ''
const { workspaceDir } = await import('../config/paths.js')
const { agentConfigSchema } = await import('../agents/types.js')
const { writeAgentConfig } = await import('../agents/config-write.js')
const { readAgentConfig } = await import('../agents/loader.js')
const { buildTools } = await import('../tools/registry.js')
const { createServer } = await import('../http/server.js')
const { DESKTOP_CARD_PDF_MAX_BYTES } = await import('./card-file.js')
const alpha = 'cards-alpha', bravo = 'cards-bravo'
const app = createServer()
const options = { messages: [], toolCallId: 'card-test' }

const config = (id: string) => agentConfigSchema.parse({ name: id, tools: { desktopToolGrants: { cardFile: false } } })
const grant = async (id: string, enabled: boolean) => {
    const response = await app.request(`/agents/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tools: { desktopToolGrants: { cardFile: enabled } } }) })
    expect(response.status).toBe(200)
}
const registry = async (id: string, signal?: AbortSignal) => {
    const ctx = { agent: { id, config: await readAgentConfig(id) }, abortSignal: signal } as RunContext
    return (await buildTools(ctx)).tools
}
const toolFor = async (id: string, signal?: AbortSignal) => (await registry(id, signal)).card_file!
const show = async (tool: Awaited<ReturnType<typeof toolFor>>, path: string, scope?: 'agent' | 'shared') =>
    String(await tool.execute!({ files: [{ path, ...(scope && { scope }) }] }, options))

beforeAll(async () => {
    vi.stubEnv('RERUN_DESKTOP_APP', '1')
    for (const id of [alpha, bravo]) {
        await mkdir(join(workspaceDir(id), 'reports'), { recursive: true })
        await mkdir(join(workspaceDir(id), 'shots'), { recursive: true })
        await mkdir(join(workspaceDir(id), 'voice'), { recursive: true })
        await writeAgentConfig(id, config(id))
        await writeFile(join(workspaceDir(id), 'reports', 'summary.md'), 'Summary')
        await writeFile(join(workspaceDir(id), 'reports', 'notes.txt'), 'Notes')
        await writeFile(join(workspaceDir(id), 'reports', 'deck.pdf'), Buffer.alloc(1024, 7))
        await writeFile(join(workspaceDir(id), 'reports', 'empty.pdf'), '')
        await writeFile(join(workspaceDir(id), 'reports', 'big.pdf'), '')
        await truncate(join(workspaceDir(id), 'reports', 'big.pdf'), DESKTOP_CARD_PDF_MAX_BYTES + 1)
        await writeFile(join(workspaceDir(id), 'shots', 'photo.png'), Buffer.alloc(1024, 7))
        await writeFile(join(workspaceDir(id), 'shots', 'empty.png'), Buffer.alloc(0))
        await writeFile(join(workspaceDir(id), 'shots', 'big.png'), '')
        await truncate(join(workspaceDir(id), 'shots', 'big.png'), CARD_MAX_IMAGE_BYTES + 1)
        for (let n = 0; n < 3; n++) {
            await writeFile(join(workspaceDir(id), 'shots', `eight-${n}.png`), '')
            await truncate(join(workspaceDir(id), 'shots', `eight-${n}.png`), CARD_MAX_IMAGE_BYTES)
        }
        await writeFile(join(workspaceDir(id), 'shots', 'one-byte.png'), Buffer.from([1]))
        await writeFile(join(workspaceDir(id), 'voice', 'tone.wav'), Buffer.alloc(1024, 7))
        await writeFile(join(workspaceDir(id), 'voice', 'tone.mp3'), Buffer.alloc(1024, 7))
        for (const ext of ['ogg', 'm4a', 'flac']) {
            await writeFile(join(workspaceDir(id), 'voice', `tone.${ext}`), Buffer.alloc(1024, 7))
        }
        await writeFile(join(workspaceDir(id), 'voice', 'empty.wav'), '')
        await writeFile(join(workspaceDir(id), 'voice', 'big.mp3'), '')
        await truncate(join(workspaceDir(id), 'voice', 'big.mp3'), CARD_MAX_AUDIO_BYTES + 1)
        await writeFile(join(workspaceDir(id), 'shots', 'clip.mp4'), Buffer.alloc(1024, 7))
        await writeFile(join(workspaceDir(id), 'shots', 'empty.mp4'), '')
        await writeFile(join(workspaceDir(id), 'shots', 'big.mp4'), '')
        await truncate(join(workspaceDir(id), 'shots', 'big.mp4'), CARD_MAX_VIDEO_BYTES + 1)
        await writeFile(join(workspaceDir(id), 'shots', 'one-byte.mp4'), Buffer.from([1]))
    }
})
afterAll(async () => {
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
})

it('starts off, then shows only the granted coworker’s existing text file', async () => {
    expect((await registry(alpha)).card_file).toBeUndefined()
    expect((await registry(bravo)).card_file).toBeUndefined()
    await grant(alpha, true)
    expect((await registry(alpha)).card_file).toBeDefined()
    expect((await registry(bravo)).card_file).toBeUndefined()
    const tool = await toolFor(alpha)
    const result = await show(tool, 'reports/summary.md')
    expect(fileCardSchema.parse(JSON.parse(result))).toEqual({
        kind: 'file',
        files: [{ path: 'reports/summary.md', name: 'summary.md', size: 7, scope: 'agent' }],
    })
    expect((await registry(alpha)).card_file!.description).not.toContain('shared space')
})

it('refuses shared, foreign, hidden, linked, directory, unsupported and oversized paths without a host path', async () => {
    await grant(alpha, true)
    const tool = await toolFor(alpha)
    const root = workspaceDir(alpha), other = workspaceDir(bravo)
    await symlink(join(other, 'reports', 'summary.md'), join(root, 'linked.md'))
    await link(join(other, 'reports', 'summary.md'), join(root, 'alias.md'))
    await symlink(join(other, 'shots', 'photo.png'), join(root, 'linked.png'))
    await link(join(other, 'shots', 'photo.png'), join(root, 'alias.png'))
    await symlink(join(other, 'voice', 'tone.wav'), join(root, 'linked.wav'))
    await link(join(other, 'voice', 'tone.wav'), join(root, 'alias.wav'))
    await symlink(join(other, 'shots', 'clip.mp4'), join(root, 'linked.mp4'))
    await link(join(other, 'shots', 'clip.mp4'), join(root, 'alias.mp4'))
    await symlink(join(other, 'reports', 'deck.pdf'), join(root, 'linked.pdf'))
    await link(join(other, 'reports', 'deck.pdf'), join(root, 'alias.pdf'))
    await mkdir(join(root, 'folder.md'))
    await mkdir(join(root, 'folder.png'))
    await mkdir(join(root, 'folder.wav'))
    await mkdir(join(root, 'folder.mp4'))
    await mkdir(join(root, 'folder.pdf'))
    await writeFile(join(root, 'big.md'), Buffer.alloc(DESKTOP_ATTACHMENT_MAX_BYTES + 1, 65))
    const cases: [string, 'agent' | 'shared', RegExp][] = [
        ['reports/summary.md', 'shared', /Shared files are not available/],
        ['shots/photo.png', 'shared', /Shared files are not available/],
        ['voice/tone.wav', 'shared', /Shared files are not available/],
        ['shots/clip.mp4', 'shared', /Shared files are not available/],
        ['reports/deck.pdf', 'shared', /Shared files are not available/],
        ['/etc/passwd.md', 'agent', /relative .* path/],
        ['/etc/passwd.png', 'agent', /relative .* path/],
        ['/etc/passwd.wav', 'agent', /relative .* path/],
        ['/etc/passwd.mp4', 'agent', /relative .* path/],
        ['/tmp/codex-edit/deck.pdf', 'agent', /relative .* path/],
        ['../cards-bravo/workspace/reports/summary.md', 'agent', /relative .* path/],
        ['../cards-bravo/workspace/shots/photo.png', 'agent', /relative .* path/],
        ['../cards-bravo/workspace/voice/tone.wav', 'agent', /relative .* path/],
        ['../cards-bravo/workspace/shots/clip.mp4', 'agent', /relative .* path/],
        ['../cards-bravo/workspace/reports/deck.pdf', 'agent', /relative .* path/],
        ['.secret/summary.md', 'agent', /relative .* path/],
        ['.secret/photo.png', 'agent', /relative .* path/],
        ['.secret/tone.wav', 'agent', /relative .* path/],
        ['.secret/clip.mp4', 'agent', /relative .* path/],
        ['.secret/deck.pdf', 'agent', /relative .* path/],
        ['reports\\summary.md', 'agent', /relative .* path/],
        ['shots\\photo.png', 'agent', /relative .* path/],
        ['voice\\tone.wav', 'agent', /relative .* path/],
        ['shots\\clip.mp4', 'agent', /relative .* path/],
        ['reports\\deck.pdf', 'agent', /relative .* path/],
        ['linked.md', 'agent', /unavailable/],
        ['alias.md', 'agent', /unavailable/],
        ['linked.png', 'agent', /unavailable/],
        ['alias.png', 'agent', /unavailable/],
        ['linked.wav', 'agent', /unavailable/],
        ['alias.wav', 'agent', /unavailable/],
        ['linked.mp4', 'agent', /unavailable/],
        ['alias.mp4', 'agent', /unavailable/],
        ['linked.pdf', 'agent', /unavailable/],
        ['alias.pdf', 'agent', /unavailable/],
        ['folder.md', 'agent', /folder, not a file/],
        ['folder.png', 'agent', /folder, not a file/],
        ['folder.wav', 'agent', /folder, not a file/],
        ['folder.mp4', 'agent', /folder, not a file/],
        ['folder.pdf', 'agent', /folder, not a file/],
        ['reports/image.svg', 'agent', /relative .* path/],
        ['shots/clip.mov', 'agent', /relative .* path/],
        ['shots/clip.webm', 'agent', /relative .* path/],
        ['voice/tone.aac', 'agent', /relative .* path/],
        ['big.md', 'agent', /32 KiB/],
        ['shots/big.png', 'agent', /8 MB/],
        ['shots/big.mp4', 'agent', /16 MB/],
        ['shots/empty.png', 'agent', /empty/],
        ['shots/empty.mp4', 'agent', /empty/],
        ['voice/empty.wav', 'agent', /empty/],
        ['voice/big.mp3', 'agent', /16 MB/],
        ['missing.md', 'agent', /unavailable/],
        ['shots/missing.png', 'agent', /unavailable/],
        ['shots/missing.mp4', 'agent', /unavailable/],
        ['voice/missing.wav', 'agent', /unavailable/],
        ['reports/empty.pdf', 'agent', /empty/],
        ['reports/big.pdf', 'agent', /16 MB/],
        ['reports/missing.pdf', 'agent', /unavailable/],
    ]
    for (const [path, scope, message] of cases) {
        const result = await show(tool, path, scope)
        expect(result, path).toContain('nothing was shown')
        expect(result, path).toMatch(message)
        expect(result, path).not.toContain(root)
        expect(result, path).not.toContain(other)
        expect(result, path).not.toContain('kind')
    }
})

it('returns an image card with the authenticated endpoint identity and byte size', async () => {
    await grant(alpha, true)
    const tool = await toolFor(alpha)
    const card = fileCardSchema.parse(JSON.parse(await show(tool, 'shots/photo.png')))
    expect(card.files[0]).toMatchObject({ path: 'shots/photo.png', name: 'photo.png', size: 1024, scope: 'agent' })
    expect(card.files[0]?.identity).toMatch(/^\d+:\d+$/)
    expect(await show(tool, join(workspaceDir(alpha), 'shots', 'photo.png'))).toContain('shots/photo.png')
})

it('returns an audio card with the authenticated endpoint identity and byte size', async () => {
    await grant(alpha, true)
    const tool = await toolFor(alpha)
    const card = fileCardSchema.parse(JSON.parse(await show(tool, 'voice/tone.wav')))
    expect(card.files[0]).toMatchObject({ path: 'voice/tone.wav', name: 'tone.wav', size: 1024, scope: 'agent' })
    expect(card.files[0]?.identity).toMatch(/^\d+:\d+$/)
    expect(await show(tool, join(workspaceDir(alpha), 'voice', 'tone.wav'))).toContain('voice/tone.wav')
    expect((await registry(alpha)).card_file!.description).toContain('16 MB per audio')
})

it('returns a PDF card with the authenticated endpoint identity and leaves it out of the media budget', async () => {
    await grant(alpha, true)
    const tool = await toolFor(alpha)
    const card = fileCardSchema.parse(JSON.parse(await show(tool, 'reports/deck.pdf')))
    expect(card.files[0]).toMatchObject({ path: 'reports/deck.pdf', name: 'deck.pdf', size: 1024, scope: 'agent' })
    expect(card.files[0]?.identity).toMatch(/^\d+:\d+$/)
    expect(JSON.stringify(card)).not.toContain('%PDF')
    expect(await show(tool, join(workspaceDir(alpha), 'reports', 'deck.pdf'))).toContain('reports/deck.pdf')
    const description = (await registry(alpha)).card_file!.description
    expect(description).toContain('16 MB per PDF')
    expect(description).toContain('document tiles')
    expect(description).toContain('does not read PDF content back to you')
    const mixed = fileCardSchema.parse(JSON.parse(String(await tool.execute!({ files: [
        { path: 'shots/eight-0.png' }, { path: 'shots/eight-1.png' }, { path: 'shots/eight-2.png' }, { path: 'reports/deck.pdf' },
    ] }, options))))
    expect(mixed.files.map(file => file.path)).toEqual(['shots/eight-0.png', 'shots/eight-1.png', 'shots/eight-2.png', 'reports/deck.pdf'])
    expect(mixed.files[3]?.identity).toMatch(/^\d+:\d+$/)
    const blocked = String(await tool.execute!({ files: [
        { path: 'reports/summary.md' }, { path: 'reports/missing.pdf' },
    ] }, options))
    expect(blocked).toContain('nothing was shown')
    expect(blocked).toContain('reports/missing.pdf')
    expect(blocked).not.toContain('kind')
})

it('returns an MP4 card with the authenticated endpoint identity, byte size and video wording', async () => {
    await grant(alpha, true)
    const tool = await toolFor(alpha)
    const card = fileCardSchema.parse(JSON.parse(await show(tool, 'shots/clip.mp4')))
    expect(card.files[0]).toMatchObject({ path: 'shots/clip.mp4', name: 'clip.mp4', size: 1024, scope: 'agent' })
    expect(card.files[0]?.identity).toMatch(/^\d+:\d+$/)
    expect(await show(tool, join(workspaceDir(alpha), 'shots', 'clip.mp4'))).toContain('shots/clip.mp4')
    expect((await registry(alpha)).card_file!.description).toContain('16 MB per video')
    expect((await registry(alpha)).card_file!.description).toContain('MP4')
})

it('keeps mixed text and image files in the order the model asked for', async () => {
    await grant(alpha, true)
    const tool = await toolFor(alpha)
    const result = String(await tool.execute!({ files: [
        { path: 'reports/summary.md' }, { path: 'shots/photo.png' }, { path: 'reports/notes.txt' },
    ] }, options))
    const card = fileCardSchema.parse(JSON.parse(result))
    expect(card.files.map(file => file.path)).toEqual(['reports/summary.md', 'shots/photo.png', 'reports/notes.txt'])
    expect(card.files[1]?.identity).toMatch(/^\d+:\d+$/)
})

it('keeps audio in a mixed card without charging it to the image-thumbnail budget', async () => {
    await grant(alpha, true)
    const tool = await toolFor(alpha)
    const result = String(await tool.execute!({ files: [
        { path: 'shots/eight-0.png' }, { path: 'shots/eight-1.png' }, { path: 'shots/eight-2.png' }, { path: 'voice/tone.wav' },
    ] }, options))
    const card = fileCardSchema.parse(JSON.parse(result))
    expect(card.files.map(file => file.path)).toEqual(['shots/eight-0.png', 'shots/eight-1.png', 'shots/eight-2.png', 'voice/tone.wav'])
    expect(card.files[3]?.identity).toMatch(/^\d+:\d+$/)
})

it('keeps an MP4 in a mixed card and charges it to the combined image and video budget', async () => {
    await grant(alpha, true)
    const tool = await toolFor(alpha)
    const card = fileCardSchema.parse(JSON.parse(String(await tool.execute!({ files: [
        { path: 'reports/summary.md' }, { path: 'shots/photo.png' }, { path: 'shots/clip.mp4' },
    ] }, options))))
    expect(card.files.map(file => file.path)).toEqual(['reports/summary.md', 'shots/photo.png', 'shots/clip.mp4'])
    expect(card.files[1]?.identity).toMatch(/^\d+:\d+$/)
    expect(card.files[2]?.identity).toMatch(/^\d+:\d+$/)
    const over = String(await tool.execute!({ files: [
        { path: 'shots/eight-0.png' }, { path: 'shots/eight-1.png' }, { path: 'shots/eight-2.png' }, { path: 'shots/one-byte.mp4' },
    ] }, options))
    expect(over).toContain('nothing was shown')
    expect(over).toContain('24 MB')
    expect(over).not.toContain('kind')
})

it('refuses images whose total exceeds the bounded card preview budget', async () => {
    await grant(alpha, true)
    const tool = await toolFor(alpha)
    const result = String(await tool.execute!({ files: [
        { path: 'shots/eight-0.png' }, { path: 'shots/eight-1.png' }, { path: 'shots/eight-2.png' }, { path: 'shots/one-byte.png' },
    ] }, options))
    expect(result).toContain('nothing was shown')
    expect(result).toContain('24 MB')
    expect(result).not.toContain('kind')
})

it('shows nothing when one file of a multi-file card is missing', async () => {
    await grant(alpha, true)
    const tool = await toolFor(alpha)
    const result = String(await tool.execute!({ files: [
        { path: 'reports/summary.md' }, { path: 'reports/missing.md' }, { path: 'reports/notes.txt' },
    ] }, options))
    expect(result).toContain('nothing was shown')
    expect(result).toContain('reports/missing.md')
    expect(result).not.toContain('summary.md:')
    expect(result).not.toContain('kind')
})

it('bounds the file count and accepts the JSON-string input the model sometimes sends', async () => {
    await grant(alpha, true)
    const tool = await toolFor(alpha)
    const schema = tool.inputSchema as { safeParse: (value: unknown) => { success: boolean } }
    const files = Array.from({ length: CARD_MAX_FILES }, (_, index) => ({ path: `reports/${index}.md` }))
    expect(schema.safeParse({ files }).success).toBe(true)
    expect(schema.safeParse({ files: [...files, { path: 'reports/too-many.md' }] }).success).toBe(false)
    expect(schema.safeParse({ files: JSON.stringify([{ path: 'reports/summary.md' }]) }).success).toBe(true)
})

it('rechecks the current grant and the coworker’s enabled state before drawing a cached card', async () => {
    await grant(alpha, true)
    const tool = await toolFor(alpha)
    await grant(alpha, false)
    await expect(tool.execute!({ files: [{ path: 'reports/summary.md' }] }, options)).rejects.toThrow(/turned off/)
    await grant(alpha, true)
    await app.request(`/agents/${alpha}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) })
    await expect(tool.execute!({ files: [{ path: 'reports/summary.md' }] }, options)).rejects.toThrow(/turned off/)
    await app.request(`/agents/${alpha}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }) })
})

it('stops a card run that was cancelled', async () => {
    await grant(alpha, true)
    const controller = new AbortController()
    const tool = await toolFor(alpha, controller.signal)
    controller.abort(new Error('Reply stopped'))
    await expect(tool.execute!({ files: [{ path: 'reports/summary.md' }] }, options)).rejects.toThrow(/Reply stopped/)
})

it('points ask_user at card_file only when the file-card grant is on', async () => {
    await grant(alpha, true)
    const response = await app.request(`/agents/${alpha}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tools: { desktopToolGrants: { askUser: true } } }) })
    expect(response.status).toBe(200)
    const tools = await registry(alpha)
    expect(tools.card_file).toBeDefined()
    expect(tools.ask_user?.description).toContain('card_file')
})

it('accepts an absolute path only when it resolves inside the granted workspace', async () => {
    await grant(alpha, true)
    const tool = await toolFor(alpha)
    const inside = join(workspaceDir(alpha), 'reports', 'summary.md')
    const shown = fileCardSchema.parse(JSON.parse(await show(tool, inside)))
    expect(shown.files[0]).toEqual({ path: 'reports/summary.md', name: 'summary.md', size: 7, scope: 'agent' })
    const foreign = await show(tool, join(workspaceDir(bravo), 'reports', 'summary.md'))
    expect(foreign).toContain('nothing was shown')
    expect(foreign).toMatch(/relative .* path/)
})


it.each(['m4a', 'ogg', 'flac'])('delivers persistent %s audio with identity and rejects a mixed card when one entry exceeds the audio bound', async ext => {
    await grant(alpha, true)
    const tool = await toolFor(alpha)
    const path = `voice/tone.${ext}`
    const card = fileCardSchema.parse(JSON.parse(await show(tool, path)))
    expect(card.files).toEqual([{ path, name: `tone.${ext}`, size: 1024, scope: 'agent', identity: expect.stringMatching(/^\d+:\d+$/) }])
    await truncate(join(workspaceDir(alpha), path), CARD_MAX_AUDIO_BYTES)
    expect(fileCardSchema.parse(JSON.parse(await show(tool, path))).files[0]!.size).toBe(CARD_MAX_AUDIO_BYTES)
    await truncate(join(workspaceDir(alpha), path), CARD_MAX_AUDIO_BYTES + 1)
    const rejected = String(await tool.execute!({ files: [{ path: 'reports/notes.txt' }, { path }] }, options))
    expect(rejected).toContain('16 MB')
    expect(rejected).not.toContain('"kind":"file"')
    await truncate(join(workspaceDir(alpha), path), 0)
    expect(await show(tool, path)).toContain('empty')
    await writeFile(join(workspaceDir(alpha), path), Buffer.alloc(1024, 7))
    await grant(alpha, false)
    await expect(show(tool, path)).rejects.toThrow()
})
