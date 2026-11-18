import 'server-only'
import { desktopWorkOwnerActionSchema, desktopWorkRegisterViewSchema, desktopWorkRoutineChangeSchema } from '@rerun/contracts'
import { DesktopHttpError } from '../auth'
import { openDesktopDatabase } from '../database'
import { desktopForeman } from '../foreman/binding'
import { createForemanConversation } from '../foreman/chat-store'
import { desktopRoute } from '../http'
import { readDesktopJson } from '../request-json'
import type { DesktopRuntime } from '../runtime'
import { assertDesktopWorkspaceAdmission } from '../workspace-admission'
import { desktopWorkRoster } from './engine'
import { readDesktopWorkRoutine, runDesktopWorkRoutineNow, saveDesktopWorkRoutine, type DesktopWorkRoutinePorts } from './routine'
import { closeDesktopWorkItem, DesktopWorkRegisterError, listDesktopWorkItems, listDesktopWorkNotices, readDesktopWorkNotice } from './store'

const headers = { 'cache-control': 'no-store' }
const refusal = (error: unknown) => error instanceof DesktopWorkRegisterError ? new DesktopHttpError(error.status, error.message) : error

/** The Chief of Staff's own send and conversations, for the routine's firings. */
export async function desktopWorkRoutinePorts(runtime: DesktopRuntime): Promise<DesktopWorkRoutinePorts> {
    const db = await openDesktopDatabase(runtime.dataRoot)
    const foreman = await desktopForeman(runtime)
    return {
        db, workspaceId: String(runtime.workspaceId),
        createConversation: requestId => createForemanConversation(db, runtime, requestId),
        send: (chat, requestId, text) => foreman.send(chat, requestId, text),
        watchReply: (runId, watcher) => foreman.watchReply(runId, watcher),
    }
}

/** GET: the register as the person reads it, newest first within each status, and what needs them. */
export function GETDesktopWorkRegister(request: Request) {
    return desktopRoute(request, async runtime => {
        const db = await openDesktopDatabase(runtime.dataRoot)
        const workspaceId = String(runtime.workspaceId)
        const [{ items }, notices] = await Promise.all([
            listDesktopWorkItems(db, workspaceId, await desktopWorkRoster(db), { status: 'all', limit: 300 }),
            listDesktopWorkNotices(db, workspaceId),
        ])
        return Response.json(desktopWorkRegisterViewSchema.parse({ items, notices: notices.map(({ chatId: _chatId, ...notice }) => notice) }), { headers })
    })
}

/** POST: the person's only changes, closing an item as done or dropped and marking a notice read. */
export function POSTDesktopWorkRegister(request: Request) {
    return desktopRoute(request, async runtime => {
        const parsed = desktopWorkOwnerActionSchema.safeParse(await readDesktopJson(request, 4_096))
        if (!parsed.success) throw new DesktopHttpError(400, 'Choose an item to close.')
        await assertDesktopWorkspaceAdmission(runtime)
        const db = await openDesktopDatabase(runtime.dataRoot)
        const workspaceId = String(runtime.workspaceId)
        try {
            if (parsed.data.action === 'read-notice') return Response.json({ read: await readDesktopWorkNotice(db, workspaceId, parsed.data.id) }, { headers })
            const { id, expectedRevision, status } = parsed.data
            return Response.json({ item: await closeDesktopWorkItem(db, workspaceId, await desktopWorkRoster(db), { id, expectedRevision, status }) }, { headers })
        } catch (error) { throw refusal(error) }
    })
}

export function GETDesktopWorkRoutine(request: Request) {
    return desktopRoute(request, async runtime => Response.json(await readDesktopWorkRoutine(runtime, await openDesktopDatabase(runtime.dataRoot), request.signal), { headers }))
}

/** POST: save the routine (switch, days and times, scope, summaries) or Run now. */
export function POSTDesktopWorkRoutine(request: Request) {
    return desktopRoute(request, async runtime => {
        const parsed = desktopWorkRoutineChangeSchema.safeParse(await readDesktopJson(request, 16_000))
        if (!parsed.success) throw new DesktopHttpError(400, 'Check the routine fields before saving.')
        await assertDesktopWorkspaceAdmission(runtime)
        const db = await openDesktopDatabase(runtime.dataRoot)
        if (parsed.data.action === 'run') return Response.json(await runDesktopWorkRoutineNow(await desktopWorkRoutinePorts(runtime), parsed.data.requestId), { headers })
        const { action: _action, ...input } = parsed.data
        return Response.json(await saveDesktopWorkRoutine(runtime, db, input, AbortSignal.any([request.signal, AbortSignal.timeout(15_000)])), { headers })
    })
}
