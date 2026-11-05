import { join } from 'node:path'
import {
    DESKTOP_PORTABLE_TEMPLATE_FORMAT,
    DESKTOP_PORTABLE_TEMPLATE_FORMAT_VERSION,
    DESKTOP_PORTABLE_TEMPLATE_LIMITS,
    DESKTOP_PORTABLE_TEMPLATE_PROSE_WARNING,
    DESKTOP_TEMPLATE_PROSE_WARNING,
    type DesktopPortableExportResult,
    type DesktopPortableMember,
    type DesktopPortablePackageManifest,
} from '@rerun/contracts'
import { TemplateRequestError } from './errors.js'
import { readConfined, readConfinedBytes } from './files.js'
import { canonicalJson, sha256 } from './hash.js'
import { readManifest, type TemplateManifest } from './install.js'
import { readOwnJson, requestHome, templateHome, writeOwnJson, replaceOwnJson } from './store.js'
import { sealPortableManifest, writeOwnedDownloadArtifact, writePortableArchive, type PortablePackageMemberBytes } from './portable-package.js'
import { z } from 'zod'
import { desktopTemplateRevisionSchema } from '@rerun/contracts'

const exportReceiptSchema = z.strictObject({
    version: z.literal(1),
    requestId: z.uuid(),
    templateId: z.string(),
    revision: desktopTemplateRevisionSchema,
    fingerprint: desktopTemplateRevisionSchema,
    artifactId: z.string().regex(/^[a-f0-9]{32}$/).optional(),
    contentDigest: desktopTemplateRevisionSchema.optional(),
    bytes: z.number().int().positive().optional(),
    fileName: z.string().min(1).max(180).optional(),
    fidelity: z.strictObject({
        binaryAssets: z.boolean(),
        userSkillTrees: z.boolean(),
        sourceKind: z.enum(['portable-capture', 'local-v1-export']),
        notes: z.array(z.string()).max(20),
    }).optional(),
})

export type PortableExportDeps = {
    dataRoot: string
    publishDownloadArtifact: (bytes: Buffer, fileName: string) => Promise<{ artifactId: string }>
}

function fidelityFor(manifest: TemplateManifest) {
    const files = manifest.coworkers.flatMap(coworker => coworker.files)
    const hasBinary = files.some(file => file.kind === 'binary' || file.binary === true)
    const hasSkills = files.some(file => file.kind === 'skill')
    const notes: string[] = []
    if (!hasBinary) notes.push('This local revision was captured without binary assets. Export will not invent missing binaries.')
    if (!hasSkills) notes.push('This local revision has no user skill trees.')
    notes.push('Existing text-only local captures are not advertised as full portable fidelity.')
    return {
        binaryAssets: hasBinary,
        userSkillTrees: hasSkills,
        sourceKind: 'local-v1-export' as const,
        notes,
    }
}

function toPortableMembers(manifest: TemplateManifest, dataRoot: string): Promise<{ members: PortablePackageMemberBytes[]; coworkers: DesktopPortablePackageManifest['coworkers'] }> {
    return (async () => {
        const members: PortablePackageMemberBytes[] = []
        const coworkers: DesktopPortablePackageManifest['coworkers'] = []
        for (const coworker of manifest.coworkers) {
            const archiveDir = join(templateHome(dataRoot, manifest.templateId), 'revisions', manifest.revision, coworker.agentKey)
            const portableMembers: DesktopPortableMember[] = []
            for (const file of coworker.files) {
                const binary = file.kind === 'binary' || file.binary === true
                const read = binary
                    ? await readConfinedBytes(archiveDir, file.path, DESKTOP_PORTABLE_TEMPLATE_LIMITS.maxFileBytes)
                    : await readConfined(archiveDir, file.path, DESKTOP_PORTABLE_TEMPLATE_LIMITS.maxFileBytes)
                if (!read.ok || read.bytes.length !== file.bytes || read.contentRevision !== file.sourceRevision) {
                    throw new TemplateRequestError(409, 'Template bytes changed before export finished')
                }
                const digest = read.contentRevision
                members.push({ agentKey: coworker.agentKey, path: file.path, bytes: read.bytes, digest })
                portableMembers.push({
                    path: file.path,
                    bytes: file.bytes,
                    kind: file.kind === 'binary' ? 'binary' : file.kind,
                    contentDigest: digest,
                    flagged: file.flagged,
                    binary,
                    textScanned: file.textScanned ?? !binary,
                })
            }
            coworkers.push({
                agentKey: coworker.agentKey,
                name: coworker.name,
                description: coworker.description,
                setup: coworker.setup,
                members: portableMembers,
                exclusions: coworker.exclusions,
                redactions: coworker.redactions,
                strippedConfigKeys: coworker.strippedConfigKeys,
                requirements: coworker.requirements ?? [],
                envKeys: coworker.envKeys ?? [],
                mcpAuth: coworker.mcpAuth ?? [],
            })
        }
        return { members, coworkers }
    })()
}

export async function exportDesktopPortableTemplate(input: {
    requestId: string
    templateId: string
    revision: string
    deps: PortableExportDeps
}): Promise<DesktopPortableExportResult> {
    const fingerprint = sha256(canonicalJson({ operation: 'export', requestId: input.requestId, templateId: input.templateId, revision: input.revision }))
    const home = requestHome(input.deps.dataRoot)
    const priorRaw = await readOwnJson(home, `portable-export-${input.requestId}.json`)
    const prior = exportReceiptSchema.safeParse(priorRaw)
    if (priorRaw && (!prior.success || prior.data.fingerprint !== fingerprint)) {
        throw new TemplateRequestError(409, 'This export request already belongs to another package')
    }
    if (prior.success && prior.data.artifactId && prior.data.contentDigest && prior.data.fileName && prior.data.bytes && prior.data.fidelity) {
        return {
            status: 'exported',
            requestId: input.requestId,
            receiptId: input.requestId,
            templateId: input.templateId,
            revision: input.revision,
            artifactId: prior.data.artifactId,
            contentDigest: prior.data.contentDigest,
            bytes: prior.data.bytes,
            fileName: prior.data.fileName,
            fidelity: prior.data.fidelity,
        }
    }
    const startedAt = Date.now()
    const manifest = await readManifest(input.deps.dataRoot, input.templateId, input.revision)
    const fidelity = fidelityFor(manifest)
    const { members, coworkers } = await toPortableMembers(manifest, input.deps.dataRoot)
    const packageKey = sha256(canonicalJson({ templateId: input.templateId, revision: input.revision })).slice(0, 32)
    const body = {
        format: DESKTOP_PORTABLE_TEMPLATE_FORMAT,
        formatVersion: DESKTOP_PORTABLE_TEMPLATE_FORMAT_VERSION,
        packageKey,
        title: manifest.title,
        capturedAt: manifest.capturedAt,
        proseWarning: fidelity.binaryAssets ? DESKTOP_PORTABLE_TEMPLATE_PROSE_WARNING : DESKTOP_TEMPLATE_PROSE_WARNING,
        limits: DESKTOP_PORTABLE_TEMPLATE_LIMITS,
        coworkers,
        fidelity,
        excludedCategories: [
            'credentials', 'history', 'memory', 'database', 'connector-skill', 'system-skill',
            'service-registry', 'native-grant', 'tool-permissions', 'active-schedule', 'active-trigger',
            'browser-profile', 'private-memory', 'paid-data', 'cached-pages', 'chat-transcript',
            'tool-arguments', 'telemetry', 'marketplace', 'hosted-publish',
        ],
    } as const
    const portableManifest = sealPortableManifest(body)
    if (!prior.success) {
        await writeOwnJson(home, `portable-export-${input.requestId}.json`, {
            version: 1, requestId: input.requestId, templateId: input.templateId, revision: input.revision, fingerprint,
        })
    }
    try {
        const built = await writePortableArchive({
            title: manifest.title,
            packageKey,
            manifest: portableManifest,
            members,
            startedAt,
        })
        const published = await writeOwnedDownloadArtifact(input.deps.publishDownloadArtifact, built)
        await replaceOwnJson(home, `portable-export-${input.requestId}.json`, {
            version: 1,
            requestId: input.requestId,
            templateId: input.templateId,
            revision: input.revision,
            fingerprint,
            artifactId: published.artifactId,
            contentDigest: built.contentDigest,
            bytes: published.bytes,
            fileName: published.fileName,
            fidelity,
        })
        return {
            status: 'exported',
            requestId: input.requestId,
            receiptId: input.requestId,
            templateId: input.templateId,
            revision: input.revision,
            artifactId: published.artifactId,
            contentDigest: built.contentDigest,
            bytes: published.bytes,
            fileName: published.fileName,
            fidelity,
        }
    } catch (error) {
        if (error instanceof TemplateRequestError && (error.status === 400 || error.status === 404 || error.status === 409 || error.status === 413 || error.status === 503)) throw error
        return {
            status: 'uncertain',
            requestId: input.requestId,
            receiptId: input.requestId,
            recoverable: true,
            reason: error instanceof Error ? error.message.slice(0, 400) : 'Portable export did not finish',
        }
    }
}
