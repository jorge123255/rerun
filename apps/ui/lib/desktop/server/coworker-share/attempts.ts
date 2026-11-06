import 'server-only'
import type { Client } from '@libsql/client'
import { z } from 'zod'
import { desktopCoworkerShareExportInputSchema,desktopCoworkerShareImportInputSchema,desktopCoworkerShareRevokeInputSchema } from '@rerun/contracts'
import { DesktopHttpError } from '../auth'
import { shareFingerprint } from './store'

export function createDesktopCoworkerShareAttemptStore(db: Client, workspaceId: number, routeAgentId: string) {
    const schema = z.strictObject({ mode: z.enum(['list','remember','forget']),kind: z.enum(['export','import','revoke']),input: z.unknown().optional(),snapshotId: z.string().regex(/^[a-f0-9]{32}$/).optional(),workspaceWide: z.boolean().optional() })
    const parse = (kind: string,value: unknown) => kind === 'export' ? desktopCoworkerShareExportInputSchema.parse(value) : kind === 'import' ? desktopCoworkerShareImportInputSchema.parse(value) : desktopCoworkerShareRevokeInputSchema.parse(value)
    return async (raw: unknown) => {
        const input = schema.parse(raw)
        if (input.mode === 'list') {
            const rows = await db.execute({ sql: `SELECT body,fingerprint,operation,request_id,route_agent_id FROM desktop_coworker_share_attempts WHERE workspace_id=? AND operation=? ${input.workspaceWide && input.kind === 'import' ? '' : 'AND route_agent_id=?'} ORDER BY created_at LIMIT 101`, args: [workspaceId,input.kind,...(input.workspaceWide && input.kind === 'import' ? [] : [routeAgentId])] })
            if (rows.rows.length > 100) throw new DesktopHttpError(409,'Too many pending share operations. Resolve the existing attempts first.')
            const attempts = rows.rows.map(row => {
                const body = parse(input.kind,JSON.parse(String(row.body)))
                if (row.request_id !== body.requestId || row.operation !== input.kind || row.fingerprint !== shareFingerprint([input.kind,body]) || 'workspaceId' in body && (body.workspaceId !== workspaceId || body.agentId !== row.route_agent_id) || 'targetWorkspaceId' in body && body.targetWorkspaceId !== workspaceId) throw new DesktopHttpError(503,'Saved share attempt identity mismatch.')
                return body
            }).filter(body => !input.snapshotId || 'snapshotId' in body && body.snapshotId === input.snapshotId)
            const unique = new Map<string,(typeof attempts)[number]>()
            for (const body of attempts) {
                const previous = unique.get(body.requestId)
                if (previous && shareFingerprint(previous) !== shareFingerprint(body)) throw new DesktopHttpError(503,'Saved share attempt identity mismatch.')
                unique.set(body.requestId,body)
            }
            return { attempts: [...unique.values()] }
        }
        const body = parse(input.kind,input.input)
        if ('workspaceId' in body && (body.workspaceId !== workspaceId || body.agentId !== routeAgentId) || 'targetWorkspaceId' in body && body.targetWorkspaceId !== workspaceId) throw new DesktopHttpError(404,'Share attempt belongs to another workspace or coworker.')
        const fingerprint = shareFingerprint([input.kind,body])
        if (input.mode === 'remember') {
            await db.execute({ sql: 'INSERT INTO desktop_coworker_share_attempts(workspace_id,route_agent_id,request_id,operation,fingerprint,body,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING', args: [workspaceId,routeAgentId,body.requestId,input.kind,fingerprint,JSON.stringify(body),new Date().toISOString()] })
            const row = (await db.execute({ sql: 'SELECT fingerprint FROM desktop_coworker_share_attempts WHERE workspace_id=? AND route_agent_id=? AND request_id=?', args: [workspaceId,routeAgentId,body.requestId] })).rows[0]
            if (!row || row.fingerprint !== fingerprint) throw new DesktopHttpError(409,'This share attempt already names another operation.')
            if (input.kind === 'import') {
                const copies = await db.execute({ sql: 'SELECT fingerprint FROM desktop_coworker_share_attempts WHERE workspace_id=? AND request_id=?',args: [workspaceId,body.requestId] })
                if (copies.rows.some(copy => copy.fingerprint !== fingerprint)) throw new DesktopHttpError(409,'This import attempt already names another operation.')
            }
        } else await db.execute({ sql: `DELETE FROM desktop_coworker_share_attempts WHERE workspace_id=? ${input.kind === 'import' ? '' : 'AND route_agent_id=?'} AND request_id=? AND fingerprint=?`, args: [workspaceId,...(input.kind === 'import' ? [] : [routeAgentId]),body.requestId,fingerprint] })
        return { acknowledged: true }
    }
}
