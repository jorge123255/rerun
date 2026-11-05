import { mkdtempSync } from 'node:fs'
import { link, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { TEXT_FILE_PAGE_CHARS } from '@rerun/contracts'
import { prepareSkillHelperFixture } from './skill-publication.test-support.js'

const created = mkdtempSync(join(tmpdir(), 'rerun-shared-files-'))
let app = created
let engine = ''
let shared = ''
let helper: Awaited<ReturnType<typeof prepareSkillHelperFixture>>
const priorHelper = process.env.RERUN_DESKTOP_RENAME_HELPER

const { importSharedText, listSharedDirectory, readSharedText, resolveDesktopSharedDirectory, resolveEngineSharedDirectory } = await import('./shared-workspace-files.js')

beforeAll(async () => {
    helper = await prepareSkillHelperFixture()
    process.env.RERUN_DESKTOP_RENAME_HELPER = helper.path
    app = await realpath(created)
    engine = join(app, 'workspaces', '1', 'engine')
    await mkdir(engine, { recursive: true })
    shared = join(engine, 'shared')
})

afterAll(async () => {
    if (priorHelper === undefined) delete process.env.RERUN_DESKTOP_RENAME_HELPER; else process.env.RERUN_DESKTOP_RENAME_HELPER = priorHelper
    await helper?.close()
    await rm(created, { recursive: true, force: true })
})

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

it('acknowledges imports that change the root and nested directory entries, leaving one durable file link', async () => {
    for (const folder of ['', 'new/deep/folder']) {
        const result = await importSharedText(shared, folder, 'atomic.txt', new TextEncoder().encode('durable'))
        expect(await readFile(join(shared, result.path), 'utf8')).toBe('durable')
        expect((await lstat(join(shared, result.path))).nlink).toBe(1)
        expect((await readdir(join(shared, folder))).filter(name => name.startsWith('.rerun-shared-import-'))).toEqual([])
    }
})

it('preserves a readable single-link document when the response is lost after publication', async () => {
    const name = 'lost-response.txt'
    await expect(importSharedText(shared, '', name, new TextEncoder().encode('accepted once'), {
        beforeCommit: async () => {
            if (await lstat(join(shared, name)).catch(() => null)) throw new Error('simulated response loss')
        },
    })).rejects.toThrow('simulated response loss')
    vi.resetModules()
    const restarted = await import('./shared-workspace-files.js')
    expect((await restarted.readSharedText(shared, name)).content).toBe('accepted once')
    expect((await lstat(join(shared, name))).nlink).toBe(1)
    await expect(restarted.importSharedText(shared, '', name, new TextEncoder().encode('replacement'))).rejects.toThrow('existing file was kept')
    expect(await readFile(join(shared, name), 'utf8')).toBe('accepted once')
})

it('keeps a foreign destination that arrives after staging and does not blindly remove an uncertain source', async () => {
    const folder = 'arrival'
    await mkdir(join(shared, folder))
    await expect(importSharedText(shared, folder, 'same.txt', new TextEncoder().encode('ours'), {
        beforeCommit: async () => {
            if ((await readdir(join(shared, folder))).some(name => name.startsWith('.rerun-shared-import-'))) {
                await writeFile(join(shared, folder, 'same.txt'), 'theirs', { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error })
            }
        },
    })).rejects.toThrow('existing file was kept')
    expect(await readFile(join(shared, folder, 'same.txt'), 'utf8')).toBe('theirs')
    const retained = (await readdir(join(shared, folder))).filter(name => name.startsWith('.rerun-shared-import-'))
    expect(retained).toHaveLength(1)
    expect(await readFile(join(shared, folder, retained[0]!), 'utf8')).toBe('ours')
    expect((await lstat(join(shared, folder, retained[0]!))).nlink).toBe(1)
})

it('refuses publication when a pinned parent has moved out of shared files', async () => {
    const folder = 'relocated', moved = join(app, 'relocated-outside')
    await mkdir(join(shared, folder))
    let didMove = false
    await expect(importSharedText(shared, folder, 'new.txt', new TextEncoder().encode('do not publish'), {
        beforeCommit: async () => {
            if (!didMove && (await readdir(join(shared, folder))).some(name => name.startsWith('.rerun-shared-import-'))) {
                didMove = true
                await rename(join(shared, folder), moved)
                await mkdir(join(shared, folder))
            }
        },
    })).rejects.toThrow('outside the shared folder')
    expect(didMove).toBe(true)
    expect(await readdir(moved)).toEqual([])
    expect(await readdir(join(shared, folder))).toEqual([])
})

it.each([1, 2, 3])('decodes a valid prefix whose byte window ends %i bytes into a UTF-8 character', async prefix => {
    const content = `${'a'.repeat(prefix)}${'😀'.repeat(TEXT_FILE_PAGE_CHARS + 2)}`
    const name = `utf8-${prefix}.txt`
    await writeFile(join(shared, name), content)
    const first = await readSharedText(shared, name)
    expect(first.content).toBe(content.slice(0, TEXT_FILE_PAGE_CHARS))
    expect(first.nextOffset).toBe(TEXT_FILE_PAGE_CHARS)
    const second = await readSharedText(shared, name, TEXT_FILE_PAGE_CHARS)
    expect(first.content + second.content).toBe(content.slice(0, 2 * TEXT_FILE_PAGE_CHARS))
})
