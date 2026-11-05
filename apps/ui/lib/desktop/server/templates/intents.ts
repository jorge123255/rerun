import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import type { Client } from '@libsql/client'
import { z } from 'zod'
import { desktopTemplateDetailSchema, desktopTemplateOperationSchema, type DesktopTemplateOperation } from '@rerun/contracts'
import { agentsOverlap, containerContainsTile, DEFAULT_SPAN } from '@rerun/ui/iso-grid/iso'
import { DesktopHttpError } from '../auth'
import { withRosterWrite } from '../roster-writes'
import type { DesktopTemplateEngineClient } from './server'

const bodySchema = z.strictObject({ operation: z.record(z.string(), z.unknown()), againRequestId: z.uuid().optional() })
function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
    if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
    return JSON.stringify(value)
}

export async function prepareTemplateIntent(db: Client, engine: DesktopTemplateEngineClient, raw: unknown): Promise<DesktopTemplateOperation> {
    const input = bodySchema.safeParse(raw)
    if (!input.success) throw new DesktopHttpError(400, 'Invalid template attempt')
    const body = input.data.operation
    if ('requestId' in body || !['create-draft', 'plan', 'capture', 'install'].includes(String(body.operation))) throw new DesktopHttpError(400, 'Invalid template attempt')
    const key = createHash('sha256').update(canonical(body)).digest('hex')
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
            if (prior && !input.data.againRequestId && previousReceipt?.status!=='refused') {
                const operation = desktopTemplateOperationSchema.parse(JSON.parse(String(prior.operation)))
                await tx.commit()
                return operation
            }
            if (input.data.againRequestId) {
                const receipt = prior ? (await tx.execute({ sql: "SELECT status FROM desktop_template_requests WHERE request_id=? AND operation='install'", args: [String(prior.request_id)] })).rows[0] : null
                if (body.operation !== 'install' || !['installed','refused'].includes(String(receipt?.status))) throw new DesktopHttpError(409, 'Confirm the previous installation before installing another copy')
            }
            let positionBody = {}
            if (detail) {
                const space = (await tx.execute({ sql: 'SELECT * FROM desktop_spaces WHERE workspace_id=1 AND (? IS NULL OR id=?) ORDER BY rowid LIMIT 1', args: [typeof body.spaceId === 'string' ? body.spaceId : null, typeof body.spaceId === 'string' ? body.spaceId : null] })).rows[0]
                if (!space) throw new DesktopHttpError(409, 'Create a Box before installing a template')
                const spaceId = String(space.id)
                const rect = { col_start: Number(space.col_start), row_start: Number(space.row_start), col_end: Number(space.col_end), row_end: Number(space.row_end) }
                const occupied = (await tx.execute({ sql: `SELECT col,row FROM desktop_space_placements WHERE space_id=? UNION ALL SELECT board_col,board_row FROM desktop_duplicates WHERE completed=0 AND space_id=? UNION ALL SELECT board_col,board_row FROM desktop_creations WHERE phase='reserved' AND space_id=?`, args: [spaceId, spaceId, spaceId] })).rows.map(row => ({ col: Number(row.col), row: Number(row.row) }))
                const reserved = await tx.execute("SELECT i.operation FROM desktop_template_intents i LEFT JOIN desktop_template_requests r ON r.request_id=i.request_id WHERE r.status IS NULL OR r.status NOT IN ('installed','refused')")
                for (const record of reserved.rows) {
                    const operation = desktopTemplateOperationSchema.parse(JSON.parse(String(record.operation)))
                    if (operation.operation === 'install' && operation.spaceId === spaceId) occupied.push(...operation.positions)
                }
                const positions: { col: number; row: number }[] = []
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
            const parsed = desktopTemplateOperationSchema.safeParse({ ...body, ...positionBody, requestId: randomUUID() })
            if (!parsed.success) throw new DesktopHttpError(400, 'Invalid template attempt')
            await tx.execute({ sql: 'INSERT INTO desktop_template_intents(key,request_id,operation) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET request_id=excluded.request_id,operation=excluded.operation', args: [key, 'requestId' in parsed.data ? parsed.data.requestId : '', JSON.stringify(parsed.data)] })
            if(input.data.againRequestId)await tx.execute({sql:'INSERT INTO desktop_template_rotations(request_id,key,operation) VALUES(?,?,?)',args:[input.data.againRequestId,key,JSON.stringify(parsed.data)]})
            await tx.commit()
            return parsed.data
        } finally { tx.close() }
    })
}
