import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { desktopDownloadTools } from './tool.js'
import { executeDownload } from './download.js'
import { DownloadPermissionError } from './errors.js'
import type { PublicBinaryRead, PublicBinaryReader } from './types.js'

const { afterStagingSync } = vi.hoisted(() => ({ afterStagingSync: vi.fn<() => Promise<void>>() }))
vi.mock('node:fs/promises', async importOriginal => {
    const fs = await importOriginal<typeof import('node:fs/promises')>()
    const open: typeof fs.open = async (...args) => {
        const handle = await fs.open(...args)
        if (typeof args[0] === 'string' && args[0].includes('/.rerun-download-')) {
            const sync = handle.sync.bind(handle)
            handle.sync = async () => { await sync(); await afterStagingSync() }
        }
        return handle
    }
    return { ...fs, open }
})

const roots: string[] = []
afterEach(async () => {
    vi.restoreAllMocks()
    afterStagingSync.mockReset()
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function workspace(): Promise<string> {
    // tmpdir() is /var/folders, a symlink. Publication refuses a non-canonical root.
    const parent = await mkdtemp(join(await realpath(tmpdir()), 'rerun-download-up04-'))
    roots.push(parent)
    const root = join(parent, 'workspace')
    await mkdir(root)
    return root
}

function body(bytes: number[], status = 200, contentType: string | null = 'application/octet-stream', finalUrl = 'https://example.com/a.bin'): PublicBinaryRead {
    return { status, finalUrl, contentType, bytes: Uint8Array.from(bytes) }
}

function reader(result: PublicBinaryRead | (() => Promise<PublicBinaryRead>)): PublicBinaryReader {
    return vi.fn(async () => typeof result === 'function' ? result() : result)
}

const allow = async () => {}
const signal = () => new AbortController().signal

async function run(root: string, path: string, read: PublicBinaryReader, url = 'https://example.com/a.bin', runSignal = signal()) {
    return executeDownload({ url, path }, { signal: runSignal, workspaceRoot: root, read, assertPermission: allow })
}

describe('public binary download', () => {
    it('publishes the original bytes once and reports only the relative path', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch')
        const root = await workspace()
        const read = reader(body([0, 1, 2, 255]))
        const result = await run(root, 'assets/raw/a.bin', read)
        expect(result).toEqual({ text: 'Downloaded 4 bytes to assets/raw/a.bin', failed: false, saved: true })
        expect([...(await readFile(join(root, 'assets/raw/a.bin')))]).toEqual([0, 1, 2, 255])
        expect((await stat(join(root, 'assets/raw/a.bin'))).mode & 0o111).toBe(0)
        expect(read).toHaveBeenCalledTimes(1)
        expect(fetchSpy).not.toHaveBeenCalled()
        expect((await readdir(join(root, 'assets/raw'))).filter(name => name.startsWith('.rerun'))).toEqual([])
    })

    it('keeps an ordinary hidden file', async () => {
        const root = await workspace()
        const result = await run(root, '.cache/notes.bin', reader(body([9], 200, 'application/octet-stream', 'https://example.com/a.bin')))
        expect(result.saved).toBe(true)
        expect(await readFile(join(root, '.cache/notes.bin'))).toEqual(Buffer.from([9]))
    })

    it('does not write a missing file or retry', async () => {
        const root = await workspace()
        const read = reader(body([1], 404, 'text/plain'))
        expect(await run(root, 'a.bin', read)).toEqual({ text: 'Download failed: [404] https://example.com/a.bin', failed: false, saved: false })
        await expect(lstat(join(root, 'a.bin'))).rejects.toThrow()
        expect(read).toHaveBeenCalledTimes(1)
    })

    it('does not write a server failure', async () => {
        const root = await workspace()
        const result = await run(root, 'a.bin', reader(body([1], 503, 'text/plain')))
        expect(result.saved).toBe(false)
        expect(result.failed).toBe(true)
        expect(result.text).toBe('Download failed: [503] https://example.com/a.bin')
        expect(result.text).not.toContain('attempt')
        await expect(lstat(join(root, 'a.bin'))).rejects.toThrow()
    })

    it('refuses an oversize body without writing it', async () => {
        const root = await workspace()
        const bytes = new Uint8Array(50_000_001)
        const read = reader({ status: 200, finalUrl: 'https://example.com/a.bin', contentType: 'application/octet-stream', bytes })
        expect(await run(root, 'huge.bin', read)).toEqual({ text: 'Download too large (50000001 bytes, limit 50MB)', failed: false, saved: false })
        await expect(lstat(join(root, 'huge.bin'))).rejects.toThrow()
    })

    it('does not fetch a private, credentialed, or non-http URL', async () => {
        const root = await workspace()
        const read = reader(body([1]))
        for (const url of ['file:///etc/passwd', 'http://localhost/a.bin', 'http://127.0.0.1/a.bin', 'https://example.com:8443/a.bin', 'https://user:pass@example.com/a.bin', 'http://printer.local/a.bin']) {
            await expect(run(root, 'a.bin', read, url)).rejects.toThrow()
        }
        expect(read).not.toHaveBeenCalled()
        await expect(lstat(join(root, 'a.bin'))).rejects.toThrow()
    })

    it('refuses an escaping, reserved, or executable path before reading', async () => {
        const root = await workspace()
        const read = reader(body([1]))
        await expect(run(root, '../escape.bin', read)).rejects.toThrow('Path escapes the root')
        await expect(run(root, '.rerun/pages/a.bin', read)).rejects.toThrow('reserved')
        await expect(run(root, 'skills/.rerun-skill-pack/a.bin', read)).rejects.toThrow('reserved')
        await expect(run(root, 'payload.exe', read)).rejects.toThrow('can’t be downloaded')
        await expect(run(root, 'Foo.app/MacOS/bin', read)).rejects.toThrow('can’t be downloaded')
        expect(read).not.toHaveBeenCalled()
    })

    it('discards an executable content type without publishing', async () => {
        const root = await workspace()
        const read = reader(body([1, 2], 200, 'application/x-msdownload'))
        const result = await run(root, 'notes.bin', read)
        expect(result).toMatchObject({ saved: false, failed: true, text: 'That file type can’t be downloaded.' })
        await expect(lstat(join(root, 'notes.bin'))).rejects.toThrow()
    })

    it('discards a private final URL without publishing', async () => {
        const root = await workspace()
        const result = await run(root, 'a.bin', reader(body([1], 200, 'application/octet-stream', 'http://127.0.0.1/secret.bin')))
        expect(result.saved).toBe(false)
        expect(result.failed).toBe(true)
        await expect(lstat(join(root, 'a.bin'))).rejects.toThrow()
    })

    it('keeps an existing file', async () => {
        const root = await workspace()
        await writeFile(join(root, 'a.bin'), Buffer.from([7, 7]))
        const result = await run(root, 'a.bin', reader(body([1, 2, 3])))
        expect(result.saved).toBe(false)
        expect(result.failed).toBe(true)
        expect(result.text).toContain('existing file was kept')
        expect([...(await readFile(join(root, 'a.bin')))]).toEqual([7, 7])
    })

    it('does not follow a directory alias', async () => {
        const parent = await mkdtemp(join(await realpath(tmpdir()), 'rerun-download-up04-'))
        roots.push(parent)
        const root = join(parent, 'workspace')
        const elsewhere = join(parent, 'elsewhere')
        await mkdir(root)
        await mkdir(elsewhere)
        await symlink(elsewhere, join(root, 'alias'))
        const result = await run(root, 'alias/a.bin', reader(body([1, 2, 3, 4])))
        expect(result.saved).toBe(false)
        expect(result.text).toContain('outside')
        await expect(lstat(join(elsewhere, 'a.bin'))).rejects.toThrow()
    })

    it('rethrows cancellation and does not publish or retry', async () => {
        const root = await workspace()
        const controller = new AbortController()
        controller.abort(new Error('aborted'))
        const read = reader(body([1]))
        await expect(run(root, 'a.bin', read, 'https://example.com/a.bin', controller.signal)).rejects.toThrow('aborted')
        expect(read).not.toHaveBeenCalled()
        const during = new AbortController()
        const once = vi.fn(async () => {
            during.abort(new Error('aborted'))
            throw new Error('aborted')
        })
        await expect(run(root, 'a.bin', once, 'https://example.com/a.bin', during.signal)).rejects.toThrow('aborted')
        expect(once).toHaveBeenCalledTimes(1)
        await expect(lstat(join(root, 'a.bin'))).rejects.toThrow()
    })

    it('returns one network failure and does not retry', async () => {
        const root = await workspace()
        const read = vi.fn(async () => { throw new Error('getaddrinfo ENOTFOUND example.com') })
        const result = await run(root, 'a.bin', read)
        expect(result).toEqual({ text: 'Download failed: getaddrinfo ENOTFOUND example.com (https://example.com/a.bin)', failed: true, saved: false })
        expect(read).toHaveBeenCalledTimes(1)
        await expect(lstat(join(root, 'a.bin'))).rejects.toThrow()
    })

    it('rethrows a missing permission and writes nothing', async () => {
        const root = await workspace()
        const read = reader(body([1]))
        await expect(executeDownload({ url: 'https://example.com/a.bin', path: 'a.bin' }, {
            signal: signal(), workspaceRoot: root, read, assertPermission: async () => { throw new DownloadPermissionError('This tool is turned off for this coworker.') },
        })).rejects.toThrow('turned off')
        expect(read).not.toHaveBeenCalled()
    })

    it('refuses publication when permission is revoked while bytes are staged', async () => {
        const root = await workspace()
        let granted = true
        afterStagingSync.mockImplementationOnce(async () => { granted = false })
        await expect(executeDownload({ url: 'https://example.com/a.bin', path: 'assets/a.bin' }, {
            signal: signal(), workspaceRoot: root, read: reader(body([1])),
            assertPermission: async () => {
                if (!granted) throw new DownloadPermissionError('This tool is turned off for this coworker.')
            },
        })).rejects.toThrow('turned off')
        expect(afterStagingSync).toHaveBeenCalledOnce()
        await expect(lstat(join(root, 'assets'))).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('refuses to publish into a directory moved outside the workspace during staging', async () => {
        const root = await workspace()
        const parent = join(root, 'assets')
        const moved = join(root, '..', 'moved-assets')
        await mkdir(parent)
        afterStagingSync.mockImplementationOnce(async () => {
            await rename(parent, moved)
            await mkdir(parent)
        })
        const result = await run(root, 'assets/a.bin', reader(body([1])))
        expect(afterStagingSync).toHaveBeenCalledOnce()
        expect(result).toMatchObject({ saved: false, failed: true })
        expect(await readdir(moved)).toEqual([])
        expect(await readdir(parent)).toEqual([])
    })

    it('stays unavailable until root binds download permission', () => {
        expect(desktopDownloadTools({ agent: { id: 'coworker' } } as never)).toEqual({})
    })
})
