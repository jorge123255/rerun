import { mkdtempSync } from 'node:fs'
import { link, mkdir, open, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { TEXT_FILE_PAGE_CHARS } from '@rerun/contracts'

const created = mkdtempSync(join(tmpdir(), 'rerun-shared-files-'))
let app = created
let engine = ''
let shared = ''

const { importSharedText, listSharedDirectory, readSharedText, resolveDesktopSharedDirectory, resolveEngineSharedDirectory } = await import('./shared-workspace-files.js')

beforeAll(async () => {
    app = await realpath(created)
    engine = join(app, 'workspaces', '1', 'engine')
    await mkdir(engine, { recursive: true })
    shared = join(engine, 'shared')
})

afterAll(async () => { await rm(created, { recursive: true, force: true }) })

it('resolves the desktop data root and the engine data directory to the same shared folder', async () => {
    expect(await resolveDesktopSharedDirectory(app)).toBe(shared)
    expect(await resolveEngineSharedDirectory(engine)).toBe(shared)
    await expect(resolveDesktopSharedDirectory(engine)).rejects.toThrow('not ready')
})

it('lets two readers see one create-only import and keeps a private file out of that folder', async () => {
    const bytes = new TextEncoder().encode('from both')
    const imported = await importSharedText(shared, 'handoff', 'note.txt', bytes)
    expect(imported).toEqual({ path: 'handoff/note.txt', name: 'note.txt' })
    const first = await readSharedText(shared, 'handoff/note.txt')
    const second = await readSharedText(shared, 'handoff/note.txt', 0)
    expect(first.content).toBe('from both')
    expect(second).toMatchObject({ content: 'from both', truncated: false, offset: 0, nextOffset: null })
    await expect(importSharedText(shared, 'handoff', 'note.txt', new TextEncoder().encode('replaced'))).rejects.toThrow('existing file was kept')
    expect((await readSharedText(shared, 'handoff/note.txt')).content).toBe('from both')

    const listing = await listSharedDirectory(shared, 'handoff')
    expect(listing.entries.map(entry => entry.name)).toEqual(['note.txt'])
    const privateDir = join(engine, 'agents', 'alice', 'workspace')
    await mkdir(privateDir, { recursive: true })
    await writeFile(join(privateDir, 'secret.txt'), 'private-only')
    expect((await listSharedDirectory(shared, '.')).entries.some(entry => entry.name === 'secret.txt')).toBe(false)
    await expect(readSharedText(shared, '../agents/alice/workspace/secret.txt')).rejects.toThrow('outside the shared folder')
    expect(await (await import('node:fs/promises')).readFile(join(privateDir, 'secret.txt'), 'utf8')).toBe('private-only')
})

it('refuses symlinks, extra links, hidden names, non-text, and a root that is not the shared directory', async () => {
    await writeFile(join(app, 'outside.txt'), 'secret')
    await symlink(join(shared, 'handoff'), join(shared, 'jump'))
    await link(join(app, 'outside.txt'), join(shared, 'alias.txt'))
    await writeFile(join(shared, '.hidden.txt'), 'hidden')
    await expect(readSharedText(shared, 'jump/note.txt')).rejects.toThrow('outside the shared folder')
    await expect(readSharedText(shared, 'alias.txt')).rejects.toThrow('linked elsewhere')
    await expect(listSharedDirectory(shared, 'jump')).rejects.toThrow('outside the shared folder')
    expect((await listSharedDirectory(shared, '.')).entries.map(entry => entry.name)).not.toContain('.hidden.txt')
    await expect(importSharedText(shared, '', 'pic.png', new TextEncoder().encode('x'))).rejects.toThrow('Only .txt and .md')
    await expect(importSharedText(shared, '', 'bad.txt', Uint8Array.from([97, 0, 98]))).rejects.toThrow('Only text files')
    await expect(importSharedText(join(engine, 'agents'), '', 'note.txt', new TextEncoder().encode('x'))).rejects.toThrow('outside the shared folder')
    await expect(readSharedText(shared, 'handoff/note.txt', 0, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' })
})

it('returns one character page and the following page without reading past the requested window', async () => {
    const tail = 'TAIL!'
    await writeFile(join(shared, 'long.txt'), `${'a'.repeat(TEXT_FILE_PAGE_CHARS)}${tail}`)
    const page = await readSharedText(shared, 'long.txt')
    expect(page.truncated).toBe(true)
    expect(page.content).toHaveLength(TEXT_FILE_PAGE_CHARS)
    expect(page.content.includes(tail)).toBe(false)
    expect(page.nextOffset).toBe(TEXT_FILE_PAGE_CHARS)
    const rest = await readSharedText(shared, 'long.txt', TEXT_FILE_PAGE_CHARS)
    expect(rest.content).toBe(tail)
    expect(rest.truncated).toBe(false)
    await expect(readSharedText(shared, 'long.txt', 3_000_000)).rejects.toThrow('too large')
})

it('refuses a file whose bytes change while the pinned descriptor is open', async () => {
    const target = join(shared, 'moving.txt')
    await writeFile(target, 'stable')
    const probe = await open(target)
    const prototype = Object.getPrototypeOf(probe)
    await probe.close()
    const original = prototype.read
    const intercept = vi.spyOn(prototype, 'read').mockImplementationOnce(async function (this: typeof probe, ...args: unknown[]) {
        await writeFile(target, 'stable-and-then-some')
        return original.apply(this, args)
    })
    try { await expect(readSharedText(shared, 'moving.txt')).rejects.toThrow('changed while it was being read') }
    finally { intercept.mockRestore() }
})

it('refuses a linked engine directory instead of following it', async () => {
    const moved = `${engine}-real`
    const { rename } = await import('node:fs/promises')
    await rename(engine, moved)
    try {
        await symlink(moved, engine)
        await expect(resolveDesktopSharedDirectory(app)).rejects.toThrow('outside the shared folder')
    } finally {
        const { unlink } = await import('node:fs/promises')
        await unlink(engine)
        await rename(moved, engine)
    }
})
