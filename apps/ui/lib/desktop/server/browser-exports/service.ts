import 'server-only'
import { join } from 'node:path'
import { realpath } from 'node:fs/promises'
import type { Client } from '@libsql/client'
import { z } from 'zod'
import { request } from '@/lib/engine/client'
import { createScreenExportPublisher, createScreenExportReader, screenExportIdentity, validateScreenExportManifest, type ScreenExportAuthority, type ScreenExportDependencies, type ScreenExportIdentity, type ScreenExportReceipt, type ScreenExportReconciler } from '../../../../../engine/src/desktop/isolated-screen/transport'
import { browserHtmlPath, PAGE_RETENTION } from '../../../../../engine/src/desktop/isolated-screen/export-metadata'
import type { ScreenExportCall } from '../../../../../engine/src/desktop/isolated-screen/transport'
import type { ScreenSavedExports } from '../../../../../engine/src/desktop/isolated-screen/types'
import { getDesktopRemoteMcpService } from '../mcp-binding'
import type { DesktopRuntime } from '../runtime'
import { engineOf } from '../settings'
import { assertCoworkerNotDeleting } from '../coworker-delete'
import { browserWorkspaceIdentity, inspectBrowserExportFile, publishBrowserExportFile } from './filesystem'

const denied = () => Object.assign(new Error('Browser export authority changed.'), { code: 'EXPORT_REVOKED' })
const ownerSchema = z.object({ id: z.string(), config: z.object({ enabled: z.boolean(), tools: z.object({ desktopToolGrants: z.record(z.string(), z.boolean()).optional() }).passthrough() }).passthrough() }).passthrough()
const sourceSchema = z.object({ id: z.string(), agentId: z.string(), sessionId: z.string().optional() }).passthrough()
const rootOf = (authority: ScreenExportAuthority) => (JSON.parse(authority.workspaceIdentity) as [string, string, string])[0]

export function createDesktopBrowserExports(runtime: DesktopRuntime, db: Client) {
    async function authorize(input: ScreenExportIdentity, signal: AbortSignal, reading = false): Promise<ScreenExportAuthority> {
        const call = screenExportIdentity(input)
        signal.throwIfAborted()
        const owner = (await db.execute({ sql: 'SELECT id,engine_agent_id,enabled FROM desktop_agents WHERE engine_agent_id=? AND workspace_id=1', args: [call.engineAgentId] })).rows[0]
        if (!owner || !Number(owner.enabled) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(call.engineAgentId)) throw denied()
        const ownerId = String(owner.id)
        await assertCoworkerNotDeleting(db, ownerId)
        const conn = engineOf(runtime), prefix = `/agents/${encodeURIComponent(call.engineAgentId)}`
        const detail = await request(conn, prefix, { signal }, value => ownerSchema.parse(value))
        if (detail.id !== call.engineAgentId || !detail.config.enabled) throw denied()
        const grants = detail.config.tools.desktopToolGrants ?? {}
        if (reading) {
            if (!grants.workspaceRead) throw denied()
            const [session, run] = await Promise.all([
                request(conn, `${prefix}/sessions/${encodeURIComponent(call.sessionId)}`, { signal }, value => sourceSchema.parse(value)),
                request(conn, `${prefix}/runs/${encodeURIComponent(call.runId)}`, { signal }, value => sourceSchema.parse(value)),
            ])
            if (session.id !== call.sessionId || session.agentId !== call.engineAgentId || run.id !== call.runId || run.agentId !== call.engineAgentId || run.sessionId !== call.sessionId) throw denied()
        } else {
            if (call.target.launchNonce !== runtime.launchNonce || !grants.browser || !grants.computer) throw denied()
            const service = await getDesktopRemoteMcpService(runtime)
            if (await service.authorizeRun(call, signal, 'privateFileWrite') !== ownerId) throw denied()
            const status = await request(conn, `${prefix}/screen/status?launchNonce=${encodeURIComponent(runtime.launchNonce)}`, { signal }, value => z.object({ running: z.literal(true), driving: z.literal(false), sessionGeneration: z.string() }).passthrough().parse(value))
            if (status.sessionGeneration !== call.target.sessionGeneration) throw denied()
        }
        const root = join(await realpath(runtime.dataRoot), 'workspaces', '1', 'engine', 'agents', call.engineAgentId, 'workspace')
        const workspaceIdentity = await browserWorkspaceIdentity(root)
        const current = (await db.execute({ sql: 'SELECT engine_agent_id,enabled FROM desktop_agents WHERE id=?', args: [ownerId] })).rows[0]
        if (!current || current.engine_agent_id !== call.engineAgentId || !Number(current.enabled)) throw denied()
        await assertCoworkerNotDeleting(db, ownerId); signal.throwIfAborted()
        return { ownerId, workspaceIdentity, runIdentity: JSON.stringify([call.engineAgentId, call.sessionId, call.runId]), launchNonce: runtime.launchNonce }
    }

    const receipts: ScreenExportDependencies['receipts'] = {
        async read(key): Promise<ScreenExportReceipt | null> {
            const row = (await db.execute({ sql: 'SELECT * FROM desktop_browser_exports WHERE operation_key=?', args: [key] })).rows[0]
            if (!row) return null
            return { digest: String(row.digest), state: row.state as 'claimed' | 'settled', sourceFingerprint: String(row.source_fingerprint), source: JSON.parse(String(row.source_json)), files: validateScreenExportManifest(JSON.parse(String(row.files_json))), ...(row.result_json ? { result: JSON.parse(String(row.result_json)) } : {}) }
        },
        async claim(key, digest, details) {
            const files = validateScreenExportManifest(details.files)
            const source = screenExportIdentity(details.source)
            const ownerId = JSON.parse(key)[0] as string
            if (key !== JSON.stringify([ownerId, source.sessionId, source.runId, source.toolCallId, 'browser-exports'])) throw denied()
            const html = browserHtmlPath(source.url, { agentId: source.engineAgentId, sessionId: source.sessionId, runId: source.runId, toolCallId: source.toolCallId })
            for (const file of files) if (file.path !== (file.kind === 'screenshot' ? source.navigation?.screenshotPath : file.kind === 'rendered-html' ? html : html.replace(/\.html\.txt$/, '.meta.txt'))) throw denied()
            const bytes = files.reduce((total, file) => total + file.byteLength, 0)
            const tx = await db.transaction('write')
            try {
                if ((await tx.execute({ sql: 'SELECT 1 FROM desktop_browser_exports WHERE operation_key=?', args: [key] })).rows.length) { await tx.commit(); return false }
                const budget = (await tx.execute({ sql: 'SELECT COUNT(*) AS count,COALESCE(SUM(reserved_bytes),0) AS bytes FROM desktop_browser_exports WHERE owner=?', args: [ownerId] })).rows[0]
                if (Number(budget?.count) >= 4096 || Number(budget?.bytes) + bytes > PAGE_RETENTION.maxOwnedBytes) throw Object.assign(new Error('Browser export storage is full.'), { code: 'EXPORT_BUDGET' })
                await tx.execute({ sql: 'INSERT INTO desktop_browser_exports(operation_key,owner,digest,source_fingerprint,source_json,files_json,state,reserved_bytes,created_at) VALUES(?,?,?,?,?,?,\'claimed\',?,?)', args: [key, ownerId, digest, details.sourceFingerprint, JSON.stringify(source), JSON.stringify(files), bytes, new Date().toISOString()] })
                for (const [index, file] of files.entries()) await tx.execute({ sql: 'INSERT INTO desktop_browser_export_files(operation_key,file_index,path,sha256,byte_length) VALUES(?,?,?,?,?)', args: [key, index, file.path, file.sha256, file.byteLength] })
                await tx.commit(); return true
            } finally { tx.close() }
        },
        async settle(key, digest, result) {
            const saved = await db.execute({ sql: "UPDATE desktop_browser_exports SET state='settled',result_json=? WHERE operation_key=? AND digest=?", args: [JSON.stringify(result), key, digest] })
            if (saved.rowsAffected !== 1) throw denied()
        },
    }
    const reconcile: ScreenExportReconciler = async (operation, authority, guard, signal) => {
        const files: ScreenSavedExports['files'] = []
        const receipt = await receipts.read(operation.key)
        if (!receipt || receipt.digest !== operation.digest) throw denied()
        for (const [index, file] of operation.files.entries()) {
            signal.throwIfAborted(); await guard()
            const row = (await db.execute({ sql: 'SELECT * FROM desktop_browser_export_files WHERE operation_key=? AND file_index=?', args: [operation.key, index] })).rows[0]
            if (!row?.dev || !row.ino || !row.parent_json || row.path !== file.path || row.sha256 !== file.sha256 || Number(row.byte_length) !== file.byteLength) continue
            try {
                await inspectBrowserExportFile(rootOf(authority), file, { dev: String(row.dev), ino: String(row.ino), parent_json: String(row.parent_json) }, guard)
                files.push(file)
            } catch { signal.throwIfAborted() }
        }
        return files.length === operation.files.length ? { status: 'saved', files } : { status: 'unknown', files, failure: 'conflict' }
    }
    const publish = createScreenExportPublisher({ authorize, receipts, reconcile,
        createOnly: (artifact, authority, guard, signal, operation) => publishBrowserExportFile(db, rootOf(authority), artifact, guard, signal, operation),
    })
    const read = createScreenExportReader({ authorizeRead: (call, signal) => authorize(call, signal, true), receipts, reconcile })
    async function readFile(invocation: { engineAgentId: string; sessionId: string; runId: string }, path: string, signal: AbortSignal) {
        if (!path.startsWith('.rerun/pages/') || !path.endsWith('.txt')) throw denied()
        const rows = await db.execute({ sql: 'SELECT e.*,f.file_index,f.dev,f.ino,f.parent_json FROM desktop_browser_exports e JOIN desktop_browser_export_files f ON f.operation_key=e.operation_key JOIN desktop_agents a ON a.id=e.owner WHERE a.engine_agent_id=? AND f.path=?', args: [invocation.engineAgentId, path] })
        if (rows.rows.length !== 1) throw denied()
        const row = rows.rows[0]!, source = screenExportIdentity(JSON.parse(String(row.source_json)))
        const files = validateScreenExportManifest(JSON.parse(String(row.files_json))), file = files[Number(row.file_index)]
        if (!file || file.path !== path || file.kind === 'screenshot' || !row.dev || !row.ino || !row.parent_json) throw denied()
        let authority: ScreenExportAuthority | undefined
        const guard = async () => {
            const current = await authorize(source, signal, true)
            if (authority && JSON.stringify(current) !== JSON.stringify(authority)) throw denied()
            authority = current
            const prefix = `/agents/${encodeURIComponent(invocation.engineAgentId)}`
            const [session, run] = await Promise.all([
                request(engineOf(runtime), `${prefix}/sessions/${encodeURIComponent(invocation.sessionId)}`, { signal }, value => sourceSchema.parse(value)),
                request(engineOf(runtime), `${prefix}/runs/${encodeURIComponent(invocation.runId)}`, { signal }, value => sourceSchema.extend({ status: z.literal('running') }).parse(value)),
            ])
            if (session.id !== invocation.sessionId || session.agentId !== invocation.engineAgentId || run.id !== invocation.runId || run.agentId !== invocation.engineAgentId || run.sessionId !== invocation.sessionId) throw denied()
        }
        await guard()
        const bytes = await inspectBrowserExportFile(rootOf(authority!), file, { dev: String(row.dev), ino: String(row.ino), parent_json: String(row.parent_json) }, guard)
        return { path, content: new TextDecoder('utf-8', { fatal: true }).decode(bytes), size: bytes.length, sha256: file.sha256 }
    }
    return { publish: (call: ScreenExportCall, signal: AbortSignal) => publish(call, signal), read, readFile }
}
