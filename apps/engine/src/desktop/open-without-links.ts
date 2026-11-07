import { constants } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'

// Open the original relative path without following links in any component. O_NONBLOCK
// lets us reject a FIFO using fstat without waiting for a writer.
export async function openWithoutLinks(path: string, directory = false): Promise<FileHandle> {
    const flags = constants.O_RDONLY | constants.O_NONBLOCK | (directory ? constants.O_DIRECTORY : 0)
    if (process.platform === 'darwin') return open(path, flags | 0x20000000) // O_NOFOLLOW_ANY
    if (process.platform !== 'linux') throw new Error('Unsupported filesystem')
    let dir = await open('/', constants.O_RDONLY | constants.O_DIRECTORY)
    try {
        const parts = path.split('/').filter(Boolean)
        for (const [index, part] of parts.entries()) {
            const next = await open(`/proc/self/fd/${dir.fd}/${part}`, constants.O_NOFOLLOW |
                (index === parts.length - 1 ? flags : constants.O_RDONLY | constants.O_DIRECTORY))
            await dir.close()
            dir = next
        }
        return dir
    } catch (error) {
        await dir.close()
        throw error
    }
}

export async function readBoundedFileWithoutLinks(path: string, maxBytes: number): Promise<Buffer> {
    const file = await openWithoutLinks(path)
    try {
        const initial = await file.stat({ bigint: true })
        if (!initial.isFile() || initial.nlink !== 1n || initial.size > maxBytes) throw new Error('Unsafe file')
        const bytes = Buffer.alloc(Number(initial.size) + 1)
        let length = 0
        while (length < bytes.length) {
            const { bytesRead } = await file.read(bytes, length, bytes.length - length, null)
            if (!bytesRead) break
            length += bytesRead
        }
        const current = await openWithoutLinks(path)
        try {
            const info = await current.stat({ bigint: true })
            if (info.dev !== initial.dev || info.ino !== initial.ino || info.nlink !== 1n
                || info.size !== initial.size || info.ctimeNs !== initial.ctimeNs || BigInt(length) !== initial.size) {
                throw new Error('File changed during read')
            }
        } finally { await current.close() }
        return bytes.subarray(0, length)
    } finally { await file.close() }
}
