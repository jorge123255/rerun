// Authored for the integration owner. This lane does not run it.
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FilesImportError } from './errors.js'
import { publishFilesImport } from './publish.js'

const roots: string[] = []

afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function parentDir(): Promise<string> {
    // tmpdir() is /var/folders on this Mac, and /var is a symlink. Publication requires a canonical root.
    const parent = await mkdtemp(join(await realpath(tmpdir()), 'rerun-files-import-ui03-'))
    roots.push(parent)
    return parent
}

async function workspace(): Promise<string> {
    const parent = await parentDir()
    const root = join(parent, 'workspace')
    await mkdir(root)
    return root
}

const signal = () => new AbortController().signal
const body = (...values: number[]) => Uint8Array.from(values)

describe('coworker Files import publication', () => {
    it('publishes nested bytes once and leaves no staging name', async () => {
        const root = await workspace()
        const seen: number[] = []
        const result = await publishFilesImport(root, 'docs/sub/a.txt', body(0, 1, 255), signal(), loaded => seen.push(loaded))
        expect(result).toEqual({ saved: true, path: 'docs/sub/a.txt', bytes: 3 })
        expect([...(await readFile(join(root, 'docs/sub/a.txt')))]).toEqual([0, 1, 255])
        expect((await stat(join(root, 'docs/sub/a.txt'))).mode & 0o111).toBe(0)
        expect((await readdir(join(root, 'docs/sub'))).filter(name => name.startsWith('.rerun'))).toEqual([])
        expect(seen).toEqual([0, 3])
    })

    it('creates a missing workspace and not its parent', async () => {
        const parent = await parentDir()
        const root = join(parent, 'workspace')
        const result = await publishFilesImport(root, '.gitignore', body(9), signal())
        expect(result.saved).toBe(true)
        expect(await readFile(join(root, '.gitignore'))).toEqual(Buffer.from([9]))
        await expect(publishFilesImport(join(parent, 'missing', 'workspace'), 'a.txt', body(1), signal())).rejects.toMatchObject({ code: 'outside' })
        expect(await readdir(parent)).toEqual(['workspace'])
    })

    it('keeps an existing name, including a symlink', async () => {
        const root = await workspace()
        await writeFile(join(root, 'notes.txt'), 'keep')
        await expect(publishFilesImport(root, 'notes.txt', body(1), signal())).rejects.toMatchObject({ code: 'clash' })
        expect(await readFile(join(root, 'notes.txt'), 'utf8')).toBe('keep')
        await symlink(join(root, 'notes.txt'), join(root, 'alias.txt'))
        await expect(publishFilesImport(root, 'alias.txt', body(2), signal())).rejects.toMatchObject({ code: 'clash' })
        expect(await readFile(join(root, 'notes.txt'), 'utf8')).toBe('keep')
    })

    it('does not follow a directory symlink out of the workspace', async () => {
        const parent = await parentDir()
        const root = join(parent, 'workspace')
        await mkdir(root)
        await writeFile(join(parent, 'outside.txt'), 'keep')
        await symlink(parent, join(root, 'linked'))
        await expect(publishFilesImport(root, 'linked/a.txt', body(1), signal())).rejects.toMatchObject({ code: 'outside' })
        expect(await readFile(join(parent, 'outside.txt'), 'utf8')).toBe('keep')
        await expect(lstat(join(parent, 'a.txt'))).rejects.toThrow()
    })

    it('refuses an unsafe path before creating a directory', async () => {
        const root = await workspace()
        for (const path of ['../escape.bin', '.rerun/secret.txt', 'internal.rerun-lock/a.txt', 'payload.exe', 'Foo.app/MacOS/bin']) {
            await expect(publishFilesImport(root, path, body(1), signal())).rejects.toBeInstanceOf(FilesImportError)
        }
        expect(await readdir(root)).toEqual([])
    })

    it('writes nothing when the import is already cancelled', async () => {
        const root = await workspace()
        const controller = new AbortController()
        controller.abort()
        await expect(publishFilesImport(root, 'a.txt', body(1), controller.signal)).rejects.toMatchObject({ code: 'aborted', kind: 'aborted' })
        await expect(lstat(join(root, 'a.txt'))).rejects.toThrow()
    })
})
