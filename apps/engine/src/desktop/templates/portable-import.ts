import { join } from 'node:path'
import { z } from 'zod'
import {
    DESKTOP_PORTABLE_TEMPLATE_LIMITS,
    DESKTOP_TEMPLATE_LIMITS,
    DESKTOP_TEMPLATE_PROSE_WARNING,
    DESKTOP_PORTABLE_TEMPLATE_PROSE_WARNING,
    desktopTemplateIdSchema,
    desktopTemplateRevisionSchema,
    desktopTemplateFidelityManifestSchema as desktopPortablePackageManifestSchema,
    desktopPortableRequirementSchema,
    scanPathForSecrets,
    type DesktopPortableImportResult,
    type DesktopPortableProvenance,
} from '@rerun/contracts'
import { normalizeTemplateRequirements, templateMediaType } from './fidelity.ts'
import { TemplateRequestError } from './errors.ts'
import { writeExclusiveFile, ensurePrivateDir } from './files.ts'
import { canonicalJson, draftRevision, newTemplateId, sha256 } from './hash.ts'
import { isTemplateManifestPath, readManifest, sealManifest, type TemplateManifest } from './install.ts'
import { scrubConfig } from './inspect.ts'
import { withPortableLibraryLease } from './portable-lock.ts'
import { readOwnJson, replaceOwnJson, requestHome, templateHome, writeOwnJson } from './store.ts'
import { readImmutableUploadBytes, readPortableArchive } from './portable-package.ts'

const importReceiptSchema = z.strictObject({
    version: z.literal(1),
    requestId: z.uuid(),
    uploadId: z.uuid(),
    fingerprint: desktopTemplateRevisionSchema,
    phase: z.enum(['reserved', 'published']).optional(),
    capturedAt: z.string().min(20).max(40).optional(),
    fidelity: desktopPortablePackageManifestSchema.shape.fidelity.optional(),
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

async function importUnlocked(input: {
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
    if (prior.success && prior.data.phase === 'published' && prior.data.templateId && prior.data.revision && prior.data.provenance && prior.data.fidelity) {
        return {
            status: 'imported',
            requestId: input.requestId,
            receiptId: input.requestId,
            templateId: prior.data.templateId,
            revision: prior.data.revision,
            provenance: prior.data.provenance as DesktopPortableProvenance,
            fidelity: prior.data.fidelity,
        }
    }


    const startedAt = Date.now()
    try {
        if (!input.deps.readImmutableUpload) throw new TemplateRequestError(503, 'Immutable upload callback is not configured')
        const archiveBytes = await readImmutableUploadBytes(() => input.deps.readImmutableUpload(input.uploadId))
        const { manifest, members } = await readPortableArchive(archiveBytes, startedAt)
        if (members.some(member => !isTemplateManifestPath(member.path) || scanPathForSecrets(member.path).length > 0)) throw new TemplateRequestError(400, 'Portable package contains an unsupported coworker file')
        const title = (input.title?.trim() || manifest.title).slice(0, DESKTOP_PORTABLE_TEMPLATE_LIMITS.maxTitleLength)
        const templateId = prior.success && prior.data.templateId ? prior.data.templateId : newTemplateId()
        const draft = {
            version: 1 as const,
            requestId: input.requestId,
            templateId,
            title,
            revision: draftRevision(input.requestId, templateId, title),
        }

        for (const coworker of manifest.coworkers) {
            coworker.requirements = normalizeTemplateRequirements(coworker.requirements)
            if (coworker.envKeys.some(key => !/^[A-Z_][A-Z0-9_]{0,127}$/.test(key)) || coworker.mcpAuth.some(auth => !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(auth.server))) throw new TemplateRequestError(400, 'Portable requirement names are not supported')
            for (const member of coworker.members) {
                const bytes = members.find(item => item.agentKey === coworker.agentKey && item.path === member.path)!
                const inferred = templateMediaType(member.path, bytes.bytes, member.binary)
                if (member.mediaType && member.mediaType !== inferred) throw new TemplateRequestError(409, 'Portable member media type does not match its bytes')
            }
            const config = members.find(member => member.agentKey === coworker.agentKey && member.path === 'config.json')
            if (!config) throw new TemplateRequestError(400, 'Portable coworker is missing config.json')
            let raw: unknown
            try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(config.bytes)) }
            catch { throw new TemplateRequestError(400, 'Portable coworker config is not JSON') }
            const scrubbed = scrubConfig(raw, coworker.name)
            if ('error' in scrubbed) throw new TemplateRequestError(400, scrubbed.error)
            config.bytes = Buffer.from(scrubbed.text)
            config.digest = sha256(config.bytes)
            coworker.strippedConfigKeys = [...new Set([...coworker.strippedConfigKeys, ...scrubbed.stripped])].slice(0, 100)
            coworker.requirements = z.array(desktopPortableRequirementSchema).max(200).parse([...new Map([...coworker.requirements, ...scrubbed.requirements].map(item => [`${item.kind}:${item.name}`, item])).values()])
            coworker.mcpAuth = [...new Map([...coworker.mcpAuth, ...scrubbed.mcpAuth].map(item => [`${item.server}:${item.kind}`, item])).values()].slice(0, 50)
        }
        const localCoworkers: TemplateManifest['coworkers'] = manifest.coworkers.map(coworker => ({
            agentKey: coworker.agentKey,
            sourceEngineId: `imported-${coworker.agentKey}`,
            enabled: JSON.parse(members.find(item => item.agentKey === coworker.agentKey && item.path === 'config.json')!.bytes.toString('utf8')).enabled !== false,
            name: coworker.name,
            description: coworker.description,
            setup: {
                ...coworker.setup,
                // Receiving install must remain unanswered until the owner runs setup.
                answered: false,
            },
            files: coworker.members.map(member => {
                const bytes = members.find(item => item.agentKey === coworker.agentKey && item.path === member.path)!
                return {
                    path: member.path,
                    bytes: bytes.bytes.length,
                    kind: member.path === 'config.json' ? 'config' as const : member.kind,
                    sourceRevision: bytes.digest,
                    flagged: member.flagged,
                    binary: member.path === 'config.json' ? false : member.binary,
                    textScanned: member.path === 'config.json' ? true : member.textScanned,
                    mediaType: templateMediaType(member.path, bytes.bytes, member.binary),
                }
            }),
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
            capturedAt: prior.success && prior.data.capturedAt ? prior.data.capturedAt : new Date().toISOString(),
            planRevision: sha256(canonicalJson({ kind: 'portable-import', packageKey: manifest.packageKey, contentDigest: manifest.contentDigest })),
            requestId: input.requestId,
            proseWarning: manifest.fidelity.binaryAssets ? DESKTOP_PORTABLE_TEMPLATE_PROSE_WARNING : DESKTOP_TEMPLATE_PROSE_WARNING,
            limits: DESKTOP_TEMPLATE_LIMITS,
            engineCommit: null,
            coworkers: localCoworkers,
        }
        const sealed = sealManifest(body)
        const provenance: DesktopPortableProvenance = {
            importedAt: body.capturedAt,
            sourcePackageKey: manifest.packageKey,
            sourceContentDigest: manifest.contentDigest,
            sourceTitle: manifest.title,
            uploadId: input.uploadId,
        }
        const reservation = {
            version: 1 as const, requestId: input.requestId, uploadId: input.uploadId, fingerprint,
            phase: 'reserved' as const, templateId, revision: sealed.revision, capturedAt: body.capturedAt,
            provenance, fidelity: manifest.fidelity,
        }
        if (prior.success && prior.data.templateId && (prior.data.templateId !== templateId || prior.data.revision !== sealed.revision || canonicalJson(prior.data.provenance) !== canonicalJson(provenance))) {
            throw new TemplateRequestError(409, 'The reserved import no longer matches these immutable bytes')
        }
        if (!prior.success) await writeOwnJson(home, `portable-import-${input.requestId}.json`, reservation)
        else await replaceOwnJson(home, `portable-import-${input.requestId}.json`, reservation)
        await writeOwnJson(templateHome(input.deps.dataRoot, templateId), 'draft.json', draft)
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
        await readManifest(input.deps.dataRoot, templateId, sealed.revision)
        await replaceOwnJson(templateHome(input.deps.dataRoot, templateId), 'current.json', { revision: sealed.revision })
        await replaceOwnJson(home, `portable-import-${input.requestId}.json`, { ...reservation, phase: 'published' })

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
        if (error instanceof z.ZodError) throw new TemplateRequestError(400, 'Portable package does not match supported coworker settings')
        if (error instanceof TemplateRequestError && (error.status === 400 || error.status === 404 || error.status === 409 || error.status === 413 || error.status === 503)) throw error
        return {
            status: 'uncertain',
            requestId: input.requestId,
            receiptId: input.requestId,
            recoverable: true,
            reason: 'The local portable operation did not finish. Retry the same request.',
        }
    }
}

export function importDesktopPortableTemplate(input: Parameters<typeof importUnlocked>[0]): Promise<DesktopPortableImportResult> {
    return withPortableLibraryLease(input.deps.dataRoot, () => importUnlocked(input))
}
