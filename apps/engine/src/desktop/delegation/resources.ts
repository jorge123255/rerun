import { createHash } from 'node:crypto'
import { lstat, mkdir, open, readdir, realpath, rmdir, unlink, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { agentsDir, agentDir } from '../../config/paths.js'
import { openWithoutLinks } from '../open-without-links.js'
import { renameSkillEntry } from '../skill-publication-native.js'
import type { Allocation } from './protocol.js'

type Manifest = NonNullable<Allocation['manifest']>
const identity = (info: { dev: bigint; ino: bigint }) => `${info.dev}:${info.ino}`
const fail = () => new Error('Delegated workspace changed; its files were preserved')
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT'
const pinned = async (handle: FileHandle) => { const s = await handle.stat({ bigint: true }); return process.platform === 'darwin' ? `/.vol/${s.dev}/${s.ino}` : `/proc/self/fd/${handle.fd}` }
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const runtimeFile = (name: string) => /^data\/system\.db(?:-(?:wal|shm|journal))?$/.test(name)
const transientFile = (name: string) => /^data\/system\.db-(?:wal|shm|journal)$/.test(name)
export const DELEGATION_SOUL = 'Complete only the explicit delegated task and context. Return a concise text answer with sources, limits and assumptions. You have no private coworker context, credentials, memories, files or instructions. No human can answer you. Do not create or promise files; this isolated task returns text only. Use only the tools actually offered.'

function validateNames(record: Allocation) {
    if (!record.childAgentId.startsWith('delegate-') || !uuid.test(record.childAgentId.slice(9)) || !uuid.test(record.token)) throw fail()
}
async function root(record: Allocation, retired = false) {
    validateNames(record)
    if (!record.rootIdentity) throw fail()
    const parent = await openWithoutLinks(agentsDir(), true)
    try {
        const path = retired ? join(agentsDir(), `.delegation-retired-${record.token}`) : agentDir(record.childAgentId)
        const handle = await openWithoutLinks(path, true)
        try {
            const info = await handle.stat({ bigint: true }), named = await lstat(path, { bigint: true })
            if (!info.isDirectory() || identity(info) !== record.rootIdentity || identity(named) !== record.rootIdentity || info.uid !== BigInt(process.getuid?.() ?? -1) || await realpath(path) !== path) throw fail()
            return { parent, handle, path, info, pinned: await pinned(handle) }
        } catch (error) { await handle.close(); throw error }
    } catch (error) { await parent.close(); throw error }
}

export async function allocateDelegationDirectory(record: Allocation, check: () => Promise<void>) {
    validateNames(record)
    const parent = await openWithoutLinks(agentsDir(), true)
    try {
        await check()
        if (await realpath(agentsDir()) !== agentsDir()) throw fail()
        await mkdir(join(await pinned(parent), record.childAgentId), { mode: 0o700 })
        const handle = await openWithoutLinks(agentDir(record.childAgentId), true)
        try { const info = await handle.stat({ bigint: true }); await parent.sync(); await check(); return identity(info) }
        finally { await handle.close() }
    } finally { await parent.close() }
}

export function assertDelegationManifest(record: Allocation, actual: Manifest, options: { runtimeFiles?: boolean; removed?: boolean } = {}) {
    validateManifest(record.manifest)
    validateManifest(actual)
    for (const old of record.manifest!) {
        const now = actual.find(entry => entry.path === old.path)
        if (!now) {
            if (options.removed || options.runtimeFiles && transientFile(old.path)) continue
            throw fail()
        }
        if (now.dev !== old.dev || now.ino !== old.ino || now.directory !== old.directory) throw fail()
        if (!old.directory && !(options.runtimeFiles && runtimeFile(old.path)) && (now.hash !== old.hash || now.size !== old.size)) throw fail()
    }
    for (const now of actual) {
        if (!record.manifest!.some(old => old.path === now.path) && !(options.runtimeFiles && runtimeFile(now.path) && !now.directory)) throw fail()
    }
}

export async function initializeDelegationDirectory(record: Allocation, config: unknown, check: () => Promise<void>, persist: (manifest: Manifest) => Promise<void>) {
    const directory = await root(record)
    try {
        await check()
        if (!record.manifest || record.manifest.length || (await readdir(directory.pinned)).length) throw fail()
        const manifest: Manifest = []
        const remember = async (path: string, handle: FileHandle, hash: string | null) => {
            const info = await handle.stat({ bigint: true }), named = await lstat(join(directory.pinned, path), { bigint: true })
            if (identity(info) !== identity(named)) throw fail()
            manifest.push({ path, dev: String(info.dev), ino: String(info.ino), size: Number(info.size), directory: info.isDirectory(), hash })
            await directory.handle.sync()
            await persist([...manifest].sort((a, b) => a.path.localeCompare(b.path)))
        }
        for (const name of ['workspace', 'data', 'skills', 'memory']) {
            await check()
            await mkdir(join(directory.pinned, name), { mode: 0o700 })
            const handle = await openWithoutLinks(join(directory.pinned, name), true)
            try { await remember(name, handle, null) } finally { await handle.close() }
        }
        for (const [name, text] of [['config.json', JSON.stringify(config, null, 4)], ['SOUL.md', DELEGATION_SOUL]] as const) {
            await check()
            const file = await open(join(directory.pinned, name), 'wx', 0o600)
            try {
                await file.writeFile(text); await file.sync()
                await remember(name, file, createHash('sha256').update(text).digest('hex'))
            } finally { await file.close() }
        }
        assertDelegationManifest({ ...record, manifest }, await inspectDelegationDirectory(record))
        await check()
    } finally { await directory.handle.close(); await directory.parent.close() }
}

const allowed = new Set(['workspace', 'data', 'skills', 'memory', 'config.json', 'SOUL.md', 'data/system.db', 'data/system.db-wal', 'data/system.db-shm', 'data/system.db-journal'])
function validateManifest(manifest: Allocation['manifest']): asserts manifest is Manifest {
    if (!Array.isArray(manifest) || manifest.length > 16 || new Set(manifest.map(entry => entry.path)).size !== manifest.length) throw fail()
    let size = 0
    for (const entry of manifest) {
        if (!allowed.has(entry.path) || !/^\d+$/.test(entry.dev) || !/^\d+$/.test(entry.ino) || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.directory !== ['workspace', 'data', 'skills', 'memory'].includes(entry.path) || (entry.directory ? entry.hash !== null : !/^[a-f0-9]{64}$/.test(entry.hash ?? ''))) throw fail()
        size += entry.size
        if (size > 20 * 1024 * 1024) throw fail()
    }
}
/** Text-only tasks admit no model-supplied files or paths. Unknown entries prevent cleanup. */
export async function inspectDelegationDirectory(record: Allocation, retired = false): Promise<Manifest> {
    const directory = await root(record, retired)
    try {
        const manifest: Manifest = []; let bytes = 0
        async function visit(path: string, relative: string) {
            for (const name of await readdir(path)) {
                const entry = relative ? `${relative}/${name}` : name
                if (!allowed.has(entry) || manifest.length >= 16) throw fail()
                const target = join(path, name), info = await lstat(target, { bigint: true })
                if (info.isSymbolicLink() || info.uid !== BigInt(process.getuid?.() ?? -1) || !info.isDirectory() && (!info.isFile() || info.nlink !== BigInt(1))) throw fail()
                bytes += Number(info.size); if (bytes > 20 * 1024 * 1024) throw fail()
                let hash: string | null = null
                const handle = await openWithoutLinks(target, info.isDirectory())
                try {
                    if (identity(await handle.stat({ bigint: true })) !== identity(info)) throw fail()
                    if (info.isFile()) {
                        const contents = await handle.readFile(), after = await handle.stat({ bigint: true })
                        if (after.size !== info.size || after.mtimeNs !== info.mtimeNs || after.ctimeNs !== info.ctimeNs) throw fail()
                        hash = createHash('sha256').update(contents).digest('hex')
                    }
                    manifest.push({ path: entry, dev: String(info.dev), ino: String(info.ino), size: Number(info.size), directory: info.isDirectory(), hash })
                    if (info.isDirectory()) await visit(await pinned(handle), entry)
                } finally { await handle.close() }
            }
        }
        await visit(directory.pinned, '')
        return manifest.sort((a, b) => a.path.localeCompare(b.path))
    } finally { await directory.handle.close(); await directory.parent.close() }
}

/** Drained, exact-owned files only. No recursive rm, glob, provider path or parent workspace. */
export async function cleanupDelegationDirectory(record: Allocation, signal: AbortSignal) {
    validateManifest(record.manifest)
    if (!record.cleanupStarted) throw fail()
    validateNames(record)
    let directory: Awaited<ReturnType<typeof root>>
    let retired = false
    try { directory = await root(record, true); retired = true }
    catch (retiredError) {
        if (!missing(retiredError)) throw retiredError
        try { directory = await root(record) }
        catch (originalError) {
            if (!missing(originalError)) throw originalError
            // The durable cleanup intent precedes deletion. Both names being absent after
            // a crash means the exact resource has already gone; never adopt a replacement.
            const parent = await openWithoutLinks(agentsDir(), true)
            try { signal.throwIfAborted() } finally { await parent.close() }
            return
        }
    }
    try {
        signal.throwIfAborted()
        assertDelegationManifest(record, await inspectDelegationDirectory(record, retired), { removed: retired })
        const name = `.delegation-retired-${record.token}`
        if (!retired) await renameSkillEntry(agentsDir(), await directory.parent.stat({ bigint: true }), record.childAgentId, directory.info, name)
        const base = await pinned(directory.handle)
        for (const entry of [...record.manifest].sort((a, b) => b.path.split('/').length - a.path.split('/').length || Number(a.directory) - Number(b.directory))) {
            signal.throwIfAborted()
            const target = join(base, entry.path)
            let info
            try { info = await lstat(target, { bigint: true }) } catch (error) { if (missing(error)) continue; throw error }
            if (String(info.dev) !== entry.dev || String(info.ino) !== entry.ino || info.isSymbolicLink() || info.isDirectory() !== entry.directory) throw fail()
            if (entry.directory) await rmdir(target)
            else {
                const file = await openWithoutLinks(target)
                try { if (createHash('sha256').update(await file.readFile()).digest('hex') !== entry.hash || identity(await file.stat({ bigint: true })) !== `${entry.dev}:${entry.ino}`) throw fail() }
                finally { await file.close() }
                const named = await lstat(target, { bigint: true })
                if (identity(named) !== `${entry.dev}:${entry.ino}` || named.nlink !== BigInt(1)) throw fail()
                await unlink(target)
            }
        }
        const final = join(await pinned(directory.parent), name)
        if (identity(await lstat(final, { bigint: true })) !== record.rootIdentity) throw fail()
        await rmdir(final); await directory.parent.sync()
    } finally { await directory.handle.close(); await directory.parent.close() }
}
