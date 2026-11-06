import { lstat, mkdtemp, rm } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { z } from 'zod'
import {
    DESKTOP_PORTABLE_TEMPLATE_LIMITS,
    DESKTOP_TEMPLATE_LIMITS,
    desktopTemplateAgentKeySchema,
    desktopTemplateDetailSchema,
    desktopTemplateExclusionSchema,
    desktopTemplateIdSchema,
    desktopTemplateRedactionSchema,
    desktopTemplateRelativePathSchema,
    desktopTemplateRevisionSchema,
    desktopPortableCoworkerSchema,
    desktopTemplateMediaTypeSchema,
    type DesktopTemplateDetail,
} from '@rerun/contracts'
import { withPortableLibraryLease } from './portable-lock.js'
import { TemplateRequestError } from './errors.js'
import { readConfined, writeExclusiveFile } from './files.js'
import { canonicalJson, sha256 } from './hash.js'
import { renameSkillEntry } from '../skill-publication-native.js'
import { readOwnJson, replaceOwnJson, templateHome, writeOwnJson } from './store.js'

const fileSchema = z.strictObject({
    path: desktopTemplateRelativePathSchema,
    bytes: z.number().int().nonnegative().max(DESKTOP_PORTABLE_TEMPLATE_LIMITS.maxFileBytes),
    kind: z.enum(['instruction', 'config', 'text', 'skill', 'binary']),
    sourceRevision: desktopTemplateRevisionSchema,
    flagged: z.array(z.string().min(1).max(80)).max(20),
    binary: z.boolean().optional(),
    textScanned: z.boolean().optional(),
    mediaType: desktopTemplateMediaTypeSchema.optional(),
})
const coworkerSchema = z.strictObject({
    agentKey: desktopTemplateAgentKeySchema,
    sourceEngineId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    name: z.string().min(1).max(60),
    description: z.string().max(2_000),
    setup: z.strictObject({
        required: z.boolean().nullable(),
        prompt: z.string().max(DESKTOP_TEMPLATE_LIMITS.maxFileBytes),
        answered: z.boolean(),
    }),
    files: z.array(fileSchema).max(DESKTOP_PORTABLE_TEMPLATE_LIMITS.maxFiles),
    exclusions: z.array(desktopTemplateExclusionSchema).max(500),
    redactions: z.array(desktopTemplateRedactionSchema).max(50),
    strippedConfigKeys: z.array(z.string().min(1).max(200)).max(100),
    requirements: desktopPortableCoworkerSchema.shape.requirements.optional(),
    envKeys: desktopPortableCoworkerSchema.shape.envKeys.optional(),
    mcpAuth: desktopPortableCoworkerSchema.shape.mcpAuth.optional(),
})
const manifestSchema = z.strictObject({
    version: z.literal(1),
    kind: z.literal('desktop-local-template'),
    templateId: desktopTemplateIdSchema,
    revision: desktopTemplateRevisionSchema,
    title: z.string().min(1).max(DESKTOP_TEMPLATE_LIMITS.maxTitleLength),
    capturedAt: z.string().min(20).max(40),
    planRevision: desktopTemplateRevisionSchema,
    requestId: z.uuid(),
    proseWarning: desktopTemplateDetailSchema.shape.proseWarning,
    limits: desktopTemplateDetailSchema.shape.limits,
    engineCommit: z.null(),
    coworkers: z.array(coworkerSchema).min(1).max(DESKTOP_TEMPLATE_LIMITS.maxCoworkers),
})
export type TemplateManifest = z.infer<typeof manifestSchema>

const importReceiptSchema = z.strictObject({
    version: z.literal(1),
    importReceiptId: z.uuid(),
    templateId: desktopTemplateIdSchema,
    revision: desktopTemplateRevisionSchema,
    engineAgentId: z.string().regex(/^i[a-f0-9]{31}$/),
    agentKey: desktopTemplateAgentKeySchema,
    phase: z.enum(['bound', 'files', 'indexed']),
    foremanDisabled: z.literal(true).optional(),
    folder: z.strictObject({dev:z.string(),ino:z.string()}).optional(),
})
type ImportReceipt = z.infer<typeof importReceiptSchema>

const ALLOWED = /^(?:SOUL\.md|INSTALL\.md|config\.json|workspace\/(?!\.rerun(?:\/|$)).+|skills\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}\/.+)$/
export const isTemplateManifestPath = (path: string): boolean => ALLOWED.test(path)

export function manifestBody(manifest: TemplateManifest): Omit<TemplateManifest, 'revision'> {
    const { revision, ...body } = manifest
    void revision
    return body
}

export function sealManifest(body: Omit<TemplateManifest, 'revision'>): TemplateManifest {
    const revision = sha256(canonicalJson(body))
    return manifestSchema.parse({ ...body, revision })
}

export async function readManifest(dataRoot: string, templateId: string, revision: string): Promise<TemplateManifest> {
    if (!desktopTemplateRevisionSchema.safeParse(revision).success) throw new TemplateRequestError(400, 'Invalid template revision')
    const directory = join(templateHome(dataRoot, templateId), 'revisions', revision)
    const parsed = manifestSchema.safeParse(await readOwnJson(directory, 'manifest.json'))
    if (!parsed.success) throw new TemplateRequestError(409, 'Template manifest metadata is not supported')
    if (parsed.data.templateId !== templateId || parsed.data.revision !== revision) throw new TemplateRequestError(409, 'Template revision does not match its manifest')
    if (sha256(canonicalJson(manifestBody(parsed.data))) !== revision) throw new TemplateRequestError(409, 'Template revision does not match its manifest')
    const seen = new Set<string>()
    let total = 0
    for (const coworker of parsed.data.coworkers) {
        if (seen.has(coworker.agentKey)) throw new TemplateRequestError(409, 'Template manifest repeats a coworker')
        seen.add(coworker.agentKey)
        const paths = new Set<string>()
        for (const file of coworker.files) {
            if (!ALLOWED.test(file.path) || paths.has(file.path)) throw new TemplateRequestError(409, 'Template manifest has an unsupported path')
            paths.add(file.path)
            total += file.bytes
            const reader = file.binary || file.kind === 'binary'
                ? (await import('./files.js')).readConfinedBytes
                : readConfined
            const stored = await reader(join(directory, coworker.agentKey), file.path, DESKTOP_PORTABLE_TEMPLATE_LIMITS.maxFileBytes)
            if (!stored.ok || stored.bytes.length !== file.bytes || stored.contentRevision !== file.sourceRevision) {
                throw new TemplateRequestError(409, 'Template bytes do not match the manifest')
            }
        }
    }
    const fileCount = parsed.data.coworkers.reduce((sum, coworker) => sum + coworker.files.length, 0)
    const maxFiles = Math.max(DESKTOP_TEMPLATE_LIMITS.maxFiles, DESKTOP_PORTABLE_TEMPLATE_LIMITS.maxFiles)
    const maxTotal = Math.max(DESKTOP_TEMPLATE_LIMITS.maxTotalBytes, DESKTOP_PORTABLE_TEMPLATE_LIMITS.maxTotalBytes)
    if (fileCount > maxFiles || total > maxTotal) {
        throw new TemplateRequestError(413, 'Template exceeds the capture limit')
    }
    return parsed.data
}

export function publicDetail(manifest: TemplateManifest): DesktopTemplateDetail {
    return desktopTemplateDetailSchema.parse({
        templateId: manifest.templateId,
        title: manifest.title,
        revision: manifest.revision,
        capturedAt: manifest.capturedAt,
        proseWarning: manifest.proseWarning,
        limits: manifest.limits,
        engineCommit: null,
        coworkers: manifest.coworkers.map(coworker => ({
            agentKey: coworker.agentKey,
            name: coworker.name,
            description: coworker.description,
            setup: coworker.setup,
            files: coworker.files.map(file => ({
                ...file,
                binary: file.binary ?? file.kind === 'binary',
                textScanned: file.textScanned ?? file.kind !== 'binary',
            })),
            exclusions: coworker.exclusions,
            redactions: coworker.redactions,
            strippedConfigKeys: coworker.strippedConfigKeys,
            requirements: coworker.requirements ?? [],
            envKeys: coworker.envKeys ?? [],
            mcpAuth: coworker.mcpAuth ?? [],
        })),
    })
}

export type InstalledPhase = { engineAgentId: string; agentKey: string; name: string; description: string; phase: 'indexed' | 'partial' | 'foreign' }

function destination(agentsRoot: string, engineAgentId: string): string {
    if (!/^i[a-f0-9]{31}$/.test(engineAgentId)) throw new TemplateRequestError(400, 'Invalid imported coworker')
    const root = resolve(agentsRoot)
    const folder = resolve(root, engineAgentId)
    const rel = relative(root, folder)
    if (rel !== engineAgentId) throw new TemplateRequestError(400, 'Invalid imported coworker')
    return folder
}

async function readReceipt(folder: string): Promise<ImportReceipt | null> {
    const parsed = importReceiptSchema.safeParse(await readOwnJson(folder, '.desktop-template-import.json'))
    return parsed.success ? parsed.data : null
}

async function installManifestUnlocked(input: {
    foremanDisabled?: true
    dataRoot: string
    agentsRoot: string
    importReceiptId: string
    templateId: string
    revision: string
    coworkers: { engineAgentId: string; agentKey: string }[]
    insertIndex: (id: string, name: string) => Promise<void>
    readIndex: (id: string) => Promise<{ name: string } | null>
}): Promise<{ status: 'ready' | 'uncertain'; reason?: string; coworkers: InstalledPhase[] }> {
    const manifest = await readManifest(input.dataRoot, input.templateId, input.revision)
    const wanted = new Map(input.coworkers.map(coworker => [coworker.agentKey, coworker.engineAgentId]))
    if (wanted.size !== input.coworkers.length || manifest.coworkers.some(coworker => !wanted.has(coworker.agentKey)) || wanted.size !== manifest.coworkers.length) {
        throw new TemplateRequestError(400, 'Install does not match this template revision')
    }
    const sourceIds = new Set(manifest.coworkers.map(coworker => coworker.sourceEngineId))
    for (const engineAgentId of wanted.values()) {
        if (sourceIds.has(engineAgentId)) throw new TemplateRequestError(409, 'Import refused to overwrite a source coworker')
    }
    // Capacity is checked inside readManifest before any destination is created.
    const phases: InstalledPhase[] = []
    let uncertain: string | null = null
    for (const coworker of manifest.coworkers) {
        const engineAgentId = wanted.get(coworker.agentKey)!
        const folder = destination(input.agentsRoot, engineAgentId)
        const sourceFolder = resolve(input.agentsRoot, coworker.sourceEngineId)
        if (resolve(folder) === sourceFolder) throw new TemplateRequestError(409, 'Import refused to overwrite a source coworker')
        const kind = await lstat(folder).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error))
        if (kind?.isSymbolicLink() || (kind && !kind.isDirectory())) {
            phases.push({ engineAgentId, agentKey: coworker.agentKey, name: coworker.name, description: coworker.description, phase: 'foreign' })
            uncertain = 'An imported coworker path is not a plain directory owned by this receipt'
            continue
        }
        const bound: ImportReceipt = {
            version: 1, importReceiptId: input.importReceiptId, templateId: input.templateId, revision: input.revision,
            engineAgentId, agentKey: coworker.agentKey, phase: 'bound', ...(input.foremanDisabled && { foremanDisabled: true }),
        }
        if (!kind) {
            const staged = await mkdtemp(join(input.agentsRoot, '.template-import-'))
            try {
                const identity = await lstat(staged,{bigint:true})
                await writeOwnJson(staged, '.desktop-template-import.json', {...bound,...(input.foremanDisabled && {folder:{dev:String(identity.dev),ino:String(identity.ino)}})})
                await renameSkillEntry(input.agentsRoot, await lstat(input.agentsRoot, { bigint: true }), staged.split('/').at(-1)!, await lstat(staged, { bigint: true }), engineAgentId)
            } finally { await rm(staged, { recursive: true, force: true }) }
        }
        const receipt = await readReceipt(folder)
        const identity = await lstat(folder,{bigint:true})
        const ownedForemanFolder = !input.foremanDisabled || (receipt?.folder?.dev === String(identity.dev) && receipt.folder.ino === String(identity.ino))
        if (!ownedForemanFolder || !receipt || receipt.importReceiptId !== bound.importReceiptId || receipt.engineAgentId !== engineAgentId || receipt.templateId !== bound.templateId || receipt.revision !== bound.revision || receipt.agentKey !== coworker.agentKey || receipt.foremanDisabled !== bound.foremanDisabled) {
            phases.push({ engineAgentId, agentKey: coworker.agentKey, name: coworker.name, description: coworker.description, phase: 'foreign' })
            uncertain = 'An imported coworker folder is not owned by this receipt'
            continue
        }
        const archiveDir = join(templateHome(input.dataRoot, input.templateId), 'revisions', input.revision, coworker.agentKey)
        let partial = false
        for (const file of receipt.phase === 'bound' ? coworker.files : []) {
            const reader = file.binary || file.kind === 'binary'
                ? (await import('./files.js')).readConfinedBytes
                : readConfined
            const stored = await reader(archiveDir, file.path, DESKTOP_PORTABLE_TEMPLATE_LIMITS.maxFileBytes)
            if (!stored.ok || stored.contentRevision !== file.sourceRevision) {
                partial = true
                uncertain = 'Template bytes changed before import finished'
                break
            }
            let bytes = stored.bytes
            if (input.foremanDisabled && file.path === 'config.json') {
                // The captured conservative config remains otherwise exact; enabling is reserved
                // for the later explicit lead action. No runnable enabled window during import.
                const config = JSON.parse(Buffer.from(bytes).toString('utf8'))
                bytes = Buffer.from(JSON.stringify({ ...config, enabled: false }, null, 4), 'utf8')
            }
            try { await writeExclusiveFile(folder, file.path, bytes) }
            catch (error) {
                if (error instanceof TemplateRequestError && error.status === 409) {
                    partial = true
                    uncertain = 'An imported file already has different bytes'
                    break
                }
                throw error
            }
        }
        if (partial) {
            phases.push({ engineAgentId, agentKey: coworker.agentKey, name: coworker.name, description: coworker.description, phase: 'partial' })
            continue
        }
        await writeOwnJson(folder, '.desktop-template-requirements.json', { version: 1, importReceiptId: input.importReceiptId, requirements: coworker.requirements ?? [] })
        if (receipt.phase === 'bound') await replaceOwnJson(folder, '.desktop-template-import.json', { ...receipt, phase: 'files' })
        try {
            const indexed = await input.readIndex(engineAgentId)
            if (!indexed) await input.insertIndex(engineAgentId, coworker.name)
            else if (indexed.name !== coworker.name) {
                phases.push({ engineAgentId, agentKey: coworker.agentKey, name: coworker.name, description: coworker.description, phase: 'partial' })
                uncertain = 'The engine index for an imported coworker does not match this receipt'
                continue
            }
        } catch {
            phases.push({ engineAgentId, agentKey: coworker.agentKey, name: coworker.name, description: coworker.description, phase: 'partial' })
            uncertain = 'The engine index for an imported coworker could not be saved'
            continue
        }
        await replaceOwnJson(folder, '.desktop-template-import.json', { ...receipt, phase: 'indexed' })
        phases.push({ engineAgentId, agentKey: coworker.agentKey, name: coworker.name, description: coworker.description, phase: 'indexed' })
    }
    if (uncertain || phases.some(phase => phase.phase !== 'indexed')) {
        return { status: 'uncertain', reason: uncertain ?? 'Import did not finish every coworker', coworkers: phases }
    }
    return { status: 'ready', coworkers: phases }
}

/** Foreman lookup is read-only and proves the original imported directory, not merely its name. */
export async function readForemanTemplateImport(agentsRoot: string, engineAgentId: string, importReceiptId: string) {
    const path = destination(agentsRoot,engineAgentId)
    const before = await lstat(path,{bigint:true}).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error))
    if (!before) return {state:'absent' as const}
    if (!before.isDirectory() || before.isSymbolicLink()) return {state:'replaced' as const}
    const receipt = await readReceipt(path)
    const after = await lstat(path,{bigint:true})
    if (!receipt || !receipt.foremanDisabled || receipt.engineAgentId !== engineAgentId || receipt.importReceiptId !== importReceiptId || receipt.folder?.dev !== String(before.dev) || receipt.folder.ino !== String(before.ino) || before.dev !== after.dev || before.ino !== after.ino) return {state:'replaced' as const}
    if (receipt.phase !== 'indexed') return {state:'unknown' as const}
    return {state:'present' as const,engineAgentId,importReceiptId,templateId:receipt.templateId,revision:receipt.revision}
}

export function installManifest(input: Parameters<typeof installManifestUnlocked>[0]): ReturnType<typeof installManifestUnlocked> {
    return withPortableLibraryLease(input.dataRoot, () => installManifestUnlocked(input))
}
