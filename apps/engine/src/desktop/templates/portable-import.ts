import { join } from 'node:path'
import { z } from 'zod'
import {
    DESKTOP_PORTABLE_TEMPLATE_LIMITS,
    DESKTOP_TEMPLATE_LIMITS,
    DESKTOP_TEMPLATE_PROSE_WARNING,
    desktopTemplateIdSchema,
    desktopTemplateRevisionSchema,
    type DesktopPortableImportResult,
    type DesktopPortableProvenance,
} from '@rerun/contracts'
import { TemplateRequestError } from './errors.js'
import { writeExclusiveFile, ensurePrivateDir } from './files.js'
import { canonicalJson, draftRevision, newTemplateId, sha256 } from './hash.js'
import { sealManifest, type TemplateManifest } from './install.js'
import { readOwnJson, replaceOwnJson, requestHome, templateHome, writeOwnJson } from './store.js'
import { readImmutableUploadBytes, readPortableArchive } from './portable-package.js'

const importReceiptSchema = z.strictObject({
    version: z.literal(1),
    requestId: z.uuid(),
    uploadId: z.uuid(),
    fingerprint: desktopTemplateRevisionSchema,
    templateId: desktopTemplateIdSchema.optional(),
    revision: desktopTemplateRevisionSchema.optional(),
    provenance: z.strictObject({
        importedAt: z.string(),
        sourcePackageKey: z.string(),
        sourceContentDigest: z.string(),
        sourceTitle: z.string(),
        uploadId: z.uuid().optional(),
    }).optional(),
})

export type PortableImportDeps = {
    dataRoot: string
    readImmutableUpload: (uploadId: string) => Promise<Buffer>
}

export async function importDesktopPortableTemplate(input: {
    requestId: string
    uploadId: string
    title?: string
    deps: PortableImportDeps
}): Promise<DesktopPortableImportResult> {
    const fingerprint = sha256(canonicalJson({ operation: 'import-package', requestId: input.requestId, uploadId: input.uploadId, title: input.title ?? null }))
    const home = requestHome(input.deps.dataRoot)
    const priorRaw = await readOwnJson(home, `portable-import-${input.requestId}.json`)
    const prior = importReceiptSchema.safeParse(priorRaw)
    if (priorRaw && (!prior.success || prior.data.fingerprint !== fingerprint)) {
        throw new TemplateRequestError(409, 'This import request already belongs to another package')
    }
    if (prior.success && prior.data.templateId && prior.data.revision && prior.data.provenance) {
        return {
            status: 'imported',
            requestId: input.requestId,
            receiptId: input.requestId,
            templateId: prior.data.templateId,
            revision: prior.data.revision,
            provenance: prior.data.provenance as DesktopPortableProvenance,
            fidelity: {
                binaryAssets: true,
                userSkillTrees: true,
                sourceKind: 'portable-capture',
                notes: ['Recovered from a prior acknowledged portable import.'],
            },
        }
    }

    if (!prior.success) {
        await writeOwnJson(home, `portable-import-${input.requestId}.json`, {
            version: 1, requestId: input.requestId, uploadId: input.uploadId, fingerprint,
        })
    }

    const startedAt = Date.now()
    try {
        if (!input.deps.readImmutableUpload) throw new TemplateRequestError(503, 'Immutable upload callback is not configured')
        const archiveBytes = await readImmutableUploadBytes(() => input.deps.readImmutableUpload(input.uploadId))
        const { manifest, members } = await readPortableArchive(archiveBytes, startedAt)
        const title = (input.title?.trim() || manifest.title).slice(0, DESKTOP_PORTABLE_TEMPLATE_LIMITS.maxTitleLength)
        const templateId = prior.success && prior.data.templateId ? prior.data.templateId : newTemplateId()
        const draft = {
            version: 1 as const,
            requestId: input.requestId,
            templateId,
            title,
            revision: draftRevision(input.requestId, templateId, title),
        }
        await writeOwnJson(templateHome(input.deps.dataRoot, templateId), 'draft.json', draft)

        const localCoworkers: TemplateManifest['coworkers'] = manifest.coworkers.map(coworker => ({
            agentKey: coworker.agentKey,
            sourceEngineId: `imported-${coworker.agentKey}`,
            name: coworker.name,
            description: coworker.description,
            setup: {
                ...coworker.setup,
                // Receiving install must remain unanswered until the owner runs setup.
                answered: false,
            },
            files: coworker.members.map(member => ({
                path: member.path,
                bytes: member.bytes,
                kind: member.kind,
                sourceRevision: member.contentDigest,
                flagged: member.flagged,
                binary: member.binary,
                textScanned: member.textScanned,
            })),
            exclusions: coworker.exclusions,
            redactions: coworker.redactions,
            strippedConfigKeys: coworker.strippedConfigKeys,
            requirements: coworker.requirements,
            envKeys: coworker.envKeys,
            mcpAuth: coworker.mcpAuth,
        }))

        const body: Omit<TemplateManifest, 'revision'> = {
            version: 1,
            kind: 'desktop-local-template',
            templateId,
            title,
            capturedAt: new Date().toISOString(),
            planRevision: sha256(canonicalJson({ kind: 'portable-import', packageKey: manifest.packageKey, contentDigest: manifest.contentDigest })),
            requestId: input.requestId,
            proseWarning: DESKTOP_TEMPLATE_PROSE_WARNING,
            limits: DESKTOP_TEMPLATE_LIMITS,
            engineCommit: null,
            coworkers: localCoworkers,
        }
        const sealed = sealManifest(body)
        const directory = join(templateHome(input.deps.dataRoot, templateId), 'revisions', sealed.revision)
        await ensurePrivateDir(directory)
        for (const member of members) {
            await writeExclusiveFile(directory, `${member.agentKey}/${member.path}`, member.bytes)
        }
        await writeOwnJson(directory, 'manifest.json', sealed)
        await writeOwnJson(directory, 'portable-provenance.json', {
            importedAt: body.capturedAt,
            sourcePackageKey: manifest.packageKey,
            sourceContentDigest: manifest.contentDigest,
            sourceTitle: manifest.title,
            uploadId: input.uploadId,
            fidelity: manifest.fidelity,
        })
        await replaceOwnJson(templateHome(input.deps.dataRoot, templateId), 'current.json', { revision: sealed.revision })
        const provenance: DesktopPortableProvenance = {
            importedAt: body.capturedAt,
            sourcePackageKey: manifest.packageKey,
            sourceContentDigest: manifest.contentDigest,
            sourceTitle: manifest.title,
            uploadId: input.uploadId,
        }
        await replaceOwnJson(home, `portable-import-${input.requestId}.json`, {
            version: 1,
            requestId: input.requestId,
            uploadId: input.uploadId,
            fingerprint,
            templateId,
            revision: sealed.revision,
            provenance,
        })
        return {
            status: 'imported',
            requestId: input.requestId,
            receiptId: input.requestId,
            templateId,
            revision: sealed.revision,
            provenance,
            fidelity: manifest.fidelity,
        }
    } catch (error) {
        if (error instanceof TemplateRequestError && (error.status === 400 || error.status === 404 || error.status === 409 || error.status === 413 || error.status === 503)) throw error
        return {
            status: 'uncertain',
            requestId: input.requestId,
            receiptId: input.requestId,
            recoverable: true,
            reason: error instanceof Error ? error.message.slice(0, 400) : 'Portable import did not finish',
        }
    }
}
