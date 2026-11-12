import { hiddenWorkspaceError } from './workspace-access.mjs'

export async function readWorkspaceChats(runtime, { agentId, chatId }) {
    if (!runtime?.app?.origin || !runtime.app.sessionToken) throw hiddenWorkspaceError()
    const address = new URL('/api/desktop/phone-pairing', runtime.app.origin)
    if (agentId) address.searchParams.set('agentId', agentId)
    if (chatId) address.searchParams.set('chatId', chatId)
    const response = await fetch(address, {
        headers: { Cookie: `rerun-desktop-session=${runtime.app.sessionToken}`, Accept: 'application/json' },
        redirect: 'error', signal: AbortSignal.timeout(5000),
    })
    if (response.status === 404) throw hiddenWorkspaceError()
    if (!response.ok) throw new Error('Local workspace is unavailable')
    return response.json()
}
