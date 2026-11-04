import 'server-only'
import { chat } from '@/lib/engine/client'
import { QUEUED_RETRY_DELAYS_MS } from '@/lib/chat/start-chat'

// As in Rerun, a completed stream can precede releasing the provider's session claim.
// Only that explicit busy response is retryable; an identity collision must remain an error.
export async function startQueuedChat(conn: Parameters<typeof chat>[0], agentId: string, params: Parameters<typeof chat>[2], delays: readonly number[] = QUEUED_RETRY_DELAYS_MS) {
    let response = await chat(conn, agentId, params)
    for (const delay of delays) {
        if (response.status !== 409 || (await response.clone().json().catch(() => ({}))).code !== 'run_in_flight') break
        await response.body?.cancel().catch(() => {})
        await new Promise(resolve => setTimeout(resolve, delay))
        response = await chat(conn, agentId, params)
    }
    return response
}
