import 'server-only'
import { constants, type BigIntStats } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { lstat, mkdir, open, realpath, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import type { Client } from '@libsql/client'
import { openWithoutLinks } from '../../../../../engine/src/desktop/open-without-links'
import { renameSkillEntry } from '../../../../../engine/src/desktop/skill-publication-native'
import { exportPath } from '../../../../../engine/src/desktop/isolated-screen/exports'
import type { ScreenExportArtifact } from '../../../../../engine/src/desktop/isolated-screen/types'
import { withRosterWrite } from '../roster-writes'

type Directory = { path: string; dev: string; ino: string; uid: string }
const uid = () => BigInt(process.getuid?.() ?? -1)
const same = (info: BigIntStats, recorded: { dev: string; ino: string }) => String(info.dev) === recorded.dev && String(info.ino) === recorded.ino
const conflict = () => Object.assign(new Error('Browser export location changed.'), { code: 'EXPORT_CONFLICT' })
const pin = async (handle: FileHandle) => {
    const info = await handle.stat({ bigint: true })
    return process.platform === 'darwin' ? `/.vol/${info.dev}/${info.ino}` : `/proc/self/fd/${handle.fd}`
}

export async function browserWorkspaceIdentity(root: string): Promise<string> {
    const handle = await openWithoutLinks(root, true)
    try {
        const info = await handle.stat({ bigint: true })
        if (!info.isDirectory() || info.uid !== uid() || await realpath(/* turbopackIgnore: true */ root) !== root) throw conflict()
        return JSON.stringify([root, String(info.dev), String(info.ino)])
    } finally { await handle.close() }
}

async function assertDirectories(directories: Directory[]) {
    for (const entry of directories) {
        const info = await lstat(/* turbopackIgnore: true */ entry.path, { bigint: true })
        if (!info.isDirectory() || info.isSymbolicLink() || !same(info, entry) || info.uid !== uid() || String(info.uid) !== entry.uid || await realpath(/* turbopackIgnore: true */ entry.path) !== entry.path) throw conflict()
    }
}

async function directory(root: string, artifact: Pick<ScreenExportArtifact, 'kind' | 'path'>, create: boolean, guard: () => Promise<void>) {
    exportPath(artifact.path, artifact.kind)
    const parts = artifact.path.split('/'), name = parts.pop()!
    const generated = artifact.kind !== 'screenshot' && artifact.path.startsWith('.rerun/pages/')
    const directories: Directory[] = []
    let current = root
    let handle = await openWithoutLinks(root, true)
    try {
        for (let index = 0; index <= parts.length; index++) {
            const info = await handle.stat({ bigint: true })
            const named = await lstat(/* turbopackIgnore: true */ current, { bigint: true })
            if (!info.isDirectory() || info.uid !== uid() || !same(named, { dev: String(info.dev), ino: String(info.ino) }) || await realpath(/* turbopackIgnore: true */ current) !== current) throw conflict()
            directories.push({ path: current, dev: String(info.dev), ino: String(info.ino), uid: String(info.uid) })
            await assertDirectories(directories)
            if (index === parts.length) return { handle, directories, name, path: current, pinned: await pin(handle) }
            const child = parts[index]!
            const pinnedChild = join(/* turbopackIgnore: true */ await pin(handle), child)
            if (create && generated) {
                await guard(); await assertDirectories(directories)
                await mkdir(/* turbopackIgnore: true */ pinnedChild, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
                await assertDirectories(directories)
            }
            current = join(/* turbopackIgnore: true */ current, child)
            const next = await openWithoutLinks(current, true)
            await handle.close(); handle = next
        }
        throw conflict()
    } catch (error) { await handle.close(); throw error }
}

/** Recovery never publishes a staged file. Only the exact acknowledged inode can be read. */
export async function inspectBrowserExportFile(root: string, artifact: Pick<ScreenExportArtifact, 'kind' | 'path' | 'sha256'> & { byteLength: number }, recorded: { dev: string; ino: string; parent_json: string }, guard: () => Promise<void>): Promise<Buffer> {
    const parents = JSON.parse(recorded.parent_json) as Directory[]
    if (!Array.isArray(parents) || parents[0]?.path !== root || parents.at(-1)?.path !== join(/* turbopackIgnore: true */ root, ...artifact.path.split('/').slice(0, -1))) throw conflict()
    await guard(); await assertDirectories(parents)
    const target = join(/* turbopackIgnore: true */ root, artifact.path), handle = await openWithoutLinks(target)
    try {
        const before = await handle.stat({ bigint: true })
        if (!before.isFile() || before.uid !== uid() || before.nlink !== BigInt(1) || !same(before, recorded) || before.size !== BigInt(artifact.byteLength)) throw conflict()
        const bytes = Buffer.alloc(artifact.byteLength + 1)
        let used = 0
        while (used < bytes.length) {
            const read = await handle.read(bytes, used, bytes.length - used, used)
            if (!read.bytesRead) break
            used += read.bytesRead
        }
        const after = await handle.stat({ bigint: true }), named = await lstat(/* turbopackIgnore: true */ target, { bigint: true })
        if (used !== artifact.byteLength || !same(named, recorded) || after.nlink !== BigInt(1) || named.nlink !== BigInt(1) || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || createHash('sha256').update(bytes.subarray(0, used)).digest('hex') !== artifact.sha256) throw conflict()
        await guard(); await assertDirectories(parents)
        return bytes.subarray(0, used)
    } finally { await handle.close() }
}

export async function publishBrowserExportFile(db: Client, root: string, artifact: ScreenExportArtifact, guard: () => Promise<void>, signal: AbortSignal, operation: { key: string; digest: string; index: number }) {
    return withRosterWrite(async () => {
        signal.throwIfAborted(); await guard()
        const receipt = (await db.execute({ sql: 'SELECT f.*,e.digest FROM desktop_browser_export_files f JOIN desktop_browser_exports e ON e.operation_key=f.operation_key WHERE f.operation_key=? AND f.file_index=?', args: [operation.key, operation.index] })).rows[0]
        if (!receipt || receipt.digest !== operation.digest || receipt.path !== artifact.path || receipt.sha256 !== artifact.sha256 || Number(receipt.byte_length) !== artifact.bytes.length || receipt.state !== 'planned') throw conflict()
        const parent = await directory(root, artifact, true, guard)
        try {
            const tempName = `.rerun-browser-export-${randomBytes(16).toString('hex')}`
            const temp = join(/* turbopackIgnore: true */ parent.pinned, tempName)
            const handle = await open(/* turbopackIgnore: true */ temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (process.platform === 'darwin' ? 0x20000000 : constants.O_NOFOLLOW), 0o600)
            let info: BigIntStats
            try {
                await handle.writeFile(artifact.bytes); await handle.sync()
                info = await handle.stat({ bigint: true })
                if (!info.isFile() || info.uid !== uid() || info.nlink !== BigInt(1) || info.size !== BigInt(artifact.bytes.length)) throw conflict()
                await guard(); await assertDirectories(parent.directories)
                const saved = await db.execute({ sql: "UPDATE desktop_browser_export_files SET parent_json=?,temp_name=?,dev=?,ino=?,state='staged' WHERE operation_key=? AND file_index=? AND state='planned'", args: [JSON.stringify(parent.directories), tempName, String(info.dev), String(info.ino), operation.key, operation.index] })
                if (saved.rowsAffected !== 1) throw conflict()
            } finally { await handle.close() }
            await guard(); signal.throwIfAborted(); await assertDirectories(parent.directories)
            const parentInfo = await parent.handle.stat({ bigint: true })
            // Existing native helper pins parent+source inode and uses exclusive rename: no
            // link alias and no replacement of either a user file or a racing export.
            await renameSkillEntry(parent.path, parentInfo, tempName, info!, parent.name)
            const recorded = { dev: String(info!.dev), ino: String(info!.ino), parent_json: JSON.stringify(parent.directories) }
            await inspectBrowserExportFile(root, { ...artifact, byteLength: artifact.bytes.length }, recorded, guard)
            await db.execute({ sql: "UPDATE desktop_browser_export_files SET state='published' WHERE operation_key=? AND file_index=? AND dev=? AND ino=?", args: [operation.key, operation.index, recorded.dev, recorded.ino] })
            await parent.handle.sync()
        } finally { await parent.handle.close() }
    })
}
