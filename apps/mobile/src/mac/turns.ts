import { FOREMAN_AGENT_ID } from '@rerun/contracts'
import type { MacReplyFrame } from '@rerun/mac-pairing-client'

import type { MacClient } from './client'

export type MacTurn = { agentId: string; chatId: string; requestId: string }

export const isChief = (agentId: string) => agentId === FOREMAN_AGENT_ID

// A turn the phone started is followed and stopped the same way whoever it was sent to: a coworker's
// through its chat, the Chief of Staff's through the Chief of Staff's own entries on the Mac.
export function turnOf(client: MacClient, { agentId, chatId, requestId }: MacTurn) {
    const chief = isChief(agentId)
    return {
        status: (signal?: AbortSignal) => (chief ? client.readChiefTurn(chatId, requestId, signal) : client.readSentTurn(agentId, chatId, requestId, signal)),
        stream: (onFrame: (frame: MacReplyFrame) => void, signal?: AbortSignal) => (chief ? client.streamChiefTurn(chatId, requestId, onFrame, signal) : client.streamSentTurn(agentId, chatId, requestId, onFrame, signal)),
        stop: (signal?: AbortSignal) => (chief ? client.stopChiefTurn(chatId, requestId, signal) : client.stopSentTurn(agentId, chatId, requestId, signal)),
    }
}
