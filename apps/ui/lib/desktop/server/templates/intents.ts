import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import type { Client } from '@libsql/client'
import { z } from 'zod'
import { DESKTOP_TEMPLATE_LIMITS, desktopTemplateDetailSchema, desktopTemplateOperationSchema, type DesktopTemplateOperation } from '@rerun/contracts'
import { agentsOverlap, containerContainsTile, DEFAULT_SPAN } from '@rerun/ui/iso-grid/iso'
import { DesktopHttpError } from '../auth'
import { withRosterWrite } from '../roster-writes'
import { templateRequestFingerprint, type DesktopTemplateEngineClient } from './server'
import { desktopTemplateInstallIdentitySchema, desktopTemplateInstallStateSchema, type DesktopTemplateInstallState } from '../../template-install-state'
import { desktopSpacePositionSchema } from '../../spaces'

const bodySchema = z.strictObject({ operation: z.record(z.string(), z.unknown()), againRequestId: z.uuid().optional() })
const installSelectionSchema = desktopTemplateInstallIdentitySchema.extend({
    operation: z.literal('install'), spaceId: z.uuid().optional(),
    positions: z.array(desktopSpacePositionSchema).min(1).max(DESKTOP_TEMPLATE_LIMITS.maxCoworkers).optional(),
})
function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
    if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
    return JSON.stringify(value)
}

export function templateInstallIntentKey({ templateId, revision }: Pick<Extract<DesktopTemplateOperation, { operation: 'install' }>, 'templateId' | 'revision'>) {
    return createHash('sha256').update(canonical({ operation: 'install', templateId, revision })).digest('hex')
}

export async function readTemplateInstallIntent(db: Client, raw: unknown): Promise<DesktopTemplateInstallState> {
    const parsed = desktopTemplateInstallIdentitySchema.safeParse(raw)
    if (!parsed.success) throw new DesktopHttpError(400, 'Invalid template selection')
    const identity = parsed.data
    const key = templateInstallIntentKey(identity)
    const tx = await db.transaction('read')
    try {
        const prior = (await tx.execute({ sql: 'SELECT request_id,operation FROM desktop_template_intents WHERE key=?', args: [key] })).rows[0]
        if (!prior) return { status: 'none', ...identity }
        const operation = desktopTemplateOperationSchema.parse(JSON.parse(String(prior.operation)))
        if (operation.operation !== 'install' || operation.requestId !== prior.request_id || operation.templateId !== identity.templateId || operation.revision !== identity.revision) {
            throw new DesktopHttpError(409, 'The saved installation could not be confirmed. Reopen the template and try again.')
        }
        const pending = { status: 'pending' as const, ...identity, requestId: operation.requestId }
        const receipt = (await tx.execute({ sql: 'SELECT * FROM desktop_template_requests WHERE request_id=?', args: [operation.requestId] })).rows[0]
        if (!receipt) return pending
        const fingerprint = templateRequestFingerprint(operation)
        if (receipt.operation !== 'install' || receipt.fingerprint !== fingerprint ||
            (receipt.template_id !== null && receipt.template_id !== identity.templateId) ||
            (receipt.revision !== null && receipt.revision !== identity.revision)) {
            throw new DesktopHttpError(409, 'The saved installation could not be confirmed. Reopen the template and try again.')
        }
        if (receipt.status === 'refused') return { ...pending, status: 'refused' }
        if (receipt.status !== 'installed') return { ...pending, ...(receipt.status === 'rolling-back' ? { cleanupPending: true as const } : {}) }
        if (receipt.template_id !== identity.templateId || receipt.revision !== identity.revision) throw new DesktopHttpError(409, 'The saved installation could not be confirmed.')
        const payload = z.object({ coworkers: z.array(z.object({ agentId: z.uuid(), engineAgentId: z.string().min(1) })).min(1).max(DESKTOP_TEMPLATE_LIMITS.maxCoworkers) }).parse(JSON.parse(String(receipt.payload)))
        const coworkers = []
        for (const coworker of payload.coworkers) {
            const record = (await tx.execute({
                sql: `SELECT a.id,a.engine_agent_id,a.name,a.description,a.enabled,a.created_at,a.updated_at,p.col,p.row,p.space_id
                      FROM desktop_agents a LEFT JOIN desktop_space_placements p ON p.agent_id=a.id WHERE a.id=? AND a.workspace_id=1`,
                args: [coworker.agentId],
            })).rows[0]
            if (!record) continue
            if (record.engine_agent_id !== coworker.engineAgentId) throw new DesktopHttpError(409, 'An installed coworker has changed identity. Its installation could not be confirmed.')
            coworkers.push({
                id: String(record.id), name: String(record.name), description: String(record.description), enabled: Number(record.enabled) !== 0,
                createdAt: String(record.created_at), updatedAt: String(record.updated_at),
                ...(record.col === null || record.row === null ? {} : { position: { col: Number(record.col), row: Number(record.row) } }),
                ...(record.space_id === null ? {} : { spaceId: String(record.space_id) }),
            })
        }
        return desktopTemplateInstallStateSchema.parse({ status: 'installed', ...identity, requestId: operation.requestId, receiptId: String(receipt.receipt_id), coworkers })
    } finally { tx.close() }
}

export async function prepareTemplateIntent(db: Client, engine: DesktopTemplateEngineClient, raw: unknown, internal?: { requestId: string; scopeKey: string }): Promise<DesktopTemplateOperation> {
    const input = bodySchema.safeParse(raw)
    if (!input.success) throw new DesktopHttpError(400, 'Invalid template attempt')
    const body = input.data.operation
    if ('requestId' in body || !['create-draft', 'plan', 'capture', 'install'].includes(String(body.operation))) throw new DesktopHttpError(400, 'Invalid template attempt')
    if (internal && (!z.uuid().safeParse(internal.requestId).success || !internal.scopeKey.startsWith('foreman:') || input.data.againRequestId)) throw new DesktopHttpError(400, 'Invalid internal template attempt')
    const selection = body.operation === 'install' ? installSelectionSchema.safeParse(body) : null
    if (selection && !selection.success) throw new DesktopHttpError(400, 'Invalid template placement')
    // A human install has one durable identity per template revision. Placement belongs to the
    // saved operation, not its lookup key: reopening or choosing another Box cannot create a
    // second install or hide an unresolved receipt. Keep the original key for existing installs.
    const key = !internal && selection
        ? templateInstallIntentKey(selection.data)
        : createHash('sha256').update(canonical(internal ? { body, scopeKey: internal.scopeKey } : body)).digest('hex')
    const detail = body.operation === 'install' ? desktopTemplateDetailSchema.parse(await engine.get(`/desktop/templates/${encodeURIComponent(String(body.templateId))}?revision=${encodeURIComponent(String(body.revision))}`)) : null
    return withRosterWrite(async () => {
        const tx = await db.transaction('write')
        try {
            if(input.data.againRequestId) {
                const repeated=(await tx.execute({sql:'SELECT key,operation FROM desktop_template_rotations WHERE request_id=?',args:[input.data.againRequestId]})).rows[0]
                if(repeated){
                    if(repeated.key!==key)throw new DesktopHttpError(409,'This attempt belongs to another template')
                    const operation=desktopTemplateOperationSchema.parse(JSON.parse(String(repeated.operation)))
                    await tx.commit();return operation
                }
            }
            const prior = (await tx.execute({ sql: 'SELECT request_id,operation FROM desktop_template_intents WHERE key=?', args: [key] })).rows[0]
            const previousReceipt = prior ? (await tx.execute({sql:'SELECT status FROM desktop_template_requests WHERE request_id=?',args:[String(prior.request_id)]})).rows[0] : null
            if (prior && !input.data.againRequestId && (internal || previousReceipt?.status!=='refused')) {
                const operation = desktopTemplateOperationSchema.parse(JSON.parse(String(prior.operation)))
                if (internal && (!('requestId' in operation) || operation.requestId !== internal.requestId)) throw new DesktopHttpError(409, 'Template attempt identity changed')
                await tx.commit()
                return operation
            }
            if (input.data.againRequestId) {
                const receipt = prior ? (await tx.execute({ sql: "SELECT status FROM desktop_template_requests WHERE request_id=? AND operation='install'", args: [String(prior.request_id)] })).rows[0] : null
                if (body.operation !== 'install' || !['installed','refused'].includes(String(receipt?.status))) throw new DesktopHttpError(409, 'Confirm the previous installation before installing another copy')
            }
            let positionBody = {}
            if (detail) {
                if (!internal && (typeof body.spaceId !== 'string' || !Array.isArray(body.positions))) throw new DesktopHttpError(409, 'Place the template coworkers on your board first.')
                const space = (await tx.execute({ sql: 'SELECT * FROM desktop_spaces WHERE workspace_id=1 AND (? IS NULL OR id=?) ORDER BY rowid LIMIT 1', args: [typeof body.spaceId === 'string' ? body.spaceId : null, typeof body.spaceId === 'string' ? body.spaceId : null] })).rows[0]
                if (!space) throw new DesktopHttpError(409, 'This Box is no longer available. Choose another spot on the board.')
                const spaceId = String(space.id)
                const rect = { col_start: Number(space.col_start), row_start: Number(space.row_start), col_end: Number(space.col_end), row_end: Number(space.row_end) }
                const occupied = (await tx.execute({ sql: `SELECT col,row FROM desktop_space_placements WHERE space_id=? UNION ALL SELECT board_col,board_row FROM desktop_duplicates WHERE completed=0 AND space_id=? UNION ALL SELECT board_col,board_row FROM desktop_creations WHERE phase='reserved' AND space_id=?`, args: [spaceId, spaceId, spaceId] })).rows.map(row => ({ col: Number(row.col), row: Number(row.row) }))
                const reserved = await tx.execute("SELECT i.operation FROM desktop_template_intents i LEFT JOIN desktop_template_requests r ON r.request_id=i.request_id WHERE r.status IS NULL OR r.status NOT IN ('installed','refused')")
                for (const record of reserved.rows) {
                    const operation = desktopTemplateOperationSchema.parse(JSON.parse(String(record.operation)))
                    if (operation.operation === 'install' && operation.spaceId === spaceId) occupied.push(...operation.positions)
                }
                const positions: { col: number; row: number }[] = []
                if (Array.isArray(body.positions)) {
                    const selected = z.array(desktopSpacePositionSchema).parse(body.positions)
                    if (selected.length !== detail.coworkers.length) throw new DesktopHttpError(400, 'Place every coworker in this template.')
                    for (const position of selected) {
                        if (!containerContainsTile(rect, position, DEFAULT_SPAN) || [...occupied, ...positions].some(other => agentsOverlap(other, position))) {
                            throw new DesktopHttpError(409, 'That spot is no longer available. Review the template and choose another placement.')
                        }
                        positions.push(position)
                    }
                }
                let examined = 0
                for (let row = rect.row_start; row <= rect.row_end && positions.length < detail.coworkers.length && examined < 100_000; row += DEFAULT_SPAN) {
                    for (let col = rect.col_start; col <= rect.col_end && positions.length < detail.coworkers.length && examined++ < 100_000; col += DEFAULT_SPAN) {
                        const position = { col, row }
                        if (containerContainsTile(rect, position, DEFAULT_SPAN) && ![...occupied, ...positions].some(other => agentsOverlap(other, position))) positions.push(position)
                    }
                }
                if (positions.length !== detail.coworkers.length) throw new DesktopHttpError(409, 'This Box needs more room. Enlarge it before installing the template.')
                positionBody = { spaceId, positions }
            }
            const parsed = desktopTemplateOperationSchema.safeParse({ ...body, ...positionBody, requestId: internal?.requestId ?? randomUUID() })
            if (!parsed.success) throw new DesktopHttpError(400, 'Invalid template attempt')
            await tx.execute({ sql: 'INSERT INTO desktop_template_intents(key,request_id,operation) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET request_id=excluded.request_id,operation=excluded.operation', args: [key, 'requestId' in parsed.data ? parsed.data.requestId : '', JSON.stringify(parsed.data)] })
            if(input.data.againRequestId)await tx.execute({sql:'INSERT INTO desktop_template_rotations(request_id,key,operation) VALUES(?,?,?)',args:[input.data.againRequestId,key,JSON.stringify(parsed.data)]})
            await tx.commit()
            return parsed.data
        } finally { tx.close() }
    })
}
