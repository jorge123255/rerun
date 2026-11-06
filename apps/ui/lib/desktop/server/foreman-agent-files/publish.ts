import 'server-only'
import { FOREMAN_AGENT_ID } from '@rerun/contracts'
import { FOREMAN_AGENT_FILE_COPY, foremanAgentBoundedText, foremanAgentFileGrantOn, foremanAgentVisiblePath } from './contract'
import { z } from 'zod'
import { authenticateDesktopEngineRequest, DesktopHttpError } from '../auth'
import { openDesktopDatabase } from '../database'
import { readPrivateCoworkerFile } from '../coworker-files'
import { abortable, boundedText } from '../mcp/remote'
import { privateFileCall, privateFilePublisher, type PrivateFileCall } from '../private-file-tools/publication'
import type { DesktopRuntime } from '../runtime'

const PUBLISHERS = Symbol.for('rerun.desktop.foreman-agent-file.publishers.v1')
const foremanView = z.object({
    id: z.literal(FOREMAN_AGENT_ID),
    config: z.object({
        kind: z.literal('foreman'),
        enabled: z.boolean(),
        tools: z.object({ desktopToolGrants: z.record(z.string(), z.boolean()).optional() }).passthrough(),
    }).passthrough(),
}).passthrough()
const foremanRun = z.object({ id: z.string(), agentId: z.literal(FOREMAN_AGENT_ID), sessionId: z.string(), status: z.string() }).passthrough()
const targetView = z.object({ id: z.string() }).passthrough()

function refused(message: string, status = 400) {
    return Response.json({ status: 'refused' as const, message }, { status, headers: { 'cache-control': 'no-store' } })
}

function publishers() {
    const globals = globalThis as unknown as Record<symbol, Map<string, ReturnType<typeof privateFilePublisher>>>
    return globals[PUBLISHERS] ??= new Map()
}

async function engineJson(runtime: DesktopRuntime, path: string, signal: AbortSignal) {
    const url = new URL(path, runtime.engine.origin)
    if (url.origin !== runtime.engine.origin || url.username || url.password) throw new Error(FOREMAN_AGENT_FILE_COPY.admission)
    signal.throwIfAborted()
    const response = await fetch(url, { headers: { authorization: `Bearer ${runtime.engine.apiKey}` }, signal, cache: 'no-store', redirect: 'error' })
    if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        throw new Error(FOREMAN_AGENT_FILE_COPY.admission)
    }
    return JSON.parse(await boundedText(response, signal, 65_536))
}

async function localTarget(runtime: DesktopRuntime, engineAgentId: string, signal: AbortSignal) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(engineAgentId) || engineAgentId === FOREMAN_AGENT_ID) throw new Error(FOREMAN_AGENT_FILE_COPY.workspace)
    const db = await abortable(openDesktopDatabase(runtime.dataRoot), signal)
    const rows = await db.execute({
        sql: `SELECT a.id FROM desktop_agents a
            WHERE a.workspace_id=1 AND a.engine_agent_id=?
            AND NOT EXISTS(SELECT 1 FROM desktop_deletions d WHERE d.agent_id=a.id OR d.engine_agent_id=a.engine_agent_id)`,
        args: [engineAgentId],
    })
    if (rows.rows.length !== 1) throw new Error(FOREMAN_AGENT_FILE_COPY.workspace)
    return { db, owner: String(rows.rows[0].id) }
}

async function admit(runtime: DesktopRuntime, call: PrivateFileCall, signal: AbortSignal) {
    const target = await localTarget(runtime, call.engineAgentId, signal)
    const [foreman, run, coworker] = await Promise.all([
        engineJson(runtime, `/agents/${FOREMAN_AGENT_ID}`, signal).then(value => foremanView.parse(value)),
        engineJson(runtime, `/agents/${FOREMAN_AGENT_ID}/runs/${encodeURIComponent(call.runId)}`, signal).then(value => foremanRun.parse(value)),
        engineJson(runtime, `/agents/${encodeURIComponent(call.engineAgentId)}`, signal).then(value => targetView.parse(value)),
    ])
    if (!foreman.config.enabled || !foremanAgentFileGrantOn(foreman.config.tools, 'foremanAgentFilesWrite')) throw new Error(FOREMAN_AGENT_FILE_COPY.off)
    if (coworker.id !== call.engineAgentId || run.id !== call.runId || run.sessionId !== call.sessionId || run.status !== 'running') throw new Error(FOREMAN_AGENT_FILE_COPY.admission)
    const again = await localTarget(runtime, call.engineAgentId, signal)
    if (again.owner !== target.owner) throw new Error(FOREMAN_AGENT_FILE_COPY.workspace)
    signal.throwIfAborted()
    return { owner: target.owner, db: target.db }
}

function textCall(call: PrivateFileCall) {
    foremanAgentVisiblePath(call.arguments.path, 'text')
    if ('content' in call.arguments) foremanAgentBoundedText(call.arguments.content)
    else {
        if (!call.arguments.oldString) throw new Error(FOREMAN_AGENT_FILE_COPY.nonTextWrite)
        foremanAgentBoundedText(call.arguments.oldString)
        foremanAgentBoundedText(call.arguments.newString)
    }
}

export async function handleDesktopForemanAgentFilePublication(request: Request): Promise<Response> {
    try {
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)])
        const runtime = await abortable(authenticateDesktopEngineRequest(request), signal)
        const call = privateFileCall.parse(JSON.parse(await boundedText(new Response(request.body), signal, 2 * 1024 * 1024)))
        try { textCall(call) } catch (error) {
            const message = error instanceof Error && (error.message === FOREMAN_AGENT_FILE_COPY.path || error.message === FOREMAN_AGENT_FILE_COPY.nonTextWrite)
                ? error.message
                : FOREMAN_AGENT_FILE_COPY.nonTextWrite
            return refused(message)
        }
        const admitted = await admit(runtime, call, signal)
        if (call.tool === 'fs_write') {
            const existing = await readPrivateCoworkerFile(runtime, admitted.owner, call.arguments.path, async () => { signal.throwIfAborted() }).then(() => true, (error: unknown) => {
                const missing = (error as NodeJS.ErrnoException).code === 'ENOENT' || (error instanceof DesktopHttpError && error.status === 404 && error.message === 'File not found')
                if (missing) return false
                throw error
            })
            if (existing) return refused('That file already exists. Nothing was saved.')
        } else {
            try { await readPrivateCoworkerFile(runtime, admitted.owner, call.arguments.path, async () => { signal.throwIfAborted() }) }
            catch { return refused('That file is unavailable in this coworker’s workspace. Nothing was saved.') }
        }
        const key = JSON.stringify([runtime.dataRoot, runtime.launchNonce, runtime.engine.origin])
        let publish = publishers().get(key)
        if (!publish) {
            publish = privateFilePublisher(admitted.db, async (identity, current) => {
                const live = await admit(runtime, identity, current)
                return { owner: live.owner, runtime }
            })
            publishers().set(key, publish)
        }
        const result = await publish(call, signal)
        return Response.json(result, { headers: { 'cache-control': 'no-store' } })
    } catch (error) {
        const message = error instanceof Error && (error.message === FOREMAN_AGENT_FILE_COPY.off || error.message === FOREMAN_AGENT_FILE_COPY.workspace || error.message === FOREMAN_AGENT_FILE_COPY.admission)
            ? error.message
            : 'Coworker file publication was refused. Nothing new was acknowledged.'
        return refused(message, error instanceof DesktopHttpError ? error.status : 400)
    }
}
