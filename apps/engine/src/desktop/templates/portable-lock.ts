import { constants } from 'node:fs'
import { lstat, open, readdir, rmdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { acquireSkillLease } from '../skill-publication-native.js'
import { ensurePrivateDir, pinDirectory } from './files.js'
import { TemplateRequestError } from './errors.js'

const libraryQueues = new Map<string, Promise<unknown>>()
export function withPortableLibraryLease<T>(dataRoot: string, work: () => Promise<T>): Promise<T> {
    const previous = libraryQueues.get(dataRoot) ?? Promise.resolve()
    const next = previous.then(() => underLibraryLease(dataRoot, work), () => underLibraryLease(dataRoot, work))
    const settled = next.then(() => undefined, () => undefined)
    libraryQueues.set(dataRoot, settled)
    void settled.then(() => { if (libraryQueues.get(dataRoot) === settled) libraryQueues.delete(dataRoot) })
    return next
}

async function underLibraryLease<T>(dataRoot: string, work: () => Promise<T>): Promise<T> {
    const directory = join(dataRoot, 'desktop-templates')
    await ensurePrivateDir(directory)
    const pin = await pinDirectory(directory)
    try {
        const identity = await stat(pin.pinned, { bigint: true })
        const lease = await acquireSkillLease(directory, identity)
        try {
            lease.assertCurrent()
            const result = await work()
            lease.assertCurrent()
            return result
        } finally { await lease.release() }
    } finally { await pin.close() }
}

type Identity = { dev: string; ino: string }
const same = (info: { dev: bigint; ino: bigint }, expected: Identity) => String(info.dev) === expected.dev && String(info.ino) === expected.ino
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'

export async function removePortableQuarantinedDirectory(parent: string, name: string, expected: Identity): Promise<void> {
    const pin = await pinDirectory(parent)
    try {
        const remove = async (parentPinned: string, entry: string, identity: Identity, depth: number): Promise<void> => {
            if (depth > 512) throw new TemplateRequestError(409, 'Template cleanup exceeds its path bound')
            const path = join(parentPinned, entry)
            const before = await lstat(path, { bigint: true }).catch(error => { if (missing(error)) return null; throw error })
            if (!before) return
            if (!before.isDirectory() || before.isSymbolicLink() || !same(before, identity)) throw new TemplateRequestError(409, 'Template cleanup target changed')
            const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
            try {
                const opened = await handle.stat({ bigint: true })
                if (!same(opened, identity)) throw new TemplateRequestError(409, 'Template cleanup target changed')
                const pinned = process.platform === 'darwin' ? `/.vol/${opened.dev}/${opened.ino}` : `/proc/self/fd/${handle.fd}`
                for (const child of await readdir(pinned)) {
                    const childPath = join(pinned, child)
                    const info = await lstat(childPath, { bigint: true })
                    if (typeof process.getuid === 'function' && info.uid !== BigInt(process.getuid())) throw new TemplateRequestError(409, 'Template cleanup contains an unowned entry')
                    if (info.isDirectory() && !info.isSymbolicLink()) await remove(pinned, child, { dev: String(info.dev), ino: String(info.ino) }, depth + 1)
                    else await unlink(childPath)
                }
            } finally { await handle.close() }
            const current = await lstat(path, { bigint: true })
            if (!same(current, identity)) throw new TemplateRequestError(409, 'Template cleanup target changed')
            await rmdir(path)
        }
        await remove(pin.pinned, name, expected, 0)
    } finally { await pin.close() }
}
