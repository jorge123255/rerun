import { foremanChatRefSchema, type DesktopForemanChatRef } from '@rerun/contracts'
import { foremanFilePermissionPatchSchema, foremanFilePermissionSnapshotSchema } from '@/lib/desktop/foreman-file-permissions'
import { DesktopHttpError } from '@/lib/desktop/server/auth'
import { openDesktopDatabase } from '@/lib/desktop/server/database'
import { ownedForemanChat } from '@/lib/desktop/server/foreman/chat-store'
import { desktopRoute } from '@/lib/desktop/server/http'
import { boundedText } from '@/lib/desktop/server/mcp/remote'
import { readDesktopJson } from '@/lib/desktop/server/request-json'
import type { DesktopRuntime } from '@/lib/desktop/server/runtime'
import { assertDesktopWorkspaceAdmission } from '@/lib/desktop/server/workspace-admission'

async function owned(runtime: DesktopRuntime, chat: DesktopForemanChatRef) {
    if (chat.workspaceId !== String(runtime.workspaceId)) throw new DesktopHttpError(404, 'Foreman conversation not found.')
    await ownedForemanChat(await openDesktopDatabase(runtime.dataRoot), chat)
}
async function proxy(runtime: DesktopRuntime, request: Request, body?: unknown) {
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(15_000)])
    const response = await fetch(new URL('/desktop/foreman/file-permissions', runtime.engine.origin), {
        method: body ? 'PATCH' : 'GET', redirect: 'error', cache: 'no-store', signal,
        headers: { authorization: `Bearer ${runtime.engine.apiKey}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const result = await boundedText(response, signal, 4096)
    if (!response.ok) throw new DesktopHttpError(409, body ? 'The permission change was not acknowledged. Refresh to inspect its saved state.' : 'Foreman file permissions are unavailable.')
    let value: unknown
    try { value = JSON.parse(result) } catch { throw new DesktopHttpError(409, 'No permission acknowledgement is available. Refresh to inspect the saved state.') }
    const parsed = foremanFilePermissionSnapshotSchema.safeParse(value)
    if (!parsed.success) throw new DesktopHttpError(409, 'No permission acknowledgement is available. Refresh to inspect the saved state.')
    const snapshot = parsed.data
    if (snapshot.workspaceId !== String(runtime.workspaceId) || snapshot.launchNonce !== runtime.launchNonce) throw new DesktopHttpError(409, 'The workspace or app launch changed. Reopen Foreman.')
    return Response.json(snapshot, { headers: { 'cache-control': 'no-store' } })
}
export async function GET(request: Request) {
    return desktopRoute(request, async runtime => {
        const query = new URL(request.url).searchParams
        const parsed = foremanChatRefSchema.safeParse({ workspaceId: query.get('workspaceId'), chatId: query.get('chatId') })
        if (!parsed.success) throw new DesktopHttpError(400, 'Choose the current Foreman conversation.')
        await owned(runtime, parsed.data)
        return proxy(runtime, request)
    })
}
export async function PATCH(request: Request) {
    return desktopRoute(request, async runtime => {
        const parsed = foremanFilePermissionPatchSchema.safeParse(await readDesktopJson(request, 4096))
        if (!parsed.success) throw new DesktopHttpError(400, 'Choose a valid Foreman file permission.')
        const input = parsed.data
        await owned(runtime, input.chat)
        if (input.launchNonce !== runtime.launchNonce) throw new DesktopHttpError(409, 'The app launch changed. Reopen Foreman.')
        await assertDesktopWorkspaceAdmission(runtime)
        const { chat, ...patch } = input
        return proxy(runtime, request, { ...patch, workspaceId: chat.workspaceId })
    })
}
