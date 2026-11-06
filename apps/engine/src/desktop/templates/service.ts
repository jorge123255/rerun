import { join } from 'node:path'
import { withSkillReadLease } from '../skill-publication.js'
import { assertUserSkillOperation } from '../service-skills/authority.js'
import { z } from 'zod'
import {
    DESKTOP_PORTABLE_TEMPLATE_LIMITS,
    DESKTOP_PORTABLE_TEMPLATE_PROSE_WARNING,
    DESKTOP_TEMPLATE_LIMITS,
    DESKTOP_TEMPLATE_PROSE_WARNING,
    desktopTemplateCoworkerPlanSchema,
    desktopPortableRequirementSchema,
    desktopPortablePackageManifestSchema,
    desktopTemplateIdSchema,
    desktopTemplatePlanSchema,
    desktopTemplateRevisionSchema,
    desktopTemplateSelectionSchema,
    type DesktopTemplateCoworkerPlan,
    type DesktopTemplateDetail,
    type DesktopTemplateList,
    type DesktopTemplatePlan,
} from '@rerun/contracts'
import { withPortableLibraryLease } from './portable-lock.js'
import { TemplateRequestError } from './errors.js'
import { writeExclusiveFile, ensurePrivateDir } from './files.js'
import { canonicalJson, draftRevision, newTemplateId, sha256 } from './hash.js'
import { inspectCoworker, type InspectedCoworker, type InspectedFile, type SkillOwnershipResolver } from './inspect.js'
import { installManifest, publicDetail, readManifest, sealManifest, type TemplateManifest } from './install.js'
import { draftSchema, listTemplateIds, readOwnJson, replaceOwnJson, requestHome, templateHome, writeOwnJson, type TemplateDraft } from './store.js'

export type TemplateRoots = { dataRoot: string; agentsRoot: string }
export type TemplateIndex = {
    get: (id: string) => Promise<{ name: string; createdAt?: string; status?: string } | null>
    insert: (id: string, name: string, createdAt?: string) => Promise<void>
}
export type TemplateEngineOptions = {
    requirementNames?: (engineAgentId: string) => Promise<import('@rerun/contracts').DesktopTemplateRequirement[]>
    skillOwnership?: SkillOwnershipResolver | null
    includeBinary?: boolean
    requireTrustedOwnership?: boolean
}

const bindingSchema = z.strictObject({
    agentId: z.uuid(),
    engineAgentId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    files: z.array(z.strictObject({
        path: z.string(),
        inodeRevision: desktopTemplateRevisionSchema,
        contentRevision: desktopTemplateRevisionSchema,
    })).max(DESKTOP_PORTABLE_TEMPLATE_LIMITS.maxFiles),
})
const planFileSchema = z.strictObject({
    version: z.literal(1),
    planRevision: desktopTemplateRevisionSchema,
    templateId: desktopTemplateIdSchema,
    revision: desktopTemplateRevisionSchema,
    coworkers: z.array(desktopTemplateCoworkerPlanSchema).min(1).max(DESKTOP_TEMPLATE_LIMITS.maxCoworkers),
    bindings: z.array(bindingSchema).min(1).max(DESKTOP_TEMPLATE_LIMITS.maxCoworkers),
})
type PlanFile = z.infer<typeof planFileSchema>

const captureReceiptSchema = z.strictObject({
    version: z.literal(1),
    requestId: z.uuid(),
    templateId: desktopTemplateIdSchema,
    planRevision: desktopTemplateRevisionSchema,
    capturedAt: z.string().min(20).max(40),
    revision: desktopTemplateRevisionSchema.optional(),
    fingerprint: desktopTemplateRevisionSchema,
})

function included(file: InspectedFile, kind: 'instruction' | 'config') {
    if (file.text == null) throw new TemplateRequestError(409, `${file.path} cannot be captured as text`)
    return { path: file.path, bytes: file.bytes, kind, sourceRevision: file.contentRevision, flagged: file.flagged, text: file.text }
}

function publish(inspected: InspectedCoworker): DesktopTemplateCoworkerPlan {
    return desktopTemplateCoworkerPlanSchema.parse({
        agentId: inspected.localAgentId,
        name: inspected.name,
        description: inspected.description,
        sourceRevision: inspected.sourceRevision,
        setup: inspected.setup,
        included: [
            ...(inspected.soul ? [included(inspected.soul, 'instruction')] : []),
            ...(inspected.install ? [included(inspected.install, 'instruction')] : []),
            ...(inspected.config ? [included(inspected.config, 'config')] : []),
        ],
        selectableFiles: inspected.selectableFiles.map(file => ({
            path: file.path,
            bytes: file.bytes,
            kind: file.binary ? 'binary' as const : 'text' as const,
            sourceRevision: file.contentRevision,
            flagged: file.flagged,
            binary: file.binary,
            textScanned: file.textScanned,
            mediaType: file.mediaType,
        })),
        selectableSkills: inspected.selectableSkills.map(skill => ({
            slug: skill.slug, name: skill.name, description: skill.description, sourceRevision: skill.sourceRevision,
            files: skill.files.map(file => ({
                path: file.path,
                bytes: file.bytes,
                kind: 'skill' as const,
                sourceRevision: file.contentRevision,
                flagged: file.flagged,
                binary: file.binary,
                textScanned: file.textScanned,
                mediaType: file.mediaType,
            })),
        })),
        exclusions: inspected.exclusions,
        redactions: inspected.redactions,
        strippedConfigKeys: inspected.strippedConfigKeys,
        blocked: inspected.blocked,
        requirements: inspected.requirements,
    })
}

function bindingsOf(inspected: InspectedCoworker) {
    const files = [
        ...(inspected.soul ? [inspected.soul] : []),
        ...(inspected.install ? [inspected.install] : []),
        ...(inspected.config ? [inspected.config] : []),
        ...inspected.selectableFiles,
        ...inspected.selectableSkills.flatMap(skill => skill.files),
    ]
    return {
        agentId: inspected.localAgentId,
        engineAgentId: inspected.engineAgentId,
        files: files.map(file => ({ path: file.path, inodeRevision: file.inodeRevision, contentRevision: file.contentRevision })),
    }
}

async function loadDraft(roots: TemplateRoots, templateId: string, revision: string): Promise<TemplateDraft> {
    const parsed = draftSchema.safeParse(await readOwnJson(templateHome(roots.dataRoot, templateId), 'draft.json'))
    if (!parsed.success) throw new TemplateRequestError(404, 'Template draft not found')
    if (parsed.data.revision !== revision || parsed.data.templateId !== templateId) throw new TemplateRequestError(409, 'Template revision does not match this draft')
    return parsed.data
}

async function ensureDraft(roots: TemplateRoots, record: TemplateDraft): Promise<void> {
    if (await readOwnJson(requestHome(roots.dataRoot), `tombstone-${record.templateId}.json`)) throw new TemplateRequestError(409, 'This template was deleted; a prior draft cannot recreate it')
    const directory = templateHome(roots.dataRoot, record.templateId)
    const draft = await readOwnJson(directory, 'draft.json')
    if (!draft) {
        try { await writeOwnJson(directory, 'draft.json', record) }
        catch (error) {
            if (!(error instanceof TemplateRequestError) || error.status !== 409) throw error
        }
    }
    const stored = draftSchema.parse(await readOwnJson(directory, 'draft.json'))
    if (canonicalJson(stored) !== canonicalJson(record)) throw new TemplateRequestError(409, 'Template draft does not match its request')
}

export function createDesktopTemplateEngine(roots: TemplateRoots, index?: TemplateIndex, options: TemplateEngineOptions = {}) {
    const includeBinary = options.includeBinary === true
    const inspectOptions = {
        skillOwnership: options.skillOwnership ?? null,
        requirementNames: options.requirementNames,
        includeBinary,
        maxFileBytes: includeBinary ? DESKTOP_PORTABLE_TEMPLATE_LIMITS.maxFileBytes : DESKTOP_TEMPLATE_LIMITS.maxFileBytes,
        maxWalkEntries: includeBinary ? DESKTOP_PORTABLE_TEMPLATE_LIMITS.maxWalkEntries : DESKTOP_TEMPLATE_LIMITS.maxWalkEntries,
        requireTrustedOwnership: options.requireTrustedOwnership === true || includeBinary,
    }
    const captureLimits = includeBinary ? {
        maxFiles: DESKTOP_PORTABLE_TEMPLATE_LIMITS.maxFiles,
        maxTotalBytes: DESKTOP_PORTABLE_TEMPLATE_LIMITS.maxTotalBytes,
        maxFileBytes: DESKTOP_PORTABLE_TEMPLATE_LIMITS.maxFileBytes,
    } : {
        maxFiles: DESKTOP_TEMPLATE_LIMITS.maxFiles,
        maxTotalBytes: DESKTOP_TEMPLATE_LIMITS.maxTotalBytes,
        maxFileBytes: DESKTOP_TEMPLATE_LIMITS.maxFileBytes,
    }
    const indexes = index ?? {
        get: async (id: string) => {
            const repo = await import('../../db/repos/agents.js')
            const row = await repo.getAgentIndex(id)
            return row ? { name: row.name, createdAt: row.createdAt, status: row.status } : null
        },
        insert: async (id: string, name: string, createdAt?: string) => {
            const { raw } = await import('../../db/client.js')
            await raw().execute({ sql: "INSERT INTO agents(id,name,status,created_at) VALUES(?,?,'idle',?)", args:[id,name,createdAt ?? new Date().toISOString()] })
        },
    }

    const engine = {
        async createDraft(requestId: string, title: string): Promise<{ requestId: string; templateId: string; revision: string }> {
            const trimmed = title.trim()
            if (!z.uuid().safeParse(requestId).success) throw new TemplateRequestError(400, 'Invalid template request')
            if (!trimmed || trimmed.length > DESKTOP_TEMPLATE_LIMITS.maxTitleLength) throw new TemplateRequestError(400, 'Template title is required')
            const home = requestHome(roots.dataRoot)
            const existing = await readOwnJson(home, `${requestId}.json`)
            if (existing) {
                const parsed = draftSchema.safeParse(existing)
                if (!parsed.success || parsed.data.requestId !== requestId) throw new TemplateRequestError(409, 'This template request is incomplete')
                if (parsed.data.title !== trimmed) throw new TemplateRequestError(409, 'This template request already used a different title')
                await ensureDraft(roots, parsed.data)
                return { requestId, templateId: parsed.data.templateId, revision: parsed.data.revision }
            }
            const templateId = newTemplateId()
            const revision = draftRevision(requestId, templateId, trimmed)
            const record = { version: 1 as const, requestId, templateId, title: trimmed, revision }
            try { await writeOwnJson(home, `${requestId}.json`, record) }
            catch (error) {
                if (!(error instanceof TemplateRequestError) || error.status !== 409) throw error
                const winner = draftSchema.safeParse(await readOwnJson(home, `${requestId}.json`))
                if (!winner.success || winner.data.requestId !== requestId || winner.data.title !== trimmed) {
                    throw new TemplateRequestError(409, 'This template request already used a different title')
                }
                await ensureDraft(roots, winner.data)
                return { requestId, templateId: winner.data.templateId, revision: winner.data.revision }
            }
            await ensureDraft(roots, record)
            return { requestId, templateId, revision }
        },

        async plan(input: { requestId: string; templateId: string; revision: string; coworkers: { agentId: string; engineAgentId: string }[] }): Promise<DesktopTemplatePlan> {
            const draft = await loadDraft(roots, input.templateId, input.revision)
            if (draft.templateId !== input.templateId) throw new TemplateRequestError(409, 'Template revision does not match this draft')
            if (new Set(input.coworkers.map(coworker => coworker.agentId)).size !== input.coworkers.length) throw new TemplateRequestError(400, 'Choose each coworker once')
            const inspected = []
            for (const coworker of input.coworkers) inspected.push(await inspectCoworker(roots.agentsRoot, coworker.agentId, coworker.engineAgentId, inspectOptions))
            const coworkers = inspected.map(publish)
            const bindings = inspected.map(bindingsOf)
            // Private file identities are part of the plan revision, so a touch with the same bytes still issues a new plan.
            const planRevision = sha256(canonicalJson({ kind: 'desktop-template-plan', templateId: input.templateId, revision: input.revision, coworkers, bindings, includeBinary }))
            const stored: PlanFile = { version: 1, planRevision, templateId: input.templateId, revision: input.revision, coworkers, bindings }
            const plan = desktopTemplatePlanSchema.parse({
                templateId: input.templateId,
                revision: input.revision,
                planRevision,
                proseWarning: includeBinary ? DESKTOP_PORTABLE_TEMPLATE_PROSE_WARNING : DESKTOP_TEMPLATE_PROSE_WARNING,
                limits: DESKTOP_TEMPLATE_LIMITS,
                coworkers,
                ...(includeBinary ? {
                    portableCapture: {
                        binaryAssets: true,
                        userSkillTrees: true,
                        maxFileBytes: captureLimits.maxFileBytes,
                        maxTotalBytes: captureLimits.maxTotalBytes,
                        ownershipRequired: true as const,
                    },
                } : {}),
            })
            await writeOwnJson(templateHome(roots.dataRoot, input.templateId), `plans/${planRevision}.json`, stored)
            return plan
        },

        async capture(input: { requestId: string; templateId: string; revision: string; planRevision: string; selections: z.infer<typeof desktopTemplateSelectionSchema>[] }): Promise<{ templateId: string; revision: string }> {
            return withPortableLibraryLease(roots.dataRoot, async () => {
                const fingerprint = sha256(canonicalJson(input))
                const home = requestHome(roots.dataRoot)
                const priorRaw = await readOwnJson(home, `capture-${input.requestId}.json`)
                const prior = captureReceiptSchema.safeParse(priorRaw)
                if (priorRaw && (!prior.success || prior.data.fingerprint !== fingerprint)) throw new TemplateRequestError(409, 'This capture request already belongs to another selection')
                if(prior.success && prior.data.revision) {
                    await readManifest(roots.dataRoot, input.templateId, prior.data.revision)
                    return {templateId:input.templateId,revision:prior.data.revision}
                }
                const draft = await loadDraft(roots, input.templateId, input.revision)
                const stored = planFileSchema.safeParse(await readOwnJson(templateHome(roots.dataRoot, input.templateId), `plans/${input.planRevision}.json`))
                if (!stored.success || stored.data.planRevision !== input.planRevision || stored.data.revision !== input.revision) {
                    throw new TemplateRequestError(409, 'Capture plan is no longer current')
                }
                const locked = [...new Map(stored.data.bindings.map(binding => [binding.engineAgentId, binding])).values()].sort((a, b) => a.engineAgentId.localeCompare(b.engineAgentId))
                const underLocks = <T>(index: number, work: () => Promise<T>): Promise<T> => index === locked.length ? work()
                    : withSkillReadLease(join(roots.agentsRoot, locked[index]!.engineAgentId, 'skills'), () => underLocks(index + 1, work))
                return underLocks(0, async () => {
                const selections = z.array(desktopTemplateSelectionSchema).parse(input.selections)
                const expected = stored.data.coworkers.map(coworker => coworker.agentId)
                const selectedIds = selections.map(selection => selection.agentId)
                if (selectedIds.length !== new Set(selectedIds).size || canonicalJson([...selectedIds].sort()) !== canonicalJson([...expected].sort())) {
                    throw new TemplateRequestError(400, 'Capture must include every coworker in the plan')
                }
                const byId = new Map(selections.map(selection => [selection.agentId, selection]))
                const fresh = []
                for (const binding of stored.data.bindings) fresh.push(await inspectCoworker(roots.agentsRoot, binding.agentId, binding.engineAgentId, inspectOptions))
                const rebuilt = fresh.map(publish)
                if (canonicalJson(rebuilt) !== canonicalJson(stored.data.coworkers)) throw new TemplateRequestError(409, 'A planned coworker changed. Review the plan again.')
                for (const binding of stored.data.bindings) {
                    const again = fresh.find(item => item.localAgentId === binding.agentId)!
                    const files = bindingsOf(again).files
                    if (canonicalJson(files) !== canonicalJson(binding.files)) throw new TemplateRequestError(409, 'A planned file changed. Review the plan again.')
                }
                const chosen = fresh.map((inspected, index) => choose(inspected, byId.get(inspected.localAgentId)!, `c${String(index).padStart(2, '0')}`))
                const totalFiles = chosen.reduce((sum, coworker) => sum + coworker.files.length, 0)
                const totalBytes = chosen.reduce((sum, coworker) => sum + coworker.files.reduce((inner, file) => inner + file.bytes, 0), 0)
                if (totalFiles > captureLimits.maxFiles || totalBytes > captureLimits.maxTotalBytes) {
                    throw new TemplateRequestError(413, 'The selection exceeds the capture limit')
                }
                if (prior.success && (prior.data.templateId !== input.templateId || prior.data.planRevision !== input.planRevision)) {
                    throw new TemplateRequestError(409, 'This capture request already belongs to another plan')
                }
                const assertSelectedSkills = async () => {
                    for (const binding of stored.data.bindings) for (const slug of byId.get(binding.agentId)!.skills)
                        await assertUserSkillOperation(join(roots.agentsRoot, binding.engineAgentId, 'workspace'), slug)
                }
                await assertSelectedSkills()
                const capturedAt = prior.success ? prior.data.capturedAt : new Date().toISOString()
                if (!prior.success) {
                    await writeOwnJson(home, `capture-${input.requestId}.json`, {
                        version: 1, fingerprint, requestId: input.requestId, templateId: input.templateId, planRevision: input.planRevision, capturedAt,
                    })
                }
                const body: Omit<TemplateManifest, 'revision'> = {
                    version: 1 as const,
                    kind: 'desktop-local-template' as const,
                    templateId: input.templateId,
                    title: draft.title,
                    capturedAt,
                    planRevision: input.planRevision,
                    requestId: input.requestId,
                    proseWarning: includeBinary ? DESKTOP_PORTABLE_TEMPLATE_PROSE_WARNING : DESKTOP_TEMPLATE_PROSE_WARNING,
                    limits: DESKTOP_TEMPLATE_LIMITS,
                    engineCommit: null,
                    coworkers: chosen.map(({ bytes: _bytes, ...coworker }) => coworker),
                }
                const manifest = sealManifest(body)
                const directory = join(templateHome(roots.dataRoot, input.templateId), 'revisions', manifest.revision)
                const already = await readOwnJson(directory, 'manifest.json')
                if (!already) {
                    for (const coworker of chosen) {
                        for (const file of coworker.bytes) {
                            await ensurePrivateDir(directory)
                            await writeExclusiveFile(directory, `${coworker.agentKey}/${file.path}`, file.bytes)
                        }
                    }
                    await assertSelectedSkills()
                    await writeOwnJson(directory, 'manifest.json', manifest)
                    if (includeBinary) {
                        await writeOwnJson(directory, 'portable-fidelity.json', {
                            binaryAssets: true,
                            userSkillTrees: true,
                            sourceKind: 'portable-capture',
                            notes: ['Captured with binary assets and user skill trees under portable bounds.'],
                        })
                    }
                }
                const confirmed = await readManifest(roots.dataRoot, input.templateId, manifest.revision)
                if (canonicalJson(confirmed) !== canonicalJson(manifest)) throw new TemplateRequestError(409, 'Stored template bytes do not match this capture')
                await assertSelectedSkills()
                await replaceOwnJson(templateHome(roots.dataRoot, input.templateId), 'current.json', { revision: manifest.revision })
                await replaceOwnJson(home, `capture-${input.requestId}.json`, {
                    version: 1, fingerprint, requestId: input.requestId, templateId: input.templateId, planRevision: input.planRevision, capturedAt, revision: manifest.revision,
                })
                return { templateId: input.templateId, revision: manifest.revision }
                })
            })
        },

        async list(): Promise<DesktopTemplateList> {
            const templates = []
            for (const templateId of await listTemplateIds(roots.dataRoot)) {
                const draft = draftSchema.safeParse(await readOwnJson(templateHome(roots.dataRoot, templateId), 'draft.json'))
                if (!draft.success) continue
                const current = z.strictObject({ revision: desktopTemplateRevisionSchema }).safeParse(await readOwnJson(templateHome(roots.dataRoot, templateId), 'current.json'))
                let coworkerCount = 0
                let capturedAt: string | null = null
                let published: string | null = null
                if (current.success) {
                    try {
                        const manifest = await readManifest(roots.dataRoot, templateId, current.data.revision)
                        coworkerCount = manifest.coworkers.length
                        capturedAt = manifest.capturedAt
                        published = current.data.revision
                    } catch { published = null }
                }
                templates.push({
                    templateId, title: draft.data.title, revision: published, draftRevision: draft.data.revision,
                    status: published ? 'captured' as const : 'draft' as const, capturedAt, coworkerCount,
                })
            }
            return { templates }
        },

        async detail(templateId: string, revision?: string): Promise<DesktopTemplateDetail> {
            let selected = revision
            if (!selected) {
                const current = z.strictObject({ revision: desktopTemplateRevisionSchema }).safeParse(await readOwnJson(templateHome(roots.dataRoot, templateId), 'current.json'))
                if (!current.success) throw new TemplateRequestError(404, 'Template not found')
                selected = current.data.revision
            }
            const manifest = await readManifest(roots.dataRoot, templateId, selected)
            const detail = publicDetail(manifest)
            const directory = join(templateHome(roots.dataRoot, templateId), 'revisions', selected)
            const fidelity = z.strictObject({
                binaryAssets: z.boolean(),
                userSkillTrees: z.boolean(),
                sourceKind: z.enum(['local-v1', 'portable-capture', 'portable-import', 'local-v1-export']),
                notes: z.array(z.string()).max(20),
            }).safeParse(await readOwnJson(directory, 'portable-fidelity.json'))
            const provenance = z.strictObject({
                importedAt: z.string(),
                sourcePackageKey: z.string(),
                sourceContentDigest: z.string(),
                sourceTitle: z.string(),
                uploadId: z.string().optional(),
                fidelity: desktopPortablePackageManifestSchema.shape.fidelity.optional(),
            }).safeParse(await readOwnJson(directory, 'portable-provenance.json'))
            return {
                ...detail,
                ...(fidelity.success ? { portable: fidelity.data } : provenance.success && provenance.data.fidelity ? {
                    portable: { ...provenance.data.fidelity, sourceKind: 'portable-import' as const },
                } : {
                    portable: {
                        binaryAssets: manifest.coworkers.some(coworker => coworker.files.some(file => file.kind === 'binary' || file.binary === true)),
                        userSkillTrees: manifest.coworkers.some(coworker => coworker.files.some(file => file.kind === 'skill')),
                        sourceKind: 'local-v1' as const,
                        notes: ['Existing text-only local captures are not advertised as full portable fidelity.'],
                    },
                }),
                ...(provenance.success ? {
                    provenance: {
                        importedAt: provenance.data.importedAt,
                        sourcePackageKey: provenance.data.sourcePackageKey,
                        sourceContentDigest: provenance.data.sourceContentDigest,
                        sourceTitle: provenance.data.sourceTitle,
                    },
                } : {}),
            }
        },

        install(input: { foremanDisabled?: true; importReceiptId: string; templateId: string; revision: string; coworkers: { engineAgentId: string; agentKey: string }[] }) {
            return installManifest({ ...input, dataRoot: roots.dataRoot, agentsRoot: roots.agentsRoot, insertIndex: indexes.insert, readIndex: indexes.get })
        },
    }
    return { ...engine,
        createDraft: (...args: Parameters<typeof engine.createDraft>) => withPortableLibraryLease(roots.dataRoot, () => engine.createDraft(...args)),
    }
}

function choose(inspected: InspectedCoworker, selection: z.infer<typeof desktopTemplateSelectionSchema>, agentKey: string) {
    if (inspected.blocked) throw new TemplateRequestError(409, inspected.blocked)
    if (new Set(selection.files).size !== selection.files.length || new Set(selection.skills).size !== selection.skills.length) {
        throw new TemplateRequestError(400, 'A capture selection repeats a path')
    }
    const files = new Map(inspected.selectableFiles.map(file => [file.path, file]))
    const skills = new Map(inspected.selectableSkills.map(skill => [skill.slug, skill]))
    const picked: (InspectedFile & { kind: TemplateManifest['coworkers'][number]['files'][number]['kind'] })[] = []
    if (inspected.soul) picked.push({ ...inspected.soul, kind: 'instruction' })
    if (inspected.install) picked.push({ ...inspected.install, kind: 'instruction' })
    if (!inspected.config) throw new TemplateRequestError(409, 'config.json cannot be captured')
    picked.push({ ...inspected.config, kind: 'config' })
    for (const path of selection.files) {
        const file = files.get(path)
        if (!file) throw new TemplateRequestError(400, 'A selected file is not in the capture plan')
        picked.push({ ...file, kind: file.binary ? 'binary' : 'text' })
    }
    for (const slug of selection.skills) {
        const skill = skills.get(slug)
        if (!skill) throw new TemplateRequestError(400, 'A selected skill is not in the capture plan')
        for (const file of skill.files) picked.push({ ...file, kind: 'skill' })
    }
    if (selection.setup) {
        const prompt = selection.setup.prompt.trim()
        if (selection.setup.required && !prompt) throw new TemplateRequestError(400, 'Required setup needs instructions')
        const at = picked.findIndex(file => file.path === 'INSTALL.md')
        if (at >= 0) picked.splice(at, 1)
        if (prompt) {
            const text = `${prompt}\n`
            const raw = Buffer.from(text, 'utf8')
            const revision = sha256(raw)
            picked.push({
                path: 'INSTALL.md', text, raw, bytes: raw.length, inodeRevision: revision, contentRevision: revision,
                flagged: [], binary: false, textScanned: true, mediaType: 'text/markdown', kind: 'instruction',
            })
        }
    }
    const seen = new Set<string>()
    for (const file of picked) {
        if (seen.has(file.path) || sha256(file.raw) !== file.contentRevision) throw new TemplateRequestError(409, 'A planned file changed. Review the plan again.')
        seen.add(file.path)
    }
    return {
        agentKey,
        sourceEngineId: inspected.engineAgentId,
        enabled: inspected.config?.text ? JSON.parse(inspected.config.text).enabled !== false : true,
        name: inspected.name,
        description: inspected.description,
        setup: selection.setup ? { ...selection.setup, prompt: selection.setup.prompt.trim(), answered: true } : inspected.setup,
        files: picked.map(file => ({
            path: file.path,
            bytes: file.raw.length,
            kind: file.kind,
            sourceRevision: file.contentRevision,
            flagged: file.flagged,
            binary: file.binary,
            textScanned: file.textScanned,
            mediaType: file.mediaType,
        })),
        exclusions: inspected.exclusions,
        redactions: inspected.redactions,
        strippedConfigKeys: inspected.strippedConfigKeys,
        requirements: z.array(desktopPortableRequirementSchema).parse(inspected.requirements),
        envKeys: inspected.envKeys,
        mcpAuth: inspected.mcpAuth,
        bytes: picked.map(file => ({ path: file.path, bytes: file.raw })),
    }
}
