import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { desktopTemplateIdSchema, desktopTemplateRevisionSchema, desktopTemplateRelativePathSchema, desktopTemplateRequirementsSchema } from '@rerun/contracts'
import { UNUSED_SCREEN_MARKER, unusedScreenMarkerText } from '../isolated-screen/ownership-file.ts'
import { renameSkillEntry } from '../skill-publication-native.js'
import { readConfinedBytes, walkConfined } from './files.js'
import { readManifest } from './install.js'
import { withPortableLibraryLease, removePortableQuarantinedDirectory } from './portable-lock.js'
import { readOwnJson, writeOwnJson, replaceOwnJson, requestHome } from './store.js'
import { TemplateRequestError } from './errors.js'
import { sha256, canonicalJson } from './hash.js'
const recoverySchema = z.strictObject({
    version: z.literal(1), requestId: z.uuid(), importReceiptId: z.uuid(), templateId: desktopTemplateIdSchema, revision: desktopTemplateRevisionSchema,
    engineAgentId: z.string().regex(/^i[a-f0-9]{31}$/), agentKey: z.string().regex(/^c[0-9]{2}$/), fingerprint: desktopTemplateRevisionSchema,
    dev: z.string().regex(/^\d+$/), ino: z.string().regex(/^\d+$/),
    // The template's 2,000 entries plus its optional exact screen ownership marker.
    files:z.array(z.strictObject({path:desktopTemplateRelativePathSchema,bytes:z.number().int().nonnegative().max(25*1024*1024),sourceRevision:desktopTemplateRevisionSchema})).max(2001), phase: z.enum(['reserved','quarantined','index-removed','removed']),
})
export type FidelityRecoveryRequest = Pick<z.infer<typeof recoverySchema>, 'requestId'|'importReceiptId'|'templateId'|'revision'|'engineAgentId'|'agentKey'>
export type FidelityRecoveryDeps = {
    dataRoot: string; agentsRoot: string
    // Required root DB CAS against the exact import receipt and new coworker identity.
    withFreshImportLease?: <T>(request: FidelityRecoveryRequest, work: () => Promise<T>) => Promise<T>
    removeOwnedIndex?: (request: FidelityRecoveryRequest) => Promise<'removed'|'absent'|'changed'>
}
export async function rollbackFreshTemplateCoworker(input: FidelityRecoveryRequest, deps: FidelityRecoveryDeps) {
    recoverySchema.omit({ dev:true, ino:true, phase:true, files:true }).parse({ version:1, ...input, fingerprint:sha256(canonicalJson(input)) })
    if (!deps.removeOwnedIndex || !deps.withFreshImportLease) throw new TemplateRequestError(503, 'Exact import-owned index rollback authority is not configured')
    return deps.withFreshImportLease(input, () => withPortableLibraryLease(deps.dataRoot, async () => {
        const fingerprint = sha256(canonicalJson(input)), home = requestHome(deps.dataRoot), record = `rollback-${input.requestId}.json`
        const priorRaw = await readOwnJson(home, record)
        const parsed = recoverySchema.safeParse(priorRaw)
        if (priorRaw && !parsed.success) throw new TemplateRequestError(409, 'Rollback recovery metadata is unsupported')
        if (parsed.success && parsed.data.fingerprint !== fingerprint) throw new TemplateRequestError(409, 'Rollback identity belongs to another import')
        if (parsed.success && parsed.data.phase === 'removed') return { status: 'rolled-back' as const, requestId: input.requestId, engineAgentId: input.engineAgentId }
        const folder = join(deps.agentsRoot, input.engineAgentId), quarantineName = `.template-rollback-${input.requestId}`, quarantine = join(deps.agentsRoot, quarantineName)
        // Validate all public/private identities before deriving a filesystem path.
        recoverySchema.omit({ dev:true, ino:true, phase:true, files:true }).parse({ version:1, ...input, fingerprint })
        let receipt = parsed.success ? parsed.data : null
        if (!receipt) {
            const manifest = await readManifest(deps.dataRoot, input.templateId, input.revision), member = manifest.coworkers.find(c => c.agentKey === input.agentKey)
            if (!member) throw new TemplateRequestError(409, 'Rollback coworker does not belong to the template')
            const before = await lstat(folder, { bigint:true })
            if (!before.isDirectory() || before.isSymbolicLink()) throw new TemplateRequestError(409, 'Rollback target is not an owned directory')
            const marker = await readOwnJson(folder, '.desktop-template-import.json') as Record<string, unknown> | null
            if (!marker || marker.importReceiptId !== input.importReceiptId || marker.templateId !== input.templateId || marker.revision !== input.revision || marker.agentKey !== input.agentKey || marker.engineAgentId !== input.engineAgentId) throw new TemplateRequestError(409, 'Rollback target belongs to a different import')
            const inventory = await walkConfined(folder, '', 4000)
            if (inventory.truncated) throw new TemplateRequestError(409, 'Rollback inventory is too large')
            const expected = new Map<string, { path: string; bytes: number; sourceRevision: string }>(
                member.files.map(({ path, bytes, sourceRevision }) => [path, { path, bytes, sourceRevision }]),
            )
            if (inventory.entries.some(entry => entry.path === UNUSED_SCREEN_MARKER)) {
                const screenMarker = Buffer.from(unusedScreenMarkerText(input.engineAgentId, String(before.dev), String(before.ino)), 'utf8')
                expected.set(UNUSED_SCREEN_MARKER, { path: UNUSED_SCREEN_MARKER, bytes: screenMarker.length, sourceRevision: sha256(screenMarker) })
            }
            for (const entry of inventory.entries) {
                if (entry.kind !== 'file') throw new TemplateRequestError(409, 'Rollback target contains a link or unsupported entry')
                if (entry.path === '.desktop-template-import.json' || entry.path === '.desktop-template-requirements.json') continue
                const meta = expected.get(entry.path)
                if (!meta) throw new TemplateRequestError(409, 'Rollback refused because the coworker contains new user data')
                const read = await readConfinedBytes(folder, entry.path, meta.bytes)
                if (!read.ok || read.bytes.length !== meta.bytes || read.contentRevision !== meta.sourceRevision) throw new TemplateRequestError(409, 'Rollback refused because imported bytes were edited')
            }
            receipt = { version:1, ...input, fingerprint, dev:String(before.dev), ino:String(before.ino), files:[...expected.values()], phase:'reserved' }
            await writeOwnJson(home, record, receipt)
        }
        const identity = { dev:receipt.dev, ino:receipt.ino }
        const queued = await lstat(quarantine, { bigint:true }).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error })
        if (queued && (String(queued.dev) !== identity.dev || String(queued.ino) !== identity.ino || queued.isSymbolicLink())) throw new TemplateRequestError(409, 'Rollback quarantine identity changed')
        if (!queued && receipt.phase === 'reserved') {
            const parent = await lstat(deps.agentsRoot, { bigint:true })
            await renameSkillEntry(deps.agentsRoot, parent, input.engineAgentId, { dev:BigInt(receipt.dev), ino:BigInt(receipt.ino) }, quarantineName)
        }
        if (receipt.phase === 'reserved') { receipt = { ...receipt, phase:'quarantined' }; await replaceOwnJson(home, record, receipt) }
        const stillQuarantined = await lstat(quarantine).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error })
        if (stillQuarantined) await verifyQuarantinedFiles(quarantine, receipt.files)
        if (receipt.phase === 'quarantined') {
            const removed = await deps.removeOwnedIndex!(input)
            if (removed === 'changed') throw new TemplateRequestError(409, 'Rollback index belongs to a different or active coworker; recovery is retained')
            receipt = { ...receipt, phase:'index-removed' }; await replaceOwnJson(home, record, receipt)
        }
        await removePortableQuarantinedDirectory(deps.agentsRoot, quarantineName, identity)
        await replaceOwnJson(home, record, { ...receipt, phase:'removed' })
        return { status:'rolled-back' as const, requestId:input.requestId, engineAgentId:input.engineAgentId }
    }))
}
export async function readInstalledTemplateRequirements(agentsRoot: string, engineAgentId: string) {
    if (!/^i[a-f0-9]{31}$/.test(engineAgentId)) throw new TemplateRequestError(400, 'Invalid imported coworker')
    const raw = await readOwnJson(join(agentsRoot, engineAgentId), '.desktop-template-requirements.json')
    if (!raw) return []
    return z.strictObject({ version:z.literal(1), importReceiptId:z.uuid(), requirements:desktopTemplateRequirementsSchema }).parse(raw).requirements
}

async function verifyQuarantinedFiles(folder: string, files: {path:string;bytes:number;sourceRevision:string}[]) {
    const allowedDirectories = new Set<string>()
    for (const file of files) { const parts = file.path.split('/'); for (let n = 1; n < parts.length; n++) allowedDirectories.add(parts.slice(0,n).join('/')) }
    let entries = 0
    async function visit(prefix: string) {
        for (const dirent of await readdir(join(folder, prefix), { withFileTypes:true })) {
            if (++entries > 4000) throw new TemplateRequestError(409, 'Rollback tree exceeds its member bound')
            const path = prefix ? `${prefix}/${dirent.name}` : dirent.name
            if (dirent.isDirectory() && !dirent.isSymbolicLink()) { if (!allowedDirectories.has(path)) throw new TemplateRequestError(409, 'Rollback refused a newly created directory'); await visit(path); continue }
            if (!dirent.isFile() || dirent.isSymbolicLink()) throw new TemplateRequestError(409, 'Rollback refused a changed entry')
            if (path === '.desktop-template-import.json' || path === '.desktop-template-requirements.json') continue
            const file = files.find(f => f.path === path)
            if (!file) throw new TemplateRequestError(409, 'Rollback refused newly created data')
            const bytes = await readConfinedBytes(folder, path, file.bytes)
            if (!bytes.ok || bytes.contentRevision !== file.sourceRevision || bytes.bytes.length !== file.bytes) throw new TemplateRequestError(409, 'Rollback refused edited bytes')
        }
    }
    await visit('')
}
