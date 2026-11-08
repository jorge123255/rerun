import 'server-only'
import type { Client, Transaction } from '@libsql/client'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { authenticateDesktopRequest, DesktopHttpError } from '@/lib/desktop/server/auth'
import { desktopRoute } from '@/lib/desktop/server/http'
import { readDesktopJson } from '@/lib/desktop/server/request-json'
import type { DesktopRuntime } from '@/lib/desktop/server/runtime'
import { fxCameraSchema, fxCameraWriteSchema, type FxCameraSnapshot, type FxCameraWrite, type FxCameraResult } from './board-camera'

/** Root appends this SQL in its next free migration; reads never initialize or repair storage. */
export const FX_BOARD_CAMERA_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS desktop_fx_board_camera (
 workspace_id INTEGER PRIMARY KEY CHECK(workspace_id >= 1), revision INTEGER NOT NULL CHECK(revision >= 1),
 camera_json TEXT NOT NULL, request_id TEXT NOT NULL, intent_json TEXT NOT NULL
);`
type Reader = Pick<Client, 'execute'> | Pick<Transaction, 'execute'>
async function rowOf(db: Reader, workspaceId: number) {
    return (await db.execute({ sql: 'SELECT revision,camera_json,request_id,intent_json FROM desktop_fx_board_camera WHERE workspace_id=?', args: [workspaceId] })).rows[0]
}
function snapshot(workspaceId: number, row: Awaited<ReturnType<typeof rowOf>>): FxCameraSnapshot {
    if (!row) return { workspaceId, revision: 0, camera: null }
    const revision = Number(row.revision)
    if (!Number.isSafeInteger(revision) || revision < 1 || revision >= Number.MAX_SAFE_INTEGER) throw Error('The saved board view is unavailable.')
    return { workspaceId, revision, camera: fxCameraSchema.parse(JSON.parse(String(row.camera_json))) }
}
export function createFxCameraWorkspaceStore(db: Pick<Client, 'execute' | 'transaction'>, workspaceId: number) {
    return {
        async read(): Promise<FxCameraSnapshot> { return snapshot(workspaceId, await rowOf(db, workspaceId)) },
        async write(raw: FxCameraWrite, signal: AbortSignal): Promise<FxCameraResult> {
            const input = fxCameraWriteSchema.parse(raw)
            if (input.workspaceId !== workspaceId) throw new DesktopHttpError(409, 'Workspace changed.')
            signal.throwIfAborted()
            const intent = JSON.stringify({ expectedRevision: input.expectedRevision, camera: input.camera })
            const tx = await db.transaction('write')
            try {
                signal.throwIfAborted()
                const row = await rowOf(tx, workspaceId), before = snapshot(workspaceId, row)
                if (row?.request_id === input.requestId) {
                    if (row.intent_json !== intent) throw new DesktopHttpError(409, 'Retry the exact board view request.')
                    await tx.commit()
                    return { status: 'saved', requestId: input.requestId, snapshot: before }
                }
                if (before.revision !== input.expectedRevision) { await tx.rollback(); return { status: 'conflict', snapshot: before } }
                const revision = before.revision + 1
                await tx.execute({ sql: `INSERT INTO desktop_fx_board_camera(workspace_id,revision,camera_json,request_id,intent_json) VALUES(?,?,?,?,?)
                    ON CONFLICT(workspace_id) DO UPDATE SET revision=excluded.revision,camera_json=excluded.camera_json,request_id=excluded.request_id,intent_json=excluded.intent_json`,
                    args: [workspaceId, revision, JSON.stringify(input.camera), input.requestId, intent] })
                signal.throwIfAborted()
                await tx.commit()
                return { status: 'saved', requestId: input.requestId, snapshot: { workspaceId, revision, camera: input.camera } }
            } catch (error) { await tx.rollback().catch(() => {}); throw error }
            finally { tx.close() }
        },
    }
}
async function current(request: Request, previous: DesktopRuntime) {
    const next = await authenticateDesktopRequest(request)
    if (next.workspaceId !== previous.workspaceId || next.dataRoot !== previous.dataRoot || next.launchNonce !== previous.launchNonce) throw new DesktopHttpError(409, 'The board workspace changed. Reload its saved view.')
}
export const fxBoardCameraHandlers = {
    read: (request: Request, workspaceId: string) => desktopRoute(request, async runtime => {
        if (workspaceId !== String(runtime.workspaceId)) throw new DesktopHttpError(409, 'Workspace changed.')
        const result = await createFxCameraWorkspaceStore(await openDesktopDatabase(runtime.dataRoot), runtime.workspaceId).read()
        await current(request, runtime)
        return Response.json(result)
    }),
    write: (request: Request, workspaceId: string) => desktopRoute(request, async runtime => {
        if (workspaceId !== String(runtime.workspaceId)) throw new DesktopHttpError(409, 'Workspace changed.')
        const input = fxCameraWriteSchema.parse(await readDesktopJson(request, 4096))
        if (input.workspaceId !== runtime.workspaceId) throw new DesktopHttpError(409, 'Workspace changed.')
        const db = await openDesktopDatabase(runtime.dataRoot)
        await current(request, runtime)
        const result = await createFxCameraWorkspaceStore(db, runtime.workspaceId).write(input, request.signal)
        await current(request, runtime)
        return Response.json(result)
    }),
}
