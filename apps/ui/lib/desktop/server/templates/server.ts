import 'server-only'
import { importedTemplateSetup } from './requirements'
import { createHash, randomUUID } from 'node:crypto'
import type { Client } from '@libsql/client'
import { z } from 'zod'
import {
    desktopTemplateCaptureResultSchema,
    desktopTemplateCreateDraftResultSchema,
    desktopTemplateDetailSchema,
    desktopTemplateInstallResultSchema,
    desktopTemplateListSchema,
    desktopTemplateOperationSchema,
    desktopTemplatePlanSchema,
    desktopTemplateReceiptSchema,
    desktopTemplateSourcesResultSchema,
    type DesktopTemplateCommit,
    type DesktopTemplateInstallResult,
    type DesktopTemplateOperation,
    type InitializeImportedSetup,
} from '@rerun/contracts'
import { DesktopHttpError } from '../auth'
import { preflightDesktopTemplateInstall } from './commit'
import { initializeDesktopTemplates } from './schema'

export type DesktopTemplateEngineClient = {
    post: (path: string, body: unknown, signal?: AbortSignal) => Promise<unknown>
    get: (path: string, signal?: AbortSignal) => Promise<unknown>
}

type InstallCoworker = {
    enabled?: boolean
    agentId: string
    engineAgentId: string
    agentKey: string
    name: string
    description: string
    prompt: string
    required: boolean
    phase: 'reserved' | 'folder' | 'indexed' | 'placed'
    position: { col: number; row: number }
}

type InstallPayload = {
    spaceId: string
    coworkers: InstallCoworker[]
    engineStarted: boolean
    setupRevisions: Record<string, string>
}

const engineInstallSchema = z.strictObject({
    status: z.enum(['ready', 'uncertain']),
    reason: z.string().optional(),
    coworkers: z.array(z.strictObject({
        engineAgentId: z.string(),
        agentKey: z.string(),
        name: z.string(),
        description: z.string(),
        phase: z.enum(['indexed', 'partial', 'foreign']),
    })),
})

function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`
    if (value && typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined)
        entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
    }
    return JSON.stringify(value) ?? 'null'
}

const fingerprintOf = (operation: DesktopTemplateOperation | (DesktopTemplateOperation & {foremanDisabled:true})): string => createHash('sha256').update(canonicalJson(operation)).digest('hex')
const engineIdFor = (requestId: string, agentKey: string): string => `i${createHash('sha256').update(`${requestId}\n${agentKey}`).digest('hex').slice(0, 31)}`

function engineFailure(error: unknown): never {
    if (error instanceof DesktopHttpError) throw error
    const status = typeof error === 'object' && error && 'status' in error ? Number((error as { status: unknown }).status) : 502
    if (status === 400 || status === 404 || status === 409 || status === 413) {
        throw new DesktopHttpError(status, error instanceof Error ? error.message : 'Template request was refused')
    }
    throw new DesktopHttpError(502, 'Could not reach the local template engine')
}

async function call<T>(work: Promise<unknown>, parse: (value: unknown) => T): Promise<T> {
    try {
        const value = await work
        const parsed = parse(value)
        return parsed
    } catch (error) {
        if (error instanceof z.ZodError) throw new DesktopHttpError(502, 'Local template engine returned an unexpected response')
        engineFailure(error)
    }
}

export function createDesktopTemplateServer(input: {
    db: Client
    engine: DesktopTemplateEngineClient
    commitInstalled?: DesktopTemplateCommit | null
    initializeImportedSetup?: InitializeImportedSetup | null
    foremanDisabled?: true
    signal?: AbortSignal
}) {
    const signal = input.signal
    const post = (path: string, body: unknown) => input.engine.post(path, body, signal)
    const get = (path: string) => input.engine.get(path, signal)

    async function row(requestId: string) {
        const result = await input.db.execute({ sql: 'SELECT * FROM desktop_template_requests WHERE request_id = ?', args: [requestId] })
        return result.rows[0] ?? null
    }

    async function insertReceipt(operation: Extract<DesktopTemplateOperation, { requestId: string }>, fingerprint: string, payload: unknown) {
        const now = new Date().toISOString()
        const receiptId = randomUUID()
        try {
            await input.db.execute({
                sql: `INSERT INTO desktop_template_requests (request_id, receipt_id, operation, template_id, revision, fingerprint, status, payload, created_at, updated_at)
                      VALUES (?,?,?,?,?,?,?,?,?,?)`,
                args: [operation.requestId, receiptId, operation.operation, null, null, fingerprint, 'accepted', JSON.stringify(payload), now, now],
            })
        } catch (error) {
            const existing = await row(operation.requestId)
            if (!existing) throw error
            sameFingerprint(existing, fingerprint, operation.operation)
            return existing
        }
        return (await row(operation.requestId))!
    }

    function sameFingerprint(existing: NonNullable<Awaited<ReturnType<typeof row>>>, fingerprint: string, operation: string) {
        if (String(existing.operation) !== operation || String(existing.fingerprint) !== fingerprint) {
            throw new DesktopHttpError(409, 'This template request already belongs to another change')
        }
    }

    async function save(requestId: string, fields: { status?: string; templateId?: string | null; revision?: string | null; payload?: unknown }) {
        const now = new Date().toISOString()
        await input.db.execute({
            sql: `UPDATE desktop_template_requests SET status = COALESCE(?, status), template_id = COALESCE(?, template_id), revision = COALESCE(?, revision), payload = COALESCE(?, payload), updated_at = ? WHERE request_id = ?`,
            args: [fields.status ?? null, fields.templateId ?? null, fields.revision ?? null, fields.payload === undefined ? null : JSON.stringify(fields.payload), now, requestId],
        })
    }

    async function views(coworkers: InstallCoworker[], historical = false) {
        const found = []
        for (const coworker of coworkers) {
            const result = await input.db.execute({
                sql: `SELECT a.id, a.name, a.description, a.enabled, a.created_at, a.updated_at, a.engine_agent_id, p.col AS board_col, p.row AS board_row, p.space_id
                      FROM desktop_agents a LEFT JOIN desktop_space_placements p ON p.agent_id = a.id
                      WHERE a.id = ? AND a.workspace_id = 1`,
                args: [coworker.agentId],
            })
            const record = result.rows[0]
            if(!record && historical)continue
            if (!record || String(record.engine_agent_id) !== coworker.engineAgentId || (!historical && String(record.name) !== coworker.name)) return null
            found.push({
                id: String(record.id),
                name: String(record.name),
                description: String(record.description),
                enabled: Number(record.enabled) !== 0,
                createdAt: String(record.created_at),
                updatedAt: String(record.updated_at),
                ...(record.board_col == null || record.board_row == null ? {} : { position: { col: Number(record.board_col), row: Number(record.board_row) } }),
                ...(record.space_id == null ? {} : { spaceId: String(record.space_id) }),
            })
        }
        return found
    }

    function receiptView(existing: NonNullable<Awaited<ReturnType<typeof row>>>) {
        const payload = JSON.parse(String(existing.payload)) as Partial<InstallPayload>
        return desktopTemplateReceiptSchema.parse({
            requestId: String(existing.request_id),
            receiptId: String(existing.receipt_id),
            operation: String(existing.operation),
            status: String(existing.status),
            templateId: existing.template_id == null ? null : String(existing.template_id),
            revision: existing.revision == null ? null : String(existing.revision),
            created: (payload.coworkers ?? []).map(coworker => ({ agentId: coworker.agentId, phase: coworker.phase })),
        })
    }

    async function install(operation: Extract<DesktopTemplateOperation, { operation: 'install' }>): Promise<DesktopTemplateInstallResult> {
        const fingerprint = fingerprintOf(input.foremanDisabled ? { ...operation, foremanDisabled: true } : operation)
        let existing = await row(operation.requestId)
        if (existing) sameFingerprint(existing, fingerprint, 'install')
        if (existing && JSON.parse(String(existing.payload)).rollback) throw new DesktopHttpError(409, 'This installation was cancelled. Start a new installation instead.')
        const detail = await call(get(`/desktop/templates/${operation.templateId}?revision=${operation.revision}`), value => desktopTemplateDetailSchema.parse(value))
        if (detail.coworkers.length !== operation.positions.length) throw new DesktopHttpError(400, 'Choose one board position for each coworker in this template')
        if (!existing) {
            const payload: InstallPayload = {
                spaceId: operation.spaceId,
                engineStarted: false,
                setupRevisions: {},
                coworkers: detail.coworkers.map((coworker, index) => ({
                    agentId: randomUUID(),
                    engineAgentId: engineIdFor(operation.requestId, coworker.agentKey),
                    agentKey: coworker.agentKey,
                    enabled: input.foremanDisabled ? false : coworker.enabled !== false,
                    name: coworker.name,
                    description: coworker.description,
                    ...importedTemplateSetup(coworker.setup, coworker.requirements),
                    phase: 'reserved' as const,
                    position: operation.positions[index]!,
                })),
            }
            existing = await insertReceipt(operation, fingerprint, payload)
            sameFingerprint(existing, fingerprint, 'install')
        }
        const payload = JSON.parse(String(existing.payload)) as InstallPayload
        const base = { requestId: operation.requestId, receiptId: String(existing.receipt_id) }
        if (String(existing.status) === 'installed') {
            const placed = await views(payload.coworkers, true)
            if (!placed) return { status: 'uncertain', ...base, recoverable: true, created: payload.coworkers.map(coworker => ({ agentId: coworker.agentId, phase: coworker.phase })), reason: 'Installed coworkers could not be read back' }
            return desktopTemplateInstallResultSchema.parse({ status: 'installed', ...base, templateId: operation.templateId, revision: operation.revision, coworkers: placed })
        }
        const folderBound = payload.engineStarted || payload.coworkers.some(coworker => coworker.phase === 'folder' || coworker.phase === 'indexed' || coworker.phase === 'placed')
        if (!input.commitInstalled && !folderBound) {
            return { status: 'recoverable', ...base, recoverable: true, reason: 'Desktop placement is not connected. Retry this same request after it is.' }
        }
        if (!input.initializeImportedSetup && !folderBound) {
            return { status: 'recoverable', ...base, recoverable: true, reason: 'Imported setup is not connected. Retry this same request after it is.' }
        }
        if (!folderBound) {
            try { await preflightDesktopTemplateInstall(input.db, {
                requestId: operation.requestId,
                receiptId: base.receiptId,
                templateId: operation.templateId,
                revision: operation.revision,
                spaceId: payload.spaceId,
                coworkers: payload.coworkers.map(coworker => ({
                    agentId: coworker.agentId, engineAgentId: coworker.engineAgentId, name: coworker.name, description: coworker.description, enabled: coworker.enabled !== false, position: coworker.position,
                })),
                signal,
            }) } catch(error) {
                await save(operation.requestId,{status:'refused'})
                throw error
            }
        }
        payload.engineStarted = true
        await save(operation.requestId, { status: 'creating', templateId: operation.templateId, revision: operation.revision, payload })
        const installed = await call(post('/desktop/templates/install', {
            importReceiptId: base.receiptId,
            ...(input.foremanDisabled && { foremanDisabled: true }),
            templateId: operation.templateId,
            revision: operation.revision,
            coworkers: payload.coworkers.map(coworker => ({ engineAgentId: coworker.engineAgentId, agentKey: coworker.agentKey })),
        }), value => engineInstallSchema.parse(value)).catch(async error => {
            if (error instanceof DesktopHttpError && error.status === 409 && !folderBound) {
                payload.engineStarted = false
                await save(operation.requestId, { status: 'accepted', payload })
                throw error
            }
            return null
        })
        if (!installed || installed.status !== 'ready') {
            const phases = new Map((installed?.coworkers ?? []).map(coworker => [coworker.engineAgentId, coworker.phase]))
            for (const coworker of payload.coworkers) {
                const phase = phases.get(coworker.engineAgentId)
                if (phase === 'indexed') coworker.phase = 'indexed'
                else if (phase === 'partial') coworker.phase = 'folder'
            }
            await save(operation.requestId, { status: 'uncertain', payload })
            return { status: 'uncertain', ...base, recoverable: true, created: payload.coworkers.filter(coworker => coworker.phase !== 'reserved').map(coworker => ({ agentId: coworker.agentId, phase: coworker.phase })), reason: installed?.reason ?? 'Import did not finish. Retry this same request.' }
        }
        for (const coworker of payload.coworkers) coworker.phase = 'indexed'
        if (!input.initializeImportedSetup || !input.commitInstalled) {
            await save(operation.requestId, { status: 'uncertain', payload })
            return { status: 'uncertain', ...base, recoverable: true, created: payload.coworkers.map(coworker => ({ agentId: coworker.agentId, phase: 'indexed' as const })), reason: 'Import files exist, but placement or setup is not connected. Retry this same request.' }
        }
        try {
            for (const coworker of payload.coworkers) {
                const setup = await input.initializeImportedSetup({
                    agentId: coworker.agentId,
                    engineAgentId: coworker.engineAgentId,
                    importReceiptId: base.receiptId,
                    prompt: coworker.prompt,
                    required: coworker.required,
                    signal,
                })
                if (!setup?.revision) throw new Error('setup revision missing')
                payload.setupRevisions[coworker.agentId] = setup.revision
            }
        } catch {
            await save(operation.requestId, { status: 'uncertain', payload })
            return { status: 'uncertain', ...base, recoverable: true, created: payload.coworkers.map(coworker => ({ agentId: coworker.agentId, phase: 'indexed' as const })), reason: 'Imported setup did not finish. Retry this same request.' }
        }
        await save(operation.requestId, { status: 'committing', payload })
        try {
            const ack = await input.commitInstalled({
                requestId: operation.requestId,
                receiptId: base.receiptId,
                templateId: operation.templateId,
                revision: operation.revision,
                spaceId: payload.spaceId,
                coworkers: payload.coworkers.map(coworker => ({
                    agentId: coworker.agentId, engineAgentId: coworker.engineAgentId, name: coworker.name, description: coworker.description, enabled: coworker.enabled !== false, position: coworker.position,
                })),
                signal,
            })
            if (ack?.acknowledged !== true) throw new Error('placement was not acknowledged')
        } catch {
            const placed = await views(payload.coworkers, true)
            if (!placed) {
                await save(operation.requestId, { status: 'uncertain', payload })
                return { status: 'uncertain', ...base, recoverable: true, created: payload.coworkers.map(coworker => ({ agentId: coworker.agentId, phase: 'indexed' as const })), reason: 'Placement was not acknowledged. Retry this same request.' }
            }
        }
        const placed = await views(payload.coworkers)
        if (!placed) {
            await save(operation.requestId, { status: 'uncertain', payload })
            return { status: 'uncertain', ...base, recoverable: true, created: payload.coworkers.map(coworker => ({ agentId: coworker.agentId, phase: 'indexed' as const })), reason: 'Placement was acknowledged but the coworkers could not be read back' }
        }
        for (const coworker of payload.coworkers) coworker.phase = 'placed'
        await save(operation.requestId, { status: 'installed', payload })
        return desktopTemplateInstallResultSchema.parse({ status: 'installed', ...base, templateId: operation.templateId, revision: operation.revision, coworkers: placed })
    }

    async function handle(operation: DesktopTemplateOperation) {
            if (operation.operation === 'sources') {
                const result = await input.db.execute(`SELECT a.id, a.name, substr(a.description, 1, 160) AS description, p.space_id, s.name AS space_name
                    FROM desktop_agents a
                    LEFT JOIN desktop_space_placements p ON p.agent_id = a.id
                    LEFT JOIN desktop_spaces s ON s.id = p.space_id
                    WHERE a.workspace_id = 1
                    ORDER BY s.name, a.name, a.id`)
                const spaces = new Map<string, { id: string | null; name: string | null; agents: { id: string; name: string; description: string }[] }>()
                for (const record of result.rows) {
                    const key = record.space_id == null ? '' : String(record.space_id)
                    const space = spaces.get(key) ?? { id: record.space_id == null ? null : String(record.space_id), name: record.space_name == null ? null : String(record.space_name), agents: [] }
                    space.agents.push({ id: String(record.id), name: String(record.name), description: String(record.description ?? '') })
                    spaces.set(key, space)
                }
                return desktopTemplateSourcesResultSchema.parse({ spaces: [...spaces.values()] })
            }
            if (operation.operation === 'list') {
                return desktopTemplateListSchema.parse(await call(get('/desktop/templates'), value => value))
            }
            if (operation.operation === 'detail') {
                const query = operation.revision ? `?revision=${operation.revision}` : ''
                return desktopTemplateDetailSchema.parse(await call(get(`/desktop/templates/${operation.templateId}${query}`), value => value))
            }
            if (operation.operation === 'receipt') {
                const existing = await row(operation.requestId)
                if (!existing) throw new DesktopHttpError(404, 'Template request not found')
                return receiptView(existing)
            }
            if (operation.operation === 'create-draft') {
                const fingerprint = fingerprintOf(operation)
                const existing = await row(operation.requestId)
                if (existing) sameFingerprint(existing, fingerprint, 'create-draft')
                const issued = await call(post('/desktop/templates/draft', { requestId: operation.requestId, title: operation.title }), value => z.strictObject({
                    requestId: z.uuid(), templateId: z.string(), revision: z.string(),
                }).parse(value))
                if (!existing) await insertReceipt(operation, fingerprint, { title: operation.title })
                await save(operation.requestId, { status: 'draft', templateId: issued.templateId, revision: issued.revision })
                const saved = await row(operation.requestId)
                return desktopTemplateCreateDraftResultSchema.parse({ ...issued, receiptId: String(saved?.receipt_id) })
            }
            if (operation.operation === 'plan') {
                const fingerprint = fingerprintOf(operation)
                const existing = await row(operation.requestId)
                if (existing) sameFingerprint(existing, fingerprint, 'plan')
                const coworkers = []
                for (const agentId of operation.agentIds) {
                    const found = await input.db.execute({ sql: 'SELECT engine_agent_id FROM desktop_agents WHERE id = ? AND workspace_id = 1', args: [agentId] })
                    if (!found.rows[0]) throw new DesktopHttpError(404, 'Source coworker not found')
                    coworkers.push({ agentId, engineAgentId: String(found.rows[0].engine_agent_id) })
                }
                const plan = await call(post('/desktop/templates/plan', { requestId: operation.requestId, templateId: operation.templateId, revision: operation.revision, coworkers }), value => desktopTemplatePlanSchema.parse(value))
                if (!existing) await insertReceipt(operation, fingerprint, { planRevision: plan.planRevision })
                await save(operation.requestId, { status: 'planned', templateId: operation.templateId, revision: plan.planRevision, payload: { planRevision: plan.planRevision } })
                return plan
            }
            if (operation.operation === 'capture') {
                const fingerprint = fingerprintOf(operation)
                const existing = await row(operation.requestId)
                if (existing) {
                    sameFingerprint(existing, fingerprint, 'capture')
                    if (existing.status === 'captured') return desktopTemplateCaptureResultSchema.parse({ status: 'captured', requestId: operation.requestId, receiptId: String(existing.receipt_id), templateId: String(existing.template_id), revision: String(existing.revision) })
                }
                if (!existing) await insertReceipt(operation, fingerprint, { planRevision: operation.planRevision })
                const captured = await call(post('/desktop/templates/capture', {
                    requestId: operation.requestId, templateId: operation.templateId, revision: operation.revision, planRevision: operation.planRevision, selections: operation.selections,
                }), value => z.object({ templateId: z.string(), revision: z.string() }).parse(value))
                await save(operation.requestId, { status: 'captured', templateId: captured.templateId, revision: captured.revision })
                const saved = await row(operation.requestId)
                return desktopTemplateCaptureResultSchema.parse({ status: 'captured', requestId: operation.requestId, receiptId: String(saved?.receipt_id), ...captured })
            }
            return install(operation)
    }
    return { handle: (operation: DesktopTemplateOperation) => 'requestId' in operation ? withTemplateRequestWrite(operation.requestId, () => handle(operation)) : handle(operation) }

}

export function withTemplateRequestWrite<T>(requestId: string, action: () => Promise<T>): Promise<T> {
    const state = globalThis as typeof globalThis & { desktopTemplateWrites?: Map<string, Promise<unknown>> }
    const writes = state.desktopTemplateWrites ??= new Map()
    const result = (writes.get(requestId) ?? Promise.resolve()).catch(() => {}).then(action)
    writes.set(requestId, result)
    void result.finally(() => { if (writes.get(requestId) === result) writes.delete(requestId) }).catch(() => {})
    return result
}

export async function openDesktopTemplateServer(db: Client, engine: DesktopTemplateEngineClient, authority: {
    commitInstalled?: DesktopTemplateCommit | null
    initializeImportedSetup?: InitializeImportedSetup | null
    foremanDisabled?: true
    signal?: AbortSignal
} = {}) {
    await initializeDesktopTemplates(db)
    return createDesktopTemplateServer({ db, engine, ...authority })
}
