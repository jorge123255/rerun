import { createWriteStream, type BigIntStats } from 'node:fs'
import { lstat, mkdir, readFile, realpath, rename, writeFile, type FileHandle } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { agentDuplicateResultSchema, type AgentDuplicateResult } from '@rerun/contracts'
import { agentDir, dataDir } from '../config/paths.js'
import { badRequest } from '../lib/errors.js'
import { openWithoutLinks } from './open-without-links.js'

const receiptFile = '.desktop-duplicate.json'
type Receipt = { sourceId: string; result?: AgentDuplicateResult }

// The randomly chosen request ID owns one engine directory across retries. The marker
// arrives with the first atomic rename, so crash recovery only touches our own copy.
export async function readCopyReceipt(id: string, sourceId: string): Promise<Receipt | null> {
    const folder = agentDir(id)
    const stat = await lstat(folder).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
    })
    if (!stat) return null
    if (!stat.isDirectory()) throw badRequest('This duplicate ID is already in use')
    const receipt: Receipt = JSON.parse(await readFile(join(folder, receiptFile), 'utf8'))
    if (receipt.sourceId !== sourceId) throw badRequest('This duplicate ID is already in use')
    if (receipt.result) {
        receipt.result = agentDuplicateResultSchema.parse(receipt.result)
        if (receipt.result.id !== id) throw badRequest('Invalid duplicate receipt')
    }
    return receipt
}

export async function writeCopyReceipt(folder: string, sourceId: string, result?: AgentDuplicateResult): Promise<void> {
    const target = join(folder, receiptFile)
    await writeFile(target + '.tmp', JSON.stringify({ sourceId, result }), { mode: 0o600 })
    await rename(target + '.tmp', target)
}

// A private tables database and its live SQLite journal have to describe the same
// instant. Copy their bound regular files together, then recheck them all, including
// journal absence. The source is never checkpointed or opened for writing.
const database = 'data/agent.db'

async function openCopyFile(path: string, optional: boolean): Promise<FileHandle | null> {
    try {
        return await openWithoutLinks(path)
    } catch (error) {
        if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw badRequest('A coworker file cannot be safely copied')
    }
}

async function copyGroup(source: string, destination: string, files: string[]) {
    const inputs: { path: string; handle: FileHandle | null; before: BigIntStats | null }[] = []
    try {
        for (const [index, path] of files.entries()) {
            const handle = await openCopyFile(join(source, path), index !== 0)
            const file = { path, handle, before: null as BigIntStats | null }
            inputs.push(file)
            if (!handle) continue
            file.before = await handle.stat({ bigint: true })
            if (!file.before.isFile() || file.before.nlink !== 1n) throw badRequest('A coworker file cannot be safely copied')
        }
        for (const { path, handle, before } of inputs) {
            if (!handle || !before) continue
            const target = join(destination, path)
            await mkdir(dirname(target), { recursive: true, mode: 0o700 })
            await pipeline(handle.createReadStream(), createWriteStream(target, { flags: 'wx', mode: Number(before.mode & 0o777n) }))
        }
        for (const { path, before } of inputs) {
            const current = await openCopyFile(join(source, path), true)
            try {
                const after = await current?.stat({ bigint: true })
                if (!before && !after) continue
                if (!after || !before || after.dev !== before.dev || after.ino !== before.ino || after.nlink !== 1n || after.size !== before.size || after.ctimeNs !== before.ctimeNs)
                    throw badRequest('A coworker file changed during duplication. Try again.')
            } finally { await current?.close() }
        }
    } finally { await Promise.all(inputs.map(file => file.handle?.close())) }
}

export async function copyDesktopFiles(sourceId: string, paths: Iterable<string>, destination: string): Promise<void> {
    const source = resolve(await realpath(dataDir()), 'agents', sourceId)
    for (const path of paths) {
        const group = path === database ? [path, path + '-wal', path + '-journal'] : [path]
        await copyGroup(source, destination, group)
    }
}
