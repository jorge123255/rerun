import { lstat, opendir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { DESKTOP_COWORKER_SHARE_MEMORY_LIMITS as LIMITS, type DesktopCoworkerShareMemoryPackage } from '@rerun/contracts'
import { pinDirectory, readConfined, writeExclusiveFile } from '../templates/files.ts'
import { readOwnJson, writeOwnJson } from '../templates/store.ts'
import { captureDesktopCoworkerShareMemory } from './capture.ts'
import { restoreDesktopCoworkerShareMemory } from './restore.ts'
import { memoryMemberPath, parseMemoryMarkdown, renderMemoryMarkdown } from './serialize.ts'

const RECEIPT = '.rerun-share-memories.json'
const reserved = (name: string) => name.normalize('NFKC').toLowerCase().startsWith('.rerun')
const absent = (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error }
const fail = (): never => { throw new Error('Canonical memories changed or are not safely available. Review the current coworker again.') }
const requireMac = () => { if (process.platform !== 'darwin') throw new Error('Portable memory binding requires the Mac confined filesystem adapter.') }

async function assertPinnedRoot(root: string, pinned: string) {
    const [named, opened] = await Promise.all([lstat(root, { bigint: true }), stat(pinned, { bigint: true })])
    if (!named.isDirectory() || named.isSymbolicLink() || named.dev !== opened.dev || named.ino !== opened.ino) return fail()
}

/** Direct canonical notes only: no archive, recall, DB, index, journal or directory traversal. */
async function noteFiles(root: string, strict: boolean) {
    const directory = join(root, 'memory')
    const before = await lstat(directory, { bigint: true }).catch(absent)
    if (!before) return []
    if (!before.isDirectory() || before.isSymbolicLink()) return fail()
    const pin = await pinDirectory(directory)
    try {
        const opened = await stat(pin.pinned, { bigint: true })
        if (opened.dev !== before.dev || opened.ino !== before.ino) return fail()
        const entries: string[] = []
        let visited = 0
        const stream = await opendir(pin.pinned)
        for await (const entry of stream) {
            if (++visited > LIMITS.maxNotes + 256) return fail()
            if (!strict && (reserved(entry.name) || entry.name === 'recall.md' || !entry.name.endsWith('.md'))) continue
            if (!entry.isFile() || !/^[A-Za-z0-9_-]+\.md$/.test(entry.name) || entry.name === 'recall.md') return fail()
            entries.push(entry.name)
            if (entries.length > LIMITS.maxNotes) return fail()
        }
        const after = await lstat(directory, { bigint: true })
        if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) return fail()
        return entries.sort()
    } finally { await pin.close() }
}

/** Uses an already-authorized canonical agent root, never process-global engine dataDir. */
export async function captureScopedCoworkerMemories(input: { agentRoot: string; workspaceId: number; agentId: string; requestId: string; assertCurrent: () => Promise<void> }): Promise<DesktopCoworkerShareMemoryPackage> {
    requireMac()
    await input.assertCurrent()
    const pin = await pinDirectory(input.agentRoot)
    try {
        const result = await captureDesktopCoworkerShareMemory({
            workspaceId: input.workspaceId, agentId: input.agentId,
            listOwnedNotes: async () => {
                const names = await noteFiles(pin.pinned, false)
                const notes = []
                let bytes = 0
                for (const name of names) {
                    await input.assertCurrent()
                    await assertPinnedRoot(input.agentRoot,pin.pinned)
                    const file = await readConfined(pin.pinned, `memory/${name}`, LIMITS.maxNoteBytes)
                    if (!file.ok) return fail()
                    bytes += file.bytes.length
                    if (bytes > LIMITS.maxTotalBytes) return fail()
                    notes.push(parseMemoryMarkdown(`memory/${name}`, file.text))
                }
                if (JSON.stringify(names) !== JSON.stringify(await noteFiles(pin.pinned, false))) return fail()
                return notes
            },
        }, { requestId: input.requestId, includeMemories: true })
        if ('unavailable' in result) return fail()
        await input.assertCurrent()
        await assertPinnedRoot(input.agentRoot,pin.pinned)
        return result
    } finally { await pin.close() }
}

/**
 * Called before publishing a fresh disabled template import into the local roster.
 * assertFreshImport must prove the exact engine folder/receipt and absent local owner.
 * Immutable reservation + exact per-note bytes permit only the SAME partial import to resume.
 */
export async function restoreScopedCoworkerMemories(input: { agentRoot: string; workspaceId: number; destinationAgentId: string; importReceiptId: string; pkg: DesktopCoworkerShareMemoryPackage; assertFreshImport: () => Promise<void> }) {
    requireMac()
    await input.assertFreshImport()
    const pin = await pinDirectory(input.agentRoot)
    try {
        const assertCurrent = async () => { await input.assertFreshImport(); await assertPinnedRoot(input.agentRoot,pin.pinned) }
        const reservation = { version: 1, importReceiptId: input.importReceiptId, destinationAgentId: input.destinationAgentId, workspaceId: input.workspaceId, captureRequestId: input.pkg.captureRequestId, digest: input.pkg.digest }
        const expected = new Map(input.pkg.notes.map(note => [memoryMemberPath(note.id).slice(7), Buffer.from(renderMemoryMarkdown(note))]))
        const validateSubset = async () => {
            for (const name of await noteFiles(pin.pinned, true)) {
                const bytes = expected.get(name)
                if (!bytes) return fail()
                const file = await readConfined(pin.pinned, `memory/${name}`, LIMITS.maxNoteBytes)
                if (!file.ok || !file.bytes.equals(bytes)) return fail()
            }
        }
        const result = await restoreDesktopCoworkerShareMemory({
            workspaceId: input.workspaceId, destinationAgentId: input.destinationAgentId,
            assertFreshDestination: async () => {
                await assertCurrent()
                const saved = await readOwnJson(pin.pinned, RECEIPT)
                if (saved === null) {
                    // Never adopt notes which were not reserved by this exact import.
                    if ((await noteFiles(pin.pinned, true)).length) return fail()
                    await assertCurrent()
                    await writeOwnJson(pin.pinned, RECEIPT, reservation)
                }
                const persisted = await readOwnJson(pin.pinned, RECEIPT)
                if (JSON.stringify(persisted) !== JSON.stringify(reservation)) return fail()
                await validateSubset()
            },
            installNote: async ({ note }) => {
                await assertCurrent()
                const outcome = await writeExclusiveFile(pin.pinned, memoryMemberPath(note.id), Buffer.from(renderMemoryMarkdown(note)))
                await assertCurrent()
                return outcome === 'created' ? 'installed' : 'reused'
            },
        }, input.pkg, { captureRequestId: input.pkg.captureRequestId, expectedDigest: input.pkg.digest })
        await validateSubset()
        if ((await noteFiles(pin.pinned, true)).length !== expected.size) return fail()
        await assertCurrent()
        return result
    } finally { await pin.close() }
}
