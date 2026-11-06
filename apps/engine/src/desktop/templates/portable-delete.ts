import { randomUUID } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { desktopTemplateIdSchema, desktopTemplateRevisionSchema, type DesktopPortableDeleteResult } from '@rerun/contracts'
import { renameSkillEntry } from '../skill-publication-native.js'
import { TemplateRequestError } from './errors.js'
import { canonicalJson, sha256 } from './hash.js'
import { removePortableQuarantinedDirectory, withPortableLibraryLease } from './portable-lock.js'
import { readOwnJson, replaceOwnJson, requestHome, templateHome, writeOwnJson } from './store.js'

const deleteReceiptSchema = z.strictObject({
    version: z.literal(1), requestId: z.uuid(), templateId: desktopTemplateIdSchema,
    revision: desktopTemplateRevisionSchema, fingerprint: desktopTemplateRevisionSchema,
    tombstoneId: z.uuid().optional(), deletedAt: z.string().min(20).max(40).optional(),
    phase: z.enum(['reserved', 'quarantined', 'deleted']).optional(),
    target: z.strictObject({ dev: z.string().regex(/^\d+$/), ino: z.string().regex(/^\d+$/) }).optional(),
})

export type PortableDeleteDeps = {
    dataRoot: string
    hasOwnedArtifactReference?: (input: { templateId: string; revision: string }) => Promise<boolean>
}

type DeleteInput = { requestId: string; templateId: string; revision: string; deps: PortableDeleteDeps }
const identityOf = (info: { dev: bigint; ino: bigint }) => ({ dev: String(info.dev), ino: String(info.ino) })
const same = (info: { dev: bigint; ino: bigint }, target: { dev: string; ino: string }) => String(info.dev) === target.dev && String(info.ino) === target.ino
async function infoAt(path: string) {
    return lstat(path, { bigint: true }).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error })
}
const deletedResult = (row: z.infer<typeof deleteReceiptSchema>): DesktopPortableDeleteResult => ({
    status: 'deleted', requestId: row.requestId, receiptId: row.requestId,
    templateId: row.templateId, revision: row.revision, tombstoneId: row.tombstoneId!,
})

async function deleteUnlocked(input: DeleteInput): Promise<DesktopPortableDeleteResult> {
    const fingerprint = sha256(canonicalJson({ operation: 'delete', requestId: input.requestId, templateId: input.templateId, revision: input.revision }))
    const home = requestHome(input.deps.dataRoot)
    const name = `portable-delete-${input.requestId}.json`
    const priorRaw = await readOwnJson(home, name)
    const prior = deleteReceiptSchema.safeParse(priorRaw)
    if (priorRaw && (!prior.success || prior.data.fingerprint !== fingerprint)) throw new TemplateRequestError(409, 'This delete request already belongs to another template revision')
    if (prior.success && prior.data.phase === 'deleted' && prior.data.tombstoneId) return deletedResult(prior.data)
    const directory = templateHome(input.deps.dataRoot, input.templateId)
    const parent = join(input.deps.dataRoot, 'desktop-templates')
    try {
        let receipt: z.infer<typeof deleteReceiptSchema>
        if (prior.success && prior.data.target && prior.data.tombstoneId && prior.data.deletedAt && prior.data.phase) receipt = prior.data
        else {
            if (prior.success) throw new TemplateRequestError(409, 'This older delete needs manual recovery before another attempt')
            const info = await infoAt(directory)
            if (!info) throw new TemplateRequestError(404, 'Template not found')
            if (!info.isDirectory() || info.isSymbolicLink()) throw new TemplateRequestError(409, 'Template is not an owned library directory')
            const current = z.strictObject({ revision: desktopTemplateRevisionSchema }).safeParse(await readOwnJson(directory, 'current.json'))
            if (!current.success || current.data.revision !== input.revision) throw new TemplateRequestError(409, 'Delete expected a different template revision')
            if (await input.deps.hasOwnedArtifactReference?.({ templateId: input.templateId, revision: input.revision })) throw new TemplateRequestError(409, 'An owned export artifact still references this revision')
            receipt = {
                version: 1, requestId: input.requestId, templateId: input.templateId, revision: input.revision,
                fingerprint, tombstoneId: randomUUID(), deletedAt: new Date().toISOString(), phase: 'reserved', target: identityOf(info),
            }
            await writeOwnJson(home, name, receipt)
        }
        const target = receipt.target!
        const quarantineName = `.portable-delete-${receipt.tombstoneId}`
        const quarantine = join(parent, quarantineName)
        let quarantined = await infoAt(quarantine)
        if (quarantined && (!quarantined.isDirectory() || quarantined.isSymbolicLink() || !same(quarantined, target))) throw new TemplateRequestError(409, 'The delete recovery directory changed')
        if (!quarantined && receipt.phase === 'reserved') {
            const source = await infoAt(directory)
            if (!source || !source.isDirectory() || source.isSymbolicLink() || !same(source, target)) throw new TemplateRequestError(409, 'The template changed before deletion')
            const current = z.strictObject({ revision: desktopTemplateRevisionSchema }).safeParse(await readOwnJson(directory, 'current.json'))
            if (!current.success || current.data.revision !== receipt.revision) throw new TemplateRequestError(409, 'The template revision changed before deletion')
            if (await input.deps.hasOwnedArtifactReference?.({ templateId: input.templateId, revision: input.revision })) throw new TemplateRequestError(409, 'An owned export artifact still references this revision')
            await renameSkillEntry(parent, await lstat(parent, { bigint: true }), input.templateId, { dev: BigInt(target.dev), ino: BigInt(target.ino) }, quarantineName)
            quarantined = await infoAt(quarantine)
            if (!quarantined || !same(quarantined, target)) throw new TemplateRequestError(409, 'Could not confirm the owned delete recovery directory')
        }
        if (receipt.phase === 'reserved') {
            receipt = { ...receipt, phase: 'quarantined' }
            await replaceOwnJson(home, name, receipt)
        }
        if (quarantined) await removePortableQuarantinedDirectory(parent, quarantineName, target)
        await writeOwnJson(home, `tombstone-${input.templateId}.json`, {
            version: 1, tombstoneId: receipt.tombstoneId, templateId: receipt.templateId,
            revision: receipt.revision, requestId: receipt.requestId, deletedAt: receipt.deletedAt, effect: 'local-library-only',
        })
        receipt = { ...receipt, phase: 'deleted' }
        await replaceOwnJson(home, name, receipt)
        return deletedResult(receipt)
    } catch (error) {
        if (error instanceof TemplateRequestError) throw error
        return { status: 'uncertain', requestId: input.requestId, receiptId: input.requestId, recoverable: true,
            reason: error instanceof Error ? error.message.slice(0, 400) : 'Portable delete did not finish' }
    }
}

export function deleteDesktopPortableTemplate(input: DeleteInput): Promise<DesktopPortableDeleteResult> {
    return withPortableLibraryLease(input.deps.dataRoot, () => deleteUnlocked(input))
}

export async function reconcilePortableDelete(dataRoot: string, requestId: string): Promise<DesktopPortableDeleteResult | null> {
    const prior = deleteReceiptSchema.safeParse(await readOwnJson(requestHome(dataRoot), `portable-delete-${requestId}.json`))
    if (!prior.success) return null
    if (prior.data.phase === 'deleted' && prior.data.tombstoneId) return deletedResult(prior.data)
    return { status: 'uncertain', requestId, receiptId: requestId, recoverable: true,
        reason: 'Delete acknowledgement is unknown. Retry the same delete request.' }
}
