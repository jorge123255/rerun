import { randomUUID } from 'node:crypto'
import { lstat, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { desktopTemplateIdSchema, desktopTemplateRevisionSchema, type DesktopPortableDeleteResult } from '@rerun/contracts'
import { TemplateRequestError } from './errors.js'
import { pinDirectory } from './files.js'
import { canonicalJson, sha256 } from './hash.js'
import { readOwnJson, replaceOwnJson, requestHome, templateHome, writeOwnJson } from './store.js'

const deleteReceiptSchema = z.strictObject({
    version: z.literal(1),
    requestId: z.uuid(),
    templateId: desktopTemplateIdSchema,
    revision: desktopTemplateRevisionSchema,
    fingerprint: desktopTemplateRevisionSchema,
    tombstoneId: z.uuid().optional(),
})

const tombstoneSchema = z.strictObject({
    version: z.literal(1),
    tombstoneId: z.uuid(),
    templateId: desktopTemplateIdSchema,
    revision: desktopTemplateRevisionSchema,
    requestId: z.uuid(),
    deletedAt: z.string().min(20).max(40),
    effect: z.literal('local-library-only'),
})

export type PortableDeleteDeps = {
    dataRoot: string
    // Returns true when an owned export artifact for this revision is still referenced.
    hasOwnedArtifactReference?: (input: { templateId: string; revision: string }) => Promise<boolean>
}

export async function deleteDesktopPortableTemplate(input: {
    requestId: string
    templateId: string
    revision: string
    deps: PortableDeleteDeps
}): Promise<DesktopPortableDeleteResult> {
    const fingerprint = sha256(canonicalJson({ operation: 'delete', requestId: input.requestId, templateId: input.templateId, revision: input.revision }))
    const home = requestHome(input.deps.dataRoot)
    const priorRaw = await readOwnJson(home, `portable-delete-${input.requestId}.json`)
    const prior = deleteReceiptSchema.safeParse(priorRaw)
    if (priorRaw && (!prior.success || prior.data.fingerprint !== fingerprint)) {
        throw new TemplateRequestError(409, 'This delete request already belongs to another template revision')
    }
    if (prior.success && prior.data.tombstoneId) {
        return {
            status: 'deleted',
            requestId: input.requestId,
            receiptId: input.requestId,
            templateId: input.templateId,
            revision: input.revision,
            tombstoneId: prior.data.tombstoneId,
        }
    }

    const directory = templateHome(input.deps.dataRoot, input.templateId)
    const current = z.strictObject({ revision: desktopTemplateRevisionSchema }).safeParse(await readOwnJson(directory, 'current.json'))
    if (!current.success) throw new TemplateRequestError(404, 'Template not found')
    if (current.data.revision !== input.revision) {
        throw new TemplateRequestError(409, 'Delete expected a different template revision')
    }
    if (input.deps.hasOwnedArtifactReference && await input.deps.hasOwnedArtifactReference({ templateId: input.templateId, revision: input.revision })) {
        throw new TemplateRequestError(409, 'An owned export artifact still references this revision')
    }

    if (!prior.success) {
        await writeOwnJson(home, `portable-delete-${input.requestId}.json`, {
            version: 1, requestId: input.requestId, templateId: input.templateId, revision: input.revision, fingerprint,
        })
    }

    const tombstoneId = prior.success?.tombstoneId ?? randomUUID()
    const deletedAt = new Date().toISOString()
    try {
        await writeOwnJson(directory, 'tombstone.json', tombstoneSchema.parse({
            version: 1,
            tombstoneId,
            templateId: input.templateId,
            revision: input.revision,
            requestId: input.requestId,
            deletedAt,
            effect: 'local-library-only',
        }))
        // Remove only this template's owned library directory. Exported copies outside app
        // ownership are intentionally left untouched. Installed coworkers are not referenced here.
        const info = await lstat(directory).catch(() => null)
        if (info?.isDirectory() && !info.isSymbolicLink()) {
            const pin = await pinDirectory(join(input.deps.dataRoot, 'desktop-templates'))
            try {
                await rm(directory, { recursive: true, force: false })
            } finally {
                await pin.close()
            }
        }
        await replaceOwnJson(home, `portable-delete-${input.requestId}.json`, {
            version: 1,
            requestId: input.requestId,
            templateId: input.templateId,
            revision: input.revision,
            fingerprint,
            tombstoneId,
        })
        // Keep a durable tombstone index outside the removed tree so lost-ack recovery can confirm.
        await writeOwnJson(home, `tombstone-${input.templateId}.json`, {
            version: 1,
            tombstoneId,
            templateId: input.templateId,
            revision: input.revision,
            requestId: input.requestId,
            deletedAt,
            effect: 'local-library-only',
        })
        return {
            status: 'deleted',
            requestId: input.requestId,
            receiptId: input.requestId,
            templateId: input.templateId,
            revision: input.revision,
            tombstoneId,
        }
    } catch (error) {
        if (error instanceof TemplateRequestError) throw error
        return {
            status: 'uncertain',
            requestId: input.requestId,
            receiptId: input.requestId,
            recoverable: true,
            reason: error instanceof Error ? error.message.slice(0, 400) : 'Portable delete did not finish',
        }
    }
}

export async function reconcilePortableDelete(dataRoot: string, requestId: string) {
    const prior = deleteReceiptSchema.safeParse(await readOwnJson(requestHome(dataRoot), `portable-delete-${requestId}.json`))
    if (!prior.success) return null
    if (prior.data.tombstoneId) {
        return {
            status: 'deleted' as const,
            requestId,
            receiptId: requestId,
            templateId: prior.data.templateId,
            revision: prior.data.revision,
            tombstoneId: prior.data.tombstoneId,
        }
    }
    return {
        status: 'uncertain' as const,
        requestId,
        receiptId: requestId,
        recoverable: true as const,
        reason: 'Delete acknowledgement is unknown. Retry the same delete request.',
    }
}
